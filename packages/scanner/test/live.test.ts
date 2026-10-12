import { join } from "node:path";
import { Baseline } from "@youiyoux/core";
import { beforeAll, describe, expect, test } from "vitest";
import { compareToBaseline, createBaseline, loadProject, ratchetBaseline, ScanCache, scanProject, type Project, type ScanResult } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/expo-app");
const CHECKOUT = "components/checkout-form.tsx";
const BAD_BUTTON = `import { Button } from "@/components/ui";\nexport function Extra() {\n  return <Button variant="nope">x</Button>;\n}\n`;

let project: Project;
let full: ScanResult;
beforeAll(async () => {
  project = await loadProject(FIXTURE);
  full = await scanProject(project);
});

describe("identity", () => {
  test("binds a result to the tool, the definitions and both revisions", () => {
    expect(full.identity).toMatchObject({ tool: expect.stringMatching(/^youi-scanner\//), system: { id: "demo" }, definitions: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(full.identity.design).toHaveProperty("dirty");
    expect(full.contentDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  test("a changed rule body changes the definitions digest, even in memory", async () => {
    const scoped = { ...project, system: { ...project.system, rules: project.system.rules.map((r) => ({ ...r, files: ["__nothing__"] })) } };
    const after = await scanProject(scoped);
    expect(after.report.violations).toHaveLength(0);
    expect(after.identity.definitions).not.toBe(full.identity.definitions);
  });

  test("an override changes the content digest, not the definitions", async () => {
    const edited = await scanProject(project, { overrides: { "components/extra.tsx": BAD_BUTTON } });
    expect(edited.identity.definitions).toBe(full.identity.definitions);
    expect(edited.contentDigest).not.toBe(full.contentDigest);
  });
});

describe("focused scans", () => {
  test("find exactly the full scan's violations in the focused files", async () => {
    const focused = await scanProject(project, { focus: [CHECKOUT, "app/settings/index.tsx"] });
    const inFiles = full.report.violations.filter((v) => v.file === CHECKOUT || v.file === "app/settings/index.tsx");
    expect(focused.report.violations).toEqual(inFiles);
    expect(Object.values(focused.report.fileRoutes!).every((v) => v.routeSource === "unrouted" && v.routeReason?.includes("focused scan"))).toBe(true);
    expect(focused.files).toEqual(["app/settings/index.tsx", CHECKOUT]);
  });
});

describe("scan cache", () => {
  test("reuses every parse and analysis when nothing changed, with identical results", async () => {
    const cache = new ScanCache();
    const first = await scanProject(project, { cache });
    expect(first.report.violations).toEqual(full.report.violations);
    expect(first.report.usages).toEqual(full.report.usages);
    const analysed = cache.stats.analysed;
    const second = await scanProject(project, { cache });
    expect(cache.stats).toMatchObject({ parsed: 0, analysed: 0, reusedAnalyses: analysed });
    expect(second.report.violations).toEqual(full.report.violations);
  });

  test("an edit re-analyses the edited file and its importers only", async () => {
    const cache = new ScanCache();
    await scanProject(project, { cache });
    const total = cache.stats.analysed;
    const button = await import("node:fs/promises").then((fs) => fs.readFile(join(FIXTURE, "components/ui/button.tsx"), "utf8"));
    await scanProject(project, { cache, overrides: { "components/ui/button.tsx": `${button}\n// edited\n` } });
    expect(cache.stats.parsed).toBe(1);
    expect(cache.stats.analysed).toBeGreaterThan(1);
    expect(cache.stats.analysed).toBeLessThan(total);
    expect(cache.stats.reusedAnalyses).toBeGreaterThan(0);
  });

  test("a definitions change drops derived caches together", async () => {
    const cache = new ScanCache();
    await scanProject(project, { cache });
    const total = cache.stats.analysed;
    const tightened = { ...project, system: { ...project.system, rules: project.system.rules.map((r) => ({ ...r, severity: "error" as const })) } };
    await scanProject(tightened, { cache });
    expect(cache.stats).toMatchObject({ parsed: 0, analysed: total, reusedAnalyses: 0 });
  });
});

describe("baseline", () => {
  test("accepts existing violations and validates against youi.baseline/v1", () => {
    const baseline = createBaseline(project.config.id, full.identity, full.report.violations);
    expect(Baseline.safeParse(baseline).success).toBe(true);
    expect(baseline.totals.errors + baseline.totals.warnings).toBe(full.report.violations.length);
    const comparison = compareToBaseline(baseline, full.report.violations);
    expect(comparison).toMatchObject({ new: [], regressed: [], fixed: [] });
    expect(comparison.known).toHaveLength(full.report.violations.length);
  });

  test("flags only what is new, and recognises moved code as known", async () => {
    const baseline = createBaseline(project.config.id, full.identity, full.report.violations);
    const edited = await scanProject(project, { overrides: { "components/extra.tsx": BAD_BUTTON } });
    const comparison = compareToBaseline(baseline, edited.report.violations);
    expect(comparison.new.map((v) => v.file)).toEqual(["components/extra.tsx"]);
    const moved = full.report.violations.map((v) => ({ ...v, line: v.line + 3 }));
    expect(compareToBaseline(baseline, moved).new).toEqual([]);
  });

  test("a warning that became an error is a regression; extra occurrences are new", () => {
    const warning = { file: "a.tsx", line: 3, column: 1, rule: "youi:demo/rule/raw-color", severity: "warn" as const, message: "m", text: "#fff" };
    const baseline = createBaseline("p", full.identity, [warning]);
    const result = compareToBaseline(baseline, [{ ...warning, severity: "error" }, { ...warning, line: 9, severity: "error" }]);
    expect(result.regressed.map((v) => v.line)).toEqual([3]);
    expect(result.new.map((v) => v.line)).toEqual([9]);
  });

  test("ratcheting drops fixed debt and never adds new findings", () => {
    const baseline = createBaseline(project.config.id, full.identity, full.report.violations);
    const remaining = full.report.violations.slice(1);
    const extra = { ...full.report.violations[0]!, file: "components/new.tsx" };
    const ratcheted = ratchetBaseline(baseline, [...remaining, extra], full.identity);
    expect(ratcheted.totals.errors + ratcheted.totals.warnings).toBe(remaining.length);
    expect(ratcheted.entries.some((e) => e.file === "components/new.tsx")).toBe(false);
    expect(compareToBaseline(baseline, remaining).fixed.reduce((n, f) => n + f.gone, 0)).toBe(1);
  });

  test("a focused comparison ignores other files' entries", () => {
    const baseline = createBaseline(project.config.id, full.identity, full.report.violations);
    const only = full.report.violations.filter((v) => v.file === CHECKOUT);
    expect(compareToBaseline(baseline, only, new Set([CHECKOUT])).fixed).toEqual([]);
  });
});
