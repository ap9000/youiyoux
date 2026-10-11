import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildModel } from "../src/data/model.ts";
import type { Catalog, Manifest } from "../src/data/types.ts";
import { toSearchDocs } from "../src/search/docs.ts";
import { createIndex, searchIndex } from "../src/search/engine.ts";

const DATA = join(import.meta.dirname, "../public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const model = buildModel(catalog, manifest);
const docs = toSearchDocs(model);
const index = createIndex(docs);
const SEARCH_BUDGET_MS = 50;

describe("search on the Signal snapshot", () => {
  test("indexes every element once", () => {
    expect(docs).toHaveLength(model.elements.length);
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
  });

  test("ranks the named element first, by prefix and through a typo", () => {
    expect(searchIndex(index, "button")[0]).toBe("youi:signal/component/button");
    expect(searchIndex(index, "butt")[0]).toBe("youi:signal/component/button");
    expect(searchIndex(index, "buton")[0]).toBe("youi:signal/component/button");
  });

  test("finds tokens by value and components by their props", () => {
    expect(searchIndex(index, "c4320a")).toContain("youi:signal/token/color.danger");
    expect(searchIndex(index, "destructive")).toContain("youi:signal/component/button");
  });

  test("combines terms with AND", () => {
    const both = searchIndex(index, "attention soft");
    expect(both).toContain("youi:signal/token/color.attention-soft");
    expect(both).not.toContain("youi:signal/component/switch");
  });

  test("returns nothing for gibberish", () => {
    expect(searchIndex(index, "zzqxv")).toEqual([]);
  });

  test("answers well inside the 50 ms budget", () => {
    const queries = ["button", "ink", "radius", "attention", "no raw", "c4", "typography body", "danger soft"];
    const times = queries.flatMap((q) =>
      Array.from({ length: 25 }, () => {
        const started = performance.now();
        searchIndex(index, q);
        return performance.now() - started;
      }),
    );
    const p95 = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)]!;
    expect(p95).toBeLessThan(SEARCH_BUDGET_MS);
  });
});
