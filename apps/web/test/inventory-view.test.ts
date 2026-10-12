import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { InventoryReport as InventorySchema } from "@youiyoux/core";
import { buildInventory } from "../../../packages/scanner/src/inventory/inventory.ts";
import { memorySource, type InventorySource } from "../src/data/inventory-source.ts";
import {
  attributeRows,
  clipInset,
  compareSides,
  consolidation,
  familyViews,
  filterCounts,
  filterFamilies,
  filtersToSearch,
  kitCells,
  Libraries,
  neededChunks,
  NO_FILTERS,
  parseFilters,
  shouldDismiss,
  sideShape,
  sliderPercent,
  topFixes,
  uniqueNames,
  usageRows,
  withinStep,
  type FamilyView,
  type Filters,
} from "../src/data/inventory-view.ts";
import type { DetectReport, InventoryChunk, InventoryExtras, InventoryReport } from "../src/data/types.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(TOOL, "packages/scanner/test/fixtures/inventory");

let source: InventorySource;
let chunks: InventoryChunk[];
let extras: InventoryExtras;
let libraries: Libraries;
let views: FamilyView[];
beforeAll(async () => {
  const report: InventoryReport = InventorySchema.parse(await buildInventory([join(FIXTURES, "console"), join(FIXTURES, "site")], { cwd: TOOL }));
  source = memorySource(report);
  chunks = source.index.roles.flatMap((r) => Object.values(r.chunks)).map((file) => (source.get(file) as { value: InventoryChunk }).value);
  extras = (source.get(source.index.extras) as { value: InventoryExtras }).value;
  libraries = new Libraries(extras);
  views = familyViews(chunks, libraries);
});

const view = (id: string): FamilyView => views.find((v) => v.family.id === id)!;
const ids = (list: readonly FamilyView[]): string[] => list.map((v) => v.family.id);

describe("filters in the URL (c1)", () => {
  test("filters round-trip through the query string; defaults are left out and unknown values dropped", () => {
    const filters: Filters = { type: "button", lib: "css-ui", project: "site", near: true, q: "toolbar" };
    expect(filtersToSearch(filters)).toBe("?type=button&lib=css-ui&project=site&near=1&q=toolbar");
    expect(parseFilters(filtersToSearch(filters), source.index)).toEqual(filters);
    expect(filtersToSearch(NO_FILTERS)).toBe("");
    expect(parseFilters("?type=widget&project=nowhere&near=yes", source.index)).toEqual(NO_FILTERS);
  });

  test("a role or project filter needs only its own chunk files", () => {
    const all = neededChunks(source.index, NO_FILTERS);
    expect(all).toHaveLength(source.index.roles.reduce((n, r) => n + Object.keys(r.chunks).length, 0));
    expect(neededChunks(source.index, { type: "button", project: null })).toEqual(Object.values(source.index.roles.find((r) => r.role === "button")!.chunks));
    const siteButtons = neededChunks(source.index, { type: "button", project: "site" });
    expect(siteButtons).toEqual([source.index.roles.find((r) => r.role === "button")!.chunks.site]);
    expect(neededChunks(source.index, { type: null, project: "site" }).every((f) => f.startsWith("inventory.site."))).toBe(true);
  });
});

describe("library or kit (c1)", () => {
  test("no kit is plain elements; a cva() folder is shadcn-style; a stylesheet kit is a CSS kit by its prefix or file", () => {
    expect(libraries.primary(null)).toMatchObject({ id: "plain", label: "Plain elements" });
    expect(libraries.primary("console:src/components/ui")).toMatchObject({ id: "shadcn", label: "shadcn-style" });
    expect(libraries.primary("console:src/browser/ui.css")).toMatchObject({ id: "css-ui", label: ".ui-* CSS kit", short: "CSS kit" });
    expect(libraries.primary("site:src/styles/ui.css")).toMatchObject({ id: "css-ui" });
    expect(libraries.primary("console:src/styles/legacy.css")).toMatchObject({ id: "css-lg", label: ".lg-* CSS kit" });
    expect(libraries.primary("site:src/styles/marketing.css")).toMatchObject({ id: "css-marketing", label: "marketing.css CSS kit" });
  });

  test("a component built on a Radix primitive also counts as Radix; Slot alone does not", () => {
    const tabs = view("tabs-1");
    expect(tabs.libs.map((g) => g.id)).toEqual(expect.arrayContaining(["shadcn", "radix"]));
    const dialog = view("dialog-1");
    expect(dialog.libs.map((g) => g.id)).toContain("radix");
    // The console Button wraps only @radix-ui/react-slot.
    expect(libraries.of({ kit: "console:src/components/ui", tag: "Button" }, "console", "button").map((g) => g.id)).toEqual(["shadcn"]);
  });

  test("library names come from youi detect when it lists them", () => {
    const detect = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/detect.site.json"), "utf8")) as DetectReport;
    const named = new Libraries(extras, detect);
    expect(named.primary("console:src/components/ui").label).toBe(detect.libraries.find((l) => l.id === "shadcn")!.name);
    expect(named.radix().label).toBe(detect.libraries.find((l) => l.id === "radix")!.name);
  });
});

