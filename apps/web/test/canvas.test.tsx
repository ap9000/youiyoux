// @vitest-environment jsdom
/** The Screens canvas: every screen on one board, pins for its requests, and zoom that keeps its point. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { RequestDoc } from "@youiyoux/core";
import { fitView, MAX_SCALE, MIN_SCALE, ScreensCanvas, zoomAt } from "../src/screens/screens/ScreensCanvas.tsx";
import type { Screen, ScreenIndex } from "../src/data/screens.ts";
import { NO_ISSUES } from "../src/data/screens.ts";

afterEach(cleanup);

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
  });

  test("a pin opens its request on the screen's page; + − and 0 zoom and fit, and zoomed in the full pictures are drawn", () => {
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
    expect(window.location.pathname + window.location.search).toBe("/screens/app/settings?request=r-0000000001");
  });
});
