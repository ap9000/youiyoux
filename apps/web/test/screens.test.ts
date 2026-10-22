import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { RouteConfig, ScanReport as ScanReportSchema } from "@youiyoux/core";
import { loadProject } from "../../../packages/scanner/src/project.ts";
import { scanProject } from "../../../packages/scanner/src/scan.ts";
import { buildScreens, countIssues, routeLabel, screenHref, screensOf, screensOfElement, screenSlug } from "../src/data/screens.ts";
import { elementOf, hitAt, isSelected, matchPlaces } from "../src/data/places.ts";
import type { Manifest, PlacedComponent, ScanReport, UsageSite } from "../src/data/types.ts";
import { EVERY_SCREEN, indexUsage, UNROUTED } from "../src/data/usage.ts";

const BUTTON = "youi:demo/component/button";
const CARD = "youi:demo/component/card";
const RAW_COLOR = "youi:demo/rule/color.no-raw-color";

function site(overrides: Partial<UsageSite>): UsageSite {
  return { element: BUTTON, kind: "render", export: "Button", local: "Button", props: {}, spread: false, file: "src/work.tsx", line: 1, column: 1, routes: ["/work"], routeSource: "route-file", fingerprint: "f", ...overrides };
}

const report: ScanReport = {
  schema: "youi.usage/v1",
  project: "demo-app",
  system: "demo",
  commit: "abc1234def",
  scanner: "test",
  configDigest: "x",
  generatedAt: "2026-10-11T00:00:00.000Z",
  durationMs: 1,
  status: "complete",
  coverage: { filesMatched: 4, filesScanned: 4, failed: [] },
  usages: [
    site({ line: 3 }),
    site({ line: 9, props: { variant: { literal: "ghost" } } }),
    site({ element: CARD, export: "Card", local: "Card", line: 12 }),
    site({ file: "src/shared.tsx", routes: ["/work", "/review"], routeSource: "imported-by" }),
    site({ file: "src/app.tsx", routes: [EVERY_SCREEN], routeSource: "shell" }),
    site({ file: "src/orphan.tsx", routes: [], routeSource: "unrouted" }),
  ],
  fileRoutes: {
    "src/work.tsx": { routes: ["/work"], routeSource: "route-file" },
    "src/shared.tsx": { routes: ["/work", "/review"], routeSource: "imported-by" },
    "src/orphan.tsx": { routes: [], routeSource: "unrouted", routeReason: "No route reaches this file." },
    "src/empty.ts": { routes: [], routeSource: "unrouted", routeReason: "No scanned file imports this file." },
    "src/styles.css": { routes: [], routeSource: "unrouted", routeReason: "No route reaches this file." },
  },
  unknowns: [{ name: "Btn", reason: "dynamic-component", detail: "computed", candidate: BUTTON, file: "src/shared.tsx", line: 2, column: 3 }],
  suppressed: 0,
  checks: [],
  lookalikes: [{ resembles: BUTTON, local: "Button", resolved: "src/ui/primitives.tsx#Button", file: "src/work.tsx", line: 20, column: 1 }],
  violations: [
    { rule: RAW_COLOR, severity: "error", message: "raw", text: "#fff", file: "src/work.tsx", line: 4, column: 1 },
    { rule: RAW_COLOR, severity: "warn", message: "raw", text: "#000", file: "src/shared.tsx", line: 5, column: 1 },
    { rule: RAW_COLOR, severity: "warn", message: "raw", text: "red", file: "src/styles.css", line: 1, column: 1 },
  ],
};

const shot = { light: { full: "l.webp", thumb: "lt.webp" }, dark: { full: "d.webp", thumb: "dt.webp" } };
const manifest: Manifest = {
  schema: "youiyoux.manifest/v1",
  source: { commit: null },
  systems: [
    {
      id: "demo",
      catalog: "demo.catalog.json",
      usage: [{ project: "demo-app", file: "demo-app.usage.json", screens: { source: "a demo", capturedAt: "2026-10-11", viewport: { width: 1440, height: 900 }, screens: [{ route: "/work", path: "/work", ...shot }] } }],
    },
  ],
};

