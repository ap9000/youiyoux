/**
 * The store at size (bench/library.ts): 100,000 Library items and 5,000 looks on SQLite and on
 * Postgres (PGlite). Slow (about a minute), so it runs only with YOUI_PERF=1.
 */
import { describe, expect, test } from "vitest";
import { BUDGET_MS, measure } from "../bench/library.ts";

describe.skipIf(!process.env.YOUI_PERF)("store at size (YOUI_PERF=1)", () => {
  test("100,000 Library items: a Discover search on SQLite is under 50 ms at p95; PGlite is measured too", async () => {
    const results = await measure({ items: 100_000, looks: 5_000, runs: 5, engines: ["sqlite", "pglite"] });
    for (const r of results) console.log(`${r.engine}: ${r.items} items, ${r.looks} looks; search p50 ${r.search.p50} ms, p95 ${r.search.p95} ms, max ${r.search.max} ms; where_used ${r.graph.whereUsedMs} ms, swap_impact ${r.graph.swapImpactMs} ms`);
    const [sqlite, pglite] = results;
    expect(sqlite).toMatchObject({ engine: "sqlite", items: 100_000, looks: 5_000 });
    expect(Object.values(sqlite!.matched).every((n) => n > 0)).toBe(true);
    expect(sqlite!.search.p95).toBeLessThan(BUDGET_MS);
    expect(pglite).toMatchObject({ engine: "postgres (PGlite)", items: 100_000, looks: 5_000, search: { runs: 100 } });
  }, 900_000);
});
