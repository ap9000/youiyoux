import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getSystem, loadDesignRepo, type RuleSpec } from "@youiyoux/core";
import { expect, test } from "vitest";
import type { Catalog, Manifest } from "../../../apps/web/src/data/types.ts";

const ROOT = join(import.meta.dirname, "../../..");
const DATA = join(ROOT, "apps/web/snapshot/public/data");

function toolsByRule(rules: readonly RuleSpec[]): Record<string, string[]> {
  return Object.fromEntries(rules.map((rule) => [rule.id, [...new Set(JSON.stringify(rule).match(/\b(?:youi|system|library)_[a-z0-9_]+\b/g) ?? [])].sort()]));
}

test("the committed demo snapshot's tool names match the demo rules", async () => {
  // Read the committed files directly: regenerating here would hide a stale snapshot.
  const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
  const demo = manifest.systems.find((system) => system.id === "demo")!;
  const catalog = JSON.parse(readFileSync(join(DATA, demo.catalog), "utf8")) as Catalog;
  const source = getSystem(await loadDesignRepo(join(ROOT, "examples/demo-design")), "demo");
  const expected = toolsByRule(source.rules);

  expect(Object.values(expected).flat()).toEqual(expect.arrayContaining(["system_get_tokens", "system_get_component"]));
  expect(toolsByRule(catalog.rules)).toEqual(expected);
  expect(JSON.stringify(catalog)).not.toMatch(/\byoui_[a-z0-9_]+\b/);
  expect(readdirSync(DATA).filter((file) => file.startsWith("demo.catalog.")).sort()).toEqual([demo.catalog]);
});