describe("screen slugs and links", () => {
  test("turn routes into stable, readable URL segments", () => {
    expect(screenSlug("/work")).toBe("work");
    expect(screenSlug("/work (task detail)")).toBe("work-task-detail");
    expect(screenSlug("/user/[id]")).toBe("user-id");
    expect(screenSlug("/")).toBe("root");
    expect(screenSlug(EVERY_SCREEN)).toBe("app-shell");
    expect(screenSlug(UNROUTED)).toBe("unrouted");
    expect(screenHref("demo-app", "/review")).toBe("/screens/demo-app/review");
    expect(routeLabel(EVERY_SCREEN)).toBe("App shell");
  });
});

describe("buildScreens", () => {
  const screens = buildScreens(indexUsage([report]), manifest);
  const at = (route: string) => screens.screens.find((s) => s.route === route)!;

  test("lists the shell first, then routes by name, with no synthetic unrouted screen", () => {
    expect(screens.screens.map((s) => s.route)).toEqual([EVERY_SCREEN, "/review", "/work"]);
  });

  test("groups each screen's sites by element, most used first", () => {
    const work = at("/work");
    expect(work.sites).toBe(4);
    expect(work.elements.map((e) => [e.id, e.sites.length])).toEqual([
      [BUTTON, 3],
      [CARD, 1],
    ]);
  });

  test("places issues on the screens their file reaches, including a shared file on each of its screens", () => {
    expect(at("/work").issues).toEqual({ errors: 1, warnings: 1, lookalikes: 1, unresolved: 1, total: 4 });
    expect(at("/review").issues).toEqual({ errors: 0, warnings: 1, lookalikes: 0, unresolved: 1, total: 2 });
    expect(at("/work").elements.find((e) => e.id === BUTTON)?.lookalikes).toHaveLength(1);
    expect(at("/review").elements.find((e) => e.id === BUTTON)?.unresolved).toHaveLength(1);
  });

  test("keeps unreachable files visible with their scanner reason", () => {
    expect(screens.unattributed).toEqual({ errors: 0, warnings: 1, lookalikes: 0, unresolved: 0, total: 1 });
    expect(screens.unattributedFiles).toEqual([
      { project: "demo-app", file: "src/orphan.tsx", sites: 1, reason: "No route reaches this file." },
      { project: "demo-app", file: "src/styles.css", sites: 0, reason: "No route reaches this file." },
    ]);
  });

  test("unrouted sites and findings share one file list, excluding files with neither", () => {
    const unplaced = buildScreens(indexUsage([{
      ...report,
      usages: [site({ file: "src/styles.css", routes: [], routeSource: "unrouted" }), site({ file: "src/styles.css", routes: [], routeSource: "unrouted", line: 2 })],
    }]), manifest);
    expect(unplaced.unattributedFiles).toEqual([
      { project: "demo-app", file: "src/styles.css", sites: 2, reason: "No route reaches this file." },
    ]);
    expect(unplaced.unattributed.total).toBe(1);
    expect(unplaced.screens.some((s) => s.route === UNROUTED)).toBe(false);
  });

  test("finding-level routes from older maps never override a missing fileRoutes map", () => {
    const oldRoutes = { routes: ["/wrong"], routeSource: "imported-by" as const, routeReason: "Old reason" };
    const legacy = buildScreens(indexUsage([{
      ...report, usages: [], fileRoutes: undefined,
      violations: report.violations.map((f) => ({ ...f, ...oldRoutes })),
      lookalikes: report.lookalikes.map((f) => ({ ...f, ...oldRoutes })),
      unknowns: report.unknowns.map((f) => ({ ...f, ...oldRoutes })),
    }]), manifest);
    expect(legacy.screens).toEqual([]);
    expect(legacy.unattributed.total).toBe(5);
    expect(legacy.unattributedFiles.every((f) => f.reason.includes("Scan the project again"))).toBe(true);
  });

  test("places findings on screens with no element sites, using the saved file map", () => {
    const onlyIssues = buildScreens(indexUsage([{ ...report, usages: [], fileRoutes: { ...report.fileRoutes, "src/styles.css": { routes: ["/work"], routeSource: "imported-by" } } }]), manifest);
    expect(onlyIssues.screens.find((s) => s.route === "/work")).toMatchObject({ sites: 0, issues: { total: 5 } });
    expect(onlyIssues.unattributed.total).toBe(0);
  });

  test("older reports ask for a rescan instead of inferring issue routes from element sites", () => {
    const legacy = buildScreens(indexUsage([{ ...report, fileRoutes: undefined }]), manifest);
    expect(legacy.unattributed.total).toBe(5);
    expect(legacy.screens.every((s) => s.issues.total === 0)).toBe(true);
    expect(legacy.unattributedFiles.every((f) => f.reason.includes("Scan the project again"))).toBe(true);
  });

  test("demo-app findings reach the hub after scanning and serializing, even without system elements", async () => {
    const project = await loadProject(join(import.meta.dirname, "../../../examples/demo-app"));
    const file = "components/invite-form.tsx";
    const mapped = { ...project, config: { ...project.config, routes: RouteConfig.parse({ strategy: "map", map: [{ file: "app/invite/index.tsx", routes: ["/join"] }] }) } };
    const scan = await scanProject(mapped, { overrides: { [file]: 'import { Button } from "other-kit"; import { Missing } from "./missing"; export function InviteForm() { return <div><button>Invite</button><Button /><Missing /></div>; }' } });
    const saved = ScanReportSchema.parse(JSON.parse(JSON.stringify(scan.report)));
    expect(saved.usages.some((s) => s.file === file)).toBe(false);
    const built = buildScreens(indexUsage([saved]), manifest);
    const screen = built.screens.find((s) => s.route === "/join")!;
    expect(screen.sites).toBe(0);
    expect(screen.violations.some((v) => v.file === file)).toBe(true);
    expect(screen.lookalikes.some((v) => v.file === file)).toBe(true);
    expect(screen.unresolved.some((v) => v.file === file)).toBe(true);
    expect(built.unattributedFiles.some((f) => f.file === file)).toBe(false);
  });

  test("the demo scanner's unrouted stylesheet reason reaches the hub unchanged", async () => {
    const project = await loadProject(join(import.meta.dirname, "../../../examples/demo-app"));
    const file = "components/console.css";
    const scan = await scanProject(project, { overrides: { [file]: ".notice { color: #c62828; }" } });
    const saved = ScanReportSchema.parse(JSON.parse(JSON.stringify(scan.report)));
    const built = buildScreens(indexUsage([saved]), manifest);
    expect(saved.fileRoutes?.[file]?.routeReason).toContain("routes.shell");
    expect(built.unattributedFiles.find((f) => f.file === file)).toEqual({
      project: "demo-app", file, sites: 0, reason: saved.fileRoutes![file]!.routeReason,
    });
    const activeFiles = new Set([...saved.usages, ...saved.violations, ...saved.lookalikes, ...saved.unknowns].map((f) => f.file));
    expect(built.unattributedFiles.every((f) => activeFiles.has(f.file))).toBe(true);
  });

  test("attaches the captured screenshot and leaves screens without one empty", () => {
    expect(at("/work").shot?.light?.full).toBe("l.webp");
    expect(at("/review").shot).toBeNull();
    expect(screens.byHref.get("/screens/demo-app/work")).toBe(at("/work"));
  });

  test("screensOf builds once per usage index", () => {
    const index = indexUsage([report]);
    expect(screensOf(index, manifest)).toBe(screensOf(index, manifest));
  });
});

