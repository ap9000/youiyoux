// @vitest-environment jsdom
/** Live screens on the canvas: the app framed and greeted, its bridge's answers read only from it, and commenting on it as on a picture. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bridgeSnippet, routeAt } from "../src/data/live.ts";
import { GIVE_UP_MS, HELLO_EVERY_MS, LiveScreen, REPLY_MS } from "../src/screens/screens/LiveScreen.tsx";
import { LIVE_AT_ONCE, ScreensCanvas } from "../src/screens/screens/ScreensCanvas.tsx";
import { NO_ISSUES, type Screen, type ScreenIndex } from "../src/data/screens.ts";
import type { Site } from "../src/data/usage.ts";

const APP = "http://127.0.0.1:3000";
const BUTTON = "youi:demo/component/button";
const SCREENS = [{ route: "/settings", path: "/settings" }, { route: "/", path: "/" }];
const site = { element: BUTTON, kind: "render", export: "Button", local: "Button", file: "src/settings.tsx", line: 8, column: 3 } as Site;
const VIEW = { youiyoux: 1, type: "view", path: "/settings", scroll: { x: 0, y: 100 }, viewport: { width: 1440, height: 900 }, page: { width: 1440, height: 2000 } };
const RAW = { name: "Button", owner: "Settings", frames: [{ url: `${APP}/src/settings.tsx?t=1`, line: 40, column: 9 }], box: { x: 100, y: 300, width: 120, height: 40 }, depth: 3 };

let resolved: unknown[];
beforeEach(() => {
  resolved = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    resolved.push(JSON.parse(String(init?.body)));
    expect(new URL(String(input), "http://localhost/").pathname).toBe("/api/live/resolve");
    return new Response(JSON.stringify({ places: [{ ...RAW, file: "src/settings.tsx", line: 8, column: 3 }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  sessionStorage.setItem("youiyoux.editor-key", "k-test");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function show(props: Partial<Parameters<typeof LiveScreen>[0]> = {}) {
  const onPick = vi.fn();
  render(<LiveScreen url={`${APP}/settings`} viewport={{ width: 1440, height: 900 }} width={360} screens={SCREENS} route="/settings" commenting={false} sites={{ sites: [site], lookalikes: [] }} nameOf={(p) => (p.element === BUTTON ? "Button" : p.place.name)} picking={false} onPick={onPick} requests={[]} onPin={() => undefined} {...props} />);
  const frame = document.querySelector("iframe")!;
  const posted = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => undefined);
  const from = (data: unknown, origin = APP, source: Window | null = frame.contentWindow) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, origin, source })));
  return { frame, posted, from, onPick, state: () => document.querySelector("[data-live]")!.getAttribute("data-live") };
}

describe("the running app in a card", () => {
  test("is framed at the screen's address and greeted until its bridge answers; answers from another origin or frame are not read", () => {
    vi.useFakeTimers();
    const { frame, posted, from, state } = show();
    expect(frame.getAttribute("src")).toBe(`${APP}/settings`);
    // The captured viewport, scaled to the card.
    expect(frame.style.width).toBe("1440px");
    expect(frame.style.transform).toBe("scale(0.25)");
    act(() => void vi.advanceTimersByTime(HELLO_EVERY_MS));
    expect(posted).toHaveBeenCalledWith({ youiyoux: 1, type: "hello" }, APP);
    from(VIEW, "http://127.0.0.1:4000");
    from(VIEW, APP, window);
    expect(state()).toBe("connecting");
    from(VIEW);
    expect(state()).toBe("live");
  });

  test("an app that never answers says how to connect it: one line that loads the bridge only on this machine, inside the hub", () => {
    vi.useFakeTimers();
    const { state } = show();
    act(() => void vi.advanceTimersByTime(GIVE_UP_MS + HELLO_EVERY_MS));
    expect(state()).toBe("no-bridge");
    fireEvent.click(screen.getByRole("button", { name: "How to connect it" }));
    const dialog = screen.getByRole("dialog", { name: "Connect the running app" });
    expect(dialog.textContent).toContain(`${location.origin}/api/live/bridge.js`);
    // A strict app refuses to be framed until it allows the hub in development: the help says how.
    expect(dialog.querySelector("[data-live-policy]")!.textContent).toContain(`frame-ancestors ${location.origin}`);
    expect(bridgeSnippet("http://localhost:5173")).toMatch(/window\.parent !== window && \/\^\(localhost\|127/);
  });
});

describe("commenting on a live screen", () => {
  test("the component under the pointer is asked of the bridge, named with its line from the service, and a click picks it on the screen the page shows", async () => {
    const { posted, from, onPick } = show({ commenting: true });
    from(VIEW);
    const layer = document.querySelector<HTMLElement>("[data-live-layer]")!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 360, height: 225, right: 360, bottom: 225, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(layer, { clientX: 40, clientY: 55 });
    // The card's pixels are the page's viewport pixels, scaled.
    expect(posted).toHaveBeenLastCalledWith({ youiyoux: 1, type: "at", id: 1, x: 160, y: 220 }, APP);
    from({ ...VIEW, type: "at", id: 1, react: true, dev: true, places: [RAW] });
    await waitFor(() => expect(document.querySelector("[data-place-label]")?.textContent).toBe("Button"));
    // Placed where the page is scrolled to: 300 down the page is 200 down the viewport.
    expect(document.querySelector<HTMLElement>('[data-live-box="hover"]')!.style.top).toBe(`${(200 / 900) * 100}%`);
    expect(resolved).toEqual([{ places: [RAW] }]);
    fireEvent.click(layer, { clientX: 40, clientY: 55 });
    from({ ...VIEW, type: "at", id: 2, react: true, dev: true, places: [RAW] });
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    const [placed, page, at, route] = onPick.mock.calls[0]!;
    expect(placed).toMatchObject({ element: BUTTON, at: "src/settings.tsx:8" });
    expect([page, at.clientX, route]).toEqual([{ width: 1440, height: 2000 }, 40, "/settings"]);
    // The line was found once for these frames, and kept.
    expect(resolved).toHaveLength(1);
  });

  test("a pick comes with a handle on the component in the page: asked by name and box, answered only by its own reply; plain HTML gets none", async () => {
    const { posted, from, onPick } = show({ commenting: true });
    from(VIEW);
    const layer = document.querySelector<HTMLElement>("[data-live-layer]")!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 360, height: 225, right: 360, bottom: 225, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(layer, { clientX: 40, clientY: 55 });
    from({ ...VIEW, type: "at", id: 1, react: true, dev: true, places: [RAW] });
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    const live = onPick.mock.calls[0]![4] as import("../src/data/live.ts").LiveHandle;
    const asking = live.ask(["variant"]);
    const question = posted.mock.calls.at(-1)![0] as { id: number };
    expect(question).toEqual({ youiyoux: 1, type: "props", ask: ["variant"], name: "Button", box: RAW.box, id: question.id });
    // Another frame's answer, or one to another question, is not this one's.
    from({ youiyoux: 1, type: "props", id: question.id, editable: true, why: null, found: true, props: { variant: "evil" }, text: null }, APP, window);
    from({ youiyoux: 1, type: "props", id: question.id + 1, editable: true, why: null, found: true, props: { variant: "other" }, text: null });
    from({ youiyoux: 1, type: "props", id: question.id, editable: true, why: null, found: true, props: { variant: "outline" }, text: "Save" });
    expect(await asking).toEqual({ editable: true, why: null, found: true, props: { variant: "outline" }, text: "Save" });
    live.reset();
    expect(posted).toHaveBeenLastCalledWith({ youiyoux: 1, type: "reset" }, APP);
    onPick.mockClear();
    fireEvent.click(layer, { clientX: 40, clientY: 55 });
    from({ ...VIEW, type: "at", id: 2, react: true, dev: true, places: [{ ...RAW, name: 'button "Approve"', html: "button" }] });
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(onPick.mock.calls[0]![4]).toBeNull();
  });

  test("an app that never answers a question about a component is not editable, and an edit it never confirms is not done", async () => {
    vi.useFakeTimers();
    const { from, onPick } = show({ commenting: true });
    from(VIEW);
    const layer = document.querySelector<HTMLElement>("[data-live-layer]")!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 360, height: 225, right: 360, bottom: 225, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(layer, { clientX: 40, clientY: 55 });
    from({ ...VIEW, type: "at", id: 1, react: true, dev: true, places: [RAW] });
    await vi.waitFor(() => expect(onPick).toHaveBeenCalled());
    const live = onPick.mock.calls[0]![4] as import("../src/data/live.ts").LiveHandle;
    const asking = live.ask(["variant"]);
    const editing = live.edit({ variant: "ghost" }, null);
    act(() => void vi.advanceTimersByTime(REPLY_MS + 1));
    expect(await asking).toMatchObject({ editable: false, found: false, why: expect.stringMatching(/didn't answer/) });
    expect(await editing).toMatchObject({ ok: false });
  });

  test("a page that is not a captured screen says so, and is not asked about", () => {
    const { posted, from } = show({ commenting: true });
    from({ ...VIEW, path: "/somewhere-else" });
    expect(document.querySelector("[data-live-note]")!.textContent).toContain("/somewhere-else");
    posted.mockClear();
    fireEvent.click(document.querySelector("[data-live-layer]")!, { clientX: 10, clientY: 10 });
    expect(posted).not.toHaveBeenCalled();
  });

  test("a path is the screen whose address it is, with or without a trailing slash or a query", () => {
    expect(routeAt(SCREENS, "/settings")).toBe("/settings");
    expect(routeAt(SCREENS, "/settings/?tab=2")).toBe("/settings");
    expect(routeAt(SCREENS, "/billing")).toBeNull();
  });
});

describe("live screens on the canvas", () => {
  const scr = (project: string, route: string): Screen => ({ project, route, slug: route, sites: 0, elements: [], violations: [], lookalikes: [], unresolved: [], notRun: [], issues: NO_ISSUES, shot: { route, path: route, light: { full: "x.webp", thumb: "x.thumb.webp" } } }) as unknown as Screen;
  const routes = ["/", "/a", "/b", "/c", "/d", "/uncaptured"];
  const index = { screens: [...routes.map((r) => scr("app", r)), scr("site", "/")] } as unknown as ScreenIndex;
  const live = { project: "app", base: APP, viewport: { width: 1440, height: 900 }, screens: routes.filter((r) => r !== "/uncaptured").map((route) => ({ route, path: route })) };

  test("the served product's captured screens can run live, at most a few at once; turning on one more stops the first", () => {
    render(<ScreensCanvas screens={index} scheme="light" requests={[]} live={live} />);
    const toggle = (key: string) => document.querySelector<HTMLElement>(`[data-canvas-screen="${key}"] [data-live-toggle]`);
    expect(toggle("site:/")).toBeNull();
    expect(toggle("app:/uncaptured")).toBeNull();
    for (const route of ["/", "/a", "/b", "/c", "/d"]) fireEvent.click(toggle(`app:${route}`)!);
    const running = [...document.querySelectorAll<HTMLIFrameElement>("iframe")].map((f) => f.getAttribute("src"));
    expect(running).toHaveLength(LIVE_AT_ONCE);
    expect(running).toEqual([`${APP}/a`, `${APP}/b`, `${APP}/c`, `${APP}/d`]);
    expect(toggle("app:/")!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle("app:/a")!);
    expect(document.querySelectorAll("iframe")).toHaveLength(LIVE_AT_ONCE - 1);
  });

  test("without the service, or before a capture recorded where the app runs, nothing offers to run live", () => {
    const { unmount } = render(<ScreensCanvas screens={index} scheme="light" requests={[]} live={null} />);
    expect(document.querySelector("[data-live-toggle]")).toBeNull();
    unmount();
    render(<ScreensCanvas screens={index} scheme="light" requests={[]} live={{ ...live, base: null, why: "no base" }} />);
    expect(document.querySelector("[data-live-toggle]")).toBeNull();
  });
});
