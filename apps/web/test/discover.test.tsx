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
import { compact, descriptionOf, findDiscoverHit, parseQuery, queryToSearch, resetDiscoverSource, searchListings, signalLines, sortListings, type ListingsFile } from "../src/data/discover.ts";
import { cleanMarkup, onlyCustomProperties, previewRequests, setDrawn, type PreviewAnswer } from "../src/data/discover-preview.ts";
import { resetThumbs, type Thumbs } from "../src/data/discover-thumbs.ts";
import { memorySource, type InventorySource } from "../src/data/inventory-source.ts";
import type { Resource } from "../src/data/store.ts";
import { siteOf } from "../src/screens/discover/CandidatePanel.tsx";
import { pageScale } from "../src/screens/discover/PagePreview.tsx";
import { pinnedRows } from "../src/screens/discover/PinnedCompare.tsx";
import { DiscoverView, pageNumbers } from "../src/screens/discover/DiscoverScreen.tsx";
import { browseHref, RegistriesScreen } from "../src/screens/discover/RegistriesScreen.tsx";
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
/** What `/__youi/discover-every` answers, by method: none by default, as a static host. */
let every: ((method: string) => Response) | null;

beforeEach(() => {
  calls = [];
  drafts = [];
  service = "up";
  thumbs = null;
  every = null;
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
      if (url.pathname === "/__youi/discover-every") return every ? every(init?.method ?? "GET") : new Response("not found", { status: 404 });
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

describe("everything, in an order and by page", () => {
  test("the order and the page size live in the URL; anything else is the default", () => {
    expect(parseQuery("?sort=name&per=50")).toMatchObject({ sort: "name", per: 50 });
    expect(parseQuery("?sort=newest&per=7")).toMatchObject({ sort: null, per: 20 });
    expect(queryToSearch(parseQuery("?sort=registry&per=100&source=%40coss"))).toBe("?source=%40coss&sort=registry&per=100");
    expect(queryToSearch(parseQuery("?per=20"))).toBe("");
  });

  test("numbered pages: the first, the last and the ones around this one, a gap only where pages are skipped", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(5, 65)).toEqual([1, "gap", 4, 5, 6, "gap", 65]);
    expect(pageNumbers(65, 65)).toEqual([1, "gap", 64, 65]);
  });

  test("sorted by name, by registry then name, or by downloads; a filler summary is no description", () => {
    const hit = (id: string, name: string, ref: string | null, downloads: number | null, title: string | null = null) => ({ id, name, title, source: { kind: ref ? "shadcn-registry" : "npm", name: ref ? ref.split("/")[0]! : name, ref }, signals: { weeklyDownloads: downloads } }) as never as Parameters<typeof sortListings>[0][number];
    const listings = [hit("a", "tabs", "@shadcn/tabs", null), hit("b", "accordion", "@coss/accordion", null), hit("c", "sonner", null, 9_000_000), hit("d", "button", "@coss/button", null, "Button")];
    expect(sortListings(listings, "name").map((l) => l.id)).toEqual(["b", "d", "c", "a"]);
    expect(sortListings(listings, "registry").map((l) => l.id)).toEqual(["b", "d", "a", "c"]);
    expect(sortListings(listings, "downloads")[0]!.id).toBe("c");
    expect(sortListings(listings, null).map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
    expect(descriptionOf({ name: "accordion", title: null, summary: "accordion from @coss" })).toBeNull();
    expect(descriptionOf({ name: "card", title: "Card", summary: "Card" })).toBeNull();
    expect(descriptionOf({ name: "aurora-text", title: "Aurora Text", summary: "A beautiful aurora text effect" })).toBe("A beautiful aurora text effect");
  });

  test("choosing an order and a page size asks the index for them, and a page number jumps to that page", async () => {
    // The index answers each change; under a full parallel run that can take past the default second.
    const WAIT = { timeout: 5000 };
    show("?view=list");
    await waitFor(() => expect(document.querySelectorAll("[data-hit]").length).toBeGreaterThan(0), WAIT);
    fireEvent.change(document.querySelector<HTMLSelectElement>("[data-sort]")!, { target: { value: "name" } });
    await waitFor(() => expect(window.location.search).toContain("sort=name"), WAIT);
    await waitFor(() => expect(text(document.querySelector("[data-results-summary]")!)).toMatch(/^By name, A–Z: 1–\d+ of \d+/), WAIT);
    await waitFor(() => expect(calls.some((c) => c.startsWith("/__youi/query") && c.includes("sort=name"))).toBe(true), WAIT);
    await waitFor(() => {
      const titles = [...document.querySelectorAll<HTMLElement>("[data-hit] h3")].map((h) => text(h).toLowerCase());
      expect(titles.length).toBeGreaterThan(1);
      expect(titles).toEqual([...titles].sort());
    }, WAIT);
    fireEvent.change(document.querySelector<HTMLSelectElement>("[data-per]")!, { target: { value: "50" } });
    await waitFor(() => expect(calls.some((c) => c.startsWith("/__youi/query") && c.includes("limit=50"))).toBe(true), WAIT);
    fireEvent.change(document.querySelector<HTMLSelectElement>("[data-per]")!, { target: { value: "20" } });
    const second = await screen.findByRole("button", { name: /^Page 2 of / }, WAIT);
    fireEvent.click(second);
    await waitFor(() => expect(window.location.search).toContain("offset=20"), WAIT);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Page 2 of / }).getAttribute("aria-current")).toBe("page"), WAIT);
  });
});

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
    expect(parseQuery("?q=x&role=button&source=%40shadcn&licence=known&style=styled&family=button-1&open=lib%3Ax&offset=20")).toEqual({ q: "x", role: "button", source: "@shadcn", licence: "known", style: "styled", family: "button-1", open: "lib:x", view: null, sort: null, per: 20, offset: 20, every: false });
    expect(queryToSearch(parseQuery("?licence=bogus&style=nope&q=a&every=yes"))).toBe("?q=a");
    expect(queryToSearch(parseQuery("?q=a&every=1"))).toBe("?q=a&every=1");
  });

  test("on a phone the facets fold behind one Filters button that says how many are on; each one on comes off without unfolding", async () => {
    show("?q=command%20menu&source=%40coss&licence=known");
    await waitFor(() => expect(card("lib:coss/component/command")).not.toBeNull());
    const facets = document.querySelector<HTMLElement>("[data-facets]")!;
    const toggle = within(document.querySelector<HTMLElement>("[data-filter-toggle]")!).getByRole("button", { name: /^Filters/ });
    // Folded below the md breakpoint (CSS), always shown above it.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(facets.id);
    expect(facets.className).toContain("max-md:hidden");
    expect(text(toggle)).toBe("Filters · 2 on");
    const on = screen.getByRole("list", { name: "Filters on" });
    expect([...on.querySelectorAll("button")].map(text)).toEqual(["@coss", "Known licence"]);
    fireEvent.click(within(on).getByRole("button", { name: "Take off Known licence" }));
    await waitFor(() => expect(window.location.search).not.toContain("licence="));
    expect(window.location.search).toContain("source=%40coss");
    expect(text(toggle)).toBe("Filters · 1 on");
    // Unfolded: the facets show, and the list of what is on gives way to them.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(facets.className).not.toContain("max-md:hidden");
    expect(screen.queryByRole("list", { name: "Filters on" })).toBeNull();
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
  test("opening asks for that one item; it runs at once on a stage, light or dark, its states drawn still beneath, and says what could not be themed", async () => {
    show("?q=command%20menu");
    await waitFor(() => expect(card("lib:shadcn/component/command")).not.toBeNull());
    expect(previewCalls()).toEqual([]);
    fireEvent.click(within(card("lib:shadcn/component/command")).getByRole("button", { name: /^Preview Command in your theme/ }));
    const drawer = await screen.findByTestId("candidate-drawer");
    expect(drawer.dataset.size).toBe("large");
    await waitFor(() => expect(previewCalls()).toEqual(["/__youi/discover-preview?id=lib%3Ashadcn%2Fcomponent%2Fcommand"]));
    // It runs on the stage at once, before anything is drawn still: the bundle, sandboxed allow-scripts only, never same origin.
    const stage = (): HTMLIFrameElement => {
      const frame = drawer.querySelector<HTMLIFrameElement>("iframe[data-stage-frame]");
      expect(frame).not.toBeNull();
      return frame!;
    };
    await waitFor(() => stage());
    expect(drawer.querySelector("[data-drawn]")).toBeNull();
    expect(stage().getAttribute("sandbox")).toBe("allow-scripts");
    expect(stage().getAttribute("srcdoc")).toMatch(/<script src="[^"]+\/__youi\/discover-preview\/a{16}\.js">/);
    expect(stage().getAttribute("srcdoc")).toContain(`/__youi/discover-preview/${"b".repeat(16)}.css`);
    // Centred in the frame, not shrink-wrapped in its corner.
    expect(stage().getAttribute("srcdoc")).toMatch(/id="youi-specimen" style="display:flex;[^"]*justify-content:center/);
    // Its registry publishes no demo of it (this answer has none): said, plainly.
    expect(text(drawer)).toContain("@shadcn publishes no demo of it, so it is put together here from its own parts.");
    // Dark: the dark sheet, in a new document.
    fireEvent.click(within(drawer).getByRole("radio", { name: "Dark" }));
    expect(stage().dataset.stageFrame).toBe("dark");
    expect(stage().getAttribute("srcdoc")).toContain(`/__youi/discover-preview/${"c".repeat(16)}.css`);
    // An error it hits is said, from that frame only; Run it again starts a fresh document and clears it.
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: window, data: { youi: "try", type: "error", message: "forged" } })));
    expect(drawer.querySelector("[data-stage-error]")).toBeNull();
    const first = stage();
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: first.contentWindow, data: { youi: "try", type: "error", message: "x is not a function" } })));
    expect(text(drawer.querySelector("[data-stage-error]")!)).toMatch(/^It failed when it ran \(x is not a function\)/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Run it again" }));
    expect(stage()).not.toBe(first);
    expect(drawer.querySelector("[data-stage-error]")).toBeNull();
    // The hidden frame learns what it draws; that comes back by message, from that frame only, and is cleaned before use.
    const probe = await waitFor(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-draw-probe="lib:shadcn/component/command"]');
      expect(frame).not.toBeNull();
      return frame!;
    });
    expect(probe.getAttribute("sandbox")).toBe("allow-scripts");
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: window, data: { youi: "try", type: "html", html: "<button>forged</button>" } })));
    expect(drawer.querySelector("[data-drawn]")).toBeNull();
    act(() => setDrawn("lib:shadcn/component/command", '<div class="rounded-md bg-popover" onclick="alert(1)"><input placeholder="Type a command"><script>alert(2)</script><a href="javascript:alert(3)">x</a></div>'));
    const drawn = await waitFor(() => {
      const element = drawer.querySelector<HTMLElement>("[data-drawn]");
      expect(element).not.toBeNull();
      return element!;
    });
    // Its states, drawn still: no script, nothing active from the markup; no second pair of light and dark tiles.
    const strip = drawn.querySelector<HTMLElement>("[data-strip]")!;
    expect(strip).not.toBeNull();
    const still = strip.querySelector("iframe")!;
    expect(still.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(still.getAttribute("srcdoc")).not.toMatch(/<script|onclick|javascript:/);
    expect(drawer.querySelectorAll("[data-tile]")).toHaveLength(0);
    expect(text(drawer.querySelector('[data-fit="themed"]')!)).toContain("rounded-md draws with your --radius-md: 8px");
    expect(text(drawer.querySelector('[data-fit="unthemed"]')!)).toContain("16px type (text-base), project uses 14px (text-sm)");
    expect(text(drawer.querySelector("[data-implicit]")!)).toBe("Imports without declaring: lucide-react (an install would need it too)");
    expect(cleanMarkup('<img src="https://tracker.example/x.png" style="background:url(https://x)"><style>@import url(https://x)</style>')).toBe('<img src="">');
    // Escape pressed inside it (the frame keeps the key) closes the drawer, as Escape anywhere in it does.
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: stage().contentWindow, data: { youi: "try", type: "escape" } })));
    await waitFor(() => expect(screen.queryByTestId("candidate-drawer")).toBeNull());
    expect(window.location.search).not.toContain("open=");
  });

  test("drawn from its registry's own demo, it says so", async () => {
    // An item no other test opens: previews are asked for once per candidate and page load.
    const id = "lib:coss/component/command";
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input), "http://localhost:5173/").pathname === "/__youi/discover-preview" ? json(answerFor(await entryOf(id), { demo: "@coss/p-command-1", compose: { export: "default", props: {}, children: [] } })) : base(input, init))));
    show(`?q=command%20menu&open=${encodeURIComponent(id)}`);
    const drawer = await screen.findByTestId("candidate-drawer");
    const caption = await waitFor(() => {
      const element = drawer.querySelector<HTMLElement>('[data-demo="@coss/p-command-1"]');
      expect(element, text(drawer)).not.toBeNull();
      return element!;
    });
    expect(text(caption)).toBe("Its registry's own demo, @coss/p-command-1, in your theme.");
  });

  test("a link to a candidate on no page shown still opens it: that one listing is asked for by id", async () => {
    const id = "lib:shadcn/component/command";
    show(`?q=date%20picker&open=${encodeURIComponent(id)}`);
    const drawer = await screen.findByTestId("candidate-drawer", {}, { timeout: 5000 });
    expect(within(drawer).getByRole("heading", { name: "Command" })).toBeTruthy();
    expect(card(id)).toBeNull();
    expect(calls.some((c) => c.startsWith("/__youi/query") && c.includes(`id=${encodeURIComponent(id)}`))).toBe(true);
    // One the index does not have opens nothing, and says nothing wrong.
    cleanup();
    show(`?open=${encodeURIComponent("lib:nope/component/x")}`);
    await waitFor(() => expect(calls.some((c) => c.includes("id=lib%3Anope"))).toBe(true));
    expect(screen.queryByTestId("candidate-drawer")).toBeNull();
  });

  test("a link by ref (@shadcn/command) opens it too, and the address takes its id", async () => {
    show(`?q=date%20picker&open=${encodeURIComponent("@shadcn/command")}`);
    const drawer = await screen.findByTestId("candidate-drawer", {}, { timeout: 5000 });
    expect(within(drawer).getByRole("heading", { name: "Command" })).toBeTruthy();
    await waitFor(() => expect(parseQuery(window.location.search).open).toBe("lib:shadcn/component/command"));
  });

  test("on a static host the link is found in the snapshot's listings", async () => {
    const listings = JSON.parse(readFileSync(join(scratch, "data", listingsFile), "utf8")) as ListingsFile;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost:5173/");
        if (url.pathname === "/__youi/query") return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        if (url.pathname === "/data/manifest.json") return json({ schema: "youiyoux.manifest/v1", source: { commit: null }, systems: [], discover: listingsFile });
        if (url.pathname === `/data/${listingsFile}`) return json(listings);
        return new Response("not found", { status: 404 });
      }),
    );
    const hit = await findDiscoverHit("lib:coss/component/command");
    expect(hit).toMatchObject({ id: "lib:coss/component/command", name: "command" });
    expect(hit).not.toHaveProperty("text");
    expect(await findDiscoverHit("lib:nope/component/x")).toBeNull();
  });
});