describe("screensOfElement", () => {
  test("ranks an element's routed screens by its sites there, with the app shell last and unrouted sites left out", () => {
    const list = screensOfElement(buildScreens(indexUsage([report]), manifest), BUTTON);
    expect(list.map((s) => [s.screen.route, s.sites])).toEqual([
      ["/work", 3],
      ["/review", 1],
      [EVERY_SCREEN, 1],
    ]);
  });
});

describe("countIssues", () => {
  test("splits errors from warnings and totals every kind", () => {
    const issues = countIssues(
      report.violations.map((v) => ({ ...v, project: "p" })),
      [1],
      [],
    );
    expect(issues).toEqual({ errors: 1, warnings: 2, lookalikes: 1, unresolved: 0, total: 4 });
  });
});

describe("components placed on a captured screen", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const place = (name: string, file: string | null, line: number | null, b = box(0, 0, 100, 40), depth = 1): PlacedComponent => ({ name, owner: "Work", file, line, column: 5, box: b, depth });
  const sites = report.usages.map((u) => ({ ...u, project: "demo-app", commit: null }));
  const lookalikes = report.lookalikes.map((l) => ({ ...l, project: "demo-app" }));

  test("a place is the element whose site is on its line, by the name it renders; a hand-built lookalike is that; anything else is itself", () => {
    const placed = matchPlaces([place("Button", "src/work.tsx", 3), place("Card", "src/work.tsx", 12), place("Button", "src/work.tsx", 20), place("Card", "src/work.tsx", 3), place("Sidebar", "src/work.tsx", 30), place("Primitive", null, null)], sites, lookalikes);
    expect(placed.map((p) => [p.element, p.lookalike, p.at])).toEqual([
      [BUTTON, null, "src/work.tsx:3"],
      [CARD, null, "src/work.tsx:12"],
      [null, BUTTON, "src/work.tsx:20"],
      // On a Button's line but named Card: not that site.
      [null, null, "src/work.tsx:3"],
      [null, null, "src/work.tsx:30"],
      [null, null, null],
    ]);
    expect(placed.map(elementOf)).toEqual([BUTTON, CARD, BUTTON, null, null, null]);
    // Picked out by the element (its uses and its lookalikes) or by file:line.
    expect(placed.filter((p) => isSelected(p, BUTTON)).map((p) => p.at)).toEqual(["src/work.tsx:3", "src/work.tsx:20"]);
    expect(placed.filter((p) => isSelected(p, "src/work.tsx:30")).map((p) => p.place.name)).toEqual(["Sidebar"]);
    expect(placed.some((p) => isSelected(p, null))).toBe(false);
  });

  test("the component under a point is the smallest box holding it, among those that count", () => {
    const placed = matchPlaces([place("Card", "src/work.tsx", 12, box(0, 0, 400, 300), 1), place("Button", "src/work.tsx", 3, box(20, 20, 80, 30), 2), place("Icon", "src/icon.tsx", 1, box(25, 25, 10, 10), 3)], sites);
    expect(hitAt(placed, 30, 30)?.place.name).toBe("Icon");
    expect(hitAt(placed, 30, 30, (p) => p.element !== null)?.place.name).toBe("Button");
    expect(hitAt(placed, 200, 200)?.place.name).toBe("Card");
    expect(hitAt(placed, 500, 500)).toBeNull();
  });

  test("a screen's page opens with an element or a line picked out", () => {
    expect(screenHref("demo-app", "/work", BUTTON)).toBe("/screens/demo-app/work?select=youi%3Ademo%2Fcomponent%2Fbutton");
    expect(screenHref("demo-app", "/work", "src/work.tsx:3")).toBe("/screens/demo-app/work?select=src%2Fwork.tsx%3A3");
    expect(screenHref("demo-app", "/work")).toBe("/screens/demo-app/work");
  });
});
