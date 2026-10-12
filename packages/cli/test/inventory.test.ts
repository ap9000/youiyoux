import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InventoryReport } from "@youiyoux/core";
import { hubPlan, main } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "../../scanner/test/fixtures/inventory");
const CONSOLE = join(FIXTURES, "console");
const SITE = join(FIXTURES, "site");

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

describe("youi inventory", () => {
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

  test("help lists it; youi ui --inventory passes the file to the snapshot", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("inventory [--project <dir>…] [--include <glob>…] [--exclude <glob>…]");
    const plan = hubPlan("/opt/youi", { inventory: "/tmp/inventory.json" });
    expect(plan.snapshot).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--inventory", "/tmp/inventory.json"]);
    expect(hubPlan("/opt/youi", { inventory: "/tmp/inventory.json", watch: true }).watch).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--inventory", "/tmp/inventory.json", "--project", "/opt/youi/examples/demo-app", "--watch"]);
  });
});
