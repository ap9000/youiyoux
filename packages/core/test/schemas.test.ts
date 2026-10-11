import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ComponentContract, DefinitionError, formatId, loadDesignRepo, matchesQuery, parseDefinition, parseId, ProjectConfig, renderJsonSchemas, RuleSpec } from "../src/index.ts";

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

  test("every published schema is emitted as JSON Schema 2020-12 and matches the committed copy", async () => {
    const rendered = renderJsonSchemas();
    expect(rendered.map((s) => s.file)).toHaveLength(7);
    for (const { file, content } of rendered) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(await readFile(join(REPO, "schema", file), "utf8")).toBe(content);
    }
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
