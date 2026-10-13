// @vitest-environment jsdom
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InventoryReport as InventorySchema } from "@youiyoux/core";
import { buildInventory } from "../../../packages/scanner/src/inventory/inventory.ts";
import { familyName, shapeChips, uniqueExamples } from "../src/data/inventory.ts";
import { createSource, memorySource, type InventorySource } from "../src/data/inventory-source.ts";
import type { InventoryChunk, InventoryFamily, InventoryIndex, InventoryReport, Manifest } from "../src/data/types.ts";
import { InventoryView } from "../src/screens/inventory/InventoryScreen.tsx";
import { StrictMode } from "react";
import { DESK_WIDTH, disabledHtml, FrameBudget, FrameQueue, frameDocument, LeadTile, MAX_MOUNTED, MAX_RENDERING, stateStripDocument, STATES, TileGrid, VIRTUALISE_AT } from "../src/screens/inventory/Specimens.tsx";
import { leadTiles } from "../src/screens/inventory/family-tiles.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(TOOL, "packages/scanner/test/fixtures/inventory");

let inventory: InventoryReport;
beforeAll(async () => {
  inventory = InventorySchema.parse(await buildInventory([join(FIXTURES, "console"), join(FIXTURES, "site")], { cwd: TOOL }));
});
afterEach(cleanup);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();

const familyOf = (container: ParentNode, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-family="${id}"]`)!;
const wallIds = (container: ParentNode): string[] => [...container.querySelectorAll<HTMLElement>("[data-family]")].map((t) => t.dataset.family!);

describe("Inventory page: headline and wall (c2)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/inventory"));

  test("the headline counts the families and what they could be, the top three fixes, and how grouping works", () => {
    const source = memorySource(inventory);
    render(<InventoryView inventory={source} />);
    const headline = screen.getByTestId("inventory-headline");
    expect(text(screen.getByTestId("consolidation"))).toMatch(new RegExp(`^${inventory.families.length} families → could be ~\\d+$`));
    const estimate = Number(/~(\d+)/.exec(text(screen.getByTestId("consolidation")))![1]);
    expect(estimate).toBeLessThan(inventory.families.length);
    const fixes = within(screen.getByTestId("top-fixes")).getAllByRole("listitem");
    expect(fixes).toHaveLength(3);
    expect(text(fixes[0]!)).toContain("Button · 32px · radius 8");
    expect(within(fixes[0]!).getByRole("link", { name: "Compare" }).getAttribute("href")).toBe("#compare-button-1");
    expect(within(fixes[0]!).getByRole("link", { name: "Fix" }).getAttribute("href")).toBe("#fix-button-1");
    const details = headline.querySelector("details")!;
    expect(text(details.querySelector("summary")!)).toBe("How grouping works");
    expect(text(details)).toContain("height ±2px, padding ±2px, radius ±2px, font size ±1px and weight ±100");
    // The wall comes after the headline.
    expect(headline.compareDocumentPosition(familyOf(document, "button-1")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("one row per role; each family is a tile with its specimen, a unique plain name, uses and projects, and Open", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    expect([...container.querySelectorAll<HTMLElement>("[data-role]")].map((r) => r.dataset.role)).toEqual(["button", "link-as-button", "input", "card", "badge", "dialog", "tabs"]);
    expect(wallIds(container).sort()).toEqual(inventory.families.map((f) => f.id).sort());
    const names = inventory.families.map((f) => text(familyOf(container, f.id).querySelector("h3")!));
    expect(new Set(names).size).toBe(names.length);
    for (const family of inventory.families) {
      const tile = familyOf(container, family.id);
      expect(tile.closest("[data-role]")!.getAttribute("data-role")).toBe(family.role);
      expect(tile.querySelector("[data-tile]")).not.toBeNull();
      expect(text(tile)).toContain(`${family.looks} ${family.looks === 1 ? "use" : "uses"} · ${family.projects.length} ${family.projects.length === 1 ? "project" : "projects"}`);
      expect(within(tile).getByRole("button", { name: /^Open / }).textContent).toBe("Open");
    }
    expect(text(familyOf(container, "button-1").querySelector("h3")!)).toBe("Button · 32px · radius 8 · shadcn-style");
    expect(text(familyOf(container, "button-4").querySelector("h3")!)).toBe("Button · 28px · radius 4 · CSS kit");
    // Families sit in cells by library or kit; no cell is empty.
    const buttons = container.querySelector('[data-role="button"]')!;
    expect([...buttons.querySelectorAll<HTMLElement>("[data-kit-cell]")].map((c) => c.dataset.kitCell)).toEqual(["shadcn", "css-lg", "plain"]);
    for (const cell of container.querySelectorAll("[data-kit-cell]")) expect(cell.querySelectorAll("[data-family]").length).toBeGreaterThan(0);
    // Two columns on a phone.
    expect(buttons.querySelector("ul")!.className).toContain("max-md:grid-cols-2");
  });

  test("flags, kits and the not-clustered note stay below the wall", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    expect(text(container)).toContain("Badge is defined 3 times");
    expect(text(container)).toContain("console:src/app/settings/page.tsx imports 2 kits’ button in 2 imports");
    expect(text(container)).toContain("LegacyButton, LegacyIconButton from src/styles/legacy.css · line 2");
    expect(text(container)).toMatch(/\d+ breakpoint and state classes recorded, not clustered/);
    const kits = screen.getByRole("heading", { name: "Kits and primitives" });
    expect(familyOf(container, "tabs-1").compareDocumentPosition(kits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("role-grid")).toBeNull();
  });

  test("with no inventory the page says how to make one", () => {
    render(<InventoryView inventory={null} />);
    expect(screen.getByRole("heading", { name: "No inventory yet" })).toBeTruthy();
    expect(text(document.body)).toContain("youi ui --inventory");
  });
});

describe("Inventory page: filters (c1)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/inventory"));

  const bar = (): HTMLElement => screen.getByTestId("filter-bar");
  const option = (group: string, name: RegExp): HTMLElement => within(within(bar()).getByRole("radiogroup", { name: group })).getByRole("radio", { name });

  test("type, library, project, near-duplicates and search each narrow the wall, and are written to the URL", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    fireEvent.click(option("Type", /^Badges/));
    expect(window.location.search).toBe("?type=badge");
    expect(wallIds(container).sort()).toEqual(["badge-1", "badge-2"]);
    fireEvent.click(option("Type", /^All/));
    fireEvent.click(option("Library", /^\.lg-\* CSS kit/));
    expect(window.location.search).toBe("?lib=css-lg");
    expect(wallIds(container).sort()).toEqual(["badge-2", "button-4", "button-5"]);
    fireEvent.click(option("Library", /^All/));
    fireEvent.click(option("Project", /^site/));
    expect(window.location.search).toBe("?project=site");
    expect(wallIds(container).every((id) => inventory.families.find((f) => f.id === id)!.projects.includes("site"))).toBe(true);
    fireEvent.click(option("Project", /^All/));
    fireEvent.click(within(bar()).getByRole("button", { name: /Near-duplicates only/ }));
    expect(window.location.search).toBe("?near=1");
    expect(wallIds(container).sort()).toEqual(inventory.families.filter((f) => f.nearDuplicate).map((f) => f.id).sort());
    fireEvent.click(within(bar()).getByRole("button", { name: /Near-duplicates only/ }));
    fireEvent.change(within(bar()).getByRole("searchbox", { name: "Search by name or file" }), { target: { value: "settings/page" } });
    expect(window.location.search).toBe("?q=settings%2Fpage");
    const inSettings = new Set(inventory.looks.filter((l) => l.family && l.file.includes("settings/page")).map((l) => l.family!));
    expect(inSettings.size).toBeGreaterThan(1);
    expect(wallIds(container).sort()).toEqual([...inSettings].sort());
    fireEvent.change(within(bar()).getByRole("searchbox", { name: "Search by name or file" }), { target: { value: "pill" } });
    expect(wallIds(container)).toEqual(["badge-1"]);
  });

  test("filters combine, restore from the URL on load, and Clear filters empties it", () => {
    window.history.replaceState(null, "", "/inventory?type=button&project=site&near=1");
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    expect(wallIds(container)).toEqual(["button-1"]);
    expect(option("Type", /^Buttons/).getAttribute("aria-checked")).toBe("true");
    expect(within(bar()).getByRole("button", { name: /Near-duplicates only/ }).getAttribute("aria-pressed")).toBe("true");
    // Empty kit cells are hidden: only the family's own cell is left.
    expect([...container.querySelectorAll<HTMLElement>("[data-kit-cell]")].map((c) => c.dataset.kitCell)).toHaveLength(1);
    // Other roles' rows are gone.
    expect([...container.querySelectorAll<HTMLElement>("[data-role]")].map((r) => r.dataset.role)).toEqual(["button"]);
    fireEvent.click(within(bar()).getByRole("button", { name: "Clear filters" }));
    expect(window.location.search).toBe("");
    expect(wallIds(container)).toHaveLength(inventory.families.length);
  });

  test("each option shows how many families it would show with the other filters on", () => {
    window.history.replaceState(null, "", "/inventory?near=1");
    render(<InventoryView inventory={memorySource(inventory)} />);
    const near = inventory.families.filter((f) => f.nearDuplicate);
    expect(text(option("Type", /^Buttons/))).toBe(`Buttons${near.filter((f) => f.role === "button").length}`);
    expect(text(option("Type", /^All/))).toBe(`All${near.length}`);
    expect(text(option("Project", /^site/))).toBe(`site${near.filter((f) => f.projects.includes("site")).length}`);
    expect(text(within(bar()).getByRole("button", { name: /Near-duplicates only/ }))).toBe(`Near-duplicates only${near.length}`);
    expect(text(bar())).toContain(`${near.length} of ${inventory.families.length} families`);
  });

  test("a role or project filter fetches only its own chunk files; the others are never requested", async () => {
    const preloaded = snapshotSource();
    const files = new Map<string, unknown>();
    for (const file of [preloaded.index.extras, ...preloaded.index.roles.flatMap((r) => Object.values(r.chunks))]) files.set(file, (preloaded.get(file) as { value: unknown }).value);
    const fetchPart = vi.fn((file: string) => Promise.resolve(files.get(file) as InventoryChunk));
    const source = createSource(preloaded.index, fetchPart, (file) => `http://hub.test/data/${file}`);
    window.history.replaceState(null, "", "/inventory?type=button&project=site");
    const { container } = render(<InventoryView inventory={source} />);
    await waitFor(() => expect(wallIds(container)).toEqual(["button-1"]));
    const siteButton = preloaded.index.roles.find((r) => r.role === "button")!.chunks.site!;
    expect(fetchPart.mock.calls.map(([file]) => file).sort()).toEqual([preloaded.index.extras, siteButton].sort());
    // Widening to every project fetches the console's button chunk, and still no other role.
    fireEvent.click(option("Project", /^All/));
    await waitFor(() => expect(wallIds(container)).toHaveLength(5));
    expect(fetchPart.mock.calls.map(([file]) => file).filter((f) => f !== preloaded.index.extras).sort()).toEqual(Object.values(preloaded.index.roles.find((r) => r.role === "button")!.chunks).sort());
  });

  test("on a phone the filters sit in a bottom sheet behind a Filters button", () => {
    render(<InventoryView inventory={memorySource(inventory)} />);
    expect(bar().className).toContain("max-md:hidden");
    const phone = screen.getByTestId("filter-phone");
    expect(phone.className).toContain("md:hidden");
    fireEvent.click(within(phone).getByRole("button", { name: /Filters/ }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    expect(sheet.dataset.variant).toBe("sheet");
    fireEvent.click(within(within(sheet).getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Tabs/ }));
    expect(window.location.search).toBe("?type=tabs");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Show 3 families$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The button counts the filters on.
    expect(text(within(phone).getByRole("button", { name: /Filters/ }))).toBe("Filters1");
  });
});

