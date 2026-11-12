import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { BEHAVIOUR_CHECK_IDS, BEHAVIOUR_CHECKS, BEHAVIOUR_NOT_RUN, BEHAVIOUR_PATTERNS, BehaviourConsent, BehaviourResult, BehaviourRouteRun, ComponentContract, DefinitionError, executionLabel, formatId, InventoryLook, loadDesignRepo, matchesQuery, parseDefinition, parseId, ProjectConfig, renderJsonSchemas, RuleRun, ruleExecution, RuleSpec } from "../src/index.ts";

const REPO = join(import.meta.dirname, "../../..");
const DEMO = join(REPO, "examples/demo-design");

const minimalContract = {
  schema: "youi.component/v1",
  id: "youi:demo/component/chip",
  name: "Chip",
  version: "1.0.0",
  status: "beta",
  summary: "A chip.",
  source: { file: "chip/chip.tsx", export: "Chip" },
  platforms: ["web"],
  props: { tone: { type: "enum", values: ["neutral", "info"], default: "neutral" } },
};

describe("element ids", () => {
  test("round-trip and match by full id, kind/name or bare name", () => {
    const id = formatId("demo", "component", "button");
    expect(id).toBe("youi:demo/component/button");
    expect(parseId(id)).toEqual({ system: "demo", kind: "component", name: "button" });
    expect(parseId("dl:demo/component/button")).toBeNull();
    for (const query of [id, "component/button", "Button"]) expect(matchesQuery(id, query)).toBe(true);
    expect(matchesQuery(id, "badge")).toBe(false);
  });
});

describe("youi.component/v1", () => {
  test("accepts a minimal contract and fills defaults", () => {
    const contract = ComponentContract.parse(minimalContract);
    expect(contract.rules).toEqual([]);
    expect(contract.source.also).toEqual([]);
    expect(contract.props.tone).toMatchObject({ required: false });
  });

  test("rejects bad ids, names and prop specs with the failing field", () => {
    const bad = { ...minimalContract, id: "chip", name: "chip", props: { tone: { type: "enum", values: [] } } };
    expect(() => parseDefinition("chip.contract.json", JSON.stringify(bad), ComponentContract)).toThrowError(DefinitionError);
    try {
      parseDefinition("chip.contract.json", JSON.stringify(bad), ComponentContract);
    } catch (error: unknown) {
      const issues = (error as DefinitionError).issues.join("\n");
      expect(issues).toContain("id:");
      expect(issues).toContain("name:");
      expect(issues).toContain("props.tone.values");
    }
  });

  test("refuses source paths that escape the components dir", () => {
    const escaping = { ...minimalContract, source: { file: "../../etc/passwd", export: "Chip" } };
    expect(ComponentContract.safeParse(escaping).success).toBe(false);
  });
});

describe("other formats", () => {
  test("a rule needs an engine; advisory rules carry no check body", () => {
    const rule = { schema: "youi.rule/v1", id: "youi:demo/rule/x.y", title: "X", severity: "warn", statement: "S", agent: "A", check: { engine: "advisory" } };
    expect(RuleSpec.parse(rule).files).toEqual(["**/*.{ts,tsx,css}"]);
    expect(RuleSpec.safeParse({ ...rule, check: { engine: "eslint" } }).success).toBe(false);
  });

  test("project config defaults dark selectors, outputs and the youiyoux skill folder", () => {
    const config = ProjectConfig.parse({ schema: "youi.project/v1", id: "app", system: "demo", source: { path: ".." }, include: ["src/**/*.tsx"], componentsDir: "src/ui" });
    expect(config.outputs.dark).toHaveLength(2);
    expect(config.agents.skillDir).toBe(".agents/skills/youiyoux");
    expect(config.routes.strategy).toBe("none");
  });

  test("project config may list the stylesheets specimens use, inside the project only (c6)", () => {
    const base = { schema: "youi.project/v1", id: "app", system: "demo", source: { path: ".." }, include: ["src/**/*.tsx"], componentsDir: "src/ui" };
    expect(ProjectConfig.parse({ ...base, specimens: { css: ["src/browser/tailwind.css", "src/design/tokens.css"] } }).specimens).toEqual({ css: ["src/browser/tailwind.css", "src/design/tokens.css"] });
    expect(ProjectConfig.parse(base).specimens).toBeUndefined();
    expect(ProjectConfig.safeParse({ ...base, specimens: { css: ["../other/x.css"] } }).success).toBe(false);
  });

  test("every published schema is emitted as JSON Schema 2020-12 and matches the committed copy", async () => {
    const rendered = renderJsonSchemas();
    expect(rendered.map((s) => s.file)).toHaveLength(22);
    for (const { file, content } of rendered) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(await readFile(join(REPO, "schema", file), "utf8")).toBe(content);
    }
  });
});

