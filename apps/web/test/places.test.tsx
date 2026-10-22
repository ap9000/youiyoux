// @vitest-environment jsdom
/**
 * The screen picture with its components on it: what is outlined in each mode, the name under the
 * pointer, a click picks the smallest component there, and a pick from the address is lit.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeScreens } from "../scripts/snapshot.ts";
import { matchPlaces, type Placed } from "../src/data/places.ts";
import type { PlacedComponent, PlacesFile } from "../src/data/types.ts";
import type { Site } from "../src/data/usage.ts";
import { PlacesOverlay, type Outline } from "../src/screens/screens/PlacesOverlay.tsx";

const BUTTON = "youi:demo/component/button";
const size = { width: 1000, height: 500 };
const place = (name: string, line: number, box: PlacedComponent["box"], depth: number): PlacedComponent => ({ name, owner: "Page", file: "src/page.tsx", line, column: 3, box, depth });
const places: PlacesFile = {
  schema: "youiyoux.places/v1",
  route: "/",
  path: "/",
  viewport: { width: 1000, height: 500 },
  size,
  dev: true,
  capped: false,
  places: [place("Panel", 4, { x: 0, y: 0, width: 600, height: 400 }, 0), place("Button", 8, { x: 100, y: 100, width: 100, height: 40 }, 1), place("Button", 9, { x: 300, y: 100, width: 100, height: 40 }, 1)],
};
const site = { element: BUTTON, kind: "render", export: "Button", local: "Button", file: "src/page.tsx", line: 8, column: 3 } as Site;
const lookalike = { resembles: BUTTON, local: "Button", resolved: "src/ui/x.tsx#Button", file: "src/page.tsx", line: 9, column: 3, project: "app" };
const placed = matchPlaces(places.places, [site], [lookalike]);

beforeEach(() => {
  // The layer is drawn 500px wide: half the page's pixels.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(outline: Outline, select: string | null = null, onSelect: (p: Placed | null) => void = () => undefined) {
  return render(<PlacesOverlay shot={null} scheme="light" label="app /" places={places} placed={placed} outline={outline} select={select} pointed={null} nameOf={(p) => p.place.name} onSelect={onSelect} />);
}
const layer = (): HTMLElement => document.querySelector("[data-places-layer]")!;

describe("the components on a screen's picture", () => {
  test("Elements outlines the System element and its lookalike; All outlines nothing until pointed at; Off takes no pointer", () => {
    show("elements");
    expect([...document.querySelectorAll("[data-place]")].map((b) => [b.getAttribute("data-place"), b.hasAttribute("data-lookalike")])).toEqual([[BUTTON, false], [BUTTON, true]]);
    cleanup();
    show("all");
    expect(document.querySelectorAll("[data-place]")).toHaveLength(0);
    cleanup();
    const onSelect = vi.fn();
    show("off", null, onSelect);
    fireEvent.click(layer(), { clientX: 75, clientY: 60 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("pointing names the smallest component there, scaled to the picture; a click picks it", () => {
    const onSelect = vi.fn();
    show("all", null, onSelect);
    // (75, 60) on a half-size picture is (150, 120) on the page: the first button, inside the panel.
    fireEvent.pointerMove(layer(), { clientX: 75, clientY: 60 });
    expect(document.querySelector("[data-place-label]")!.textContent).toBe("Button");
    fireEvent.click(layer(), { clientX: 75, clientY: 60 });
    expect((onSelect.mock.calls[0]![0] as Placed).at).toBe("src/page.tsx:8");
    fireEvent.click(layer(), { clientX: 25, clientY: 180 });
    expect((onSelect.mock.calls[1]![0] as Placed).place.name).toBe("Panel");
    fireEvent.pointerLeave(layer());
    expect(document.querySelector("[data-place-label]")).toBeNull();
  });

  test("in Elements a point inside a plain component reaches the element under it, not the component", () => {
    const onSelect = vi.fn();
    show("elements", null, onSelect);
    fireEvent.click(layer(), { clientX: 25, clientY: 180 });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  test("a pick from the address lights every box it names, placed as shares of the page, and brings the first into view", () => {
    show("off", BUTTON);
    const lit = [...document.querySelectorAll<HTMLElement>("[data-place-lit]")];
    expect(lit).toHaveLength(2);
    expect([lit[0]!.style.left, lit[0]!.style.top, lit[0]!.style.width, lit[0]!.style.height]).toEqual(["10%", "20%", "10%", "8%"]);
    expect(lit[0]!.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("the snapshot carries each screen's places", () => {
  const dir = mkdtempSync(join(tmpdir(), "youi-places-snapshot-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a places file is copied under its content hash and named on its route; one that is not youiyoux.places/v1 is left out", () => {
    const screens = join(dir, "screens");
    const data = join(dir, "data");
    mkdirSync(screens, { recursive: true });
    writeFileSync(join(screens, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "test", capturedAt: "2026-10-22", viewport: { width: 1000, height: 500 }, screens: [{ route: "/", path: "/" }, { route: "/other", path: "/other" }] }));
    writeFileSync(join(screens, "root.places.json"), JSON.stringify(places));
    writeFileSync(join(screens, "other.places.json"), JSON.stringify({ schema: "something/else" }));
    const shots = writeScreens(screens, data, "app");
    const root = shots.screens.find((s) => s.route === "/")!;
    expect(root.places).toMatch(/^app\.places\.[0-9a-f]+\.json$/);
    expect(JSON.parse(readFileSync(join(data, root.places!), "utf8"))).toEqual(places);
    expect(shots.screens.find((s) => s.route === "/other")!.places).toBeUndefined();
    expect(readdirSync(data).filter((f) => f.includes("places"))).toEqual([root.places]);
  });
});

describe("request pins on the picture", () => {
  test("each pin is a button at its box, numbered, that opens its request without picking what is under it", () => {
    const onSelect = vi.fn();
    const onPin = vi.fn();
    render(<PlacesOverlay shot={null} scheme="light" label="app /" places={places} placed={placed} outline="all" select={null} pointed={null} nameOf={(p) => p.place.name} onSelect={onSelect} pins={[{ id: "r-0000000001", number: 1, box: { x: 100, y: 100 }, status: "open" }, { id: "r-0000000002", number: 2, box: { x: 300, y: 100 }, status: "addressed" }]} activePin="r-0000000002" onPin={onPin} />);
    const pins = [...document.querySelectorAll<HTMLButtonElement>("[data-pin]")];
    expect(pins.map((p) => [p.textContent, p.getAttribute("aria-label"), p.getAttribute("aria-pressed"), p.style.left, p.style.top])).toEqual([
      ["1", "Request 1 (open)", "false", "10%", "20%"],
      ["2", "Request 2 (addressed)", "true", "30%", "20%"],
    ]);
    fireEvent.click(pins[0]!);
    expect(onPin).toHaveBeenCalledWith("r-0000000001");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