describe("Inventory page: compare and fix (c3)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/inventory"));

  test("each near-duplicate has a compare card: both specimens stacked, a slider that moves the clip, and an attribute table", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    const cards = [...container.querySelectorAll<HTMLElement>("[data-compare]")].map((c) => c.dataset.compare);
    expect(cards.sort()).toEqual(inventory.families.filter((f) => f.nearDuplicate).map((f) => f.id).sort());
    const card = container.querySelector<HTMLElement>('[data-compare="button-1"]')!;
    const stage = within(card).getByTestId("compare-stage");
    expect(stage.querySelector('[data-layer="bottom"] [data-tile]')).not.toBeNull();
    const top = stage.querySelector<HTMLElement>('[data-layer="top"]')!;
    expect(top.querySelector("[data-tile]")).not.toBeNull();
    expect(top.style.clipPath).toBe("inset(0 0 0 50%)");
    const slider = within(card).getByRole("slider");
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).toBe("55");
    expect(top.style.clipPath).toBe("inset(0 0 0 55%)");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(top.style.clipPath).toBe("inset(0 0 0 0%)");
    // Dragging: the handle follows the pointer across the stage.
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ left: 100, width: 400, top: 0, height: 136, right: 500, bottom: 136, x: 100, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { clientX: 400, pointerId: 1, button: 0 });
    expect(top.style.clipPath).toBe("inset(0 0 0 75%)");
    fireEvent.pointerMove(stage, { clientX: 200, pointerId: 1 });
    expect(slider.getAttribute("aria-valuenow")).toBe("25");
    fireEvent.pointerUp(stage, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 450, pointerId: 1 });
    expect(slider.getAttribute("aria-valuenow")).toBe("25");
    // The attribute table, differing rows marked.
    const table = within(card).getByRole("table", { name: "Attributes" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => text(r.querySelector("th")!).replace(" (differs)", ""))).toEqual(["Height", "Padding", "Radius", "Font size", "Weight", "Uses", "Projects"]);
    expect(rows.find((r) => text(r).startsWith("Uses"))!.hasAttribute("data-differs")).toBe(true);
    expect(rows.find((r) => text(r).startsWith("Radius"))!.hasAttribute("data-differs")).toBe(false);
    // Overlay / Side by side.
    fireEvent.click(within(within(card).getByRole("radiogroup", { name: "Compare as" })).getByRole("radio", { name: "Side by side" }));
    expect(within(card).queryByTestId("compare-stage")).toBeNull();
    expect(within(card).getByTestId("compare-side-by-side").querySelectorAll("[data-tile]")).toHaveLength(2);
  });

  test("the fix list has a card per near-duplicate with every side's specimen, its files, and Merge turned off", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    const fix = container.querySelector<HTMLElement>('[data-fix="button-1"]')!;
    expect(fix.id).toBe("fix-button-1");
    expect(within(fix).getByRole("list", { name: "Ways it is built" }).querySelectorAll("[data-tile]")).toHaveLength(inventory.families.find((f) => f.id === "button-1")!.sides.length);
    expect(text(fix)).toContain("console:src/app/page.tsx");
    expect(text(fix)).toContain("site:src/pages/docs.astro");
    const merge = within(fix).getByRole("button", { name: "Merge into one" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(document.getElementById(merge.getAttribute("aria-describedby")!)!.textContent).toContain("never changes them");
  });
});

