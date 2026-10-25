// @vitest-environment jsdom
/**
 * The Discover page (c1–c4), over the recorded fixture catalog: search by need through
 * /__youi/query (the real middleware) or the snapshot's listings on a static host, nothing
 * fetched for a candidate until it is opened; an opened one drawn in the project's theme with
 * what could not be themed; a pinned Inventory family compared beside it with the slider; and
 * Save to Library / Add to my project as drafts, refusing adoption when the licence is unknown.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InventoryReport as InventorySchema, type LibraryEntry } from "@youiyoux/core";
import * as discover from "../../../packages/discover/src/index.ts";
import { buildInventory } from "../../../packages/scanner/src/inventory/inventory.ts";
import { discoverFixture } from "../scripts/discover-fixture.ts";
import { queryMiddleware } from "../scripts/query-server.ts";
import { writeDiscover } from "../scripts/snapshot.ts";
import { compact, parseQuery, queryToSearch, resetDiscoverSource, searchListings, signalLines, type ListingsFile } from "../src/data/discover.ts";
import { cleanMarkup, onlyCustomProperties, previewRequests, setDrawn, type PreviewAnswer } from "../src/data/discover-preview.ts";
import { resetThumbs, type Thumbs } from "../src/data/discover-thumbs.ts";
import { memorySource, type InventorySource } from "../src/data/inventory-source.ts";
import type { Resource } from "../src/data/store.ts";
import { siteOf } from "../src/screens/discover/CandidatePanel.tsx";
import { pageScale } from "../src/screens/discover/PagePreview.tsx";
import { pinnedRows } from "../src/screens/discover/PinnedCompare.tsx";
import { DiscoverView } from "../src/screens/discover/DiscoverScreen.tsx";
import { SpecimenCapture } from "../src/screens/discover/SpecimenCapture.tsx";
import { InventoryView } from "../src/screens/inventory/InventoryScreen.tsx";

const TOOL = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(TOOL, "packages/scanner/test/fixtures/inventory");
const scratch = mkdtempSync(join(tmpdir(), "youi-discover-page-"));
let cache: string;
let middleware: ReturnType<typeof queryMiddleware>;
let listingsFile: string;
let inventory: InventorySource;
const NONE: Resource<InventorySource | null> = { status: "ready", value: null };

beforeAll(async () => {
  ({ cache } = await discoverFixture(join(scratch, "discover")));
  middleware = queryMiddleware({ cache, index: join(cache, "index.db"), env: {} });
  listingsFile = (await writeDiscover(join(scratch, "data"), cache, discover))!;
  inventory = memorySource(InventorySchema.parse(await buildInventory([join(FIXTURES, "console"), join(FIXTURES, "site")], { cwd: TOOL })));
}, 60_000);
afterAll(async () => {
  await discover.closeSharedStores();
  rmSync(scratch, { recursive: true, force: true });
});

/** The query middleware answering one request, as a fetch Response. */
function viaMiddleware(url: URL): Promise<Response> {
  return new Promise((done) => {
    let headers: Record<string, string> = {};
    const res = { statusCode: 200, setHeader: (name: string, value: string) => (headers = { ...headers, [name]: value }), end: (body: string) => done(new Response(body, { status: res.statusCode, headers })) };
    void middleware({ url: `${url.pathname}${url.search}`, method: "GET", headers: { host: "localhost:5173" } } as unknown as IncomingMessage, res as unknown as ServerResponse, () => done(new Response("not found", { status: 404 })));
  });
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function entryOf(id: string): Promise<LibraryEntry> {
  return (await discover.findListing(cache, id)).entry;
}

/** A preview answer as the server gives it (its own tests check the real one), for an entry. */
function answerFor(entry: LibraryEntry, extra: Partial<PreviewAnswer> = {}): PreviewAnswer {
  const license = entry.license && entry.license !== "unknown" ? entry.license.spdx : "unknown";
  return {
    id: entry.id,
    name: entry.name,
    entry,
    project: "console",
    script: `/__youi/discover-preview/${"a".repeat(16)}.js`,
    css: { light: `/__youi/discover-preview/${"b".repeat(16)}.css`, dark: `/__youi/discover-preview/${"c".repeat(16)}.css` },
    html: "",
    compose: { export: "Button", props: {}, children: ["Button"] },
    fit: { themed: ["rounded-md draws with your --radius-md: 8px (Tailwind's default is 6px)", "type face: your --font-sans (Console Mono)"], unthemed: ["16px type (text-base), project uses 14px (text-sm)", "bg-popover: your theme has no --color-popover, so it draws with no colour"], type: { item: 16, project: 14 }, radius: 8 },
    notes: ["cn: your src/lib/utils.ts"],
    parts: [{ name: "dialog", from: "fetched", detail: "dialog: the registry's own @shadcn/dialog, fetched (your project has none)" }],
    implicitDeps: ["lucide-react"],
    error: null,
    install: entry.install ? { command: entry.install.command, npm: entry.install.npm } : null,
    license,
    fetched: true,
    ms: 900,
    // As the server says: a block is drawn as a page.
    page: entry.kind === "pattern",
    ...extra,
  };
}

let calls: string[];
let drafts: unknown[];
let service: "up" | "down";
/** What `/__youi/discover-thumbs` answers: none by default, as a hub before `youiyoux discover previews`. */
let thumbs: Thumbs | null;

beforeEach(() => {
  calls = [];
  drafts = [];
  service = "up";
  thumbs = null;
  resetDiscoverSource();
  resetThumbs();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:5173/");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/__youi/query") return viaMiddleware(url);
      if (url.pathname === "/__youi/discover-preview") return json(answerFor(await entryOf(url.searchParams.get("id")!)));
      if (url.pathname === "/__youi/discover-thumbs") return thumbs ? json(thumbs) : new Response("not found", { status: 404 });
      if (url.pathname === "/api/info") return service === "up" ? json({ schema: "youiyoux.workflow/v1", kinds: ["rule", "style", "library"] }) : new Response("<html>", { status: 502, headers: { "Content-Type": "text/html" } });
      if (url.pathname === "/api/drafts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { content: { request: string; entry: LibraryEntry } };
        drafts.push(body);
        if (body.content.request === "adopt" && body.content.entry.license === "unknown") return json({ error: "its licence is unknown", code: "invalid" }, 422);
        return json({ id: "d-0123456789", kind: "library", status: "draft" }, 201);
      }
      return new Response("not found", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const previewCalls = (): string[] => calls.filter((c) => c.startsWith("/__youi/discover-preview"));
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-hit="${id}"]`)!;

function show(search: string, source: Resource<InventorySource | null> = NONE) {
  window.history.replaceState(null, "", `/discover${search}`);
  return render(<DiscoverView inventory={source} />);
}

describe("search by need (c1)", () => {
  test("'command menu' lists candidates with licence or 'licence unknown', signals and the install command, and fetches nothing for any of them", async () => {
    show("?q=command%20menu");
    await waitFor(() => expect(card("lib:shadcn/component/command")).not.toBeNull());
    const shadcn = card("lib:shadcn/component/command");
    expect(text(shadcn)).toContain("MIT");
    expect(text(shadcn)).toContain("42M/wk via cmdk");
    expect(within(shadcn).getByText("npx shadcn add command")).toBeTruthy();
    // coss is AGPL-3.0: a known licence, marked as copyleft.
    const coss = card("lib:coss/component/command");
    expect(within(coss).getByText("AGPL-3.0 · copyleft").getAttribute("title")).toMatch(/^Copyleft: /);
    expect(within(shadcn).queryByText(/copyleft/)).toBeNull();
    expect(within(coss).getByText("npx shadcn add @coss/command")).toBeTruthy();
    expect(calls.filter((c) => c.startsWith("/__youi/query"))[0]).toMatch(/kind=discover.*q=command\+menu/);
    // Listings only: no preview asked for, and nothing written under the cache's source/ or preview/ for them.
    expect(previewCalls()).toEqual([]);
    expect(previewRequests).toEqual([]);
    expect(readFileSync(join(cache, "index.json"), "utf8")).not.toMatch(/"content":/);
  });

  test("facets narrow by role, source, licence known or unknown, headless or styled, and live in the URL; 'seen on' is later", async () => {
    show("?q=command%20menu");
    await waitFor(() => expect(card("lib:shadcn/component/command")).not.toBeNull());
    const facets = document.querySelector<HTMLElement>("[data-facets]")!;
    expect([...facets.querySelectorAll("legend")].map(text)).toEqual(["Role", "Source", "Licence", "Style", "Seen on"]);
    expect(within(facets).getByText("Later: which sites you know use it.")).toBeTruthy();
    fireEvent.click(within(facets).getByRole("button", { name: /^Unknown/ }));
    await waitFor(() => expect(card("lib:shadcn/component/command")).toBeNull());
    expect(window.location.search).toContain("licence=unknown");
    expect([...document.querySelectorAll<HTMLElement>("[data-hit]")].every((hit) => text(hit).includes("licence unknown"))).toBe(true);
    expect(calls.some((c) => c.includes("licence=unknown"))).toBe(true);
    expect(parseQuery("?q=x&role=button&source=%40shadcn&licence=known&style=styled&family=button-1&open=lib%3Ax&offset=20")).toEqual({ q: "x", role: "button", source: "@shadcn", licence: "known", style: "styled", family: "button-1", open: "lib:x", view: null, offset: 20 });
    expect(queryToSearch(parseQuery("?licence=bogus&style=nope&q=a"))).toBe("?q=a");
  });

  test("a static host has no /__youi/query: the snapshot's listings are searched in memory, and still nothing is fetched for a candidate", async () => {
    const listings = JSON.parse(readFileSync(join(scratch, "data", listingsFile), "utf8")) as ListingsFile;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost:5173/");
        calls.push(url.pathname);
        if (url.pathname === "/__youi/query") return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        if (url.pathname === "/data/manifest.json") return json({ schema: "youiyoux.manifest/v1", source: { commit: null }, systems: [], discover: listingsFile });
        if (url.pathname === `/data/${listingsFile}`) return json(listings);
        return new Response("not found", { status: 404 });
      }),
    );
    show("?q=command%20menu");
    await waitFor(() => expect(card("lib:shadcn/component/command")).not.toBeNull());
    expect(text(document.querySelector("[data-results-summary]")!)).toContain("from this snapshot's listings");
    expect(text(card("lib:shadcn/component/command"))).toContain("42M/wk via cmdk");
    expect(text(card("lib:coss/component/command"))).toContain("AGPL-3.0 · copyleft");
    expect(calls.filter((c) => c.includes("discover-preview"))).toEqual([]);
    // The in-memory search: by need, facets counted before paging.
    const page = searchListings(listings, { ...parseQuery("?q=command"), licence: "known" }, 2);
    expect(page.hits.length).toBeLessThanOrEqual(2);
    expect(page.hits.every((h) => h.license !== "unknown")).toBe(true);
    expect(page.facets.licence.unknown).toBeUndefined();
    expect(listings.entries.every((e) => !("content" in e))).toBe(true);
  });

  test("signals read plainly", () => {
    expect(compact(41_566_267)).toBe("42M");
    expect(compact(3_834_761)).toBe("3.8M");
    expect(compact(57_296)).toBe("57k");
    expect(signalLines({ signals: { via: { package: "cmdk", weeklyDownloads: 41_566_267 }, weeklyDownloads: null, stars: 22_637, pushedAt: null, archived: true } })).toEqual(["42M/wk via cmdk", "★ 23k", "archived"]);
  });
});

describe("an opened candidate, in the project's theme (c2)", () => {
  test("opening asks for that one item; it is drawn light and dark with the state strip and Try it, and says what could not be themed", async () => {
    show("?q=command%20menu");
    await waitFor(() => expect(card("lib:shadcn/component/command")).not.toBeNull());
    expect(previewCalls()).toEqual([]);
    fireEvent.click(within(card("lib:shadcn/component/command")).getByRole("button", { name: /^Preview Command in your theme/ }));
    const drawer = await screen.findByTestId("candidate-drawer");
    await waitFor(() => expect(previewCalls()).toEqual(["/__youi/discover-preview?id=lib%3Ashadcn%2Fcomponent%2Fcommand"]));
    // The bundle runs only in a hidden frame sandboxed allow-scripts, never same origin.
    const probe = await waitFor(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-draw-probe="lib:shadcn/component/command"]');
      expect(frame).not.toBeNull();
      return frame!;
    });
    expect(probe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(probe.getAttribute("srcdoc")).toMatch(/<script src="[^"]+\/__youi\/discover-preview\/a{16}\.js">/);
    // What it drew comes back by message, from that frame only, and is cleaned before use.
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: window, data: { youi: "try", type: "html", html: "<button>forged</button>" } })));
    expect(drawer.querySelector("[data-drawn]")).toBeNull();
    act(() => setDrawn("lib:shadcn/component/command", '<div class="rounded-md bg-popover" onclick="alert(1)"><input placeholder="Type a command"><script>alert(2)</script><a href="javascript:alert(3)">x</a></div>'));
    const drawn = await waitFor(() => {
      const element = drawer.querySelector<HTMLElement>("[data-drawn]");
      expect(element).not.toBeNull();
      return element!;
    });
    const tiles = [...drawn.querySelectorAll<HTMLElement>("[data-tile]")];
    expect(tiles.map((t) => t.dataset.tile)).toEqual(["lib:shadcn/component/command:light", "lib:shadcn/component/command:dark"]);
    const light = tiles[0]!.querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(light).toContain(`/__youi/discover-preview/${"b".repeat(16)}.css`);
    expect(light).not.toMatch(/<script|onclick|javascript:/);
    expect(tiles[1]!.querySelector("iframe")!.getAttribute("srcdoc")).toContain(`/__youi/discover-preview/${"c".repeat(16)}.css`);
    expect(within(tiles[0]!).getByRole("button", { name: /^Try / })).toBeTruthy();
    expect(drawn.querySelector("[data-strip]")).not.toBeNull();
    expect(text(drawer.querySelector('[data-fit="themed"]')!)).toContain("rounded-md draws with your --radius-md: 8px");
    expect(text(drawer.querySelector('[data-fit="unthemed"]')!)).toContain("16px type (text-base), project uses 14px (text-sm)");
    expect(text(drawer.querySelector("[data-implicit]")!)).toBe("Imports without declaring: lucide-react (an install would need it too)");
    expect(cleanMarkup('<img src="https://tracker.example/x.png" style="background:url(https://x)"><style>@import url(https://x)</style>')).toBe('<img src="">');
  });
});

describe("an opened block, drawn as the page it is", () => {
  const id = "lib:shadcn/pattern/dashboard-01";
  test("one large frame at a desktop's size, then a phone's, light or dark, live on Try it and full size in a dialog; the hidden frame stays until the drawing settles", async () => {
    // jsdom lays nothing out: the drawer is 640px wide here.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    try {
      show(`?open=${encodeURIComponent(id)}`);
      const drawer = await screen.findByTestId("candidate-drawer");
      // The page is laid out in a page-sized frame, at full width, not shrink-wrapped.
      const probe = await waitFor(() => {
        const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-draw-probe="${id}"]`);
        expect(frame).not.toBeNull();
        return frame!;
      });
      expect([probe.style.width, probe.style.height]).toEqual(["1280px", "768px"]);
      expect(probe.getAttribute("srcdoc")).toContain('id="youi-specimen" style="display:block;min-height:100vh"');
      // A first drawing shows at once; the frame stays until the settled one (a chart still animating in).
      act(() => setDrawn(id, '<main class="flex min-h-svh"><aside>Sidebar</aside><section>Cards</section></main>', false));
      const frame = (): HTMLIFrameElement => drawer.querySelector<HTMLIFrameElement>("iframe[data-page-frame]")!;
      await waitFor(() => expect(frame()).not.toBeNull());
      expect(document.querySelector(`iframe[data-draw-probe="${id}"]`)).not.toBeNull();
      act(() => setDrawn(id, '<main class="flex min-h-svh"><aside>Sidebar</aside><section>Cards, drawn</section></main>', true));
      await waitFor(() => expect(document.querySelector(`iframe[data-draw-probe="${id}"]`)).toBeNull());
      expect(frame().getAttribute("srcdoc")).toContain("Cards, drawn");
      // One frame, no light-and-dark tiles or state strip; scaled to the drawer (640 / 1280).
      expect(drawer.querySelectorAll("[data-tile]")).toHaveLength(0);
      expect(drawer.querySelector("[data-strip]")).toBeNull();
      expect(frame().dataset.pageFrame).toBe("desktop");
      expect(frame().style.transform).toBe("scale(0.5)");
      expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
      expect(frame().getAttribute("srcdoc")).not.toContain("<script");
      // A phone's width, then dark: the dark sheet.
      fireEvent.click(within(drawer).getByRole("radio", { name: "Phone" }));
      expect(frame().dataset.pageFrame).toBe("phone");
      expect(frame().style.width).toBe("390px");
      fireEvent.click(within(drawer).getByRole("radio", { name: "Dark" }));
      expect(frame().getAttribute("srcdoc")).toContain(`/__youi/discover-preview/${"c".repeat(16)}.css`);
      // Try it: the bundle, sandboxed allow-scripts only; Escape pressed inside it (the frame keeps the key) ends it.
      fireEvent.click(within(drawer).getByRole("button", { name: "Try it" }));
      expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame().getAttribute("srcdoc")).toMatch(/<script src="[^"]+\/__youi\/discover-preview\/a{16}\.js">/);
      act(() => void window.dispatchEvent(new MessageEvent("message", { source: window, data: { youi: "try", type: "escape" } })));
      expect(frame().dataset.live).toBe("true");
      act(() => void window.dispatchEvent(new MessageEvent("message", { source: frame().contentWindow, data: { youi: "try", type: "escape" } })));
      expect(frame().dataset.live).toBeUndefined();
      // Full size: a dialog of its own; closing it gives focus back.
      const open = within(drawer).getByRole("button", { name: "Show Dashboard 01 full size" });
      fireEvent.click(open);
      const full = await screen.findByTestId("page-fullscreen");
      expect(within(full).getByRole("heading", { name: "Dashboard 01" })).toBeTruthy();
      expect(full.querySelector("iframe[data-page-frame=phone]")).not.toBeNull();
      fireEvent.click(within(full).getByRole("button", { name: "Close full size" }));
      await waitFor(() => expect(screen.queryByTestId("page-fullscreen")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(open));
    } finally {
      width.mockRestore();
    }
  });

  test("a block that cannot be drawn says why and links to its registry's own site", async () => {
    const block = "lib:coss/pattern/p-command-2";
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input), "http://localhost:5173/").pathname === "/__youi/discover-preview" ? json(answerFor(await entryOf(block), { script: null, error: "it needs @tabler/icons-react, which is installed in neither your project nor the hub" })) : base(input, init))));
    show(`?q=command&open=${encodeURIComponent(block)}`);
    const drawer = await screen.findByTestId("candidate-drawer");
    const error = await waitFor(() => {
      const element = drawer.querySelector<HTMLElement>("[data-preview-error]");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(text(error)).toMatch(/^No drawing: it needs @tabler\/icons-react, which is installed in neither your project nor the hub\. Find p-command-2 on coss\.com, drawn as its authors made it\.$/);
    const link = error.querySelector<HTMLAnchorElement>("a[data-site-link]")!;
    expect([link.href, link.target, link.rel]).toEqual(["https://coss.com/ui", "_blank", "noreferrer noopener"]);
  });

  test("the site link is https only", () => {
    expect(siteOf("https://ui.shadcn.com")).toEqual({ href: "https://ui.shadcn.com/", host: "ui.shadcn.com" });
    expect(siteOf("http://ui.example.com")).toBeNull();
    expect(siteOf("javascript:alert(1)")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  test("a page fits the space it has, never above full size", () => {
    expect(pageScale("desktop", 640)).toBe(0.5);
    expect(pageScale("phone", 640, 560)).toBeCloseTo(560 / 844);
    expect(pageScale("phone", 2000, 2000)).toBe(1);
  });

  test("a drawing's style survives only when all it sets is custom properties, as a shadcn chart names its colours", () => {
    const chart = "[data-chart=chart-r1] {\n  --color-desktop: var(--chart-1);\n  --color-mobile: var(--chart-2);\n}\n.dark [data-chart=chart-r1] {\n  --color-desktop: var(--chart-1)\n}\n";
    expect(onlyCustomProperties(chart)).toBe(true);
    for (const css of ["a { color: red }", "a { --x: 1 } b { display: none }", "a { --x: url(https://x) }", "@import 'x'; a { --x: 1 }", "a { --x: \\75rl(x) }", "</style><script>"]) expect(onlyCustomProperties(css), css).toBe(false);
    expect(cleanMarkup(`<div data-chart="chart-r1"><style>${chart}</style><svg></svg></div><style>body { display: none }</style>`)).toBe(`<div data-chart="chart-r1"><style>${chart}</style><svg></svg></div>`);
  });
});

describe("pinned comparison (c3)", () => {
  test("Find alternatives on an Inventory family opens Discover with it pinned and its role chosen", async () => {
    window.history.replaceState(null, "", "/inventory");
    render(<InventoryView inventory={inventory} />);
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-family="button-1"]')!).getByRole("button", { name: /^Open / }));
    const link = await screen.findByRole("link", { name: /Find alternatives/ });
    expect(link.getAttribute("href")).toBe("/discover?role=button&family=button-1");
  });

  test("the family is pinned; an opened candidate is compared beside it with the slider (pointer and keys) and the attribute table", async () => {
    show("?role=button&family=button-1", { status: "ready", value: inventory });
    const pinned = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-pinned="button-1"]');
      expect(element && text(element)).toContain("Finding alternatives for Button · 32px · radius 8");
      return element!;
    });
    expect(pinned.querySelector("[data-tile]")).not.toBeNull();
    await waitFor(() => expect(card("lib:shadcn/component/button")).not.toBeNull());
    expect(previewCalls()).toEqual([]);
    const opener = within(card("lib:shadcn/component/button")).getByRole("button", { name: /^Preview Button in your theme/ });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(previewCalls()).toEqual(["/__youi/discover-preview?id=lib%3Ashadcn%2Fcomponent%2Fbutton&project=console"]));
    act(() => setDrawn("lib:shadcn/component/button", '<button class="rounded-md bg-primary">Button</button>'));
    const compare = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-pinned-compare="lib:shadcn/component/button"]');
      expect(element).not.toBeNull();
      return element!;
    });
    // Closing the drawer gives focus back to the result that opened it.
    fireEvent.keyDown(screen.getByTestId("candidate-drawer"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("candidate-drawer")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    const top = compare.querySelector<HTMLElement>('[data-layer="top"]')!;
    expect(top.style.clipPath).toBe("inset(0 0 0 50%)");
    const slider = within(compare).getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(top.style.clipPath).toBe("inset(0 0 0 55%)");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(top.style.clipPath).toBe("inset(0 0 0 0%)");
    expect(compare.querySelector('[data-layer="bottom"] [data-tile]')).not.toBeNull();
    expect(top.querySelector("[data-tile]")).not.toBeNull();
    const rows = [...compare.querySelectorAll("tbody tr")].map((row) => text(row.querySelector("th")!).replace(" (differs)", ""));
    expect(rows).toEqual(["Role", "Radius", "Type size", "Padding", "Colours", "Licence", "Source"]);
    fireEvent.click(within(compare).getByRole("radio", { name: "Side by side" }));
    expect(compare.querySelector('[data-testid="pinned-side-by-side"]')).not.toBeNull();
  });

  test("the attribute table compares the family's shape with what the candidate measured", async () => {
    const entry = await entryOf("@shadcn/button");
    const rows = pinnedRows({ role: "button", shape: { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 }, projects: ["console"] }, answerFor(entry), "Button");
    expect(rows.find((r) => r.label === "Radius")).toEqual({ label: "Radius", a: "8px", b: "8px", differs: false });
    expect(rows.find((r) => r.label === "Type size")).toEqual({ label: "Type size", a: "14px", b: "16px", differs: true });
    expect(rows.find((r) => r.label === "Colours")?.b).toBe("some not in your theme");
    expect(rows.find((r) => r.label === "Licence")?.b).toBe("MIT");
  });
});

