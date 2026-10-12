import { join, resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { InventoryReport as InventorySchema } from "@youiyoux/core";
import { buildInventory, familiesOf } from "../../../packages/scanner/src/inventory/inventory.ts";
import { synthesizeInventory } from "../scripts/synthetic-inventory.ts";
import { splitInventory } from "../src/data/inventory-split.ts";
import type { InventoryReport } from "../src/data/types.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(TOOL, "packages/scanner/test/fixtures/inventory");

let base: InventoryReport;
beforeAll(async () => {
  base = InventorySchema.parse(await buildInventory([join(FIXTURES, "console"), join(FIXTURES, "site")], { cwd: TOOL }));
});

const split = (report: InventoryReport) => splitInventory(report, {}, (stem, ext, text) => `${stem}.${text.length}.${ext}`);

describe("first paint does not grow with the library (c3)", () => {
  test("synthetic inventories of 50 and 5,000 looks are valid youi.inventory/v1 files with many more families", () => {
    const small = InventorySchema.parse(synthesizeInventory(base, 50, familiesOf));
    const large = InventorySchema.parse(synthesizeInventory(base, 5000, familiesOf));
    expect([small.looks.length, large.looks.length]).toEqual([50, 5000]);
    expect(large.families.length).toBeGreaterThan(small.families.length * 2);
    expect(new Set(large.looks.map((l) => l.id)).size).toBe(5000);
  });

  test("the index the page paints from is the same size at 50 and at 5,000 looks; the looks are all in chunks", () => {
    const small = split(synthesizeInventory(base, 50, familiesOf));
    const large = split(synthesizeInventory(base, 5000, familiesOf));
    const smallIndex = JSON.stringify(small.index).length;
    const largeIndex = JSON.stringify(large.index).length;
    // Only counts change (a few more digits); no list in the index grows with the looks.
    expect(largeIndex).toBeLessThan(smallIndex + 200);
    expect(largeIndex).toBeLessThan(8_000);
    expect(large.index.summary.looks).toBe(5000);
    expect(large.files.length).toBe(small.files.length);
    const chunkLooks = large.files.filter((f) => /^inventory\.[a-z]+\.[a-z-]+\./.test(f.name)).reduce((n, f) => n + (JSON.parse(f.text) as { looks: unknown[] }).looks.length, 0);
    expect(chunkLooks).toBe(5000);
  });
});
