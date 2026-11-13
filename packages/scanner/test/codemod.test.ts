import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationSpec, unifiedDiff } from "@youiyoux/core";
import { afterEach, describe, expect, test } from "vitest";
import { loadProject, planChange, runMigration, scanProject, verifyRewrite } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/expo-app");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");

/** variant → tone, and two values renamed: the shape of a real api-breaking Button change. */
const migration = MigrationSpec.parse({
  schema: "youi.migration/v1",
  id: "youi:demo/migration/button-2.0.0",
  element: "youi:demo/component/button",
  from: "1.x",
  to: "2.0.0",
  changes: [{ renameProp: { from: "variant", to: "tone" } }, { mapValues: { prop: "tone", map: { outline: "secondary", primary: "default" } } }],
});

const temps: string[] = [];
async function copyOfFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "youi-codemod-"));
  temps.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  // The fixture's deliberately unparseable file mentions Button; the coverage gate would (rightly) refuse.
  await rm(join(dir, "app/broken.tsx"));
  return dir;
}
const load = (root: string) => loadProject(root, { designRoot: DEMO });

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runMigration", () => {
  test("a correct migration passes every gate in a dry run and writes nothing", async () => {
    const root = await copyOfFixture();
    const before = await readFile(join(root, "app/settings/index.tsx"), "utf8");
    const result = await runMigration(await load(root), migration);
    expect(result.status).toBe("dry-run");
    expect(result.gates.map((g) => [g.name, g.ok])).toEqual([["coverage", true], ["parse-errors", true], ["usage-count", true], ["unknowns", true], ["old-api", true], ["idempotent", true]]);
    expect(result.sitesBefore).toBe(result.sitesAfter);
    expect(result.edited).toBe(5);
    expect(result.residuals.map((r) => `${r.file}:${r.line} ${r.reason}`)).toEqual([
      "components/checkout-form.tsx:4 spread props may set a migrated prop; check by hand; non-literal tone={cta}",
    ]);
    const settings = result.changes.find((c) => c.file === "app/settings/index.tsx")!;
    expect(settings.diff).toContain("-    <ui.Button variant=\"outline\">Export</ui.Button>");
    expect(settings.diff).toContain("+    <ui.Button tone=\"secondary\">Export</ui.Button>");
    // The lookalike LegacyButton is not ours: its `kind` prop and the file stay as they were.
    expect(settings.after).toContain("<LegacyButton kind=\"primary\">Old</LegacyButton>");
    expect(await readFile(join(root, "app/settings/index.tsx"), "utf8")).toBe(before);
  });

  test("--write applies only after the gates pass, and a second run is a no-op", async () => {
    const root = await copyOfFixture();
    const project = await load(root);
    const applied = await runMigration(project, migration, { write: true });
    expect(applied.status).toBe("applied");
    const home = await readFile(join(root, "app/(tabs)/index.tsx"), "utf8");
    expect(home).toContain("<Button tone=\"secondary\" size=\"sm\">Open</Button>");
    expect(home).toContain("<Button tone=\"default\">Save</Button>");
    const rescan = await scanProject(project);
    expect(rescan.report.usages.filter((u) => u.element === migration.element)).toHaveLength(applied.sitesBefore);
    expect((await runMigration(project, migration)).status).toBe("noop");
  });

  test("a broken codemod that reports success is caught by the gates and nothing is written", async () => {
    // The scout PoC's real bug: a replacement that drops the closing quote. ast-grep happily
    // applies it; the rewritten files no longer parse and Buttons vanish from the usage map.
    const root = await copyOfFixture();
    const before = await readFile(join(root, "app/(tabs)/index.tsx"), "utf8");
    const result = await runMigration(await load(root), migration, { write: true, rewriteValue: (quoted, _from, to) => `${quoted[0]}${to}` });
    expect(result.status).toBe("rejected");
    const failed = result.gates.filter((g) => !g.ok).map((g) => g.name);
    expect(failed).toContain("parse-errors");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(await readFile(join(root, "app/(tabs)/index.tsx"), "utf8")).toBe(before);
  });

  test("a rewrite that still parses but loses a Button fails the usage-count gate", async () => {
    // Corruption tree-sitter cannot see: valid JSX, but one owned Button became a native <button>.
    const project = await load(FIXTURE);
    const before = await scanProject(project);
    const home = before.modules.get("app/(tabs)/index.tsx")!.source;
    const corrupted = home.replace("<Button variant=\"primary\">Save</Button>", "<button>Save</button>");
    expect(corrupted).not.toBe(home);
    const { gates, sitesAfter } = await verifyRewrite(project, migration, before, new Map([["app/(tabs)/index.tsx", corrupted]]));
    expect(gates.find((g) => g.name === "parse-errors")?.ok).toBe(true);
    expect(gates.find((g) => g.name === "usage-count")).toMatchObject({ ok: false });
    expect(sitesAfter).toBe(before.report.usages.filter((u) => u.element === migration.element).length - 1);
  });

  test("a codemod that maps to the wrong value is caught by the old-API and idempotence gates", async () => {
    const root = await copyOfFixture();
    const result = await runMigration(await load(root), migration, { write: true, rewriteValue: (quoted) => quoted });
    expect(result.status).toBe("rejected");
    expect(result.gates.find((g) => g.name === "old-api")?.ok).toBe(false);
    expect(result.gates.find((g) => g.name === "idempotent")?.ok).toBe(false);
  });
});