describe("every registry, and the registries behind Discover", () => {
  const WAIT = { timeout: 5000 };
  const status = (state: string, extra: Record<string, unknown> = {}) => json({ state, done: 0, total: 0, listings: null, failed: 0, fetchedAt: null, error: null, ...extra });

  test("Every registry searches beyond your sources (all=1 in the address and the query); not fetched yet, one button fetches every registry's list, says how far it has got, then searches again", async () => {
    let state: "none" | "running" | "ready" = "none";
    const posts: string[] = [];
    every = (method) => {
      if (method === "POST") return (posts.push(method), (state = "running"), status("running", { done: 1, total: 3 }));
      if (state === "running") return ((state = "ready"), status("running", { done: 2, total: 3 }));
      return state === "ready" ? status("ready", { done: 3, total: 3, listings: 120, fetchedAt: "2026-10-25T12:00:00.000Z" }) : status("none");
    };
    show("?q=command&view=list");
    await waitFor(() => expect(document.querySelectorAll("[data-hit]").length).toBeGreaterThan(0), WAIT);
    expect(document.querySelector("[data-every]")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Every registry" }));
    await waitFor(() => expect(parseQuery(window.location.search).every).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.startsWith("/__youi/query") && c.includes("all=1"))).toBe(true), WAIT);
    const start = await screen.findByRole("button", { name: "Fetch every registry's list" }, WAIT);
    expect(text(document.querySelector("[data-every='none']")!)).toMatch(/never an item's code/);
    const asked = calls.filter((c) => c.startsWith("/__youi/query")).length;
    fireEvent.click(start);
    await waitFor(() => expect(text(document.querySelector("[data-every='running']")!)).toMatch(/1 of 3|2 of 3/), WAIT);
    expect(posts).toEqual(["POST"]);
    await waitFor(() => expect(document.querySelector("[data-every='ready']")).not.toBeNull(), WAIT);
    expect(text(document.querySelector("[data-every='ready']")!)).toMatch(/^Searching every registry in shadcn's directory, as listed on/);
    // The same search, asked again once the listings are in.
    await waitFor(() => expect(calls.filter((c) => c.startsWith("/__youi/query")).length).toBeGreaterThan(asked), WAIT);
    // Back to your sources: all=1 is gone.
    fireEvent.click(screen.getByRole("radio", { name: "Your sources" }));
    await waitFor(() => expect(window.location.search).not.toContain("every=1"));
  });

  test("on a static host, Every registry says it needs the hub's own server", async () => {
    show("?every=1&view=list");
    await waitFor(() => expect(document.querySelector("[data-every='none']")).not.toBeNull(), WAIT);
    expect(text(document.querySelector("[data-every='none']")!)).toMatch(/youiyoux ui/);
    expect(screen.queryByRole("button", { name: "Fetch every registry's list" })).toBeNull();
  });

  test("Registries lists the directory, yours and the official first; words narrow it; Browse its items opens Discover on it, among every registry's unless it is yours", async () => {
    window.history.replaceState(null, "", "/discover/registries");
    render(<RegistriesScreen />);
    await waitFor(() => expect(document.querySelectorAll("[data-registry]").length).toBeGreaterThan(3), WAIT);
    const names = [...document.querySelectorAll<HTMLElement>("[data-registry]")].map((li) => li.dataset.registry);
    expect(names.slice(0, 2)).toEqual(["@shadcn", "@coss"]);
    expect(names).not.toContain("@abstract");
    expect(text(document.querySelector("[data-registry='@shadcn']")!)).toMatch(/Official/);
    expect(text(document.querySelector("[data-registry='@coss']")!)).toMatch(/Your source.*\d+ to browse/);
    expect(document.querySelector<HTMLAnchorElement>("[data-browse='@coss']")!.getAttribute("href")).toBe("/discover?source=%40coss");
    expect(browseHref({ name: "@extra", state: "available" })).toBe("/discover?source=%40extra&every=1");
    expect(document.querySelector<HTMLAnchorElement>("[data-registry='@coss'] a[target='_blank']")!.rel).toContain("noopener");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search registries" }), { target: { value: "animated" } });
    await waitFor(() => expect(window.location.search).toBe("?q=animated"), WAIT);
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>("[data-registry]")].map((li) => li.dataset.registry)).toEqual(["@magicui"]), WAIT);
    fireEvent.change(document.querySelector<HTMLSelectElement>("[data-registry-sort]")!, { target: { value: "name" } });
    await waitFor(() => expect(window.location.search).toBe("?q=animated&sort=name"));
    await waitFor(() => expect(calls.some((c) => c.includes("kind=registries") && c.includes("sort=name"))).toBe(true), WAIT);
  });

  test("Registries on a static host says it needs the hub's own server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    window.history.replaceState(null, "", "/discover/registries");
    render(<RegistriesScreen />);
    expect(await screen.findByText(/youiyoux ui/, {}, WAIT)).toBeTruthy();
  });
});

