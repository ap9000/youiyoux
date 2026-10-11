/**
 * Regression cases from the plan review: changes the planner misclassified, rules reported as
 * enforced that never ran, a digest blind to rule bodies, and token plans that read "0 affected".
 */
import { join } from "node:path";
import { MigrationSpec, RuleSpec, ScanReport, type ComponentContract } from "@youiyoux/core";
import type { ResolvedToken } from "@youiyoux/tokens";
import { beforeAll, describe, expect, test } from "vitest";
import { checkCapabilities, evaluateRule, loadProject, planChange, ruleCapability, ruleRows, scanProject, tokenClosure, type Project, type ScanResult } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/expo-app");

let project: Project;
let scan: ScanResult;
beforeAll(async () => {
  project = await loadProject(FIXTURE);
  scan = await scanProject(project);
});

const button = (): ComponentContract => project.system.components.find((c) => c.contract.name === "Button")!.contract;
const withRules = (rules: RuleSpec[]): Project => ({ ...project, system: { ...project.system, rules } });
const withButton = (edit: (contract: ComponentContract) => ComponentContract): Project => ({
  ...project,
  system: { ...project.system, components: project.system.components.map((c) => (c.contract.name === "Button" ? { ...c, contract: edit(c.contract) } : c)) },
});
const rule = (fields: Record<string, unknown>): RuleSpec =>
  RuleSpec.parse({ schema: "youi.rule/v1", id: "youi:demo/rule/test.probe", title: "Probe", severity: "error", statement: "Probe rule", agent: "Do not do the probed thing", ...fields });

describe("planner classification", () => {
  test("an optional prop becoming required is breaking, with the sites that omit it", async () => {
    const plan = await planChange(project, scan, { element: "button", patch: { props: { variant: { ...button().props.variant, required: true } } } });
    expect(plan).toMatchObject({ class: "api-breaking", semver: "major" });
    expect(plan.callSites).toMatchObject({ affected: 1, auto: 0, residual: 1, unresolved: 0 });
    expect(plan.callSites?.residualSites).toEqual(["components/orphan.tsx:2 (missing required variant)"]);
  });

  test("a new required prop counts every render site that omits it, and spreads as unresolved", async () => {
    const plan = await planChange(project, scan, { element: "button", patch: { props: { loading: { type: "boolean", required: true } } } });
    expect(plan.class).toBe("api-breaking");
    expect(plan.callSites).toMatchObject({ affected: 6, auto: 0, residual: 6, unresolved: 1 });
    expect(plan.callSites?.residualSites).toContain("components/checkout-form.tsx:4 (props spread in may pass required loading)");
    expect(plan.completeness.exact).toBe(false);
    expect(plan.completeness.limits).toContain("1 call site(s) spread props or pass dynamic values: whether they break is unknown");
  });

  test("renaming the exported component breaks every import of it; no recipe rewrites imports", async () => {
    const plan = await planChange(project, scan, { element: "button", patch: { source: { export: "RenamedButton" } } });
    expect(plan).toMatchObject({ class: "api-breaking", semver: "major" });
    expect(plan.reasons).toContain("export Button renamed to RenamedButton: every import of it breaks");
    expect(plan.callSites).toMatchObject({ affected: 6, auto: 0, residual: 6 });
  });

  test("a rename that keeps the old name exported is additive, not a break", async () => {
    const plan = await planChange(project, scan, { element: "button", patch: { source: { export: "BaseButton" }, aliases: [...button().aliases, "Button"] } });
    expect(plan.class).toBe("api-additive");
    expect(plan.callSites).toBeUndefined();
  });

  test("removing a variants alias breaks the sites that call it", async () => {
    const plan = await planChange(project, scan, { element: "button", patch: { aliases: [] } });
    expect(plan.class).toBe("api-breaking");
    expect(plan.callSites?.residualSites).toEqual(["app/settings/index.tsx:11 (imports buttonVariants, which is removed)"]);
  });

  test("a changed default is a behaviour change with review targets, never docs", async () => {
    const plan = await planChange(project, scan, { element: "button", patch: { props: { variant: { ...button().props.variant, default: "destructive" } } } });
    expect(plan).toMatchObject({ class: "behavior", semver: "minor" });
    expect(plan.review).toEqual({ sites: 1, unresolved: 0, listed: ["components/orphan.tsx:2 (relies on default variant)"] });
  });

  test("a removed enum value: literal uses are automatic, a dynamic value is unresolved", async () => {
    const variant = button().props.variant as { values: string[] };
    const plan = await planChange(project, scan, { element: "button", patch: { props: { variant: { ...button().props.variant, values: variant.values.filter((v) => v !== "outline") } } } });
    expect(plan.class).toBe("api-breaking");
    expect(plan.callSites).toMatchObject({ affected: 3, auto: 2, unresolved: 1 });
    expect(plan.callSites?.residualSites).toEqual(["components/checkout-form.tsx:4 (variant={cta} may be outline)"]);
  });

  test("a required prop becoming optional is additive; prose-only edits stay docs", async () => {
    const strict = withButton((c) => ({ ...c, props: { ...c.props, variant: { ...c.props.variant!, required: true } } }));
    const relaxed = await planChange(strict, scan, { element: "button", patch: { props: { variant: { ...button().props.variant, required: false } } } });
    expect(relaxed.class).toBe("api-additive");
    expect((await planChange(project, scan, { element: "button", patch: { summary: "Every act a person can take." } })).class).toBe("docs");
  });
});

