// @vitest-environment jsdom
/** The Screens canvas: every screen on one board, pins for its requests, zoom that keeps its point, and commenting on a component where it is. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RequestDoc } from "@youiyoux/core";
import { fitView, MAX_SCALE, MIN_SCALE, ScreensCanvas, zoomAt } from "../src/screens/screens/ScreensCanvas.tsx";
import type { Screen, ScreenIndex } from "../src/data/screens.ts";
import { NO_ISSUES } from "../src/data/screens.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const shot = (name: string) => ({ route: "", path: "/", light: { full: `${name}.full.webp`, thumb: `${name}.thumb.webp` } });
const scr = (project: string, route: string, pictured = true): Screen => ({ project, route, slug: route, sites: 0, elements: [], violations: [], lookalikes: [], unresolved: [], issues: NO_ISSUES, shot: pictured ? shot(`${project}${route.replace(/\W/g, "-")}`) : null }) as unknown as Screen;
const index = { screens: [scr("app", "/"), scr("app", "/settings"), scr("app", "/empty", false), scr("site", "/")] } as unknown as ScreenIndex;
const AT = "2026-10-22T12:00:00.000Z";
const request = (id: string, route: string, status: RequestDoc["status"], project = "app"): RequestDoc => ({ schema: "youi.request/v1", id, project, kind: "change", status, body: `ask ${id}`, author: { kind: "person", name: "you" }, createdAt: id, updatedAt: AT, target: { route, scope: "here", name: "Button", box: { x: 144, y: 90, width: 10, height: 10 }, page: { width: 1440, height: 900 } }, thread: [] });

describe("zoom and fit", () => {
  test("zooming keeps the board point under the pointer where it is, within its limits", () => {
    const view = zoomAt({ x: 100, y: 50, scale: 1 }, 2, 300, 250);
    expect(view).toEqual({ scale: 2, x: -100, y: -150 });
    // The board point under (300, 250) was (200, 200) and still is.
    expect([(300 - view.x) / view.scale, (250 - view.y) / view.scale]).toEqual([200, 200]);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 100, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0.0001, 0, 0).scale).toBe(MIN_SCALE);
  });

  test("fit shows the whole board centred, never enlarged", () => {
    expect(fitView({ width: 2000, height: 500 }, { width: 1064, height: 800 })).toEqual({ scale: 0.5, x: 32, y: 275 });
    expect(fitView({ width: 300, height: 200 }, { width: 1064, height: 800 }).scale).toBe(1);
  });
});

describe("the board", () => {
  test("each project is a row of its screens; each screen links to its page and carries its requests as pins", () => {
    render(<ScreensCanvas screens={index} scheme="light" requests={[request("r-0000000002", "/settings", "addressed"), request("r-0000000001", "/settings", "open"), request("r-0000000003", "/settings", "closed"), request("r-0000000004", "/", "open", "site")]} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["app", "site"]);
    expect([...document.querySelectorAll("[data-canvas-screen]")].map((s) => s.getAttribute("data-canvas-screen"))).toEqual(["app:/", "app:/settings", "app:/empty", "site:/"]);
    const settings = document.querySelector<HTMLElement>('[data-canvas-screen="app:/settings"]')!;
    // Numbered oldest first, at their box as shares of the page; closed ones are not counted as open.
    const pins = [...settings.querySelectorAll<HTMLElement>("[data-canvas-pin]")];
    expect(pins.map((p) => [p.textContent, p.getAttribute("data-canvas-pin"), p.style.left, p.style.top])).toEqual([
      ["1", "r-0000000001", "10%", "10%"],
      ["2", "r-0000000002", "10%", "10%"],
      ["3", "r-0000000003", "10%", "10%"],
    ]);
    expect(settings.querySelector('[title$="requests"]')!.textContent).toBe("2");
    expect(settings.querySelector("a")!.getAttribute("href")).toBe("/screens/app/settings");
    expect(document.querySelector('[data-canvas-screen="app:/"] [data-canvas-pin]')).toBeNull();
    expect(document.querySelector('[data-canvas-screen="site:/"] [data-canvas-pin]')).not.toBeNull();
    expect(document.querySelector('[data-canvas-screen="app:/empty"]')!.textContent).toContain("No screenshot yet");
    // A project's screens wrap four to a row, so a long project still fits at a readable zoom.
    const row = document.querySelector<HTMLElement>('[data-canvas-screen="app:/"]')!.parentElement!;
    expect(row.style.width).toBe(`${4 * 360 + 3 * 48}px`);
    expect(row.className).toContain("flex-wrap");
  });

  test("+ − and 0 zoom and fit, and zoomed in the full pictures are drawn; a pin opens its thread on the board, which links to the screen's page", () => {
    window.history.replaceState(null, "", "/screens?view=canvas");
    render(<ScreensCanvas screens={index} scheme="light" requests={[request("r-0000000001", "/settings", "open")]} />);
    const zoom = (): string => document.querySelector("[data-zoom]")!.textContent!;
    const src = (): string => document.querySelector<HTMLImageElement>('[data-canvas-screen="app:/"] img')!.getAttribute("src")!;
    // jsdom lays out nothing: fit gives the smallest zoom, and the thumbnails.
    expect(zoom()).toBe(`${MIN_SCALE * 100}%`);
    expect(src()).toMatch(/thumb\.webp$/);
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: "+" });
    expect(zoom()).toBe("300%");
    expect(src()).toMatch(/full\.webp$/);
    fireEvent.keyDown(window, { key: "-" });
    expect(zoom()).toBe("240%");
    fireEvent.keyDown(window, { key: "0" });
    expect(zoom()).toBe("10%");
    fireEvent.click(document.querySelector("[data-canvas-pin]")!);
    expect(window.location.pathname + window.location.search).toBe("/screens?view=canvas");
    const bubble = screen.getByRole("dialog", { name: "Comment" });
    expect(within(bubble).getByText("ask r-0000000001")).toBeTruthy();
    expect(within(bubble).getByRole("textbox", { name: "Reply to request 1" })).toBeTruthy();
    expect(within(bubble).getByRole("link", { name: /app \/settings/ }).getAttribute("href")).toBe("/screens/app/settings?request=r-0000000001");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("commenting on the board", () => {
  const BUTTON = "youi:demo/component/button";
  const site = { element: BUTTON, kind: "render", export: "Button", local: "Button", file: "src/settings.tsx", line: 8, column: 3 };
  const places = {
    schema: "youiyoux.places/v1",
    route: "/settings",
    path: "/settings",
    viewport: { width: 1440, height: 900 },
    size: { width: 1440, height: 900 },
    dev: true,
    capped: false,
    places: [
      { name: "Panel", owner: "Page", file: "src/settings.tsx", line: 4, column: 3, box: { x: 0, y: 0, width: 800, height: 600 }, depth: 0 },
      { name: "Button", owner: "Page", file: "src/settings.tsx", line: 8, column: 3, box: { x: 100, y: 100, width: 120, height: 40 }, depth: 1 },
    ],
  };
  const settings = { ...scr("app", "/settings"), elements: [{ id: BUTTON, sites: [site] }], shot: { ...shot("app-settings"), places: "app-settings.places.json" } } as unknown as Screen;
  const board = { screens: [scr("app", "/"), settings] } as unknown as ScreenIndex;
  let posts: Array<{ path: string; body: unknown }>;
  const present = <T,>(el: T | null): T => {
    expect(el).not.toBeNull();
    return el!;
  };

  beforeEach(() => {
    posts = [];
    // Every box is drawn at the page's own size, from the top left: a point on the layer is that point on the page.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      if (path.endsWith(".places.json")) return new Response(JSON.stringify(places), { status: 200, headers: { "content-type": "application/json" } });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ path, body });
      return new Response(JSON.stringify({ ...request("r-00000000aa", "/settings", "open"), ...(body as object) }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    sessionStorage.setItem("youiyoux.editor-key", "k-test");
    window.history.replaceState(null, "", "/screens?view=canvas");
  });

  test("C turns it on: a click on a component opens a comment there, filed with the component's file, line and box; Esc stops", async () => {
    const onRequest = vi.fn();
    render(<ScreensCanvas screens={board} scheme="light" requests={[]} onRequest={onRequest} nameOf={(id) => (id === BUTTON ? "Button" : id)} />);
    const card = (): HTMLElement => document.querySelector<HTMLElement>('[data-canvas-screen="app:/settings"]')!;
    expect(card().querySelector("a[aria-label]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "c" });
    expect(screen.getByRole("button", { name: /Comment/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/Click a component on any screen/);
    // The picture is no longer a link to the screen's page, and its components load to be picked.
    expect(card().querySelector("a[aria-label]")).toBeNull();
    const layer = await waitFor(() => present(card().querySelector<HTMLElement>("[data-places-layer]")));
    fireEvent.click(layer, { clientX: 150, clientY: 120 });
    const bubble = screen.getByRole("dialog", { name: "Comment" });
    expect(bubble.textContent).toContain("Button on /settings");
    expect(bubble.textContent).toContain("src/settings.tsx:8");
    expect(card().querySelector("[data-place-lit]")!.getAttribute("data-place")).toBe(BUTTON);
    expect(within(bubble).getByRole("radio", { name: "Every Button" })).toBeTruthy();
    fireEvent.change(within(bubble).getByRole("textbox", { name: "What should change" }), { target: { value: "Make it primary" } });
    fireEvent.click(within(bubble).getByRole("button", { name: "File change request" }));
    await waitFor(() => expect(onRequest).toHaveBeenCalled());
    expect(posts).toEqual([
      { path: "/api/requests", body: { kind: "change", body: "Make it primary", target: { route: "/settings", scope: "here", name: "Button", element: BUTTON, file: "src/settings.tsx", line: 8, box: { x: 100, y: 100, width: 120, height: 40 }, page: { width: 1440, height: 900 } } } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Still commenting after one; Esc stops, and the picture is a link again.
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(card().querySelector("a[aria-label]")).not.toBeNull();
  });

  test("a pan that ends over a component opens nothing; a screen with no component positions says how to get them", async () => {
    render(<ScreensCanvas screens={board} scheme="light" requests={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Comment/ }));
    expect(document.querySelector('[data-canvas-screen="app:/"] [data-canvas-unplaced]')!.textContent).toContain("youiyoux screens capture");
    const layer = await waitFor(() => present(document.querySelector<HTMLElement>('[data-canvas-screen="app:/settings"] [data-places-layer]')));
    const region = screen.getByRole("region", { name: /Every screen on one board/ });
    fireEvent.pointerDown(region, { button: 0, clientX: 150, clientY: 120 });
    fireEvent.pointerMove(region, { clientX: 260, clientY: 180 });
    fireEvent.pointerUp(region);
    fireEvent.click(layer, { clientX: 260, clientY: 180 });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(() => new Promise((done) => setTimeout(done, 0)));
    // The next click is a click again.
    fireEvent.click(layer, { clientX: 150, clientY: 120 });
    expect(screen.getByRole("dialog", { name: "Comment" })).toBeTruthy();
  });
});