describe("families (c2)", () => {
  test("every family gets a plain name, unique across the page, ending in its kit", () => {
    const names = views.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(view("button-1").name).toBe("Button · 32px · radius 8 · shadcn-style");
    expect(view("button-4").name).toBe("Button · 28px · radius 4 · CSS kit");
    expect(view("badge-1").name).toMatch(/^Badge · 20px · pill · /);
    for (const name of names) expect(name).not.toMatch(/undefined|null/);
  });

  test("names that would match are told apart by the first detail that differs", () => {
    const shape = { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 };
    const kit = { id: "css-ui", label: ".ui-* CSS kit", short: "CSS kit" };
    const names = uniqueNames([
      { id: "a", family: { role: "button", shape, projects: ["x"] }, kit },
      { id: "b", family: { role: "button", shape: { ...shape, paddingX: 16 }, projects: ["x"] }, kit },
      { id: "c", family: { role: "button", shape, projects: ["y"] }, kit: { id: "css-lg", label: ".lg-* CSS kit", short: "CSS kit" } },
    ]);
    expect(new Set(names.values()).size).toBe(3);
    expect(names.get("b")).toBe("Button · 32px · radius 8 · CSS kit · padding 0/16");
  });

  test("uses and projects come from the family; its looks are the loaded chunks' looks", () => {
    const button = view("button-1");
    expect(button.uses).toBe(10);
    expect(button.projects).toBe(2);
    expect(button.looks).toHaveLength(10);
    expect(new Set(button.looks.map((l) => l.project))).toEqual(new Set(["console", "site"]));
  });

  test("each filter narrows the families, and filters combine", () => {
    expect(ids(filterFamilies(views, { ...NO_FILTERS, type: "badge" }))).toEqual(["badge-1", "badge-2"]);
    expect(filterFamilies(views, { ...NO_FILTERS, project: "site" }).every((v) => v.family.projects.includes("site"))).toBe(true);
    expect(ids(filterFamilies(views, { ...NO_FILTERS, lib: "css-lg" }))).toEqual(["button-4", "button-5", "badge-2"]);
    expect(filterFamilies(views, { ...NO_FILTERS, near: true }).every((v) => v.family.nearDuplicate)).toBe(true);
    // Search by name, and by file.
    expect(ids(filterFamilies(views, { ...NO_FILTERS, q: "pill" }))).toEqual(["badge-1"]);
    expect(ids(filterFamilies(views, { ...NO_FILTERS, q: "toolbar.tsx" }))).toEqual(["button-1", "input-1"]);
    const combined = filterFamilies(views, { ...NO_FILTERS, type: "button", near: true, project: "site" });
    expect(ids(combined)).toEqual(["button-1"]);
    expect(ids(filterFamilies(views, { ...NO_FILTERS, type: "button", lib: "css-lg", q: "36px" }))).toEqual(["button-5"]);
  });

  test("each option shows its count with the other filters on; options whose chunks are not loaded are still counting", () => {
    const all = () => true;
    const counts = filterCounts(source.index, views, NO_FILTERS, all, libraries);
    expect(counts.types.find((t) => t.value === "button")!.count).toBe(5);
    expect(counts.all.type).toBe(views.length);
    expect(counts.near).toBe(views.filter((v) => v.family.nearDuplicate).length);
    expect(counts.libs.find((l) => l.value === "css-lg")!.count).toBe(3);
    const near = filterCounts(source.index, views, { ...NO_FILTERS, near: true }, all, libraries);
    expect(near.types.find((t) => t.value === "button")!.count).toBe(1);
    expect(near.projects.find((p) => p.value === "site")!.count).toBe(views.filter((v) => v.family.nearDuplicate && v.family.projects.includes("site")).length);
    // Only the site's button chunk loaded: other roles cannot be counted under a library filter yet.
    const siteButton = source.index.roles.find((r) => r.role === "button")!.chunks.site!;
    const partial = filterCounts(source.index, views, { ...NO_FILTERS, type: "button", lib: "css-ui", project: "site" }, (f) => f === siteButton, libraries);
    expect(partial.types.find((t) => t.value === "badge")!.count).toBeNull();
    expect(partial.types.find((t) => t.value === "button")!.count).toBe(1);
  });

  test("a role's families sit in cells by library or kit, and no cell is empty", () => {
    const cells = kitCells(filterFamilies(views, { ...NO_FILTERS, type: "button" }));
    expect(cells.map((c) => c.group.id)).toEqual(["shadcn", "css-lg", "plain"]);
    expect(cells.every((c) => c.families.length > 0)).toBe(true);
    expect(kitCells(filterFamilies(views, { ...NO_FILTERS, type: "button", lib: "css-lg" })).map((c) => c.group.id)).toEqual(["css-lg"]);
  });
});

