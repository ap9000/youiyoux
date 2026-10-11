import { describe, expect, test } from "vitest";
import type { CatalogRule } from "../src/data/types.ts";
import { checkLabel, executionOf } from "../src/screens/element/RulesTab.tsx";

const rule = (fields: Partial<CatalogRule>): CatalogRule => ({
  schema: "youi.rule/v1",
  id: "youi:demo/rule/test.probe",
  title: "Probe",
  severity: "error",
  statement: "Probe rule",
  rationale: "",
  agent: "Do not",
  check: { engine: "youi", id: "raw-color", options: {} },
  files: ["**/*.tsx"],
  examples: { bad: [], good: [] },
  ...fields,
});

describe("rule execution in the hub", () => {
  test("the snapshot's compiled answer wins", () => {
    const broken = rule({ check: { engine: "ast-grep", language: "tsx", rule: { kind: "nope" } }, execution: { state: "unsupported", reason: "does not compile" } });
    expect(executionOf(broken)).toEqual({ state: "unsupported", reason: "does not compile" });
    expect(checkLabel(broken)).toBe("Not checked: does not compile");
  });

  test("without it, an ast-grep rule is unverified, never enforced", () => {
    expect(executionOf(rule({ check: { engine: "ast-grep", language: "tsx", rule: { kind: "jsx_opening_element" } } })).state).toBe("unsupported");
  });

  test("built-in, advisory and off rules read the same model as the CLI", () => {
    expect(checkLabel(rule({}))).toBe("Checked by youi check (raw-color)");
    expect(executionOf(rule({ check: { engine: "advisory" } })).state).toBe("advisory");
    expect(executionOf(rule({ severity: "off" })).state).toBe("off");
  });
});
