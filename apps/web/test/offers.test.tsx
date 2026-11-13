// @vitest-environment jsdom
/** An agent's options on the Screens canvas: previewed in the live app, one written into the code or filed as a request, or all dismissed; only open ones pinned. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentContract, ProposalDoc } from "@youiyoux/core";
import type { LiveHandle } from "../src/data/live.ts";
import { NO_ISSUES, type Screen, type ScreenIndex } from "../src/data/screens.ts";
import { OfferPanel } from "../src/screens/screens/Offers.tsx";
import { ScreensCanvas } from "../src/screens/screens/ScreensCanvas.tsx";

const AT = "2026-11-01T10:00:00.000Z";
const CONTRACT = { name: "Button", props: { variant: { type: "enum", values: ["default", "outline", "ghost"], default: "default", required: false }, size: { type: "enum", values: ["default", "sm"], default: "default", required: false } } } as unknown as ComponentContract;
const proposal = (patch: Partial<ProposalDoc> = {}): ProposalDoc & { digest: string } => ({
  digest: "d".repeat(64),
  schema: "youi.proposal/v1", id: "p-0123456789", project: "app", route: "/a", ask: "Make the main action clearer", author: { kind: "agent", name: "agent (MCP)" }, createdAt: AT, updatedAt: AT, status: "open",
  target: { name: "Button", element: "youi:demo/component/button", file: "app/index.tsx", line: 13, column: 8, box: { x: 24, y: 80, width: 120, height: 36 }, page: { width: 1440, height: 900 } },
  options: [
    { id: "a", label: "One primary action", why: "It is the view's main action.", set: [{ prop: "variant", value: "default" }], text: null },
    { id: "b", label: "Quieter", why: "Keep the page calm.", set: [{ prop: "variant", value: "outline" }, { prop: "size", value: "sm" }], text: "Start a project" },
  ],
  ...patch,
});
const HASH = "b".repeat(64);

let posts: Array<{ path: string; body: Record<string, unknown> }>;
let preview: Record<string, unknown>;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const handle = () => ({ ask: vi.fn(), edit: vi.fn(async () => ({ ok: true, why: null })), reset: vi.fn(), forget: vi.fn() }) satisfies LiveHandle;

beforeEach(() => {
  posts = [];
  preview = { file: "app/index.tsx", hash: HASH, ok: true, tag: "Button", line: 13, before: "<Button>New project</Button>", after: '<Button variant="outline" size="sm">Start a project</Button>', written: false };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/api/requests") return json({ id: "r-0123456789", ...body });
    if (path.endsWith("/decision")) return json(proposal("dismiss" in body ? { status: "dismissed", decidedBy: { kind: "person", name: "you" }, decidedAt: AT } : { status: "chosen", choice: body.choice as "a", decidedBy: { kind: "person", name: "you" }, decidedAt: AT }));
    return json(body.write ? { ...preview, written: true } : preview);
  }));
  sessionStorage.setItem("youiyoux.editor-key", "k-test");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an agent's options", () => {
  test("each is previewed in the live app; the one used is shown in the code, written, and the pick recorded for the agent", async () => {
    const live = handle();
    const changed = vi.fn();
    render(<OfferPanel proposal={proposal()} live={live} contract={CONTRACT} onChange={changed} onRequest={() => undefined} onDone={() => undefined} />);
    expect(document.querySelector('[data-offer="open"]')!.textContent).toContain("Make the main action clearer");
    const b = document.querySelector<HTMLElement>('[data-option="b"]')!;
    expect(b.textContent).toContain('variant="outline", size="sm", text "Start a project"');
    fireEvent.click(within(b).getByRole("button", { name: "Preview" }));
    expect(live.reset).toHaveBeenCalled();
    expect(live.edit).toHaveBeenLastCalledWith({ variant: "outline", size: "sm" }, "Start a project");
    fireEvent.click(within(b).getByRole("button", { name: "Use this" }));
    fireEvent.click(within(b).getByRole("button", { name: "Write to code" }));
    await waitFor(() => expect(within(b).getByRole("button", { name: "Write to app/index.tsx" })).toBeTruthy());
    // With the contract's defaults, so a default takes the attribute out.
    expect(posts.at(-1)).toEqual({ path: "/api/live/edit", body: { file: "app/index.tsx", line: 13, column: 8, component: "Button", set: [{ prop: "variant", value: "outline", default: "default" }, { prop: "size", value: "sm", default: "default" }], text: "Start a project" } });
    fireEvent.click(within(b).getByRole("button", { name: "Write to app/index.tsx" }));
    await waitFor(() => expect(document.querySelector('[data-offer="written"]')).not.toBeNull());
    expect(posts.slice(-2).map((p) => [p.path, p.body])).toEqual([
      ["/api/live/edit", expect.objectContaining({ write: { hash: HASH } })],
      ["/api/proposals/p-0123456789/decision", { choice: "b", seen: "d".repeat(64) }],
    ]);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: "chosen", choice: "b" }));
    expect(live.forget).toHaveBeenCalled();
    const resets = live.reset.mock.calls.length;
    cleanup();
    expect(live.reset).toHaveBeenCalledTimes(resets);
  });

  test("one that can't be written is filed as a change request, and the pick names it; on a picture there is no preview; dismissing turns them all down", async () => {
    preview = { file: "app/index.tsx", hash: HASH, ok: false, why: "variant is computed in code" };
    const filed = vi.fn();
    render(<OfferPanel proposal={proposal()} live={null} contract={CONTRACT} onChange={() => undefined} onRequest={filed} onDone={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.getByText("Run this screen live to preview each option in the app.")).toBeTruthy();
    const a = document.querySelector<HTMLElement>('[data-option="a"]')!;
    fireEvent.click(within(a).getByRole("button", { name: "Use this" }));
    fireEvent.click(within(a).getByRole("button", { name: "Write to code" }));
    fireEvent.click(await within(a).findByRole("button", { name: "File as change request" }));
    await waitFor(() => expect(filed).toHaveBeenCalled());
    await waitFor(() => expect(posts.at(-1)!.path).toBe("/api/proposals/p-0123456789/decision"));
    expect(posts.slice(-2).map((p) => [p.path, p.body])).toEqual([
      ["/api/requests", { kind: "change", body: 'Set variant="default" on Button at app/index.tsx:13, as agent (MCP) offered for "Make the main action clearer" on /a.', target: { route: "/a", scope: "here", name: "Button", element: "youi:demo/component/button", file: "app/index.tsx", line: 13, box: { x: 24, y: 80, width: 120, height: 36 }, page: { width: 1440, height: 900 } } }],
      ["/api/proposals/p-0123456789/decision", { choice: "a", request: "r-0123456789", seen: "d".repeat(64) }],
    ]);
    cleanup();
    const done = vi.fn();
    render(<OfferPanel proposal={proposal()} live={null} contract={CONTRACT} onChange={() => undefined} onRequest={() => undefined} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posts.at(-1)).toEqual({ path: "/api/proposals/p-0123456789/decision", body: { dismiss: true, seen: "d".repeat(64) } });
  });
});

describe("options that answer an options request", () => {
  test("picking or dismissing closes the request, saying which", async () => {
    const answered = proposal({ for: "r-0123456789" });
    preview = { file: "app/index.tsx", hash: HASH, ok: false, why: "variant is computed in code" };
    const requested = vi.fn();
    render(<OfferPanel proposal={answered} live={null} contract={CONTRACT} onChange={() => undefined} onRequest={requested} onDone={() => undefined} />);
    const b = document.querySelector<HTMLElement>('[data-option="b"]')!;
    fireEvent.click(within(b).getByRole("button", { name: "Use this" }));
    fireEvent.click(within(b).getByRole("button", { name: "Write to code" }));
    fireEvent.click(await within(b).findByRole("button", { name: "File as change request" }));
    await waitFor(() => expect(posts.at(-1)!.path).toBe("/api/requests/r-0123456789/status"));
    expect(posts.at(-1)!.body).toEqual({ status: "closed", body: "Picked b: Quieter, filed as r-0123456789." });
    expect(requested).toHaveBeenCalledTimes(2);
    cleanup();
    render(<OfferPanel proposal={answered} live={null} contract={CONTRACT} onChange={() => undefined} onRequest={() => undefined} onDone={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(posts.at(-1)!.path).toBe("/api/requests/r-0123456789/status"));
    expect(posts.at(-1)!.body).toEqual({ status: "closed", body: "Dismissed every option." });
  });
});

describe("options on the canvas", () => {
  const scr = (route: string): Screen => ({ project: "app", route, slug: route, sites: 0, elements: [], violations: [], lookalikes: [], unresolved: [], notRun: [], issues: NO_ISSUES, shot: { route, path: route, light: { full: "x.webp", thumb: "x.thumb.webp" } } }) as unknown as Screen;
  const index = { screens: [scr("/a"), scr("/b")] } as unknown as ScreenIndex;

  test("open ones are pinned where their component is; one decided isn't; a pin opens its options", () => {
    render(<ScreensCanvas screens={index} scheme="light" requests={[]} proposals={[proposal(), proposal({ id: "p-1111111111", route: "/b", status: "chosen", choice: "a", decidedBy: { kind: "person", name: "you" }, decidedAt: AT })]} contractOf={() => CONTRACT} />);
    const pins = [...document.querySelectorAll<HTMLElement>("[data-canvas-offer]")];
    expect(pins.map((p) => p.getAttribute("data-canvas-offer"))).toEqual(["p-0123456789"]);
    expect(pins[0]!.closest("[data-canvas-screen]")!.getAttribute("data-canvas-screen")).toBe("app:/a");
    expect(pins[0]!.style.left).toBe(`${((24 + 120) / 1440) * 100}%`);
    fireEvent.click(pins[0]!);
    expect(document.querySelector('[data-offer="open"]')).not.toBeNull();
  });
});
