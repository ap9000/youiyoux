import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InventoryReport } from "@youiyoux/core";
import { hubPlan, main } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "../../scanner/test/fixtures/inventory");
const CONSOLE = join(FIXTURES, "console");
const SITE = join(FIXTURES, "site");
const STORYBOOK = join(FIXTURES, "storybook");

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("youiyoux inventory", () => {
  test("--project repeats; --json prints a valid youi.inventory/v1 document and --out writes the same", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      const file = join(dir, "inventory.json");
      expect(await main(["inventory", "--project", CONSOLE, "--project", SITE, "--json", "--out", file])).toBe(0);
      const printed = InventoryReport.parse(JSON.parse(out));
      const written = InventoryReport.parse(JSON.parse(await readFile(file, "utf8")));
      expect(written).toEqual(printed);
      expect(printed.projects.map((p) => p.id)).toEqual(["console", "site"]);
      // c1: look-alike buttons, badges and tabs grouped across the two projects, with file:line examples.
      for (const role of ["button", "badge", "tabs"] as const) {
        const family = printed.families.find((f) => f.role === role && f.projects.length === 2);
        expect(family, role).toBeDefined();
        expect(family!.nearDuplicate).toBe(true);
        expect(family!.examples.every((e) => e.file.length > 0 && e.line > 0)).toBe(true);
        expect(new Set(family!.examples.map((e) => e.project))).toEqual(new Set(["console", "site"]));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the text summary shows roles × projects, families, near-duplicates, flags and the not-clustered note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      expect(await main(["inventory", "--project", CONSOLE, "--project", SITE, "--out", join(dir, "i.json")])).toBe(0);
      expect(out).toMatch(/console\s+site/);
      expect(out).toMatch(/button\s+5f 14\s+1f 2/);
      expect(out).toMatch(/button-1\s+h32 px12 py0 r8 14px 500\s+10 looks\s+console, site\s+near-duplicate/);
      expect(out).toContain("console · src/components/ui");
      expect(out).toContain("site · src/styles/ui.css");
      expect(out).toContain("Badge is defined 3 times");
      expect(out).toContain("console:src/app/settings/page.tsx imports 2 kits' button in 2 imports: LegacyButton, LegacyIconButton from src/styles/legacy.css (line 2), Button from src/components/ui (line 3)");
      expect(out).toMatch(/\d+ breakpoint\/state classes recorded, not clustered/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Storybook: stories added beside their components, each skipped one with file:line and why, then what to do next; exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      const file = join(dir, "i.json");
      expect(await main(["inventory", "--project", STORYBOOK, "--out", file])).toBe(0);
      expect(out).toContain("4 looks in 3 families · 8 stories beside them");
      // Counts are of real uses; stories are added beside them.
      expect(out).toMatch(/button\s+1f 3\n/);
      expect(out).toMatch(/button-1\s+h32 px12 py0 r8 14px 500\s+3 looks\s+storybook\s+\+ 5 stories/);
      expect(out).toMatch(/button-2\s+h44 px32 py0 r8 16px 500\s+0 looks\s+storybook\s+only in Storybook: 1 story/);
      expect(out).toContain("Storybook: 12 stories in 5 files, 8 added as authored states beside their components; 5 skipped:");
      for (const line of [
        "src/components/ui/button.stories.tsx:59 With Icon — has its own render function; only args stories are drawn",
        "src/components/ui/button.stories.tsx:67 Legacy — a CSF 2 function story; only CSF 3 object stories are read",
        "src/stories/broken.stories.tsx:9 every story in it — the file did not parse; fix its syntax and run again",
        "src/stories/introduction.stories.tsx:5 Welcome — meta names no component",
        "src/stories/remote-button.stories.tsx:8 From Package — Button comes from package @acme/ui, not this project",
        "src/components/ui/button.stories.tsx: decorator at line 51 skipped: ThemeProvider comes from package next-themes; only providers defined in this project are applied; its stories are drawn without it",
      ])
        expect(out).toContain(line);
      expect(out).toContain(`Next: rewrite the skipped stories as CSF 3 args stories of a component in this project (or fix the file), run youiyoux inventory again, then see them beside their real uses with youiyoux ui --inventory ${file}`);
      out = "";
      expect(await main(["inventory", "--project", STORYBOOK, "--json", "--out", file])).toBe(0);
      const printed = InventoryReport.parse(JSON.parse(out));
      expect(printed.projects[0]!.stories).toMatchObject({ files: 5, read: 12, drawn: 8, skipped: expect.arrayContaining([expect.objectContaining({ file: "src/stories/introduction.stories.tsx", line: 5, reason: "meta names no component" })]) });
      expect(printed.looks.filter((l) => l.story).map((l) => l.story!.name)).toContain("High contrast");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a project with no Storybook prints no Storybook section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      expect(await main(["inventory", "--project", CONSOLE, "--out", join(dir, "i.json")])).toBe(0);
      expect(out).not.toContain("Storybook");
      expect(out).not.toContain("stories");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--include replaces the include globs and --exclude adds to the excludes; both repeat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      const file = join(dir, "i.json");
      expect(await main(["inventory", "--project", CONSOLE, "--json", "--out", file])).toBe(0);
      const all = InventoryReport.parse(JSON.parse(out));
      out = "";
      expect(await main(["inventory", "--project", CONSOLE, "--include", "src/browser/**", "--json", "--out", file])).toBe(0);
      const browser = InventoryReport.parse(JSON.parse(out));
      expect(browser.projects[0]!.files).toBeLessThan(all.projects[0]!.files);
      // Only the browser pane's looks; stylesheets still count, so the theme and class kits resolve.
      expect(browser.looks.map((l) => `${l.file}:${l.line} ${l.role}`)).toEqual(["src/browser/toolbar.tsx:7 input", "src/browser/toolbar.tsx:8 button"]);
      expect(browser.looks.length).toBeLessThan(all.looks.length);
      expect(browser.definitions.filter((d) => d.kind !== "class").map((d) => d.file)).toEqual(["src/browser/toolbar.tsx"]);
      expect(browser.kits.map((k) => k.id)).toContain("console:src/browser/ui.css");
      out = "";
      expect(await main(["inventory", "--project", CONSOLE, "--include", "src/browser/**", "--include", "src/app/browser/**", "--exclude", "**/toolbar.tsx", "--json", "--out", file])).toBe(0);
      const excluded = InventoryReport.parse(JSON.parse(out));
      expect([...new Set(excluded.looks.map((l) => l.file))]).toEqual(["src/app/browser/page.tsx"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a directory that does not exist is an error, not an empty inventory", async () => {
    expect(await main(["inventory", "--project", join(FIXTURES, "nope")])).toBe(1);
    expect(err).toContain("is not a directory");
  });

  test("help lists it; youiyoux ui --inventory passes the file to the snapshot", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("inventory [--project <dir>…] [--include <glob>…] [--exclude <glob>…]");
    const plan = hubPlan("/opt/youi", { inventory: "/tmp/inventory.json" });
    expect(plan.snapshot).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--inventory", "/tmp/inventory.json"]);
    expect(hubPlan("/opt/youi", { inventory: "/tmp/inventory.json", watch: true }).watch).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--inventory", "/tmp/inventory.json", "--project", "/opt/youi/examples/demo-app", "--watch"]);
  });
});

describe("youiyoux gaps", () => {
  test("per project: what is built by hand, what the kit has that it lacks, and across projects; without Discover it says how to get candidates", async () => {
    const cache = await mkdtemp(join(tmpdir(), "youi-gaps-cache-"));
    vi.stubEnv("YOUI_DISCOVER_CACHE", cache);
    vi.stubEnv("YOUI_INDEX", join(cache, "index.db"));
    try {
      const file = join(cache, "gaps.json");
      expect(await main(["gaps", "--project", CONSOLE, "--project", SITE, "--json", "--out", file])).toBe(0);
      const { GapsReport } = await import("@youiyoux/core");
      const report = GapsReport.parse(JSON.parse(out));
      expect(GapsReport.parse(JSON.parse(await readFile(file, "utf8")))).toEqual(report);
      expect(report.discover).toBe("not-synced");
      expect(report.projects.map((p) => p.id)).toEqual(["console", "site"]);
      const consoleGaps = report.projects[0]!;
      // The console imports Radix dialog and tabs: libraries, not gaps.
      expect(consoleGaps.concepts.filter((c) => c.status === "library").map((c) => c.concept).sort()).toEqual(["dialog", "tabs"]);
      expect(consoleGaps.concepts.find((c) => c.concept === "button")).toMatchObject({ status: "hand-built", candidates: null });
      expect(report.across.map((a) => a.concept)).toContain("badge");

      out = "";
      expect(await main(["gaps", "--project", CONSOLE, "--project", SITE])).toBe(0);
      expect(out).toMatch(/^console\n {2}Built by hand, with what could stand in for it:\n {4}button +\d+ components named for it, \d+ uses, in \d+ files \(/);
      expect(out).toContain("no candidates: the Discover index is not synced");
      expect(out).toMatch(/Not in it, from the standard kit \(\d+\): alert, drawer/);
      expect(out).toContain("Built by hand in more than one project, worth adding to the System once:");
      expect(out.trimEnd().split("\n").at(-1)).toBe("Next: youiyoux discover sync, then run youiyoux gaps again for candidates.");
    } finally {
      vi.unstubAllEnvs();
      await rm(cache, { recursive: true, force: true });
    }
  });

  test("an inventory file can stand in for scanning; help lists the command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-gaps-"));
    vi.stubEnv("YOUI_DISCOVER_CACHE", dir);
    vi.stubEnv("YOUI_INDEX", join(dir, "index.db"));
    try {
      const file = join(dir, "inventory.json");
      expect(await main(["inventory", "--project", CONSOLE, "--out", file])).toBe(0);
      out = "";
      expect(await main(["gaps", "--inventory", file, "--json"])).toBe(0);
      expect(JSON.parse(out).projects.map((p: { id: string }) => p.id)).toEqual(["console"]);
      out = "";
      expect(await main(["--help"])).toBe(0);
      expect(out).toContain("gaps [--project <dir>…] [--inventory <file>] [--json] [--out <file>]");
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
