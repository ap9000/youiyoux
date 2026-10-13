// @vitest-environment jsdom
/** Storybook stories on the Inventory page: labeled authored states beside the uses, never counted as uses. */
import { join, resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { InventoryReport as InventorySchema } from "@youiyoux/core";
import { buildInventory } from "../../../packages/scanner/src/inventory/inventory.ts";
import { memorySource } from "../src/data/inventory-source.ts";
import { splitInventory, type SplitSpecimens } from "../src/data/inventory-split.ts";
import { familyViews, Libraries, storyRows, usageRows, usesLabel } from "../src/data/inventory-view.ts";
import type { InventoryChunk, InventoryReport } from "../src/data/types.ts";
import { familyTiles, leadTiles } from "../src/screens/inventory/family-tiles.ts";
import { InventoryView } from "../src/screens/inventory/InventoryScreen.tsx";

const TOOL = resolve(import.meta.dirname, "../../..");
const STORYBOOK = join(TOOL, "packages/scanner/test/fixtures/inventory/storybook");

let inventory: InventoryReport;
/** A specimen per distinct recipe, as the snapshot builds them (the real build is tested in the scanner): each label in a button. */
let specimens: Record<string, SplitSpecimens>;

beforeAll(async () => {
  inventory = InventorySchema.parse(await buildInventory([STORYBOOK], { cwd: TOOL }));
  const looks: Record<string, string> = {};
  const drawn: SplitSpecimens["specimens"] = {};
  for (const look of inventory.looks) {
    const id = `s-${JSON.stringify(look.recipe)}`.replace(/[^a-z0-9-]/gi, "-");
    looks[look.id] = id;
    drawn[id] = { kind: "component", html: `<button>${look.recipe?.label ?? "Badge"}</button>` };
  }
  specimens = { storybook: { css: { light: "button{}", dark: "button{}" }, specimens: drawn, looks, notes: [] } };
});
afterEach(cleanup);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const familyOf = (container: ParentNode, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-family="${id}"]`)!;

/** jsdom has no IntersectionObserver; tiles render their captions without one. */
class NoObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

describe("hub data: stories ride in the chunks, every count is of real uses (c1)", () => {
  test("chunk looks carry their story; role and project counts leave stories out; the headline count leaves out families only stories have", () => {
    const { index, files } = splitInventory(inventory, specimens, (stem, ext) => `${stem}.${ext}`);
    const button = index.roles.find((r) => r.role === "button")!;
    expect(button).toMatchObject({ looks: 3, unshaped: 0, families: 2, cells: { storybook: { families: 2, looks: 3 } } });
    expect(index.summary).toMatchObject({ looks: 4, families: 2, stories: 8 });
    const chunk = JSON.parse(files.find((f) => f.name === button.chunks.storybook)!.text) as InventoryChunk;
    const primary = chunk.looks.find((l) => l.story?.name === "Primary")!;
    expect(primary).toMatchObject({ file: "src/components/ui/button.stories.tsx", line: 22, family: "button-1", story: { title: "UI/Button", name: "Primary", id: "ui-button--primary" } });
    expect(primary.specimen).not.toBeNull();
    expect(chunk.looks.filter((l) => !l.story)).toHaveLength(3);
  });

  test("a family's tiles keep each story as its own labeled tile after the uses; a use leads the family on the wall", () => {
    const source = memorySource(inventory, specimens);
    const { files } = splitInventory(inventory, specimens, (stem, ext) => `${stem}.${ext}`);
    const chunks = files.filter((f) => /^inventory\.storybook\.\w+\.json$/.test(f.name)).map((f) => JSON.parse(f.text) as InventoryChunk);
    const views = familyViews(chunks, new Libraries(null));
    const family = views.find((v) => v.family.id === "button-1")!;
    const tiles = familyTiles(family.family, chunks, source, "light");
    expect(tiles.filter((t) => !t.story).map((t) => [t.place, t.count])).toEqual([
      ["src/app/page.tsx:9", 1],
      ["src/app/page.tsx:10", 1],
      ["src/app/page.tsx:11", 1],
    ]);
    expect(tiles.filter((t) => t.story).map((t) => t.story!.name)).toEqual(["Primary", "Outline", "Default", "High contrast", "System Theme"]);
    expect(tiles.findIndex((t) => t.story)).toBe(3);
    expect(leadTiles(tiles, family.family, "wall")[0]!.story).toBeUndefined();
    expect(usageRows(family).map((r) => r.place)).toEqual(["src/app/page.tsx:9", "src/app/page.tsx:10", "src/app/page.tsx:11"]);
    expect(storyRows(family).map((r) => `${r.story} ${r.place}`)).toEqual([
      "UI/Button / Primary src/components/ui/button.stories.tsx:22",
      "UI/Button / Outline src/components/ui/button.stories.tsx:26",
      "UI/Button / Default src/components/ui/button.stories.tsx:34",
      "UI/Button / High contrast src/components/ui/button.stories.tsx:36",
      "UI/Button / System Theme src/components/ui/button.stories.tsx:48",
    ]);
    expect(usesLabel(family)).toBe("3 uses · 1 project · 5 stories");
    expect(usesLabel(views.find((v) => v.family.id === "button-2")!)).toBe("Only in Storybook · 1 story");
  });
});

describe("Inventory page: stories beside the discovered states (c1)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/inventory");
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= NoObserver;
  });

  test("wall tiles count uses, projects and stories; a family only stories have says so; the headline counts real families", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory, specimens)} />);
    expect(text(screen.getByTestId("consolidation"))).toMatch(/^2 families → could be ~2$/);
    expect(text(familyOf(container, "button-1").querySelector("[data-uses]")!)).toBe("3 uses · 1 project · 5 stories");
    expect(text(familyOf(container, "badge-1").querySelector("[data-uses]")!)).toBe("1 use · 1 project · 2 stories");
    expect(text(familyOf(container, "button-2").querySelector("[data-uses]")!)).toBe("Only in Storybook · 1 story");
  });

  test("an opened family lists its uses, then its stories beneath; Variants shows each story as a tile labeled Storybook · title / name", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory, specimens)} />);
    fireEvent.click(within(familyOf(container, "button-1")).getByRole("button", { name: /^Open / }));
    const drawer = screen.getByRole("dialog", { name: "3 uses across 1 project · 5 stories" });
    expect(within(drawer).getByRole("list", { name: "Every use" }).children).toHaveLength(3);
    const stories = [...within(drawer).getByRole("list", { name: "Storybook stories" }).children].map(text);
    expect(stories[0]).toBe("UI/Button / Primarysrc/components/ui/button.stories.tsx:22");
    expect(stories).toHaveLength(5);
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: /Variants/ }));
    const tiles = [...within(drawer).getByRole("list", { name: "Specimens" }).querySelectorAll<HTMLElement>("[data-tile]")];
    expect(tiles.filter((t) => !t.dataset.story).map((t) => text(t.querySelector("p")!))).toEqual(["storybooksrc/app/page.tsx:9", "storybooksrc/app/page.tsx:10", "storybooksrc/app/page.tsx:11"]);
    const labeled = tiles.filter((t) => t.dataset.story).map((t) => t.querySelector("p")!.getAttribute("aria-label"));
    expect(labeled).toEqual(["Storybook · UI/Button / Primary", "Storybook · UI/Button / Outline", "Storybook · UI/Button / Default", "Storybook · UI/Button / High contrast", "Storybook · UI/Button / System Theme"]);
    expect(text(tiles.find((t) => t.dataset.story === "ui-button--primary")!.querySelector("p")!)).toBe("Storybook·UI/Button / Primary");
  });

  test("a family only stories have opens with no uses, says why, and draws its story", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory, specimens)} />);
    fireEvent.click(within(familyOf(container, "button-2")).getByRole("button", { name: /^Open / }));
    const drawer = screen.getByRole("dialog", { name: "Only in Storybook: 1 story" });
    expect(text(drawer)).toContain("No project renders this shape: only its Storybook stories do.");
    expect(within(drawer).getByRole("list", { name: "Every use" }).children).toHaveLength(0);
    expect([...within(drawer).getByRole("list", { name: "Storybook stories" }).children].map(text)).toEqual(["UI/Button / Largesrc/components/ui/button.stories.tsx:30"]);
  });
});