describe("plan completeness", () => {
  test("adding a platform is additive, not docs", async () => {
    const web = withButton((c) => ({ ...c, platforms: ["web"] }));
    const plan = await planChange(web, scan, { element: "button", patch: { platforms: ["web", "android"] } });
    expect(plan).toMatchObject({ class: "api-additive", reasons: ["adds platform android"] });
  });

  test("a migration with residual sites is never presented as exact", async () => {
    const migration = MigrationSpec.parse({ schema: "youi.migration/v1", id: "youi:demo/migration/button-2.0.0", element: "youi:demo/component/button", from: "1.x", to: "2.0.0", changes: [{ renameProp: { from: "variant", to: "tone" } }] });
    const plan = await planChange(project, scan, { migration });
    expect(plan.callSites?.residual).toBeGreaterThan(0);
    expect(plan.completeness.exact).toBe(false);
    expect(plan.completeness.limits.some((l) => l.includes("residual site(s)"))).toBe(true);
  });
});

describe("token impact", () => {
  const token = (id: string, fields: Partial<ResolvedToken> = {}): ResolvedToken => ({ id, type: "color", light: null, dark: null, cssName: id.replace(/\./g, "-"), ...fields });

  test("the closure follows multi-hop and partial aliases", () => {
    const tokens = [token("a"), token("b", { aliasOf: "a" }), token("c", { aliasOf: "b" }), token("d", { dependsOn: ["c"] }), token("e")];
    expect([...tokenClosure(tokens, "a")].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("a font change reaches every typography token that reads it, and the contracts bound to those", async () => {
    const plan = await planChange(project, scan, { token: "font.sans" });
    expect(plan.token?.dependents).toEqual(expect.arrayContaining(["typography.body", "typography.label"]));
    expect(plan.token?.contracts.map((c) => c.name)).toEqual(expect.arrayContaining(["Input", "Button"]));
    expect(plan.impact.sites).toBeGreaterThan(0);
  });

  test("direct CSS-variable and Tailwind uses count; a stylesheet makes every screen a target", async () => {
    const probe = await scanProject(project, { overrides: { "app/settings/token-use.tsx": 'export const T = () => <div className="hover:bg-background/50 text-ink" />;\n' } });
    const plan = await planChange(project, probe, { token: "color.background" });
    expect(plan.token?.direct.sites.map((s) => `${s.file} ${s.text}`)).toEqual(expect.arrayContaining(["styles/app.css --demo-color-background", "app/settings/token-use.tsx bg-background"]));
    expect(plan.impact.everyScreen).toBe(true);
  });

  test("no use found is reported as a lower bound, never as proof of no effect", async () => {
    const plan = await planChange(project, scan, { token: "color.muted" });
    expect(plan.impact.sites).toBe(0);
    expect(plan.completeness.exact).toBe(false);
    expect(plan.completeness.limits[0]).toContain("a lower bound");
    expect(plan.reasons).toContain("no direct use found in the scanned files");
  });
});

describe("rule execution", () => {
  const audit = rule({ check: { engine: "ast-grep", language: "tsx", rule: { kind: "jsx_self_closing_element" } } });

  test("an ast-grep rule runs: its matches become violations and it is reported enforced", async () => {
    const custom = withRules([audit]);
    const result = await scanProject(custom);
    const direct = [...result.modules.values()].filter((m) => m.lang === "tsx").reduce((n, m) => n + m.root.root().findAll({ rule: { kind: "jsx_self_closing_element" } }).length, 0);
    expect(direct).toBeGreaterThan(0);
    expect(result.report.violations.filter((v) => v.rule === audit.id)).toHaveLength(direct);
    expect(result.report.checks).toEqual([{ rule: audit.id, state: "ran", findings: direct }]);
    expect(ruleRows(custom)[0]).toMatchObject({ enforced: true, execution: "enforced" });
  });

  test("a malformed ast-grep rule is unsupported everywhere and makes the scan partial", async () => {
    const broken = rule({ check: { engine: "ast-grep", language: "tsx", rule: { kind: "not_a_kind" } } });
    const custom = withRules([broken]);
    const result = await scanProject(custom);
    expect(ruleCapability(broken)).toMatchObject({ state: "unsupported", reason: expect.stringContaining("Kind `not_a_kind` is invalid") });
    expect(result.report.checks[0]).toMatchObject({ state: "unsupported" });
    expect(result.report.status).toBe("partial");
    expect(ruleRows(custom)[0]).toMatchObject({ enforced: false, execution: "unsupported" });
  });

  test("a built-in check whose options would make it check nothing is unsupported, not a clean run", async () => {
    const empty = rule({ check: { engine: "youi", id: "native-element", options: {} } });
    const typo = rule({ check: { engine: "youi", id: "raw-color", options: { allow: ["#fff"] } } });
    expect(ruleCapability(empty)).toMatchObject({ state: "unsupported", reason: expect.stringContaining("needs options.elements") });
    expect(ruleCapability(typo)).toMatchObject({ state: "unsupported", reason: expect.stringContaining("does not read option allow") });
    expect(evaluateRule(project, scan, empty)).toMatchObject({ ok: true, findings: null });
    expect((await scanProject(withRules([empty]))).report.status).toBe("partial");
  });

  test("off is off: not run, not listed for agents", async () => {
    const off = { ...audit, severity: "off" as const };
    const result = await scanProject(withRules([off]));
    expect(result.report.checks).toEqual([{ rule: off.id, state: "off" }]);
    expect(result.report.violations).toEqual([]);
    expect(ruleRows(withRules([off]))).toEqual([]);
  });

  test("the report with rule runs and content identity validates against youi.usage/v1", () => {
    expect(ScanReport.safeParse(scan.report).success).toBe(true);
    expect(scan.report.checks.find((c) => c.rule.endsWith("components.one-primary-action"))).toEqual({ rule: "youi:demo/rule/components.one-primary-action", state: "advisory" });
  });
});

describe("scan identity", () => {
  test("changing a rule body changes the digest", async () => {
    const narrowed = await scanProject(withRules(project.system.rules.map((r) => ({ ...r, files: ["__nothing__"] }))));
    expect(narrowed.report.violations).toHaveLength(0);
    expect(narrowed.report.configDigest).not.toBe(scan.report.configDigest);
  });

  test("changing a contract without bumping its version changes the digest", async () => {
    const edited = withButton((c) => ({ ...c, summary: "Edited." }));
    expect((await scanProject(edited)).report.configDigest).not.toBe(scan.report.configDigest);
  });

  test("overridden content is identified: a different content digest and the file listed as dirty", async () => {
    const edited = await scanProject(project, { overrides: { "components/orphan.tsx": "export const Orphan = () => null;\n" } });
    expect(edited.report.content?.digest).not.toBe(scan.report.content?.digest);
    expect(edited.report.content?.dirty).toContain("components/orphan.tsx");
    expect(edited.report.content?.overrides).toEqual(["components/orphan.tsx"]);
    expect(edited.report.configDigest).toBe(scan.report.configDigest);
  });
});

describe("rule editor capability API", () => {
  /** Every editable check, with code it must flag and code it must pass. */
  const CASES: Array<{ name: string; check: Record<string, unknown>; bad: string; good: string; css?: boolean }> = [
    { name: "raw-color", check: { engine: "youi", id: "raw-color" }, bad: 'export const A = () => <div className="bg-[#171717]" />;', good: 'export const A = () => <div className="bg-background" />;' },
    { name: "raw-color in css", check: { engine: "youi", id: "raw-color" }, bad: ".row { border-color: #e6e6e6; }", good: ".row { border-color: var(--demo-color-line); }", css: true },
    { name: "arbitrary-value", check: { engine: "youi", id: "arbitrary-value" }, bad: 'export const A = () => <div className="rounded-[12px]" />;', good: 'export const A = () => <div className="rounded-card" />;' },
    { name: "native-element", check: { engine: "youi", id: "native-element", options: { elements: { button: "youi:demo/component/button" } } }, bad: "export const A = () => <button>Save</button>;", good: 'import { Button } from "@/components/ui";\nexport const A = () => <Button>Save</Button>;' },
    { name: "prop-values", check: { engine: "youi", id: "prop-values" }, bad: 'import { Button } from "@/components/ui";\nexport const A = () => <Button variant="primary">Save</Button>;', good: 'import { Button } from "@/components/ui";\nexport const A = () => <Button variant="outline">Save</Button>;' },
    { name: "lookalike-component", check: { engine: "youi", id: "lookalike-component" }, bad: 'import { Button } from "@/components/legacy/button";\nexport const A = () => <Button>Save</Button>;', good: 'import { Button } from "@/components/ui";\nexport const A = () => <Button>Save</Button>;' },
    { name: "ast-grep", check: { engine: "ast-grep", language: "tsx", rule: { pattern: "console.log($$$A)" } }, bad: "export const A = () => { console.log(1); return null; };", good: "export const A = () => null;" },
  ];

  test.each(CASES)("$name flags the bad example and passes the good one", async ({ check, bad, good, css }) => {
    const [badFile, goodFile] = css ? ["styles/probe-bad.css", "styles/probe-good.css"] : ["app/probe/bad.tsx", "app/probe/good.tsx"];
    const snapshot = await scanProject(project, { overrides: { [badFile]: bad, [goodFile]: good } });
    const evaluation = evaluateRule(project, snapshot, rule({ check, files: ["**/*.{ts,tsx,css}"] }));
    if (!evaluation.ok || !evaluation.findings) throw new Error(`expected findings: ${JSON.stringify(evaluation)}`);
    const files = evaluation.findings.sites.map((s) => s.file);
    expect(files).toContain(badFile);
    expect(files).not.toContain(goodFile);
  });

  test("an invalid draft is rejected with its errors, never an empty preview", () => {
    expect(evaluateRule(project, scan, { schema: "youi.rule/v1", id: "nope" })).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("id")]) });
  });

  test("a malformed or advisory draft has no findings at all (null, not zero)", () => {
    expect(evaluateRule(project, scan, rule({ check: { engine: "ast-grep", language: "tsx", rule: {} } }))).toMatchObject({ ok: true, execution: { state: "unsupported" }, findings: null });
    expect(evaluateRule(project, scan, rule({ check: { engine: "advisory" } }))).toMatchObject({ ok: true, execution: { state: "advisory" }, findings: null });
  });

  test("an off draft previews what turning it on would find, and says it is off", () => {
    const evaluation = evaluateRule(project, scan, rule({ severity: "off", check: { engine: "youi", id: "raw-color" } }));
    expect(evaluation).toMatchObject({ ok: true, execution: { state: "off" } });
    if (evaluation.ok) expect(evaluation.findings?.total).toBeGreaterThan(0);
  });

  test("a draft of a published rule compares with it on the same snapshot", () => {
    const published = project.system.rules.find((r) => r.id.endsWith("color.no-raw-color"))!;
    const evaluation = evaluateRule(project, scan, { ...published, files: ["styles/**"] });
    if (!evaluation.ok || !evaluation.findings) throw new Error("expected findings");
    const all = scan.report.violations.filter((v) => v.rule === published.id).length;
    const kept = scan.report.violations.filter((v) => v.rule === published.id && v.file.startsWith("styles/")).length;
    expect(evaluation.findings.versusPublished).toEqual({ execution: "enforced", findings: all, added: 0, removed: all - kept });
    expect(evaluation.snapshot.configDigest).toBe(scan.report.configDigest);
  });

  test("capabilities list every built-in check and ast-grep language", () => {
    const capabilities = checkCapabilities();
    expect(capabilities.builtIn.map((c) => c.id).sort()).toEqual(["arbitrary-value", "lookalike-component", "native-element", "prop-values", "raw-color"]);
    expect(capabilities.astGrep.map((c) => c.language)).toEqual(["tsx", "typescript", "css"]);
  });
});