describe("Save to Library and Add to my project (c4)", () => {
  const open = async (id: string, name: RegExp, q = "command%20menu") => {
    show(`?q=${q}`);
    await waitFor(() => expect(card(id)).not.toBeNull());
    fireEvent.click(within(card(id)).getByRole("button", { name }));
    const drawer = await screen.findByTestId("candidate-drawer");
    return waitFor(() => {
      const actions = within(drawer).getByTestId("candidate-actions");
      expect(within(actions).getByRole("button", { name: /Save to Library/ }).hasAttribute("disabled")).toBe(false);
      return actions;
    });
  };

  test("an unknown licence: Add to my project is off with the reason in plain words; Save to Library drafts a save", async () => {
    const actions = await open("lib:aceternity/component/spotlight", /^Preview spotlight in your theme/, "spotlight");
    const add = within(actions).getByRole("button", { name: /Add to my project/ });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(text(actions.querySelector("[data-refusal]")!)).toBe("spotlight's licence is unknown: nothing backs one, so it cannot be adopted. Save it to the Library as a reference instead, or find its licence first.");
    expect(add.getAttribute("aria-describedby")).toBe("adopt-refusal");
    // The exact install command is shown to copy; nothing runs it.
    expect(text(actions.querySelector("[data-install]")!)).toBe("npx shadcn add @aceternity/spotlight");
    fireEvent.click(within(actions).getByRole("button", { name: /Save to Library/ }));
    await within(actions).findByRole("status");
    expect(drafts).toEqual([{ kind: "library", content: { entry: expect.objectContaining({ id: "lib:aceternity/component/spotlight", license: "unknown" }), request: "save", reason: "", swapsWith: [] } }]);
    expect(within(actions).getByRole("link", { name: "open it in Changes" }).getAttribute("href")).toBe("/changes/d-0123456789");
  });

  test("a known licence: Add to my project drafts an adoption request with a reason, for approval", async () => {
    const actions = await open("lib:shadcn/component/command", /^Preview Command in your theme/);
    fireEvent.click(within(actions).getByRole("button", { name: /Add to my project/ }));
    fireEvent.change(within(actions).getByRole("textbox"), { target: { value: "The console needs a command menu." } });
    fireEvent.click(within(actions).getByRole("button", { name: "Draft adoption request" }));
    await within(actions).findByRole("status");
    expect(drafts).toEqual([{ kind: "library", content: { entry: expect.objectContaining({ id: "lib:shadcn/component/command" }), request: "adopt", reason: "The console needs a command menu.", swapsWith: [] } }]);
    expect(text(within(actions).getByRole("status"))).toContain("Adoption request drafted for approval");
  });

  test("without the workflow service, both say it needs youiyoux ui --project", async () => {
    service = "down";
    show("?q=command%20menu");
    await waitFor(() => expect(card("lib:shadcn/component/command")).not.toBeNull());
    fireEvent.click(within(card("lib:shadcn/component/command")).getByRole("button", { name: /^Preview Command in your theme/ }));
    const drawer = await screen.findByTestId("candidate-drawer");
    await waitFor(() => expect(text(within(drawer).getByTestId("candidate-actions"))).toContain("youiyoux ui --project"));
    const actions = within(drawer).getByTestId("candidate-actions");
    expect(within(actions).getByRole("button", { name: /Save to Library/ }).hasAttribute("disabled")).toBe(true);
    expect(within(actions).getByRole("button", { name: /Add to my project/ }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the gallery (pictures from youiyoux discover previews)", () => {
  const SHADCN = "lib:shadcn/component/command";
  const COSS = "lib:coss/component/command";
  const pictures = (): Thumbs => ({
    project: "console",
    items: { [SHADCN]: { light: "/__youi/discover-thumbs/console/0123456789abcdef.light.webp", dark: "/__youi/discover-thumbs/console/0123456789abcdef.dark.webp", width: 928, height: 568, capturedAt: "2026-10-22T12:00:00.000Z" } },
    failed: { [COSS]: "it needs recharts, which is installed in neither your project nor the hub" },
  });

  test("with pictures, results are cards led by how each draws in your theme; one without says why in a few words", async () => {
    thumbs = pictures();
    show("?q=command%20menu");
    await waitFor(() => expect(document.querySelector("[data-gallery]")).not.toBeNull());
    const shadcn = card(SHADCN);
    expect(shadcn.dataset.picture).toBe("yes");
    expect(shadcn.querySelector("img")!.getAttribute("src")).toBe("/__youi/discover-thumbs/console/0123456789abcdef.light.webp");
    const coss = card(COSS);
    expect(coss.dataset.picture).toBe("failed");
    expect(within(coss).getByText("Needs recharts").getAttribute("title")).toBe("it needs recharts, which is installed in neither your project nor the hub");
    expect([...document.querySelectorAll<HTMLElement>("[data-hit]")].filter((hit) => hit.dataset.picture === "none").every((hit) => text(hit).includes("No picture yet"))).toBe(true);
    // The picture opens it, as Preview in your theme does; nothing was asked for before that.
    expect(previewCalls()).toEqual([]);
    fireEvent.click(within(shadcn).getByRole("button", { name: /^Preview Command in your theme/ }));
    expect(await screen.findByTestId("candidate-drawer")).toBeTruthy();
    expect(window.location.search).toContain(`open=${encodeURIComponent(SHADCN)}`);
  });

  test("nothing searched: a shelf per type, of its pictured candidates, and All N opens that type", async () => {
    thumbs = pictures();
    show("");
    await waitFor(() => expect(document.querySelectorAll("[data-shelf]").length).toBeGreaterThan(0));
    expect(text(document.querySelector("[data-results-summary]")!)).toMatch(/^Browsing by type: the \d+ commonest of \d+$/);
    const shelf = document.querySelector<HTMLElement>('[data-shelf="command"]')!;
    await waitFor(() => expect(shelf.querySelectorAll("[data-hit]").length).toBeGreaterThan(0));
    // Only shadcn's command has a picture, so it is the shelf; a shelf with none shows its first four as they are.
    expect([...shelf.querySelectorAll("[data-hit]")].map((hit) => hit.getAttribute("data-hit"))).toEqual([SHADCN]);
    const unpictured = [...document.querySelectorAll<HTMLElement>("[data-shelf]")].find((other) => !other.querySelector('[data-picture="yes"]'));
    if (unpictured) await waitFor(() => expect(unpictured.querySelectorAll("[data-hit]").length).toBeGreaterThan(0));
    fireEvent.click(within(shelf).getByRole("button", { name: /^All \d+/ }));
    await waitFor(() => expect(document.querySelector("[data-shelves]")).toBeNull());
    expect(window.location.search).toContain("role=command");
    expect(document.querySelector("[data-gallery]")).not.toBeNull();
  });

  test("the layout switches to the list and back, and stays in the URL; without pictures there is only the list", async () => {
    thumbs = pictures();
    show("?q=command%20menu");
    await waitFor(() => expect(document.querySelector("[data-gallery]")).not.toBeNull());
    const layout = screen.getByRole("group", { name: "Layout" });
    fireEvent.click(within(layout).getByRole("button", { name: "List" }));
    await waitFor(() => expect(document.querySelector("[data-gallery]")).toBeNull());
    expect(window.location.search).toContain("view=list");
    expect(within(card(SHADCN)).getByText("npx shadcn add command")).toBeTruthy();
    fireEvent.click(within(layout).getByRole("button", { name: "Gallery" }));
    await waitFor(() => expect(document.querySelector("[data-gallery]")).not.toBeNull());
    expect(window.location.search).toContain("view=gallery");
    expect(parseQuery("?view=gallery").view).toBe("gallery");
    expect(parseQuery("?view=wall").view).toBeNull();

    cleanup();
    resetThumbs();
    thumbs = null;
    show("?q=command%20menu");
    await waitFor(() => expect(card(SHADCN)).not.toBeNull());
    await waitFor(() => expect(calls).toContain("/__youi/discover-thumbs"));
    expect(document.querySelector("[data-gallery]")).toBeNull();
    expect(document.querySelector("[data-view-switch]")).toBeNull();
  });
});

describe("the capture page youiyoux discover previews photographs", () => {
  test("it draws one candidate on a light and a dark stage once drawn, says it is ready, and names its project and listing", async () => {
    // One no earlier test drew (drawings are kept for the page's life).
    const id = "lib:shadcn/component/input";
    window.history.replaceState(null, "", `/discover/specimen?id=${encodeURIComponent(id)}`);
    render(<SpecimenCapture />);
    const capture = (): HTMLElement => document.querySelector<HTMLElement>(`[data-capture="${id}"]`)!;
    // Fetching, then drawing in the hidden frame: not ready to photograph yet.
    await waitFor(() => expect(capture().dataset.captureProject).toBe("console"));
    expect(capture().dataset.captureState).toBe("drawing");
    expect(previewCalls()).toEqual([`/__youi/discover-preview?id=${encodeURIComponent(id)}`]);
    // A first drawing that may still be animating in is not photographed.
    act(() => setDrawn(id, '<input class="rounded-md" placeholder="Em">', false));
    expect(capture().dataset.captureState).toBe("drawing");
    act(() => setDrawn(id, '<input class="rounded-md" placeholder="Email">'));
    await waitFor(() => expect(capture().dataset.captureState).toBe("ready"));
    const page = capture();
    expect([...page.querySelectorAll<HTMLElement>("[data-capture-stage]")].map((stage) => stage.dataset.captureStage)).toEqual(["light", "dark"]);
    expect(page.dataset.captureProject).toBe("console");
    expect(page.dataset.captureSha).toBe((await entryOf(id)).provenance!.sha256);
  });

  test("a block is photographed as a page: its top, at a quarter of 1280 × 768, with room for the capture's cut", async () => {
    const id = "lib:shadcn/pattern/dashboard-01";
    window.history.replaceState(null, "", `/discover/specimen?id=${encodeURIComponent(id)}`);
    render(<SpecimenCapture />);
    const capture = (): HTMLElement => document.querySelector<HTMLElement>(`[data-capture="${id}"]`)!;
    await waitFor(() => expect(capture()).not.toBeNull());
    act(() => setDrawn(id, '<main class="flex min-h-svh">A dashboard</main>'));
    await waitFor(() => expect(capture().dataset.captureState).toBe("ready"));
    const stages = [...capture().querySelectorAll<HTMLElement>("[data-capture-stage]")];
    expect(stages.map((stage) => [stage.dataset.captureStage, stage.style.padding])).toEqual([["light", "8px"], ["dark", "8px"]]);
    const frame = stages[0]!.querySelector("iframe")!;
    expect([frame.style.width, frame.style.height, frame.style.transform]).toEqual(["1280px", "768px", "scale(0.25)"]);
    expect(frame.getAttribute("srcdoc")).toContain("display:block;min-height:100vh");
  });

  test("a candidate that cannot be drawn says so, with why, for the capture to record", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "There is no Discover index on this machine yet: run youiyoux discover sync." }, 404)));
    window.history.replaceState(null, "", "/discover/specimen?id=lib%3Ashadcn%2Fcomponent%2Fnothing");
    render(<SpecimenCapture />);
    await waitFor(() => expect(document.querySelector("[data-capture-state=failed]")).not.toBeNull());
    expect(document.querySelector("[data-capture-state=failed]")!.getAttribute("data-capture-reason")).toMatch(/no Discover index/);
  });
});
