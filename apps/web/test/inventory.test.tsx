// @vitest-environment jsdom
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InventoryReport as InventorySchema } from "@youiyoux/core";
import { buildInventory } from "../../../packages/scanner/src/inventory/inventory.ts";
import { familyName, shapeChips, uniqueExamples } from "../src/data/inventory.ts";
import { createSource, memorySource, type InventorySource } from "../src/data/inventory-source.ts";
import type { InventoryChunk, InventoryIndex, InventoryReport, Manifest } from "../src/data/types.ts";
import { InventoryView } from "../src/screens/inventory/InventoryScreen.tsx";
import { StrictMode } from "react";
import { DESK_WIDTH, FrameBudget, FrameQueue, frameDocument, MAX_MOUNTED, MAX_RENDERING, TileGrid, VIRTUALISE_AT } from "../src/screens/inventory/Specimens.tsx";

const TOOL = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(TOOL, "packages/scanner/test/fixtures/inventory");

let inventory: InventoryReport;
beforeAll(async () => {
  inventory = InventorySchema.parse(await buildInventory([join(FIXTURES, "console"), join(FIXTURES, "site")], { cwd: TOOL }));
});
afterEach(cleanup);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Inventory page (c3)", () => {
  test("a role × project grid with family and look counts", () => {
    render(<InventoryView inventory={memorySource(inventory)} />);
    const grid = screen.getByTestId("role-grid");
    const headers = within(grid).getAllByRole("columnheader").map(text);
    expect(headers).toEqual(["Role", "console", "site", "Across projects"]);
    const rows = within(grid).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("rowheader").concat(within(row).getAllByRole("cell")).map(text));
    expect(rows.map((r) => r[0])).toEqual(["Buttons", "Links as buttons", "Inputs", "Cards", "Badges", "Dialogs", "Tabs"]);
    expect(rows[0]).toEqual(["Buttons", "5 families · 14 looks", "1 family · 2 looks", "1 shared across projects"]);
    expect(rows[2]).toEqual(["Inputs", "2 families · 2 looks", "—", "none shared"]);
  });

  test("each family is a row with its shape, kits, count, file:line examples and near-duplicates across projects", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    const button = container.querySelector('[data-family="button-1"]')!;
    expect(button).not.toBeNull();
    // Named by role and shape, with the shape spelled out.
    expect(within(button as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe("Button · 32px · radius 8");
    expect([...within(button as HTMLElement).getByLabelText("Shape").children].map(text)).toEqual(["height 32px", "padding 0 12px", "radius 8px", "size 14px", "weight 500"]);
    expect(text(button)).toContain("10 looks");
    expect(text(button)).toContain("Near-duplicate across projects");
    const sides = within(button as HTMLElement).getByRole("list", { name: "Near-duplicates" });
    // The console's CSS kit, its CVA kit and the ladder's hand-rolled 32px button, then the site's kit.
    expect(sides.children).toHaveLength(4);
    const sideText = within(sides).getAllByRole("listitem").filter((li) => li.parentElement === sides).map(text);
    expect(sideText.some((s) => s.startsWith("consolesrc/browser/ui.css1 look") && s.includes("console:src/browser/toolbar.tsx:8"))).toBe(true);
    expect(sideText.some((s) => s.startsWith("consolesrc/components/ui5 looks") && s.includes("console:src/app/page.tsx:13"))).toBe(true);
    expect(sideText.some((s) => s.startsWith("sitesrc/styles/ui.css2 looks") && s.includes("site:src/pages/docs.astro:14") && s.includes("/docs"))).toBe(true);
    // A family in one kit and one project: its kit, the project and its examples.
    const legacy = container.querySelector('[data-family="button-5"]')!;
    expect(text(legacy)).toContain("src/styles/legacy.css");
    expect(text(legacy)).toContain("console:src/app/settings/page.tsx:14");
    expect(text(legacy)).not.toContain("Near-duplicate");
  });

  test("badges and tabs show their cross-project families; flags and the not-clustered note appear", () => {
    const { container } = render(<InventoryView inventory={memorySource(inventory)} />);
    expect(text(container.querySelector('[data-family="badge-1"]')!)).toContain("Badge · 20px · pill");
    expect(text(container.querySelector('[data-family="badge-1"]')!)).toContain("site:src/pages/pricing.astro:6");
    expect(text(container.querySelector('[data-family="tabs-1"]')!)).toContain("Near-duplicate across projects");
    expect(text(container)).toContain("Badge is defined 3 times");
    expect(text(container)).toContain("console:src/app/settings/page.tsx imports 2 kits’ button in 2 imports");
    expect(text(container)).toContain("LegacyButton, LegacyIconButton from src/styles/legacy.css · line 2");
    expect(text(container)).toMatch(/\d+ breakpoint and state classes recorded, not clustered/);
    expect(screen.getByRole("heading", { name: "Kits and primitives" })).toBeTruthy();
  });

  test("on a phone the grid becomes one section per role", () => {
    render(<InventoryView inventory={memorySource(inventory)} />);
    expect(screen.getByTestId("role-grid").className).toContain("max-md:hidden");
    const stack = screen.getByTestId("role-stack");
    expect(stack.className).toContain("md:hidden");
    const cards = within(stack).getAllByRole("listitem");
    expect(cards.map((c) => /^(.*?)(?:\d+ shared|none shared)/.exec(text(c))?.[1])).toEqual(["Buttons", "Links as buttons", "Inputs", "Cards", "Badges", "Dialogs", "Tabs"]);
    expect(text(cards[0]!)).toContain("console5 families · 14 looks");
    expect(text(cards[0]!)).toContain("site1 family · 2 looks");
  });

  test("with no inventory the page says how to make one", () => {
    render(<InventoryView inventory={null} />);
    expect(screen.getByRole("heading", { name: "No inventory yet" })).toBeTruthy();
    expect(text(document.body)).toContain("youi ui --inventory");
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

  test("a family row lists each file:line once, even with two looks on one line", () => {
    const example = (column: number) => ({ project: "p", file: "a.tsx", line: 3, column, tag: "Button", routes: [] });
    expect(uniqueExamples([example(5), example(20), { ...example(1), line: 4 }]).map((e) => `${e.line}:${e.column}`)).toEqual(["3:5", "4:1"]);
    const family = { ...inventory.families[0]!, nearDuplicate: false, examples: [example(5), example(20)] };
    const { container } = render(<InventoryView inventory={memorySource({ ...inventory, families: [family] })} />);
    const row = container.querySelector(`[data-family="${family.id}"]`)!;
    expect(text(row).match(/p:a\.tsx:3/g)).toHaveLength(1);
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

  test("each family shows its looks as tiles: the console's components, its class kits and the site's BEM and Astro looks", () => {
    const { container } = render(<InventoryView inventory={snapshotSource()} />);
    const buttons = tilesOf(container, "button-1");
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
    expect(tilesOf(container, "badge-1").some((t) => t.dataset.kind === "markup" && caption(t).includes("src/pages/index.astro:9"))).toBe(true);
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
    const { container } = render(<InventoryView inventory={snapshotSource((p) => p === "console")} />);
    const site = tilesOf(container, "button-1").filter((t) => caption(t).startsWith("site"));
    expect(site.length).toBeGreaterThan(0);
    for (const tile of site) {
      expect(tile.dataset.kind).toBe("shape");
      expect(within(tile).getByTestId("shape-box").textContent).toContain("shape only");
    }
    expect(tilesOf(container, "button-1").filter((t) => caption(t).startsWith("console")).every((t) => t.dataset.kind !== "shape")).toBe(true);
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