describe("youi.inventory/v1 recipes", () => {
  const look = { project: "p", file: "a.tsx", line: 1, column: 1, id: "p:a.tsx:1:1", role: "button", routes: [], routeSource: "unrouted", source: "component", tag: "Button", definition: null, kit: null, shape: { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 }, derived: [], unresolved: [], responsive: [], states: [], family: null };

  test("a look without a recipe is still valid: recipes are additive", () => {
    expect(InventoryLook.safeParse(look).success).toBe(true);
  });

  test("component and class recipes validate; an unknown kind or computed prop does not", () => {
    const component = { kind: "component", file: "src/ui/button.tsx", export: "Button", props: { variant: "outline", disabled: true }, label: "Save", wrappers: [{ file: "src/ui/tabs.tsx", export: "Tabs", props: { defaultValue: "a" } }], tag: "button", classes: ["h-8"] };
    expect(InventoryLook.safeParse({ ...look, recipe: component }).success).toBe(true);
    expect(InventoryLook.safeParse({ ...look, recipe: { kind: "class", tag: "span", classes: ["ui-badge"], label: null } }).success).toBe(true);
    expect(InventoryLook.safeParse({ ...look, recipe: { ...component, kind: "astro" } }).success).toBe(false);
    expect(InventoryLook.safeParse({ ...look, recipe: { ...component, props: { onClick: { dynamic: "go" } } } }).success).toBe(false);
  });
});

describe("design repos", () => {
  test("loads the demo system with every contract and rule valid and cross-referenced", async () => {
    const repo = await loadDesignRepo(DEMO);
    const demo = repo.systems[0]!;
    expect(demo.config.id).toBe("demo");
    expect(demo.components.map((c) => c.contract.name)).toEqual(["Button", "Card", "Input"]);
    expect(demo.rules.filter((r) => r.check.engine === "youi")).toHaveLength(5);
    expect(demo.rules.filter((r) => r.check.engine === "advisory")).toHaveLength(1);
  });

  test("the tool's own repo holds no design system: it is not a design repo", async () => {
    await expect(loadDesignRepo(REPO)).rejects.toThrowError(/not a design repo/);
  });
});

