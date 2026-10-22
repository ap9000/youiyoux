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
import { cleanMarkup, previewRequests, setDrawn, type PreviewAnswer } from "../src/data/discover-preview.ts";
import { memorySource, type InventorySource } from "../src/data/inventory-source.ts";
import type { Resource } from "../src/data/store.ts";
import { pinnedRows } from "../src/screens/discover/PinnedCompare.tsx";
import { DiscoverView } from "../src/screens/discover/DiscoverScreen.tsx";
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
    ...extra,
  };
}

let calls: string[];
let drafts: unknown[];
let service: "up" | "down";

beforeEach(() => {
  calls = [];
  drafts = [];
  service = "up";
  resetDiscoverSource();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:5173/");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/__youi/query") return viaMiddleware(url);
      if (url.pathname === "/__youi/discover-preview") return json(answerFor(await entryOf(url.searchParams.get("id")!)));
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
    expect(parseQuery("?q=x&role=button&source=%40shadcn&licence=known&style=styled&family=button-1&open=lib%3Ax&offset=20")).toEqual({ q: "x", role: "button", source: "@shadcn", licence: "known", style: "styled", family: "button-1", open: "lib:x", offset: 20 });
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
