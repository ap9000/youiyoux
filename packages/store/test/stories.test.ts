/** Storybook stories in an inventory are authored states, never uses: the graph and counts ignore them. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { InventoryReport } from "@youiyoux/core";
import { inventoryRun, openSqlite } from "../src/index.ts";
import { inventory } from "./fixtures.ts";

const SOURCE = "/work/.youi/inventory.json";
const STORIES = "src/components/ui/button.stories.tsx";

/** The fixture inventory plus two stories: one beside button-1, one in a family only stories have. */
function withStories(): InventoryReport {
  const base = inventory("2026-10-13T09:00:00.000Z");
  const first = base.looks[0]!;
  const story = (line: number, family: string, name: string) => ({ ...first, id: `console:${STORIES}:${line}:14`, file: STORIES, line, routes: [], routeSource: "unrouted" as const, family, story: { title: "UI/Button", name, id: `ui-button--${name.toLowerCase()}` } });
  const authored = { ...base.families[0]!, id: "button-3", looks: 0, sides: [], stories: 1, authored: true, examples: [] };
  return InventoryReport.parse({
    ...base,
    looks: [...base.looks, story(20, "button-1", "Primary"), story(30, "button-3", "Large")],
    families: [{ ...base.families[0]!, stories: 1 }, ...base.families.slice(1), authored],
    summary: { ...base.summary, stories: 2 },
  });
}

test("story looks add no used-in edges, rows or counts; where_used and swap_impact count real uses only", async () => {
  const plain = inventoryRun(inventory("2026-10-13T09:00:00.000Z"), SOURCE);
  const run = inventoryRun(withStories(), SOURCE);
  expect(run.graph.nodes.some((n) => n.ref.includes(STORIES))).toBe(false);
  expect(run.graph.edges).toEqual(plain.graph.edges);
  expect(run.looks.map((l) => l.id)).toEqual(plain.looks.map((l) => l.id));
  expect(run.projects.map((p) => [p.project, p.looks, p.roles])).toEqual(plain.projects.map((p) => [p.project, p.looks, p.roles]));
  // The family only stories have is listed, with no uses.
  expect(run.families.find((f) => f.id === "button-3")).toMatchObject({ looks: 0, nearDuplicate: false });

  const dir = await mkdtemp(join(tmpdir(), "youi-store-stories-"));
  try {
    const store = await openSqlite(join(dir, "index.db"));
    await store.recordInventory(run);
    const where = await store.whereUsed("button-1");
    if (!where || "choices" in where) throw new Error("Expected unique family");
    expect(where.looks).toBe(2);
    expect(where.files).toEqual(["console:src/app/page.tsx", "console:src/app/settings/page.tsx"]);
    const swap = await store.swapImpact("lib:shadcn/component/button", "button-1");
    if (!swap || "choices" in swap) throw new Error("Expected unique family");
    expect(swap.looks).toBe(2);
    expect(swap.files).not.toContain(`console:${STORIES}`);
    expect(await store.whereUsed("button-3")).toMatchObject({ looks: 0, files: [], routes: [] });
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