describe("behaviour rules (slice 0: contracts)", () => {
  const behaviourRule = (check: Record<string, unknown>) => ({ schema: "youi.rule/v1", id: "youi:demo/rule/popup.escape", title: "Esc closes popups", severity: "error", statement: "Esc closes every popup.", agent: "Close popups on Esc.", check });

  test("a rule may declare one check from the closed behaviour list; options default to none", () => {
    const parsed = RuleSpec.parse(behaviourRule({ engine: "behaviour", id: "dismiss-escape" }));
    expect(parsed.check).toEqual({ engine: "behaviour", id: "dismiss-escape", options: {} });
    for (const id of BEHAVIOUR_CHECK_IDS) expect(RuleSpec.safeParse(behaviourRule({ engine: "behaviour", id })).success).toBe(true);
  });

  test("an unknown check id or an option no check reads is refused", () => {
    expect(RuleSpec.safeParse(behaviourRule({ engine: "behaviour", id: "typeahead" })).success).toBe(false);
    expect(RuleSpec.safeParse(behaviourRule({ engine: "behaviour", id: "dismiss-escape", options: { timeout: 5 } })).success).toBe(false);
    expect(RuleSpec.safeParse(behaviourRule({ engine: "behaviour" })).success).toBe(false);
  });

  test("every behaviour check is described after its APG pattern, with the patterns it applies to", () => {
    expect(Object.keys(BEHAVIOUR_CHECKS).sort()).toEqual([...BEHAVIOUR_CHECK_IDS].sort());
    for (const check of Object.values(BEHAVIOUR_CHECKS)) {
      expect(check.description).toMatch(/APG/);
      expect(check.patterns.length).toBeGreaterThan(0);
    }
    expect(BEHAVIOUR_CHECKS["focus-trap"].patterns).toEqual(["modal-dialog"]);
    expect(BEHAVIOUR_CHECKS["focus-into"].patterns).not.toContain("combobox-listbox");
    expect(BEHAVIOUR_CHECKS["dismiss-escape"].patterns).toEqual([...BEHAVIOUR_PATTERNS]);
  });

  test("a behaviour rule executes as a probe, never as enforced; off stays off", () => {
    const rule = RuleSpec.parse(behaviourRule({ engine: "behaviour", id: "focus-return" }));
    const execution = ruleExecution(rule);
    expect(execution).toEqual({ state: "probe", by: "behaviour:focus-return" });
    expect(executionLabel(execution)).toBe("Behaviour (focus-return): checked by a probe run in the running app, not by the code scan; incomplete until one has run");
    expect(ruleExecution({ ...rule, severity: "off" })).toEqual({ state: "off" });
  });

  test("a rule run can be incomplete, with a reason", () => {
    expect(RuleRun.parse({ rule: "youi:demo/rule/popup.escape", state: "incomplete", reason: BEHAVIOUR_NOT_RUN })).toMatchObject({ state: "incomplete" });
    expect(RuleRun.safeParse({ rule: "youi:demo/rule/popup.escape", state: "pending" }).success).toBe(false);
  });

  test("a contract binds its popup pattern and parts by data-part/data-slot or role, nothing else", () => {
    const withBinding = (behaviour: unknown) => ComponentContract.safeParse({ ...minimalContract, a11y: { behaviour } });
    const ok = withBinding({ pattern: "menu-button", trigger: { part: "trigger" }, popup: { role: "menu" }, returnFocusTo: { part: "menu_trigger-2" } });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.a11y.behaviour).toEqual({ pattern: "menu-button", trigger: { part: "trigger" }, popup: { role: "menu" }, returnFocusTo: { part: "menu_trigger-2" } });
    expect(ComponentContract.parse(minimalContract).a11y.behaviour).toBeUndefined();
    expect(withBinding({ pattern: "tabs" }).success).toBe(false);
    expect(withBinding({ pattern: "menu-button", trigger: { part: "button > .x" } }).success).toBe(false);
    expect(withBinding({ pattern: "menu-button", trigger: { part: "trigger", role: "button" } }).success).toBe(false);
    expect(withBinding({ pattern: "menu-button", trigger: { selector: "#open" } }).success).toBe(false);
    expect(withBinding({ pattern: "modal-dialog", popup: { role: "Dialog" } }).success).toBe(false);
    expect(withBinding({ pattern: "popover", extra: true }).success).toBe(false);
  });

  const result = {
    runId: "run-1",
    at: "2026-11-12T10:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    route: "/flows",
    rule: "youi:demo/rule/popup.escape",
    target: { route: "/flows", pattern: "menu-button", component: "Menu", accessibleName: "More", file: "src/flows.tsx", line: 12 },
    pattern: "menu-button",
    check: "dismiss-escape",
    state: "failed",
    why: "The menu was still open 1.5 s after Esc.",
    fix: "Close the menu when Esc is pressed while focus is inside it.",
    evidence: [".youi/behaviour/run-1/menu-before.png"],
    freshness: { rule: "a".repeat(64), tool: "0.1.29", origin: "http://localhost:5173", config: "b".repeat(12), app: "c".repeat(64) },
  };

  test("a behaviour result is the canonical record: one check, one target, a state and what to do", () => {
    expect(BehaviourResult.parse(result)).toMatchObject({ state: "failed", info: [], target: { accessibleName: "More" } });
    for (const state of ["passed", "failed", "not-applicable", "incomplete", "error"]) expect(BehaviourResult.safeParse({ ...result, state }).success).toBe(true);
  });

  test("a result refuses a made-up state, a missing fix, evidence outside .youi/, a target on another route and an unknown key", () => {
    expect(BehaviourResult.safeParse({ ...result, state: "clean" }).success).toBe(false);
    expect(BehaviourResult.safeParse({ ...result, fix: "" }).success).toBe(false);
    expect(BehaviourResult.safeParse({ ...result, target: { ...result.target, route: "/other" } }).success).toBe(false);
    expect(BehaviourResult.safeParse({ ...result, target: { ...result.target, pattern: "popover" } }).success).toBe(false);
    expect(BehaviourResult.safeParse({ ...result, check: "typeahead" }).success).toBe(false);
    expect(BehaviourResult.safeParse({ ...result, violations: [] }).success).toBe(false);
    const { freshness: _freshness, ...stale } = result;
    expect(BehaviourResult.safeParse(stale).success).toBe(false);
  });

  test("a route's run holds only its own results, says why when incomplete, and consent names one origin and nothing else", () => {
    const run = { schema: "youiyoux.behaviour/v1", route: "/flows", runId: "run-1", at: "2026-11-12T10:00:00Z", origin: "http://localhost:5173", viewport: { width: 1440, height: 900 }, state: "probed", why: null, fix: null, coverage: "1 popup trigger found.", results: [result] };
    expect(BehaviourRouteRun.safeParse(run).success).toBe(true);
    expect(BehaviourRouteRun.safeParse({ ...run, results: [{ ...result, runId: "run-2" }] }).success).toBe(false);
    expect(BehaviourRouteRun.safeParse({ ...run, route: "/other" }).success).toBe(false);
    expect(BehaviourRouteRun.safeParse({ ...run, state: "incomplete" }).success).toBe(false);
    expect(BehaviourRouteRun.safeParse({ ...run, state: "incomplete", why: "it needs a sign-in", fix: "Next: probe another screen.", results: [] }).success).toBe(true);
    expect(BehaviourRouteRun.safeParse({ ...run, why: "x", fix: "y" }).success).toBe(false);
    expect(BehaviourConsent.safeParse({ allowedOrigin: "http://localhost:5173" }).success).toBe(true);
    expect(BehaviourConsent.safeParse({ allowedOrigin: "http://localhost:5173", routes: [] }).success).toBe(false);
    expect(BehaviourConsent.safeParse(true).success).toBe(false);
  });

  /** The published JSON Schema, compiled by a real draft 2020-12 validator (formats aside: they are checked by Zod). */
  const published = (file: string) => {
    const schema = renderJsonSchemas().find((s) => s.file === file);
    if (!schema) throw new Error(`${file} is not published`);
    return new Ajv2020({ strict: false, validateFormats: false }).compile(JSON.parse(schema.content) as object);
  };

  const EVIDENCE: Array<[string, boolean]> = [
    [".youi/behaviour/run-1/menu-before.png", true],
    [".youi/shot.png", true],
    [".youi/behaviour/a_b-c.2.webp", true],
    ["behaviour/run-1/menu-before.png", false],
    ["/tmp/shot.png", false],
    ["../shot.png", false],
    [".youi/../secrets.png", false],
    [".youi/behaviour/../../x.png", false],
    [".youi/./x.png", false],
    [".youi//x.png", false],
    [".youi/", false],
    [".youi/.hidden", false],
    ["C:\\shots\\a.png", false],
    ["C:/shots/a.png", false],
    [".youi/C:/a.png", false],
    ["\\\\server\\share\\a.png", false],
    ["//server/share/a.png", false],
    [".youi\\behaviour\\a.png", false],
    ["\\.youi/a.png", false],
    ["", false],
  ];

  test.each(EVIDENCE)("evidence %j: Zod and the published JSON Schema agree (%s)", (path, ok) => {
    const candidate = { ...result, evidence: [path] };
    expect(BehaviourResult.safeParse(candidate).success).toBe(ok);
    expect(published("youi.behaviour-result.schema.json")(candidate)).toBe(ok);
  });

  test("the published behaviour-result schema accepts a result and refuses a made-up state or check, a missing fix and unknown keys", () => {
    const validate = published("youi.behaviour-result.schema.json");
    expect(validate(result)).toBe(true);
    for (const bad of [{ ...result, state: "clean" }, { ...result, check: "typeahead" }, { ...result, pattern: "tabs" }, { ...result, fix: "" }, { ...result, violations: [] }, { ...result, target: { ...result.target, selector: "#x" } }]) expect(validate(bad)).toBe(false);
  });

  test("the published rule schema takes a behaviour check from the closed list only, with no options", () => {
    const validate = published("youi.rule.schema.json");
    expect(validate(behaviourRule({ engine: "behaviour", id: "dismiss-escape" }))).toBe(true);
    expect(validate(behaviourRule({ engine: "behaviour", id: "typeahead" }))).toBe(false);
    expect(validate(behaviourRule({ engine: "behaviour", id: "dismiss-escape", options: { timeout: 5 } }))).toBe(false);
  });

  test("the published component schema takes a behaviour binding by part name or role only", () => {
    const validate = published("youi.component.schema.json");
    expect(validate({ ...minimalContract, a11y: { behaviour: { pattern: "menu-button", trigger: { part: "trigger" }, popup: { role: "menu" } } } })).toBe(true);
    expect(validate({ ...minimalContract, a11y: { behaviour: { pattern: "menu-button", trigger: { part: "button > .x" } } } })).toBe(false);
    expect(validate({ ...minimalContract, a11y: { behaviour: { pattern: "tabs" } } })).toBe(false);
  });
});
