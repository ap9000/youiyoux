// @vitest-environment jsdom
/** An ingest draft in Changes: everything one link held, to keep or drop; a save sends only the kept ids. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryEntry } from "@youiyoux/core";
import type { IngestDraftView, WorkflowInfo } from "../src/data/workflow.ts";
import { IngestLink } from "../src/screens/changes/ChangesScreen.tsx";
import { IngestDraftReview } from "../src/screens/changes/IngestDraftReview.tsx";

const AT = "2026-10-24T09:00:00.000Z";
const entry = (name: string, kind: "component" | "token", categories: string[]): LibraryEntry => ({
  schema: "youi.library/v1",
  id: `lib:acme-ui/${kind}/${name.toLowerCase()}`,
  name,
  kind,
  stage: "library",
  summary: `${name}, from acme/ui.`,
  source: { name: "acme/ui", url: `https://github.com/acme/ui/blob/main/${name}.tsx`, ingestedAt: AT, kind: "github", ref: `${name}.tsx` },
  categories,
  swapsWith: [],
});

const draft: IngestDraftView = {
  id: "d-0123456789",
  kind: "ingest",
  mode: "create",
  createdAt: AT,
  updatedAt: AT,
  revision: 1,
  digest: "x",
  base: { branch: "main", commit: "c".repeat(40), files: {} },
  approval: null,
  handoff: null,
  discarded: false,
  events: [],
  content: {
    reading: { link: "github:acme/ui", source: { kind: "github", name: "acme/ui", url: "https://github.com/acme/ui" }, license: { spdx: "MIT", evidenceUrl: "https://github.com/acme/ui/blob/main/LICENSE", verifiedAt: AT }, fetchedAt: AT, entries: [entry("Button", "component", ["button"]), entry("Dialog", "component", ["dialog"]), entry("Colors", "token", ["colors"])], skipped: [{ name: "theme", reason: "registry:style: not a component or block" }], notes: ["read at ccccccc (main)"] },
    keep: ["lib:acme-ui/component/button", "lib:acme-ui/component/dialog", "lib:acme-ui/token/colors"],
  },
  preview: null,
  status: "draft",
  problems: [],
  previewStale: [],
  baseStale: [],
  needsRebase: false,
  canApprove: false,
  canHandoff: false,
};
const info = { kinds: ["rule", "style", "library", "ingest"], actor: { kind: "person", name: "captain" }, project: { id: "acme-app", root: "/x", system: "acme" } } as unknown as WorkflowInfo;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an ingest draft", () => {
  test("the link, its licence with its evidence, and its items by kind; drop one and the save sends only the kept ids", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => json({ ...draft, revision: 2, content: { ...draft.content, keep: (JSON.parse(String(init?.body)) as { content: { keep: string[] } }).content.keep } }));
    vi.stubGlobal("fetch", fetch);
    const onUpdate = vi.fn();
    render(<IngestDraftReview draft={draft} info={info} onUpdate={onUpdate} />);
    expect(screen.getByRole("link", { name: "MIT" }).getAttribute("href")).toBe("https://github.com/acme/ui/blob/main/LICENSE");
    expect(screen.getByText("3 of 3 items kept")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Components" })).getAllByRole("listitem").length).toBe(2);
    expect(within(screen.getByRole("list", { name: "Tokens" })).getAllByRole("listitem").length).toBe(1);
    expect(screen.getByText("Not read (1)")).toBeTruthy();
    // Nothing to save until something changes.
    expect(screen.queryByRole("button", { name: "Save which items are kept" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep Dialog" }));
    expect(screen.getByText("2 of 3 items kept")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save which items are kept" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toMatch(/\/api\/drafts\/d-0123456789$/);
    expect(JSON.parse(String(init!.body))).toEqual({ revision: 1, content: { keep: ["lib:acme-ui/component/button", "lib:acme-ui/token/colors"] } });
  });

  test("only https links are followed: a source that served anything else is shown as text", () => {
    const odd = { ...draft, content: { ...draft.content, reading: { ...draft.content.reading, license: { spdx: "MIT", evidenceUrl: "javascript:alert(1)", verifiedAt: AT }, entries: [{ ...entry("Button", "component", ["button"]), source: { ...entry("Button", "component", []).source, url: "javascript:alert(1)" } }] } } } as IngestDraftView;
    render(<IngestDraftReview draft={odd} info={info} onUpdate={() => {}} />);
    expect(screen.queryByRole("link", { name: "MIT" })).toBeNull();
    expect(screen.getByText("MIT")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open Button at its source/ })).toBeNull();
  });

  test("a filter narrows the items, and Keep or Drop acts on what it shows", () => {
    render(<IngestDraftReview draft={draft} info={info} onUpdate={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter items" }), { target: { value: "dialog" } });
    expect(screen.queryByRole("list", { name: "Tokens" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drop these" }));
    expect(screen.getByText("2 of 3 items kept")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter items" }), { target: { value: "" } });
    expect((screen.getByRole("checkbox", { name: "Keep Button" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("ingesting a link from Changes", () => {
  test("asks the service to read the link and opens the draft; a link it cannot read says why", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => ((JSON.parse(String(init?.body)) as { link: string }).link === "github:acme/gone" ? json({ error: "could not read the repository acme/gone: not found", code: "invalid" }, 400) : json(draft, 201)));
    vi.stubGlobal("fetch", fetch);
    const { hook, history } = memoryLocation({ path: "/changes", record: true });
    render(
      <Router hook={hook}>
        <IngestLink />
      </Router>,
    );
    const field = screen.getByRole("textbox", { name: "Link to ingest" });
    fireEvent.change(field, { target: { value: "github:acme/gone" } });
    fireEvent.click(screen.getByRole("button", { name: /Ingest/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("could not read the repository acme/gone: not found");
    fireEvent.change(field, { target: { value: "github:acme/ui" } });
    fireEvent.click(screen.getByRole("button", { name: /Ingest/ }));
    await waitFor(() => expect(history.at(-1)).toBe("/changes/d-0123456789"));
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ kind: "ingest", link: "github:acme/ui" });
  });
});
