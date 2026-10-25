import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildSpecimens, configuredSpecimenCss, DISCOVER_LISTINGS_MAX, inventoryRoots, libraries, readInventory, readSource, sheetReport, usageFiles, writeDetect, writeDiscover, writeInventory, writeScreens } from "../scripts/snapshot.ts";
import type { InventoryChunk, InventoryIndex } from "../src/data/types.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const DEMO_APP = join(TOOL, "examples/demo-app");
const DEMO_DESIGN = join(TOOL, "examples/demo-design");

describe("snapshot source", () => {
  // `youiyoux ui --config C --root T`: a pilot config kept beside the design repo, its product elsewhere.
  test("--config with --root and no --project scans the product --root names for the usage map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-pilot-"));
    try {
      const config = { ...(JSON.parse(await readFile(join(DEMO_APP, "youi.project.json"), "utf8")) as Record<string, unknown>), source: { path: DEMO_DESIGN } };
      await writeFile(join(dir, "youi.project.json"), JSON.stringify(config));
      const libs = await libraries();
      const source = await readSource({ config: join(dir, "youi.project.json"), root: DEMO_APP }, libs.core, libs.scanner);
      expect(source.projectDir).toBe(DEMO_APP);
      expect(source.designRoot).toBe(DEMO_DESIGN);
      expect(source.usage).not.toBeNull();
      expect(source.usage!.coverage.filesScanned).toBeGreaterThan(0);
      expect(source.usage!.usages.length).toBeGreaterThan(0);
      for (const site of source.usage!.usages) expect(existsSync(join(DEMO_APP, site.file)), site.file).toBe(true);
      // Without --root the config alone gives the system and no usage map, as before.
      expect((await readSource({ config: join(dir, "youi.project.json") }, libs.core, libs.scanner)).usage).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--config whose source is a package finds the design system installed for the product", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-package-"));
    try {
      const config = { ...(JSON.parse(await readFile(join(DEMO_APP, "youi.project.json"), "utf8")) as Record<string, unknown>), source: { package: "@acme/design" } };
      await writeFile(join(dir, "youi.project.json"), JSON.stringify(config));
      await mkdir(join(dir, "node_modules/@acme"), { recursive: true });
      await symlink(DEMO_DESIGN, join(dir, "node_modules/@acme/design"), "dir");
      const libs = await libraries();
      expect((await readSource({ config: join(dir, "youi.project.json") }, libs.core, libs.scanner)).designRoot).toBe(await realpath(DEMO_DESIGN));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--inventory is validated against youi.inventory/v1 and written under its content hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      const libs = await libraries();
      const fixtures = join(TOOL, "packages/scanner/test/fixtures/inventory");
      const report = await libs.scanner.buildInventory([join(fixtures, "console"), join(fixtures, "site")]);
      await writeFile(join(dir, "good.json"), JSON.stringify(report));
      const read = await readInventory(join(dir, "good.json"), false, libs);
      const { file, files } = writeInventory(join(dir, "data"), read!);
      expect(file).toMatch(/^inventory\.[0-9a-f]{10}\.json$/);
      const index = JSON.parse(await readFile(join(dir, "data", file), "utf8")) as InventoryIndex;
      expect(index).toMatchObject({ schema: "youiyoux.inventory-index/v1", summary: { looks: read!.looks.length, families: read!.families.length } });
      // Every look is in exactly one project-and-role chunk, under its content hash.
      const chunks = await Promise.all(index.roles.flatMap((r) => Object.values(r.chunks)).map(async (f) => JSON.parse(await readFile(join(dir, "data", f), "utf8")) as InventoryChunk));
      expect(chunks.flatMap((c) => c.looks.map((l) => l.id)).sort()).toEqual(read!.looks.map((l) => l.id).sort());
      expect(files).toContain(index.extras);
      for (const f of files) expect(f).toMatch(/\.[0-9a-f]{10}\.(?:json|css)$/);
      // Without specimens, every project says so and its looks show their shape.
      expect(index.projects.every((p) => p.specimenCss === null)).toBe(true);
      await writeFile(join(dir, "bad.json"), JSON.stringify({ ...(report as object), families: [{ id: 1 }] }));
      await expect(readInventory(join(dir, "bad.json"), false, libs)).rejects.toThrow(/bad\.json: families\.0\./);
      // Only the default snapshot makes an inventory of its own.
      expect(await readInventory(undefined, false, libs)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshot specimens: stylesheets and their order", () => {
  const SERVED = join(TOOL, "packages/scanner/test/fixtures/inventory/served");

  // `youiyoux ui --config C` with `root`: the product's stylesheets listed beside the design repo, the product never edited.
  test("specimens.css in a --config kept outside the product is used for the product its root names, and the order is printed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-pilot-css-"));
    const previous = process.env.YOUI_SPECIMEN_CACHE;
    process.env.YOUI_SPECIMEN_CACHE = join(dir, "cache");
    try {
      const config = { ...(JSON.parse(await readFile(join(DEMO_APP, "youi.project.json"), "utf8")) as Record<string, unknown>), source: { path: DEMO_DESIGN }, root: SERVED, specimens: { css: ["src/design/tokens.css", "src/browser/ui.css"] } };
      const configFile = join(dir, "youi.project.json");
      await writeFile(configFile, JSON.stringify(config));
      const libs = await libraries();
      const configured = configuredSpecimenCss({ config: configFile }, libs.core);
      expect(configured).toEqual({ root: SERVED, sheets: ["src/design/tokens.css", "src/browser/ui.css"], from: configFile });
      // --root wins over the config's root.
      expect(configuredSpecimenCss({ config: configFile, root: DEMO_APP }, libs.core)!.root).toBe(DEMO_APP);
      const inventory = libs.core.InventoryReport.parse(await libs.scanner.buildInventory([SERVED]));
      const roots = new Map([["served", SERVED]]);

      const logged: string[] = [];
      const found = await buildSpecimens(inventory, roots, libs.scanner, null, (line) => logged.push(line));
      expect(logged).toEqual([
        "specimens served: 3 stylesheets, in page order",
        "  1. inlined: src/design/tokens.css (readFileSync in src/server/chrome.ts)",
        "  2. inlined: src/browser/ui.css (readFile in src/server/chrome.ts)",
        expect.stringMatching(/^ {2}3\. built: src\/browser\/tailwind\.css \(link \/assets\/tailwind\.css in src\/server\/chrome\.ts, built by package\.json "build:css", Tailwind 4\.\d+\.\d+\)$/),
      ]);
      expect(found.served!.notes).toContain("inlined: src/design/tokens.css (readFileSync in src/server/chrome.ts)");

      const listed: string[] = [];
      const fromConfig = await buildSpecimens(inventory, roots, libs.scanner, configured, (line) => listed.push(line));
      expect(listed).toEqual(sheetReport("served", [`inlined: src/design/tokens.css (specimens.css in ${configFile})`, `inlined: src/browser/ui.css (specimens.css in ${configFile})`]));
      expect(fromConfig.served!.css!.light).toContain("--so-accent: #2563eb");

      // A config whose product is not in the inventory says so, and changes nothing.
      const elsewhere: string[] = [];
      await buildSpecimens(inventory, roots, libs.scanner, { ...configured!, root: DEMO_APP }, (line) => elsewhere.push(line));
      expect(elsewhere.at(-1)).toBe(`specimens.css in ${configFile}: its product ${DEMO_APP} is not an inventoried project on this machine; not used`);
      expect(elsewhere[0]).toBe("specimens served: 3 stylesheets, in page order");
    } finally {
      if (previous === undefined) delete process.env.YOUI_SPECIMEN_CACHE;
      else process.env.YOUI_SPECIMEN_CACHE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("snapshot specimens: Tailwind entries skipped", () => {
  test("the stylesheet list names a skipped entry after the numbered ones it built", () => {
    const skipped = "skipped: design/src/globals.css (a Tailwind entry nothing links, imports or reads; the page builds another)";
    expect(sheetReport("console", ["built: src/app/globals.css (import in src/app/layout.tsx, Tailwind 4.1.0)"], [skipped])).toEqual([
      "specimens console: 1 stylesheet, in page order",
      "  1. built: src/app/globals.css (import in src/app/layout.tsx, Tailwind 4.1.0)",
      `  ${skipped}`,
    ]);
  });
});

describe("snapshot --detect", () => {
  test("copies the report and its screenshots under content hashes, rewriting the screenshot paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-detect-snap-"));
    try {
      const report = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/detect.site.json"), "utf8")) as { elements: Array<{ screenshot?: string }> };
      report.elements[0]!.screenshot = "screenshots/p1-shadcn-button.png";
      report.elements[1]!.screenshot = "screenshots/p1-shadcn-dialog.png";
      await mkdir(join(dir, "in/screenshots"), { recursive: true });
      await writeFile(join(dir, "in/screenshots/p1-shadcn-button.png"), "png bytes");
      await writeFile(join(dir, "in/detect.json"), JSON.stringify(report));
      const libs = await libraries();
      const ref = writeDetect(join(dir, "in/detect.json"), join(dir, "data"), libs.core);
      expect(ref).toMatchObject({ name: "127.0.0.1:4173", kind: "site" });
      expect(ref.file).toMatch(/^detect\.[0-9a-f]{10}\.json$/);
      expect(ref.shots).toEqual([expect.stringMatching(/^detect\.shot\.[0-9a-f]{10}\.png$/)]);
      expect((await readdir(join(dir, "data"))).sort()).toEqual([ref.file, ref.shots[0]].sort());
      const copied = libs.core.DetectReport.parse(JSON.parse(await readFile(join(dir, "data", ref.file), "utf8")));
      expect(copied.elements[0]!.screenshot).toBe(ref.shots[0]);
      // A screenshot that is missing is dropped, never left pointing at nothing.
      expect(copied.elements[1]!.screenshot).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the committed demo snapshot carries no detect report", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../snapshot/public/data/manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.detect).toBeUndefined();
  });
});

