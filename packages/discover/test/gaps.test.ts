/** Gaps: each kind of element per project, in the System, from a library, built by hand or missing, with licensed candidates. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GapsReport, type InventoryReport } from "@youiyoux/core";
import { openSqlite, type Store } from "@youiyoux/store";
import { buildGaps, closeSharedStores, conceptOfName, conceptOfPackage, declaredPackages, ingestCatalog, STANDARD_KIT, syncIndex } from "../src/index.ts";
import { fixtureFetcher } from "./fixture-fetcher.ts";

let dir: string;
let store: Store;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "discover-gaps-"));
  await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  store = await openSqlite(join(dir, "gaps.db"));
  await ingestCatalog(store, dir);
}, 60_000);
afterAll(async () => {
  await store?.close();
  await closeSharedStores();
  await rm(dir, { recursive: true, force: true });
});

const shape = { height: 32, paddingX: 12, paddingY: 6, radius: 6, fontSize: 14, fontWeight: 500 };
const project = (id: string, status: "complete" | "partial" = "complete") => ({ id, root: id, commit: null, status, files: 10, routes: "none", failed: [], warnings: [] });
const definition = (projectId: string, name: string, file: string, line = 1) => ({ id: `${projectId}:${file}#${name}`, project: projectId, file, line, name, kind: "react" as const, kit: null, role: null, variants: {} });
const look = (projectId: string, file: string, line: number, definitionId: string | null, source: "component" | "intrinsic", role: "badge" | "button" = "badge") => ({ id: `${projectId}:${file}:${line}`, project: projectId, file, line, column: 1, role, routes: [], routeSource: "unrouted" as const, source, tag: "span", definition: definitionId, kit: null, shape, derived: [], unresolved: [], responsive: [], states: [], family: null });

/** Two projects: both build a date picker by hand; app also styles spans as badges, imports Radix tabs and declares sonner. */
function inventory(): InventoryReport {
  return {
    schema: "youi.inventory/v1",
    scanner: "test",
    generatedAt: "2026-10-22T12:00:00.000Z",
    durationMs: 1,
    tolerance: { height: 2, padding: 2, radius: 2, fontSize: 1, fontWeight: 100 },
    projects: [project("app", "partial"), project("admin")],
    definitions: [definition("app", "DatePicker", "src/date-picker.tsx", 3), definition("app", "DialogContent", "src/dialog.tsx"), definition("app", "PasswordHint", "src/hint.tsx"), definition("admin", "DateInput", "src/date-input.tsx"), definition("app", "PrimaryButton", "src/button.tsx")],
    kits: [],
    primitives: [{ package: "@radix-ui/react-tabs", project: "app", exports: ["Root"], count: 2, sites: [] }],
    looks: [
      look("app", "src/a.tsx", 4, "app:src/date-picker.tsx#DatePicker", "component"),
      look("app", "src/b.tsx", 9, "app:src/date-picker.tsx#DatePicker", "component"),
      look("app", "src/c.tsx", 2, null, "intrinsic"),
      look("admin", "src/x.tsx", 1, "admin:src/date-input.tsx#DateInput", "component"),
    ],
    families: [],
    flags: [],
    summary: { looks: 4, clustered: 0, unclustered: 4, families: 0, nearDuplicates: 0, kits: 0, primitives: 1, flags: 0 },
  } as unknown as InventoryReport;
}

describe("reading names as kinds", () => {
  test("a component is the kind its whole name or its last words name; a part or a plain word at the end is not", () => {
    expect(conceptOfName("DatePicker")?.id).toBe("date-picker");
    expect(conceptOfName("date-input.tsx")?.id).toBe("date-picker");
    expect(conceptOfName("ConfirmDialog")?.id).toBe("dialog");
    expect(conceptOfName("Toaster")?.id).toBe("toast");
    expect(conceptOfName("UserAvatar")?.id).toBe("avatar");
    expect(conceptOfName("DialogContent")).toBeUndefined();
    expect(conceptOfName("PasswordHint")).toBeUndefined();
    expect(conceptOfName("Hint")?.id).toBe("tooltip");
  });

  test("a package is the kind it is listed for or named for", () => {
    expect(conceptOfPackage("@radix-ui/react-tabs")?.id).toBe("tabs");
    expect(conceptOfPackage("react-day-picker")?.id).toBe("date-picker");
    expect(conceptOfPackage("sonner")?.id).toBe("toast");
    expect(conceptOfPackage("@radix-ui/react-dropdown-menu")?.id).toBe("menu");
    expect(conceptOfPackage("lodash")).toBeUndefined();
  });
});

