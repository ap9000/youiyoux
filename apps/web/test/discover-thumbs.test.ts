/** Discover thumbnails: which pictures are current, what a capture takes again, and the hub's endpoints for them. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { currentThumbs, discoverThumbsMiddleware, emptyIndex, needsCapture, prunePictures, readThumbIndex, selectCandidates, thumbsDir, writeThumbIndex, type ThumbIndex } from "../scripts/discover-thumbs.ts";
import { shortReason } from "../src/data/discover-thumbs.ts";

const scratch = mkdtempSync(join(tmpdir(), "youi-thumbs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const AT = "2026-10-22T12:00:00.000Z";
const KEY = "0123456789abcdef";
const index: ThumbIndex = {
  ...emptyIndex("console"),
  items: { "lib:shadcn/component/button": { sha: "b1", key: KEY, width: 928, height: 568, capturedAt: AT }, "lib:shadcn/component/card": { sha: "c-old", key: "fedcba9876543210", width: 928, height: 568, capturedAt: AT } },
  failed: { "lib:shadcn/component/chart": { sha: "ch1", reason: "it needs recharts, which is installed in neither your project nor the hub", at: AT } },
};

describe("what a capture takes", () => {
  test("a current picture and a current failure are left alone; a changed listing, a new one or --force is taken", () => {
    expect(needsCapture(index, "lib:shadcn/component/button", "b1")).toBe(false);
    expect(needsCapture(index, "lib:shadcn/component/chart", "ch1")).toBe(false);
    expect(needsCapture(index, "lib:shadcn/component/card", "c-new")).toBe(true);
    expect(needsCapture(index, "lib:shadcn/component/chart", "ch2")).toBe(true);
    expect(needsCapture(index, "lib:shadcn/component/dialog", "d1")).toBe(true);
    expect(needsCapture(index, "lib:shadcn/component/button", "b1", true)).toBe(true);
  });

  test("registry items only (an npm package has no drawing), narrowed by registry, type and count", () => {
    const entries = [
      { id: "lib:shadcn/component/button", source: { kind: "shadcn-registry", ref: "@shadcn/button" }, categories: ["button"], provenance: { sha256: "b" } },
      { id: "lib:coss/component/button", source: { kind: "shadcn-registry", ref: "@coss/button" }, categories: ["button"], provenance: { sha256: "c" } },
      { id: "lib:shadcn/component/dialog", source: { kind: "shadcn-registry", ref: "@shadcn/dialog" }, categories: [], provenance: { sha256: "d" } },
      { id: "lib:npm/component/cmdk", source: { kind: "npm", ref: "cmdk" }, categories: ["command"], provenance: { sha256: "n" } },
      { id: "lib:shadcn/component/nosha", source: { kind: "shadcn-registry", ref: "@shadcn/nosha" }, provenance: null },
    ];
    expect(selectCandidates(entries, { registry: null, role: null, limit: null }).map((e) => e.id)).toEqual(["lib:shadcn/component/button", "lib:coss/component/button", "lib:shadcn/component/dialog"]);
    expect(selectCandidates(entries, { registry: "@shadcn", role: null, limit: null }).map((e) => e.id)).toEqual(["lib:shadcn/component/button", "lib:shadcn/component/dialog"]);
    expect(selectCandidates(entries, { registry: null, role: "button", limit: 1 }).map((e) => e.id)).toEqual(["lib:shadcn/component/button"]);
    expect(selectCandidates(entries, { registry: null, role: "dialog", limit: null }).map((e) => e.id)).toEqual(["lib:shadcn/component/dialog"]);
  });

  test("only pictures of listings unchanged since are current; a failure is said once nothing newer stands", () => {
    const current = new Map([["lib:shadcn/component/button", "b1"], ["lib:shadcn/component/card", "c-new"], ["lib:shadcn/component/chart", "ch1"]]);
    expect(currentThumbs(index, current, (file) => `/t/${file}`)).toEqual({
      project: "console",
      items: { "lib:shadcn/component/button": { light: `/t/${KEY}.light.webp`, dark: `/t/${KEY}.dark.webp`, width: 928, height: 568, capturedAt: AT } },
      failed: { "lib:shadcn/component/chart": "it needs recharts, which is installed in neither your project nor the hub" },
    });
  });

  test("the index round-trips, a project id that is not one never reaches a path, and pictures nobody names are removed", async () => {
    const cache = join(scratch, "cache-a");
    await writeThumbIndex(cache, index);
    expect(readThumbIndex(cache, "console")).toEqual(index);
    expect(readThumbIndex(cache, "other")).toEqual(emptyIndex("other"));
    for (const bad of ["..", "../etc", "a/b", ""]) expect(() => thumbsDir(cache, bad)).toThrow(/is not a project id/);
    const dir = thumbsDir(cache, "console");
    for (const name of [`${KEY}.light.webp`, `${KEY}.dark.webp`, "aaaaaaaaaaaaaaaa.light.webp", "notes.txt"]) writeFileSync(join(dir, name), "x");
    expect(await prunePictures(cache, { ...index, items: { "lib:shadcn/component/button": index.items["lib:shadcn/component/button"]! } })).toBe(1);
    expect(existsSync(join(dir, `${KEY}.light.webp`))).toBe(true);
    expect(existsSync(join(dir, "aaaaaaaaaaaaaaaa.light.webp"))).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});

describe("the hub's thumbnail endpoints", () => {
  const snapshot = join(scratch, "snapshot");
  const cache = join(scratch, "cache-b");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "try.json"), JSON.stringify({ schema: "youiyoux.try/v1", projects: { console: { root: "../console", tsconfig: "tsconfig.json" }, site: { root: "../site", tsconfig: "tsconfig.json" } } }));
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "index.json"), JSON.stringify({ entries: [{ id: "lib:shadcn/component/button", provenance: { sha256: "b1" } }, { id: "lib:shadcn/component/card", provenance: { sha256: "c-new" } }, { id: "lib:shadcn/component/chart", provenance: { sha256: "ch1" } }] }));
  const middleware = discoverThumbsMiddleware(snapshot, "/", { cache });

  function ask(path: string, host = "localhost:5173"): Promise<{ status: number; type: string | undefined; body: string }> {
    return new Promise((done) => {
      const headers: Record<string, string> = {};
      const res = { statusCode: 200, setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value), end: (body: string | Buffer) => done({ status: res.statusCode, type: headers["content-type"], body: String(body) }) };
      void middleware({ url: path, method: "GET", headers: { host } } as unknown as IncomingMessage, res as unknown as ServerResponse, () => done({ status: 0, type: undefined, body: "next" }));
    });
  }

  test("the first project's current pictures, by URL; a picture by its name; another project by id", async () => {
    await writeThumbIndex(cache, index);
    writeFileSync(join(thumbsDir(cache, "console"), `${KEY}.light.webp`), "WEBP-BYTES");
    const answer = await ask("/__youi/discover-thumbs");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ project: "console", items: { "lib:shadcn/component/button": { light: `/__youi/discover-thumbs/console/${KEY}.light.webp` } }, failed: { "lib:shadcn/component/chart": expect.any(String) } });
    expect(Object.keys(JSON.parse(answer.body).items)).toEqual(["lib:shadcn/component/button"]);
    expect(await ask(`/__youi/discover-thumbs/console/${KEY}.light.webp`)).toEqual({ status: 200, type: "image/webp", body: "WEBP-BYTES" });
    expect(JSON.parse((await ask("/__youi/discover-thumbs?project=site")).body)).toEqual({ project: "site", items: {}, failed: {} });
    expect((await ask("/__youi/discover-thumbs?project=nope")).status).toBe(404);
  });

  test("this machine only, and nothing but a picture's own name is read", async () => {
    expect((await ask("/__youi/discover-thumbs", "evil.example:5173")).status).toBe(403);
    vi.stubEnv("YOUI_ALLOW_HOSTS", "my-mac.example.ts.net");
    try {
      // A name given to youiyoux ui --allow-host is answered; others still are not.
      expect((await ask("/__youi/discover-thumbs?project=console", "my-mac.example.ts.net:8446")).status).toBe(200);
      expect((await ask("/__youi/discover-thumbs", "evil.example:8446")).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
    for (const path of ["/__youi/discover-thumbs/console/..%2Ftry.json", "/__youi/discover-thumbs/..%2F..%2Fsnapshot/try.json", `/__youi/discover-thumbs/console/${KEY}.light.png`, "/__youi/discover-thumbs/console/index.json"]) expect((await ask(path)).status, path).toBe(400);
    expect((await ask("/__youi/discover-thumbs/console/ffffffffffffffff.dark.webp")).status).toBe(404);
    expect((await ask("/elsewhere")).body).toBe("next");
  });
});

test("a missing picture's reason in the few words a card has room for", () => {
  expect(shortReason("it needs recharts, which is installed in neither your project nor the hub")).toBe("Needs recharts");
  expect(shortReason("it needs radix-ui's Accordion (@radix-ui/react-accordion), installed in neither your project nor the hub")).toBe("Needs Accordion");
  expect(shortReason("it needs @/registry/new-york-v4/ui/collapsible, which your project does not have")).toBe("Needs its collapsible part");
  expect(shortReason("It failed when it ran (`AccordionHeader` must be used within `AccordionItem`); the listing stands")).toBe("Fails when drawn alone");
  expect(shortReason("It draws nothing visible on its own (it may need content, a provider or a parent)")).toBe("Draws nothing on its own");
  expect(shortReason("something else")).toBe("Not drawn on its own");
});