describe("planChange", () => {
  test("classifies a contract diff and counts auto versus residual call sites", async () => {
    const project = await load(FIXTURE);
    const scan = await scanProject(project);
    const button = project.system.components.find((c) => c.contract.name === "Button")!.contract;
    const values = (button.props.variant as { values: string[] }).values.filter((v) => v !== "ghost");
    const plan = await planChange(project, scan, { element: "button", patch: { props: { variant: { ...button.props.variant, values } } } });
    expect(plan).toMatchObject({ class: "api-breaking", semver: "major", version: { current: "1.0.0", next: "2.0.0" } });
    expect(plan.reasons).toEqual(["variant loses ghost"]);
    expect(plan.callSites).toMatchObject({ affected: 2, auto: 1, residual: 1 });
    expect(plan.impact.routes.map((r) => r.route)).toEqual(expect.arrayContaining(["/", "/settings", "/checkout"]));
  });

  test("an optional prop is additive and a guidance edit is docs", async () => {
    const project = await load(FIXTURE);
    const scan = await scanProject(project);
    const additive = await planChange(project, scan, { element: "button", patch: { props: { loading: { type: "boolean" } } } });
    expect(additive).toMatchObject({ class: "api-additive", semver: "minor" });
    const docs = await planChange(project, scan, { element: "button", patch: { summary: "Every act a person can take." } });
    expect(docs).toMatchObject({ class: "docs", semver: "patch" });
    // By display name too, for an element that is not the first in the system.
    expect(await planChange(project, scan, { element: "Input", patch: { summary: "A single-line field." } })).toMatchObject({ target: "youi:demo/component/input", class: "docs" });
    const removal = await planChange(project, scan, { element: "button", patch: { props: { disabled: null } } });
    expect(removal).toMatchObject({ class: "api-breaking", reasons: ["prop disabled removed"] });
  });

  test("a token change reaches the components bound to it and their screens", async () => {
    const project = await load(FIXTURE);
    const plan = await planChange(project, await scanProject(project), { token: "color.accent", value: "#2563eb" });
    expect(plan.class).toBe("token-value");
    expect(plan.reasons[1]).toContain("Button");
    expect(plan.impact.sites).toBeGreaterThan(0);
  });
});

test("unified diff marks only the changed lines", () => {
  const diff = unifiedDiff("a.tsx", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
  expect(diff).toBe("--- a/a.tsx\n+++ b/a.tsx\n@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n \n");
});

describe("write safety", () => {
  test("a scan that cannot see every site refuses to migrate", async () => {
    const root = await copyOfFixture();
    await cp(join(FIXTURE, "app/broken.tsx"), join(root, "app/broken.tsx"));
    const result = await runMigration(await load(root), migration, { write: true });
    expect(result.status).toBe("rejected");
    expect(result.gates.find((g) => g.name === "coverage")).toMatchObject({ ok: false, detail: expect.stringContaining("app/broken.tsx") });
  });

  test("a file edited after the scan is not overwritten", async () => {
    const root = await copyOfFixture();
    const project = await load(root);
    const edited = "// edited by someone else\n";
    const result = await runMigration(project, migration, {
      write: true,
      rewriteValue: (quoted, _from, to) => {
        void writeFile(join(root, "app/(tabs)/index.tsx"), edited);
        return `${quoted[0]}${to}${quoted.at(-1)}`;
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.gates.at(-1)).toMatchObject({ name: "sources-unchanged", ok: false });
    expect(await readFile(join(root, "app/settings/index.tsx"), "utf8")).toContain("variant=\"ghost\"");
  });
});