describe("gaps", () => {
  test("each kind is in the System, from a library, built by hand with its evidence, or missing from the kit; hand-built leads, most uses first", async () => {
    const report = GapsReport.parse(await buildGaps({ inventory: inventory(), system: { name: "Acme", components: ["Button", "Input"] }, dependencies: { app: ["react", "sonner"] }, now: new Date("2026-10-22T12:00:00Z") }, store));
    expect(report).toMatchObject({ schema: "youi.gaps/v1", system: "Acme", discover: "synced", generatedAt: "2026-10-22T12:00:00.000Z" });
    const app = report.projects.find((p) => p.id === "app")!;
    expect(app).toMatchObject({ complete: false, dependencies: "read" });
    const status = Object.fromEntries(app.concepts.map((c) => [c.concept, c.status]));
    // The System's Button wins over the project's own PrimaryButton; Radix tabs and the declared sonner are libraries.
    expect(status).toMatchObject({ button: "system", input: "system", tabs: "library", toast: "library", "date-picker": "hand-built", badge: "hand-built", combobox: "missing" });
    // A part (DialogContent) and a plain word at the end (PasswordHint) make no kind.
    expect(status.dialog).toBe("missing");
    expect(status.tooltip).toBe("missing");
    expect(app.concepts.slice(0, 2).map((c) => c.concept)).toEqual(["date-picker", "badge"]);
    const picker = app.concepts[0]!;
    expect(picker).toMatchObject({ count: 1, uses: 2, files: 3, definitions: [{ name: "DatePicker", file: "src/date-picker.tsx", line: 3 }] });
    expect(app.concepts[1]).toMatchObject({ count: 0, uses: 1, files: 1 });
    expect(app.concepts.find((c) => c.concept === "tabs")!.packages).toEqual(["@radix-ui/react-tabs"]);
    // Candidates: licensed only, never an unknown licence, and none that would oblige the project ahead of one that does not.
    expect(picker.candidates!.length).toBeGreaterThan(0);
    for (const c of picker.candidates!) expect(c.licence).not.toBe("unknown");
    expect(picker.candidates!.map((c) => c.copyleft)).toEqual([...picker.candidates!.map((c) => c.copyleft)].sort());
    // Kinds outside the kit that nobody has are left out, not listed as missing.
    expect(app.concepts.some((c) => c.concept === "marquee")).toBe(false);
    expect(app.concepts.filter((c) => c.status === "missing").every((c) => (STANDARD_KIT as readonly string[]).includes(c.concept))).toBe(true);
    // Built by hand in both projects: once, worth adding to the System.
    expect(report.across).toEqual([{ concept: "date-picker", name: "date picker", projects: ["app", "admin"], uses: 3 }]);
    expect(report.projects.find((p) => p.id === "admin")!.dependencies).toBe("unread");
  });

  test("without the Discover index there are no candidates, which is said, never shown as none", async () => {
    const report = await buildGaps({ inventory: inventory(), system: null, dependencies: {} }, null);
    expect(report.discover).toBe("not-synced");
    const app = report.projects.find((p) => p.id === "app")!;
    expect(app.concepts.find((c) => c.concept === "date-picker")!.candidates).toBeNull();
    expect(app.concepts.find((c) => c.concept === "combobox")!.candidates).toBeNull();
    // With no System, the project's own PrimaryButton is a button built by hand.
    expect(app.concepts.find((c) => c.concept === "button")!.status).toBe("hand-built");
  });

  test("declared packages come from each root's package.json; a root without one is left out", async () => {
    const root = await mkdtemp(join(tmpdir(), "gaps-root-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { sonner: "1" }, devDependencies: { vitest: "1" } }));
    try {
      expect(declaredPackages(new Map([["app", root], ["gone", join(root, "nope")]]))).toEqual({ app: ["sonner", "vitest"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