describe("Inventory page: a family opened (c4)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/inventory"));
  afterEach(() => vi.unstubAllGlobals());

  test("Open shows a drawer headed with its uses and projects; Usage lists every use; Variants and Code are tabs; Escape closes it", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    fireEvent.click(within(familyOf(container, "button-1")).getByRole("button", { name: /^Open / }));
    const drawer = screen.getByRole("dialog", { name: "10 uses across 2 projects" });
    expect(drawer.dataset.variant).toBe("drawer");
    expect(text(drawer)).toContain("Button · 32px · radius 8 · shadcn-style");
    const uses = within(drawer).getByRole("list", { name: "Every use" }).children;
    expect(uses).toHaveLength(10);
    const looks = inventory.looks.filter((l) => l.family === "button-1");
    for (const look of looks) expect([...uses].some((u) => text(u).startsWith(`${look.project}${look.file}:${look.line}`))).toBe(true);
    expect([...uses].find((u) => text(u).startsWith("sitesrc/pages/docs.astro"))!.textContent).toContain("/docs");
    expect(within(drawer).getByRole("tab", { name: /Variants/ })).toBeTruthy();
    expect(within(drawer).getByRole("tab", { name: /Code/ })).toBeTruthy();
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("closing the drawer gives focus back to the Open button that opened it", async () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    const open = within(familyOf(container, "button-1")).getByRole("button", { name: /^Open / });
    open.focus();
    fireEvent.click(open);
    const drawer = screen.getByRole("dialog", { name: "10 uses across 2 projects" });
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  test("clicking anywhere on a tile opens it too", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    fireEvent.click(familyOf(container, "badge-2").querySelector("h3")!);
    expect(screen.getByRole("dialog", { name: "1 use across 1 project" })).toBeTruthy();
  });

  test("on a phone it is a bottom sheet that a downward drag dismisses", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: !query.includes("min-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    fireEvent.click(within(familyOf(container, "badge-1")).getByRole("button", { name: /^Open / }));
    const sheet = screen.getByRole("dialog", { name: /uses across/ });
    expect(sheet.dataset.variant).toBe("sheet");
    const handle = within(sheet).getByTestId("sheet-handle");
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 7, button: 0 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 7 });
    expect(sheet.style.transform).toBe("translate3d(0, 300px, 0)");
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 7 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Inventory page: motion (c5)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/inventory"));

  test("wall tiles stagger on first load only; after a filter or role change none animate", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    const tiles = [...container.querySelectorAll<HTMLElement>("[data-family]")];
    expect(tiles.every((t) => t.classList.contains("inv-enter"))).toBe(true);
    expect(tiles.map((t) => Number(t.dataset.stagger))).toEqual(tiles.map((_, i) => i));
    expect(tiles[3]!.style.getPropertyValue("--inv-i")).toBe("3");
    const bar = screen.getByTestId("filter-bar");
    // A role change from the keyboard: arrow keys move the type choice.
    const all = within(within(bar).getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^All/ });
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(window.location.search).toBe("?type=button");
    expect(container.querySelectorAll(".inv-enter, [data-stagger]")).toHaveLength(0);
    fireEvent.click(within(within(bar).getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^All/ }));
    expect(container.querySelectorAll("[data-family]").length).toBe(inventory.families.length);
    expect(container.querySelectorAll(".inv-enter, [data-stagger]")).toHaveLength(0);
  });

  test("tiles and buttons press to 0.97; motion names only transform and opacity, with the brief's timings, and hover only for a fine pointer", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    const tile = familyOf(container, "button-1");
    expect(tile.classList.contains("inv-press")).toBe(true);
    expect(within(tile).getByRole("button", { name: /^Open / }).classList.contains("inv-press")).toBe(true);
    const css = readFileSync(join(import.meta.dirname, "../src/styles/inventory.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(readFileSync(join(import.meta.dirname, "../src/styles/app.css"), "utf8")).toContain('@import "./inventory.css";');
    expect(css).toMatch(/\.inv-press\s*{\s*transition:\s*transform var\(--yx-duration-press\) ease-out;/);
    expect(css).toMatch(/\.inv-press:active\s*{\s*transform:\s*scale\(0\.97\);/);
    expect(css).toMatch(/\.inv-drawer\[data-state="open"\]\s*{\s*animation:\s*inv-slide-in var\(--yx-duration-enter\) var\(--yx-easing-out\)/);
    expect(css).toMatch(/\.inv-drawer\[data-state="closed"\]\s*{\s*animation:\s*inv-slide-out var\(--yx-duration-exit\)/);
    expect(css).toMatch(/animation-delay:\s*calc\(min\(var\(--inv-i, 0\), 12\) \* 40ms\)/);
    const tokens = readFileSync(join(import.meta.dirname, "../src/styles/generated/tokens.css"), "utf8");
    expect(tokens).toContain("--yx-easing-out: cubic-bezier(0.23, 1, 0.32, 1);");
    for (const duration of ["--yx-duration-press: 160ms;", "--yx-duration-enter: 200ms;", "--yx-duration-exit: 140ms;"]) expect(tokens).toContain(duration);
    // Transitions name transform only; keyframes move transform and opacity only.
    for (const [, value] of css.matchAll(/transition(?:-property)?:\s*([^;]+);/g)) expect(value!.replace(/var\([^)]*\)/g, "").split(",").map((v) => v.trim().split(/\s+/)[0])).toEqual(["transform"]);
    for (const [, body] of css.matchAll(/@keyframes [\w-]+\s*{([\s\S]*?)}\s*}/g)) for (const [, property] of body!.matchAll(/([\w-]+)\s*:/g)) expect(["transform", "opacity"]).toContain(property);
    // Every :hover rule sits inside (hover: hover) and (pointer: fine).
    const hoverBlock = /@media \(hover: hover\) and \(pointer: fine\)\s*{([\s\S]*?)\n}/.exec(css)![1]!;
    expect(css.replace(hoverBlock, "").includes(":hover")).toBe(false);
    // The page's own markup uses no Tailwind hover: or transition utilities.
    for (const file of ["InventoryScreen.tsx", "Compare.tsx", "FilterBar.tsx", "FamilyDrawer.tsx", "Sheet.tsx"]) {
      const source = readFileSync(join(import.meta.dirname, "../src/screens/inventory", file), "utf8");
      expect(source, file).not.toMatch(/\bhover:|\btransition-(?:all|colors|shadow)\b|\banimate-(?:enter|pop|fade)\b/);
    }
  });

  test("reduced motion drops movement and keeps the fades", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/styles/inventory.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const reduce = /@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*)}\s*$/.exec(css)![1]!;
    expect(reduce).toMatch(/\.inv-press:active\s*{\s*transform:\s*none;/);
    expect(reduce).toMatch(/\.inv-enter,\s*\.inv-scrim\[data-state="open"\],\s*\.inv-drawer\[data-state="open"\]\s*{\s*animation-name:\s*inv-fade-in !important;\s*animation-duration:\s*var\(--yx-duration-enter\) !important;/);
    expect(reduce).toMatch(/animation-name:\s*inv-fade-out !important;/);
    expect(/@keyframes inv-fade-in\s*{\s*from\s*{\s*opacity:\s*0;\s*}\s*}/.test(css)).toBe(true);
    // The hub's global rule cuts animations to 0.01ms with !important on `*`; a class selector outranks it.
    expect(readFileSync(join(import.meta.dirname, "../src/styles/app.css"), "utf8")).toMatch(/\*,\s*\*::before,\s*\*::after\s*{\s*animation-duration: 0\.01ms !important;/);
  });
});

describe("inventory data", () => {
  test("rows skip roles with no looks and count looks no shape resolved", () => {
    const rows = memorySource(inventory).index.roles;
    expect(rows.map((r) => r.role)).toEqual(["button", "link-as-button", "input", "card", "badge", "dialog", "tabs"]);
    expect(rows.find((r) => r.role === "dialog")).toMatchObject({ looks: 2, unshaped: 1 });
    expect(shapeChips({ height: null, paddingX: 1, paddingY: 0, radius: 9999, fontSize: 12, fontWeight: 500 }).map((c) => `${c.label} ${c.value}`)).toEqual(["height ?", "padding 0 1px", "radius pill", "size 12px", "weight 500"]);
    expect(shapeChips({ height: 32, paddingX: 12, paddingY: 6, radius: null, fontSize: null, fontWeight: null }).map((c) => `${c.label} ${c.value}`)).toEqual(["height 32px", "padding 6px 12px", "radius ?", "size ?", "weight ?"]);
  });

  test("families are named by role and shape; unknown parts are left out", () => {
    expect(familyName({ role: "button", shape: { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 } })).toBe("Button · 32px · radius 8");
    expect(familyName({ role: "badge", shape: { height: 20, paddingX: 8, paddingY: 0, radius: 9999, fontSize: 12, fontWeight: 500 } })).toBe("Badge · 20px · pill");
    expect(familyName({ role: "card", shape: { height: null, paddingX: 24, paddingY: 24, radius: 12, fontSize: null, fontWeight: null } })).toBe("Card · radius 12");
    expect(familyName({ role: "link-as-button", shape: { height: null, paddingX: null, paddingY: null, radius: null, fontSize: null, fontWeight: null } })).toBe("Link as button");
  });

  test("examples list each file:line once, even with two looks on one line", () => {
    const example = (column: number) => ({ project: "p", file: "a.tsx", line: 3, column, tag: "Button", routes: [] });
    expect(uniqueExamples([example(5), example(20), { ...example(1), line: 4 }]).map((e) => `${e.line}:${e.column}`)).toEqual(["3:5", "4:1"]);
  });

  test("the committed snapshot names an inventory index of both fixtures, its chunks and specimen stylesheets", () => {
    const data = join(import.meta.dirname, "../snapshot/public/data");
    const manifest = JSON.parse(readFileSync(join(data, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.inventory).toMatch(/^inventory\.[0-9a-f]{10}\.json$/);
    const index = JSON.parse(readFileSync(join(data, manifest.inventory!), "utf8")) as InventoryIndex;
    expect(index.schema).toBe("youiyoux.inventory-index/v1");
    expect(index.projects.map((p) => p.id)).toEqual(["console", "site"]);
    const named = [index.extras, ...index.roles.flatMap((r) => Object.values(r.chunks)), ...index.projects.flatMap((p) => (p.specimenCss ? [p.specimenCss.light, p.specimenCss.dark] : []))];
    expect(new Set(manifest.inventoryFiles)).toEqual(new Set(named));
    for (const file of named) expect(file).toMatch(/^(?:inventory\.[a-z0-9-]+(?:\.[a-z-]+)?|specimens\.[a-z0-9-]+\.(?:light|dark))\.[0-9a-f]{10}\.(?:json|css)$/);
    const chunks = index.roles.flatMap((r) => Object.values(r.chunks)).map((file) => JSON.parse(readFileSync(join(data, file), "utf8")) as InventoryChunk);
    expect(new Set(chunks.flatMap((c) => c.families.map((f) => f.id)))).toEqual(new Set(inventory.families.map((f) => f.id)));
    expect(chunks.reduce((n, c) => n + c.looks.length, 0)).toBe(inventory.looks.length);
    // Both projects have stylesheets; the console's buttons are drawn from its own components.
    expect(index.projects.every((p) => p.specimenCss !== null)).toBe(true);
    const button = chunks.find((c) => c.project === "console" && c.role === "button")!;
    expect(Object.values(button.specimens).some((s) => s.kind === "component" && s.html.includes("bg-primary"))).toBe(true);
  });
});

/* ------------------------------------------------------------ specimen tiles */

/** The committed snapshot's inventory, every part preloaded: real specimens, built by `pnpm data`. */
function snapshotSource(only?: (project: string) => boolean): InventorySource {
  const data = join(import.meta.dirname, "../snapshot/public/data");
  const manifest = JSON.parse(readFileSync(join(data, "manifest.json"), "utf8")) as Manifest;
  const index = JSON.parse(readFileSync(join(data, manifest.inventory!), "utf8")) as InventoryIndex;
  const projects = only ? index.projects.map((p) => (only(p.id) ? p : { ...p, specimenCss: null })) : index.projects;
  const parts = new Map((manifest.inventoryFiles ?? []).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(readFileSync(join(data, f), "utf8")) as InventoryChunk]));
  return createSource({ ...index, projects }, () => Promise.reject(new Error("not preloaded")), (file) => `http://hub.test/data/${file}`, parts);
}

/** A stand-in IntersectionObserver the test drives: which elements are within which margin. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly elements = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit;
  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback;
    this.options = options;
    FakeObserver.all.push(this);
  }
  observe(element: Element): void {
    this.elements.add(element);
  }
  unobserve(element: Element): void {
    this.elements.delete(element);
  }
  disconnect(): void {
    this.elements.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Report `elements` as intersecting (or not) every observer watching them, near ones or far ones. */
  static report(elements: readonly Element[], isIntersecting: boolean, which: "near" | "far"): void {
    act(() => {
      for (const observer of FakeObserver.all) {
        // A tile's two observers: within 600px it mounts; beyond 1800px it unmounts.
        const margin = parseInt(String(observer.options.rootMargin ?? "0"), 10);
        if (margin !== (which === "near" ? 600 : 1800)) continue;
        const entries = elements.filter((e) => observer.elements.has(e)).map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry);
        if (entries.length > 0) observer.callback(entries, observer as unknown as IntersectionObserver);
      }
    });
  }
}