describe("consolidation and fixes (c2, c3)", () => {
  test("same-role families within one tolerance step fold; the estimate is never more than the families", () => {
    const t = source.index.tolerance;
    expect(withinStep({ height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 }, { height: 34, paddingX: 12, paddingY: 0, radius: 8, fontSize: null, fontWeight: 500 }, t)).toBe(true);
    expect(withinStep({ height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 }, { height: 28, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 }, t)).toBe(false);
    const result = consolidation(views, t);
    expect(result.families).toBe(views.length);
    expect(result.estimate).toBeLessThan(result.families);
    // The two tab lists (console's and the site's) differ only in a height one of them lacks.
    expect(result.folds).toContainEqual(expect.arrayContaining(["tabs-2", "tabs-3"]));
  });

  test("the top fixes are near-duplicates, most uses first", () => {
    const fixes = topFixes(views);
    expect(fixes).toHaveLength(3);
    expect(fixes.every((v) => v.family.nearDuplicate)).toBe(true);
    expect(fixes[0]!.family.id).toBe("button-1");
    expect(fixes.map((v) => v.uses)).toEqual([...fixes.map((v) => v.uses)].sort((a, b) => b - a));
  });

  test("a compare card pairs a near-duplicate's two biggest sides, with differing attributes marked", () => {
    const button = view("button-1");
    const [a, b] = compareSides(button.family)!;
    expect(a.looks).toBeGreaterThanOrEqual(b.looks);
    const rows = attributeRows({ shape: sideShape(a, button.looks, button.family.shape), uses: a.looks, projects: [a.project] }, { shape: { ...button.family.shape, height: 34 }, uses: b.looks, projects: [b.project] });
    expect(rows.map((r) => r.label)).toEqual(["Height", "Padding", "Radius", "Font size", "Weight", "Uses", "Projects"]);
    expect(rows.find((r) => r.label === "Height")).toMatchObject({ a: "32px", b: "34px", differs: true });
    expect(rows.find((r) => r.label === "Radius")!.differs).toBe(false);
    expect(compareSides(view("button-2").family)).toBeNull();
  });

  test("usage lists every look with project, repo-relative file:line and its routes", () => {
    const rows = usageRows(view("button-1"));
    expect(rows).toHaveLength(10);
    expect(rows.find((r) => r.project === "site" && r.place.startsWith("src/pages/docs.astro:"))!.routes).toContain("/docs");
    for (const row of rows) expect(row.place).toMatch(/^[^/].*:\d+$/);
  });
});

describe("slider and sheet (c3, c4)", () => {
  test("the slider follows the pointer within its box and clips the top layer from the left", () => {
    expect(sliderPercent(150, 100, 200)).toBe(25);
    expect(sliderPercent(0, 100, 200)).toBe(0);
    expect(sliderPercent(400, 100, 200)).toBe(100);
    expect(clipInset(25)).toBe("inset(0 0 0 25%)");
  });

  test("the bottom sheet closes past a third of its height or on a flick faster than 0.11 px/ms, and not otherwise", () => {
    expect(shouldDismiss({ distance: 200, height: 540, velocity: 0.05 })).toBe(true);
    expect(shouldDismiss({ distance: 60, height: 540, velocity: 0.12 })).toBe(true);
    expect(shouldDismiss({ distance: 60, height: 540, velocity: 0.11 })).toBe(false);
    expect(shouldDismiss({ distance: 150, height: 540, velocity: 0.05 })).toBe(false);
    expect(shouldDismiss({ distance: -80, height: 540, velocity: 0.5 })).toBe(false);
  });
});