describe("snapshot Discover listings (a static host's fallback)", () => {
  test("the synced index's listings, slimmed to what a card shows and searched by, under a content hash; none without an index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-discover-snap-"));
    try {
      const { discoverFixture } = await import("../scripts/discover-fixture.ts");
      const libs = await libraries();
      expect(await writeDiscover(join(dir, "data"), join(dir, "empty"), libs.discover)).toBeNull();
      const { cache } = await discoverFixture(join(dir, "discover"));
      const file = await writeDiscover(join(dir, "data"), cache, libs.discover);
      expect(file).toMatch(/^discover\.[0-9a-f]{10}\.json$/);
      const listings = JSON.parse(await readFile(join(dir, "data", file!), "utf8")) as { schema: string; total: number; capped: boolean; entries: Array<Record<string, unknown>> };
      const index = (await libs.discover.readIndex(cache))!;
      expect(listings).toMatchObject({ schema: "youiyoux.discover-listings/v1", total: index.entries.length, capped: false });
      expect(listings.entries.length).toBe(Math.min(index.entries.length, DISCOVER_LISTINGS_MAX));
      // Official first; each listing what a card shows (licence, signals, install) and what a search reads, and no provenance or source.
      expect(listings.entries[0]!.id).toMatch(/^lib:shadcn\//);
      const command = listings.entries.find((e) => e.id === "lib:shadcn/component/command")!;
      expect(command).toMatchObject({ license: "MIT", signals: { via: { package: "cmdk", weeklyDownloads: 41566267 } }, install: { command: "npx shadcn add command" }, registry: "@shadcn", style: "styled" });
      expect(command.roles).toEqual(expect.arrayContaining(["command"]));
      expect(Object.keys(command).sort()).toEqual(["id", "install", "kind", "license", "name", "registry", "roles", "signals", "source", "style", "summary", "text", "title"].sort());
      expect(await readFile(join(dir, "data", file!), "utf8")).not.toMatch(/"content"|"provenance"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the committed demo snapshot names no Discover listings", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../snapshot/public/data/manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.discover).toBeUndefined();
  });

  test("the committed demo snapshot carries gaps for its inventory, without candidates (no Discover index is read for it)", async () => {
    const data = join(import.meta.dirname, "../snapshot/public/data");
    const manifest = JSON.parse(await readFile(join(data, "manifest.json"), "utf8")) as { gaps?: string; inventory?: string };
    expect(manifest.gaps).toMatch(/^gaps\.[0-9a-f]{10}\.json$/);
    const { GapsReport } = await import("@youiyoux/core");
    const gaps = GapsReport.parse(JSON.parse(await readFile(join(data, manifest.gaps!), "utf8")));
    expect(gaps).toMatchObject({ system: "Demo", discover: "not-synced" });
    expect(gaps.projects.map((p) => p.id)).toEqual(["console", "site"]);
    // The demo System has Button, Input and Card: they are its, not gaps.
    expect(gaps.projects[0]!.concepts.filter((c) => c.status === "system").map((c) => c.concept).sort()).toEqual(["button", "card", "input"]);
  });
});