describe("specimen tiles (c1, c3)", () => {
  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const tilesOf = (container: HTMLElement, family: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(`[data-family="${family}"] [data-tile]`)];
  const rendering = (container: HTMLElement): number => container.querySelectorAll("iframe[data-rendering]").length;
  const caption = (tile: HTMLElement): string => text(tile.querySelector("p")!);
  /** Open a family from the wall and show its Variants tab: every distinct specimen, as tiles. */
  const variantsOf = (container: HTMLElement, family: string): HTMLElement[] => {
    fireEvent.click(within(container.querySelector<HTMLElement>(`[data-family="${family}"]`)!).getByRole("button", { name: /^Open / }));
    const drawer = screen.getByRole("dialog");
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: /Variants/ }));
    const tiles = [...within(drawer).getByRole("list", { name: "Specimens" }).querySelectorAll<HTMLElement>("[data-tile]")];
    fireEvent.keyDown(drawer, { key: "Escape" });
    return tiles;
  };

  test("an opened family shows its looks as tiles: the console's components, its class kits and the site's BEM and Astro looks", () => {
    window.history.replaceState(null, "", "/inventory");
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    // On the wall, the family's tile draws its most common specimen: the console's own Button.
    expect(tilesOf(container, "button-1").map((t) => t.dataset.kind)).toEqual(["component"]);
    const buttons = variantsOf(container, "button-1");
    // The family's ten looks: the CVA Button five times (each its own label), the CSS kit's,
    // the ladder's hand-rolled 32 and 34px ones and the site's two kit buttons.
    expect(buttons.map((t) => `${t.dataset.kind} ${caption(t)}`).sort()).toEqual([
      "component consolesrc/app/browser/page.tsx:8",
      "component consolesrc/app/page.tsx:13",
      "component consolesrc/app/page.tsx:16",
      "component consolesrc/app/settings/page.tsx:13",
      "component consolesrc/app/settings/page.tsx:18",
      "markup consolesrc/app/ladder/page.tsx:11",
      "markup consolesrc/app/ladder/page.tsx:12",
      "markup consolesrc/browser/toolbar.tsx:8",
      "markup sitesrc/pages/docs.astro:14",
      "markup sitesrc/pages/index.astro:11",
    ]);
    // The Astro badge is drawn from its tag and classes.
    expect(variantsOf(container, "badge-1").some((t) => t.dataset.kind === "markup" && caption(t).includes("src/pages/index.astro:9"))).toBe(true);
  });

  test("a role's chunks load as its row nears the screen; the others one at a time when the browser is idle, never outside the filters", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const preloaded = snapshotSource();
    const files = new Map<string, unknown>();
    for (const file of [preloaded.index.extras, ...preloaded.index.roles.flatMap((r) => Object.values(r.chunks))]) files.set(file, (preloaded.get(file) as { value: unknown }).value);
    const fetchPart = vi.fn((file: string) => Promise.resolve(files.get(file) as InventoryChunk));
    window.history.replaceState(null, "", "/inventory?project=console");
    const { container } = render(<InventoryView inventory={createSource(preloaded.index, fetchPart, (file) => `http://hub.test/data/${file}`)} />);
    const chunks = (): string[] => fetchPart.mock.calls.map(([file]) => file).filter((file) => file !== preloaded.index.extras);
    // After the first paint: the extras, and one idle turn waiting; no chunk yet.
    await waitFor(() => expect(idle).toHaveLength(1));
    expect(chunks()).toEqual([]);
    // The Tabs row comes within 800px of the scroll area: its console chunk loads now.
    act(() => {
      for (const observer of FakeObserver.all.filter((o) => o.options.rootMargin === "800px")) {
        const row = [...observer.elements].find((e) => (e as HTMLElement).dataset.role === "tabs");
        if (row) observer.callback([{ target: row, isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
      }
    });
    const tabs = preloaded.index.roles.find((r) => r.role === "tabs")!.chunks.console!;
    expect(chunks()).toEqual([tabs]);
    await waitFor(() => expect(container.querySelector('[data-family="tabs-3"]')).not.toBeNull());
    // Each idle turn fetches the next, one at a time, only the console's.
    const scope = preloaded.index.roles.flatMap((r) => (r.chunks.console ? [r.chunks.console] : []));
    for (let turn = 0; turn < scope.length && idle.length > 0; turn++) {
      const before = chunks().length;
      act(() => idle.shift()!());
      expect(chunks().length).toBe(before + 1);
      await waitFor(() => expect(idle.length > 0 || chunks().length === scope.length).toBe(true));
    }
    expect(chunks().sort()).toEqual([...scope].sort());
    expect(new Set(chunks()).size).toBe(chunks().length);
    await waitFor(() => expect(text(screen.getByTestId("consolidation"))).toMatch(/families → could be ~\d+$/));
  });

  test("frames mount only for tiles near the scroll area, and unmount when they are far", () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    const badges = tilesOf(container, "badge-1");
    FakeObserver.report(badges, true, "near");
    expect(container.querySelectorAll("iframe")).toHaveLength(badges.length);
    expect([...container.querySelectorAll("iframe")].every((f) => f.closest('[data-family="badge-1"]'))).toBe(true);
    // Still within the far margin: kept. Beyond it: gone.
    FakeObserver.report(badges.slice(0, 1), false, "near");
    expect(container.querySelectorAll("iframe")).toHaveLength(badges.length);
    FakeObserver.report(badges.slice(0, 1), false, "far");
    expect(container.querySelectorAll("iframe")).toHaveLength(badges.length - 1);
  });

  test("never more than six frames render at once; the rest mount as earlier ones finish", () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tiles = [...container.querySelectorAll<HTMLElement>("[data-tile]")].filter((t) => t.dataset.kind !== "shape");
    expect(tiles.length).toBeGreaterThan(12);
    FakeObserver.report(tiles, true, "near");
    let loaded = 0;
    for (let round = 0; round < 20 && loaded < tiles.length; round++) {
      expect(rendering(container)).toBeLessThanOrEqual(MAX_RENDERING);
      const frames = [...container.querySelectorAll<HTMLIFrameElement>("iframe[data-rendering]")];
      if (frames.length === 0) break;
      for (const frame of frames) fireEvent.load(frame);
      loaded += frames.length;
    }
    expect(loaded).toBe(tiles.length);
    expect(rendering(container)).toBe(0);
    expect(container.querySelectorAll("iframe")).toHaveLength(tiles.length);
  });

  test("a frame is the look's static HTML and one stylesheet link at desk width, in the hub's scheme, with no script", () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tile = tilesOf(container, "button-1").find((t) => t.dataset.kind === "component")!;
    FakeObserver.report([tile], true, "near");
    const frame = tile.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.style.width).toBe(`${DESK_WIDTH}px`);
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc).toMatch(/<link rel="stylesheet" href="http:\/\/hub\.test\/data\/specimens\.console\.light\.[0-9a-f]{10}\.css">/);
    expect(doc).toContain('<button class="inline-flex items-center justify-center');
    expect(doc).not.toMatch(/<script/i);
    expect(frameDocument("<b>x</b>", "/s.css", "dark")).toMatch(/^<!doctype html><html lang="en" class="dark" data-theme="dark" style="color-scheme:dark">/);
  });

  test("without a stylesheet a project's looks fall back to their measured shape", () => {
    window.history.replaceState(null, "", "/inventory");
    const { container } = render(<InventoryView inventory={snapshotSource((p) => p === "console")} />);
    const variants = variantsOf(container, "button-1");
    const site = variants.filter((t) => caption(t).startsWith("site"));
    expect(site.length).toBeGreaterThan(0);
    for (const tile of site) {
      expect(tile.dataset.kind).toBe("shape");
      expect(within(tile).getByTestId("shape-box").textContent).toContain("shape only");
    }
    expect(variants.filter((t) => caption(t).startsWith("console")).every((t) => t.dataset.kind !== "shape")).toBe(true);
    // The fix card's site side, too.
    const sides = [...container.querySelectorAll<HTMLElement>('[data-fix="button-1"] [data-tile]')];
    expect(sides.filter((t) => t.dataset.tile!.includes(":site:")).every((t) => t.dataset.kind === "shape")).toBe(true);
  });

  test("a lead tile skips a specimen that draws nothing at the desk width, then falls back to its shape (c2)", () => {
    const shape = { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 };
    const family = { projects: ["p"], shape, looks: 70 } as unknown as InventoryFamily;
    const look = (html: string, count: number) => ({ key: html, project: "p", specimen: { kind: "markup" as const, html }, css: "/s.css", shape, count, place: "a.tsx:1" });
    const tiles = leadTiles([look('<button class="ok">Back</button>', 4), look('<button class="so-phone-back">Back</button>', 66)], family, "wall:f");
    expect(tiles.map((t) => [t.key, t.specimen?.html ?? null])).toEqual([
      ["wall:f", '<button class="so-phone-back">Back</button>'],
      ["wall:f", '<button class="ok">Back</button>'],
      ["wall:f", null],
    ]);
    /** Load the tile's frame as a browser lays it out at the desk width: `visible` decides whether the look has a box. */
    const load = (container: HTMLElement, visible: boolean): void => {
      const frame = container.querySelector("iframe")!;
      const doc = frame.contentDocument!;
      doc.body.innerHTML = '<div id="youi-specimen"><button>Back</button></div>';
      const size = (width: number) => () => ({ width, height: width ? 20 : 0, left: 0, top: 0, right: width, bottom: width ? 20 : 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      doc.documentElement.getBoundingClientRect = size(DESK_WIDTH);
      for (const element of doc.body.querySelectorAll("*")) element.getBoundingClientRect = size(visible ? 60 : 0);
      fireEvent.load(frame);
    };
    const { container } = render(<LeadTile tiles={tiles} scheme="light" as="div" />);
    FakeObserver.report([container.querySelector("[data-tile]")!], true, "near");
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain("so-phone-back");
    load(container, false);
    // The most used look is display:none at 1280px: the next one is drawn instead.
    FakeObserver.report([container.querySelector("[data-tile]")!], true, "near");
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain('class="ok"');
    load(container, true);
    expect(container.querySelector("iframe[data-placed]")).not.toBeNull();
    expect(container.querySelector<HTMLElement>("[data-tile]")!.dataset.kind).toBe("markup");

    // When none draws anything, the family's shape stands in.
    cleanup();
    const hidden = leadTiles([look('<button class="so-phone-back">Back</button>', 66)], family, "wall:g");
    const second = render(<LeadTile tiles={hidden} scheme="light" as="div" />);
    FakeObserver.report([second.container.querySelector("[data-tile]")!], true, "near");
    load(second.container, false);
    expect(second.container.querySelector<HTMLElement>("[data-tile]")!.dataset.kind).toBe("shape");
    expect(within(second.container).getByTestId("shape-box")).toBeTruthy();
  });

  test("a strip of more than 100 tiles is virtualised: only the rows near its scroll position are in the DOM", () => {
    const shape = { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 };
    // jsdom lays nothing out: give the strip's scroll area a size, as a browser would.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(448);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(700);
    const tiles = Array.from({ length: 150 }, (_, i) => ({ key: `t${i}`, project: "p", specimen: { kind: "markup" as const, html: `<button>${i}</button>` }, css: "/s.css", shape, count: 1, place: `a.tsx:${i + 1}` }));
    const { container } = render(<TileGrid tiles={tiles} scheme="light" />);
    expect(screen.getByTestId("virtual-tiles")).toBeTruthy();
    const shown = container.querySelectorAll("[data-tile]").length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(VIRTUALISE_AT);
    render(<TileGrid tiles={tiles.slice(0, VIRTUALISE_AT)} scheme="light" />);
    expect(screen.getAllByRole("list", { name: "Specimens" })[0]!.children).toHaveLength(VIRTUALISE_AT);
  });

  test("the frame queue grants six slots and hands each freed one to the next in line", () => {
    const queue = new FrameQueue(6);
    const granted: number[] = [];
    const ids = Array.from({ length: 9 }, () => ({}));
    ids.forEach((id, i) => queue.request(id, () => granted.push(i)));
    expect(granted).toEqual([0, 1, 2, 3, 4, 5]);
    queue.release(ids[2]!);
    queue.release(ids[7]!); // left the line before its turn
    queue.release(ids[0]!);
    expect(granted).toEqual([0, 1, 2, 3, 4, 5, 6, 8]);
    expect(queue.rendering).toBe(6);
  });

  test("under StrictMode, 60 near tiles: never more than six frames load, mounted frames stay within the budget, and every tile draws (c7)", () => {
    const shape = { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 };
    const tiles = Array.from({ length: 60 }, (_, i) => ({ key: `s${i}`, project: "p", specimen: { kind: "markup" as const, html: `<button>${i}</button>` }, css: "/s.css", shape, count: 1, place: `a.tsx:${i + 1}` }));
    const { container } = render(
      <StrictMode>
        <TileGrid tiles={tiles} scheme="light" />
      </StrictMode>,
    );
    const all = [...container.querySelectorAll<HTMLElement>("[data-tile]")];
    expect(all).toHaveLength(60);
    const drew = new Set<string>();
    let most = 0;
    let mostMounted = 0;
    const drain = (): void => {
      for (let round = 0; round < 40; round++) {
        const loading = [...container.querySelectorAll<HTMLIFrameElement>("iframe[data-rendering]")];
        most = Math.max(most, loading.length);
        mostMounted = Math.max(mostMounted, container.querySelectorAll("iframe").length);
        if (loading.length === 0) break;
        for (const frame of loading) fireEvent.load(frame);
      }
      for (const tile of all) if (tile.querySelector("iframe[data-placed]")) drew.add(tile.dataset.tile!);
    };
    FakeObserver.report(all, true, "near");
    drain();
    expect(container.querySelectorAll("iframe")).toHaveLength(Math.min(60, MAX_MOUNTED));
    expect(all.filter((t) => t.dataset.frame === "waiting").length).toBe(60 - Math.min(60, MAX_MOUNTED));
    // Scrolling on: the first twenty go far, and the tiles waiting for room mount and draw.
    FakeObserver.report(all.slice(0, 20), false, "far");
    drain();
    expect(most).toBeLessThanOrEqual(MAX_RENDERING);
    expect(most).toBe(MAX_RENDERING);
    expect(mostMounted).toBeLessThanOrEqual(MAX_MOUNTED);
    expect(drew.size).toBe(60);
    expect(container.querySelectorAll("iframe[data-rendering]")).toHaveLength(0);
  });

  test("the frame budget puts visible tiles first, keeps frames where they are, and never passes its limit", () => {
    const budget = new FrameBudget(2);
    const state = new Map<string, boolean>();
    const ids = { a: {}, b: {}, c: {} };
    let peak = 0;
    const track = (name: string) => (mounted: boolean) => {
      state.set(name, mounted);
      peak = Math.max(peak, [...state.values()].filter(Boolean).length);
    };
    budget.join(ids.a, false, track("a"));
    budget.join(ids.b, false, track("b"));
    budget.join(ids.c, false, track("c"));
    // Full: c waits rather than taking a frame from a tile that has one.
    expect(Object.fromEntries(state)).toEqual({ a: true, b: true });
    budget.see(ids.c, true);
    // Visible c comes first; of the others, the first to come keeps its frame.
    expect(Object.fromEntries(state)).toEqual({ a: true, b: false, c: true });
    state.delete("a");
    budget.leave(ids.a);
    expect(Object.fromEntries(state)).toEqual({ b: true, c: true });
    expect(budget.mounted).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------- state strips */

describe("state strips: default, hover, focus, pressed and disabled side by side (c1)", () => {
  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    window.history.replaceState(null, "", "/inventory");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A strip's one frame, as the browser would get it: five cells of the same specimen. */
  const cellsOf = (strip: HTMLElement): HTMLElement[] => {
    const doc = new DOMParser().parseFromString(strip.querySelector("iframe")!.getAttribute("srcdoc")!, "text/html");
    return [...doc.querySelectorAll<HTMLElement>("#youi-specimen > [data-youi-state]")];
  };

  test("the strip document: one stylesheet, no script, five cells forcing each state by class, the disabled cell by attribute", () => {
    const doc = stateStripDocument('<button class="b">Save</button><a class="l" href="#">Docs</a>', "/s.css", "dark");
    expect(doc).toMatch(/^<!doctype html><html lang="en" class="dark" data-theme="dark" style="color-scheme:dark"><head><meta charset="utf-8"><link rel="stylesheet" href="\/s\.css"><\/head>/);
    expect(doc).not.toMatch(/<script/i);
    const cells = [...new DOMParser().parseFromString(doc, "text/html").querySelectorAll<HTMLElement>("[data-youi-state]")];
    expect(cells.map((c) => [c.dataset.youiState, c.className])).toEqual(STATES.map((s) => [s.id, `youi-state-cell${s.className ? ` ${s.className}` : ""}`]));
    expect(cells.slice(0, 4).every((c) => c.innerHTML === '<button class="b">Save</button><a class="l" href="#">Docs</a>')).toBe(true);
    const button = cells[4]!.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const link = cells[4]!.querySelector("a")!;
    expect(link.hasAttribute("disabled")).toBe(false);
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(disabledHtml('<div role="tablist"><button role="tab">A</button></div>')).toBe('<div role="tablist" aria-disabled="true" data-disabled=""><button role="tab" disabled="" aria-disabled="true" data-disabled="">A</button></div>');
  });

  test("the drawer's Variants tab shows each drawn look as a five-cell strip, its states named under it", () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-family="button-1"]')!).getByRole("button", { name: /^Open / }));
    const drawer = screen.getByRole("dialog");
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: /Variants/ }));
    fireEvent.click(within(within(drawer).getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: /States/ }));
    const strips = [...within(drawer).getByRole("list", { name: "States of each look" }).querySelectorAll<HTMLElement>("[data-strip]")];
    // Five console Button looks are drawn from the project's code; its CSS-kit and the ladder's from their classes.
    expect(strips.length).toBeGreaterThanOrEqual(5);
    // No frame until a strip nears the screen.
    expect(drawer.querySelectorAll("[data-strip] iframe")).toHaveLength(0);
    FakeObserver.report(strips, true, "near");
    const strip = strips.find((s) => s.querySelector("iframe")?.getAttribute("srcdoc")?.includes("focus-visible:ring-2"))!;
    expect(strip.querySelectorAll("iframe")).toHaveLength(1);
    expect(strip.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-same-origin");
    const cells = cellsOf(strip);
    expect(cells.map((c) => c.dataset.youiState)).toEqual(["default", "hover", "focus", "pressed", "disabled"]);
    expect(cells[4]!.querySelector("button")!.hasAttribute("disabled")).toBe(true);
    expect(cells.slice(0, 4).every((c) => !c.querySelector("[disabled]"))).toBe(true);
    expect(within(within(strip).getByRole("list", { name: "States" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Default", "Hover", "Focus", "Pressed", "Disabled"]);
    expect(strip.getAttribute("role")).toBe("group");
  });

  test("a compare card's States shows both sides' strips, one above the other, so near-duplicates compare state by state", () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const card = container.querySelector<HTMLElement>('[data-compare="button-1"]')!;
    fireEvent.click(within(within(card).getByRole("radiogroup", { name: "Compare as" })).getByRole("radio", { name: "States" }));
    const strips = [...within(card).getByTestId("compare-states").querySelectorAll<HTMLElement>("[data-strip]")];
    expect(strips).toHaveLength(2);
    FakeObserver.report(strips, true, "near");
    const drawn = strips.filter((s) => s.querySelector("iframe"));
    expect(drawn.length).toBeGreaterThan(0);
    for (const strip of drawn) {
      const cells = cellsOf(strip);
      expect(cells.map((c) => c.dataset.youiState)).toEqual(["default", "hover", "focus", "pressed", "disabled"]);
      expect(cells[4]!.querySelector("[aria-disabled='true']")).not.toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ Try it */

describe("Try it: one tile live in a sandboxed frame, loaded only on click (c2)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const tryRequests = (): string[] => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("__youi/try"));
  const answer = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    fetchMock = vi.fn(() => answer(200, { script: "/__youi/try/0123456789abcdef.js" }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/inventory?type=tabs");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const wallTile = (container: HTMLElement, family: string): HTMLElement => container.querySelector<HTMLElement>(`[data-family="${family}"] [data-tile]`)!;
  const liveFrames = (container: ParentNode): HTMLIFrameElement[] => [...container.querySelectorAll<HTMLIFrameElement>("iframe[data-live-frame]")];
  /** A message as the live frame would post it, from `source`. */
  const post = (source: Window | null, data: unknown): void => act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
  const start = async (tile: HTMLElement): Promise<HTMLIFrameElement> => {
    fireEvent.click(within(tile).getByRole("button", { name: /^Try / }));
    await waitFor(() => expect(tile.querySelector("iframe[data-live-frame]")).not.toBeNull());
    return tile.querySelector<HTMLIFrameElement>("iframe[data-live-frame]")!;
  };

  test("nothing is requested before a click; Try it bundles that look and runs it in a frame sandboxed allow-scripts only", async () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tiles = [...container.querySelectorAll<HTMLElement>("[data-tile]")];
    FakeObserver.report(tiles, true, "near");
    // Every tile near and drawn, and still no bundle asked for.
    expect(tryRequests()).toEqual([]);
    const tile = wallTile(container, "tabs-1");
    expect(tile.dataset.kind).toBe("component");
    const frame = await start(tile);
    expect(tryRequests()).toHaveLength(1);
    expect(tryRequests()[0]).toMatch(/\/__youi\/try\?project=console&specimen=[0-9a-f]{12}$/);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.tabIndex).toBe(0);
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc).toMatch(/<link rel="stylesheet" href="http:\/\/hub\.test\/data\/specimens\.console\.light\.[0-9a-f]{10}\.css">/);
    expect(doc).toMatch(/<script src="http:\/\/[^"]+\/__youi\/try\/0123456789abcdef\.js"><\/script><\/body>/);
    // Until it has drawn, the static specimen shows; its box arrives as a message from the frame.
    expect(tile.querySelector("[data-live]")!.getAttribute("data-live")).toBe("loading");
    post(frame.contentWindow, { youi: "try", type: "box", x: 32, y: 32, width: 120, height: 36 });
    expect(tile.querySelector("[data-live]")!.getAttribute("data-live")).toBe("drawn");
    expect(within(tile).getByRole("button", { name: /^Done / }).textContent).toBe("Done");
  });

  test("Try it and Done are never inside the specimen's box: over its corner on a desk, below it on a phone", async () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tile = wallTile(container, "tabs-1");
    FakeObserver.report([tile], true, "near");
    const outsideBox = (): void => {
      const button = tile.querySelector<HTMLElement>("[data-try]")!;
      const box = tile.querySelector("iframe")!.closest(".overflow-hidden")!;
      expect(box.contains(button)).toBe(false);
      // In flow under the box below md (44px tall); placed over its top corner from md up.
      expect(button.closest("[data-try-bar]")!.parentElement!.contains(box)).toBe(true);
      expect(button.className.split(" ")).toEqual(expect.arrayContaining(["max-md:h-11", "md:absolute", "md:top-1", "md:right-1"]));
      expect(button.className.split(" ")).not.toContain("absolute");
    };
    await waitFor(() => expect(tile.querySelector("iframe")).not.toBeNull());
    outsideBox();
    const frame = await start(tile);
    post(frame.contentWindow, { youi: "try", type: "box", x: 32, y: 32, width: 120, height: 36 });
    expect(tile.querySelector("[data-try]")!.getAttribute("data-try")).toBe("done");
    outsideBox();
  });

  test("a busy server (503) is shown as its own sentence", async () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tile = wallTile(container, "tabs-1");
    FakeObserver.report([tile], true, "near");
    fetchMock.mockImplementation(() => answer(503, { error: "Try it is busy building other looks; try again in a moment." }));
    fireEvent.click(within(tile).getByRole("button", { name: /^Try / }));
    await waitFor(() => expect(tile.querySelector("[data-try-failure]")).not.toBeNull());
    expect(text(tile.querySelector("[data-try-failure]")!)).toBe("Try it is busy building other looks; try again in a moment.");
  });

  test("messages from any other window are ignored, and so are boxes that are not finite numbers", async () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tile = wallTile(container, "tabs-1");
    FakeObserver.report([tile], true, "near");
    const frame = await start(tile);
    post(window, { youi: "try", type: "box", x: 0, y: 0, width: 10, height: 10 });
    post(null, { youi: "try", type: "escape" });
    post(window, { youi: "try", type: "error", message: "spoofed" });
    post(frame.contentWindow, { youi: "try", type: "box", x: Number.NaN, y: 0, width: 1e999, height: 10 });
    expect(tile.querySelector("[data-live]")!.getAttribute("data-live")).toBe("loading");
    expect(liveFrames(container)).toHaveLength(1);
    expect(tile.querySelector("[data-try-failure]")).toBeNull();
  });

  test("at most one tile is live: starting another ends the first", async () => {
    window.history.replaceState(null, "", "/inventory");
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tabs = wallTile(container, "tabs-1");
    const button = wallTile(container, "button-1");
    FakeObserver.report([tabs, button], true, "near");
    await start(tabs);
    await start(button);
    expect(liveFrames(container)).toHaveLength(1);
    expect(liveFrames(button)).toHaveLength(1);
    expect(tabs.dataset.live).toBeUndefined();
    expect(within(tabs).getByRole("button", { name: /^Try / })).toBeTruthy();
  });

  test("Done, Escape (in the page or posted by the frame) and scrolling away each return to the static specimen", async () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tile = wallTile(container, "tabs-1");
    FakeObserver.report([tile], true, "near");
    const staticFrame = (): HTMLIFrameElement | null => tile.querySelector("iframe:not([data-live-frame])");
    // Done.
    await start(tile);
    fireEvent.click(within(tile).getByRole("button", { name: /^Done / }));
    expect(liveFrames(tile)).toHaveLength(0);
    await waitFor(() => expect(staticFrame()).not.toBeNull());
    expect(document.activeElement).toBe(within(tile).getByRole("button", { name: /^Try / }));
    // Escape pressed in the hub.
    await start(tile);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(liveFrames(tile)).toHaveLength(0);
    // Escape the look did not use, posted by its frame.
    const frame = await start(tile);
    post(frame.contentWindow, { youi: "try", type: "escape" });
    expect(liveFrames(tile)).toHaveLength(0);
    // Scrolled far away: released.
    await start(tile);
    FakeObserver.report([tile], false, "far");
    expect(liveFrames(container)).toHaveLength(0);
  });

  test("Escape pressed inside a live tile in the drawer ends Try it and leaves the drawer open", async () => {
    window.history.replaceState(null, "", "/inventory");
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-family="tabs-1"]')!).getByRole("button", { name: /^Open / }));
    const drawer = screen.getByRole("dialog");
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: /Variants/ }));
    const tile = within(drawer).getByRole("list", { name: "Specimens" }).querySelector<HTMLElement>('[data-kind="component"]')!;
    FakeObserver.report([tile], true, "near");
    await start(tile);
    fireEvent.keyDown(within(tile).getByRole("button", { name: /^Done / }), { key: "Escape" });
    expect(liveFrames(tile)).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBe(drawer);
  });

  test("a bundle that fails, a look that throws, or no server: one plain sentence, and the static specimen stays", async () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const tile = wallTile(container, "tabs-1");
    FakeObserver.report([tile], true, "near");
    const failure = (): string => text(tile.querySelector("[data-try-failure]")!);
    fetchMock.mockImplementation(() => answer(422, { error: 'refused import "../../secrets" resolves outside the project root (from src/components/ui/tabs.tsx)' }));
    fireEvent.click(within(tile).getByRole("button", { name: /^Try / }));
    await waitFor(() => expect(tile.querySelector("[data-try-failure]")).not.toBeNull());
    expect(failure()).toBe('Try it could not bundle this look (refused import "../../secrets" resolves outside the project root (from src/components/ui/tabs.tsx)); the static specimen stays.');
    expect(tile.querySelector("[data-try-failure]")!.getAttribute("role")).toBe("status");
    expect(liveFrames(tile)).toHaveLength(0);
    // The static frame mounts again once its turn in the frame queue comes.
    await waitFor(() => expect(tile.querySelector("iframe")).not.toBeNull());
    // A static host: the request finds a page, not the endpoint.
    fetchMock.mockImplementation(() => Promise.resolve(new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    fireEvent.click(within(tile).getByRole("button", { name: /^Try / }));
    await waitFor(() => expect(failure()).toContain("needs the hub's own server"));
    // The server is gone.
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    fireEvent.click(within(tile).getByRole("button", { name: /^Try / }));
    await waitFor(() => expect(failure()).toContain("did not answer"));
    // It bundled, and threw when it ran.
    fetchMock.mockImplementation(() => answer(200, { script: "/__youi/try/0123456789abcdef.js" }));
    const frame = await start(tile);
    expect(tile.querySelector("[data-try-failure]")).toBeNull();
    post(frame.contentWindow, { youi: "try", type: "error", message: "localStorage is not available" });
    expect(liveFrames(tile)).toHaveLength(0);
    expect(failure()).toBe("This look failed when it ran (localStorage is not available); the static specimen stays.");
  });

  test("markup looks and shapes have no Try it; neither do compare and fix cards", () => {
    window.history.replaceState(null, "", "/inventory");
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    for (const tile of container.querySelectorAll<HTMLElement>("[data-tile]")) {
      const offered = tile.querySelector("[data-try]") !== null;
      if (tile.closest("[data-compare], [data-fix]")) expect(offered).toBe(false);
      else expect(offered).toBe(tile.dataset.kind === "component");
    }
  });
});