describe("an opened block, drawn as the page it is", () => {
  const id = "lib:shadcn/pattern/dashboard-01";
  test("one large frame at a desktop's size, running at once; still on Live off, a phone's width, light or dark, and full size in a dialog; the hidden frame stays until the drawing settles", async () => {
    // jsdom lays nothing out: the drawer is 640px wide here.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    try {
      show(`?open=${encodeURIComponent(id)}`);
      const drawer = await screen.findByTestId("candidate-drawer");
      const frame = (): HTMLIFrameElement => drawer.querySelector<HTMLIFrameElement>("iframe[data-page-frame]")!;
      // It runs at once, before anything is drawn still: the bundle, sandboxed allow-scripts only, scaled to the drawer (640 / 1280).
      await waitFor(() => expect(frame()).not.toBeNull());
      expect(frame().dataset.live).toBe("true");
      expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame().getAttribute("srcdoc")).toMatch(/<script src="[^"]+\/__youi\/discover-preview\/a{16}\.js">/);
      expect(frame().dataset.pageFrame).toBe("desktop");
      expect(frame().style.transform).toBe("scale(0.5)");
      expect(within(drawer).getByRole("button", { name: "Live" }).getAttribute("aria-pressed")).toBe("true");
      // The page is laid out in a page-sized hidden frame, at full width, not shrink-wrapped.
      const probe = await waitFor(() => {
        const element = document.querySelector<HTMLIFrameElement>(`iframe[data-draw-probe="${id}"]`);
        expect(element).not.toBeNull();
        return element!;
      });
      expect([probe.style.width, probe.style.height]).toEqual(["1280px", "768px"]);
      expect(probe.getAttribute("srcdoc")).toContain('id="youi-specimen" style="display:block;min-height:100vh"');
      // Live off: the still page, which waits for the drawing.
      fireEvent.click(within(drawer).getByRole("button", { name: "Live" }));
      expect(frame()).toBeNull();
      expect(text(drawer)).toContain("Drawing the still page…");
      // A first drawing shows at once; the hidden frame stays until the settled one (a chart still animating in).
      act(() => setDrawn(id, '<main class="flex min-h-svh"><aside>Sidebar</aside><section>Cards</section></main>', false));
      await waitFor(() => expect(frame()).not.toBeNull());
      expect(document.querySelector(`iframe[data-draw-probe="${id}"]`)).not.toBeNull();
      act(() => setDrawn(id, '<main class="flex min-h-svh"><aside>Sidebar</aside><section>Cards, drawn</section></main>', true));
      await waitFor(() => expect(document.querySelector(`iframe[data-draw-probe="${id}"]`)).toBeNull());
      expect(frame().getAttribute("srcdoc")).toContain("Cards, drawn");
      // One frame, no light-and-dark tiles or state strip; still is script-free.
      expect(drawer.querySelectorAll("[data-tile]")).toHaveLength(0);
      expect(drawer.querySelector("[data-strip]")).toBeNull();
      expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
      expect(frame().getAttribute("srcdoc")).not.toContain("<script");
      // A phone's width, then dark: the dark sheet.
      fireEvent.click(within(drawer).getByRole("radio", { name: "Phone" }));
      expect(frame().dataset.pageFrame).toBe("phone");
      expect(frame().style.width).toBe("390px");
      fireEvent.click(within(drawer).getByRole("radio", { name: "Dark" }));
      expect(frame().getAttribute("srcdoc")).toContain(`/__youi/discover-preview/${"c".repeat(16)}.css`);
      // Live on again: running.
      fireEvent.click(within(drawer).getByRole("button", { name: "Live" }));
      expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
      // Full size: a dialog of its own; closing it gives focus back.
      const open = within(drawer).getByRole("button", { name: "Show Dashboard 01 full size" });
      fireEvent.click(open);
      const full = await screen.findByTestId("page-fullscreen");
      expect(within(full).getByRole("heading", { name: "Dashboard 01" })).toBeTruthy();
      expect(full.querySelector("iframe[data-page-frame=phone]")).not.toBeNull();
      fireEvent.click(within(full).getByRole("button", { name: "Close full size" }));
      await waitFor(() => expect(screen.queryByTestId("page-fullscreen")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(open));
      // Escape pressed inside the running page (the frame keeps the key) closes the drawer; from anywhere else, nothing.
      act(() => void window.dispatchEvent(new MessageEvent("message", { source: window, data: { youi: "try", type: "escape" } })));
      expect(screen.queryByTestId("candidate-drawer")).not.toBeNull();
      act(() => void window.dispatchEvent(new MessageEvent("message", { source: frame().contentWindow, data: { youi: "try", type: "escape" } })));
      await waitFor(() => expect(screen.queryByTestId("candidate-drawer")).toBeNull());
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

  test("a paid or private component says so and links to its registry's site; one that fails otherwise does not", async () => {
    const component = "lib:coss/component/button";
    // Preview answers are kept per candidate, so the one that fails otherwise is another.
    const failing = "lib:coss/component/toast";
    const paid = "button is paid or private: its registry asks for an account or a licence before it gives its code (HTTP 403)";
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:5173/");
      if (url.pathname !== "/__youi/discover-preview") return base(input, init);
      const id = url.searchParams.get("id")!;
      return json(answerFor(await entryOf(id), { script: null, error: id === component ? paid : "It failed when it ran (boom)" }));
    }));
    show(`?q=button&open=${encodeURIComponent(component)}`);
    const shown = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-preview-error]");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(text(shown)).toBe(`No drawing: ${paid}. Find button on coss.com, drawn as its authors made it.`);
    cleanup();
    show(`?q=toast&open=${encodeURIComponent(failing)}`);
    const other = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-preview-error]");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(other.querySelector("a[data-site-link]")).toBeNull();
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

  test("one registry chosen, or an order: every candidate in pages, never shelves", async () => {
    thumbs = pictures();
    for (const search of ["?source=%40shadcn", "?sort=name"]) {
      cleanup();
      show(search);
      await waitFor(() => expect(document.querySelector("[data-gallery]"), search).not.toBeNull());
      expect(document.querySelector("[data-shelves]"), search).toBeNull();
      expect(text(document.querySelector("[data-results-summary]")!), search).toMatch(/\d+–\d+ of \d+/);
    }
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