describe("snapshot screens", () => {
  // --watch prunes every data file the manifest does not name: a screen's places must be named, or they vanish.
  test("every file writeScreens copies, places included, is a file the usage ref names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-screens-"));
    try {
      const shots = join(dir, "shots");
      const data = join(dir, "data");
      await mkdir(shots, { recursive: true });
      await writeFile(join(shots, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "http://localhost:3000", capturedAt: "2026-01-01T00:00:00.000Z", viewport: { width: 1280, height: 800 }, screens: [{ route: "/settings", path: "/settings" }] }));
      for (const variant of ["light", "light.thumb", "dark", "dark.thumb"]) await writeFile(join(shots, `settings.${variant}.webp`), `picture ${variant}`);
      await writeFile(join(shots, "settings.places.json"), JSON.stringify({ schema: "youiyoux.places/v1", places: [] }));
      const screens = writeScreens(shots, data, "app");
      expect(screens.screens[0]!.places).toBeDefined();
      const written = await readdir(data);
      expect(written).toHaveLength(5);
      expect(new Set(usageFiles([{ project: "app", file: "app.usage.json", screens }]))).toEqual(new Set(["app.usage.json", ...written]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshot --inventory: where its projects are", () => {
  test("a root is found from the file's own directory first, even where the directory it is read in has a project too", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "youi-inventory-roots-")));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await mkdir(join(dir, "app"));
      await writeFile(join(dir, "app/package.json"), "{}");
      const inventory = { projects: [{ id: "here", root: "." }, { id: "app", root: "app" }, { id: "gone", root: "nowhere" }] } as unknown as Parameters<typeof inventoryRoots>[0];
      // The tests run in the tool's repository, which has a package.json of its own: "." must not land there.
      expect(existsSync(join(process.cwd(), "package.json"))).toBe(true);
      expect(Object.fromEntries(inventoryRoots(inventory, join(dir, "inventory.json")))).toEqual({ here: dir, app: join(dir, "app") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
