/**
 * /__youi/discover-every: every registry's listings fetched on request (metadata only, recorded
 * responses, never the network) into the local index, kept apart from your sources'; asked only by
 * the hub's own page.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeSharedStores, ingestCatalog, syncIndex } from "../../../packages/discover/src/index.ts";
import { openSqlite } from "../../../packages/store/src/index.ts";
import { fixtureFetcher } from "../../../packages/discover/test/fixture-fetcher.ts";
import { discoverEveryMiddleware, type EveryStatus } from "../scripts/discover-every.ts";
import { queryMiddleware } from "../scripts/query-server.ts";

const scratch = mkdtempSync(join(tmpdir(), "youi-discover-every-"));
const cache = join(scratch, "discover");
const index = join(scratch, "index.db");
/** The directory with one more healthy registry than the fixture's sources, and its listing. */
const EXTRA = { name: "@extra", url: "https://extra.test/r/{name}.json", description: "Animated pricing blocks" };
const recorded = () => fixtureFetcher({ override: (url) => (url === "https://extra.test/r/registry.json" ? { inline: JSON.stringify({ items: [{ name: "pricing-table", type: "registry:block", description: "A pricing table", files: [{ path: "pricing-table.tsx" }] }] }) } : url.endsWith("/r/registries.json") ? { inline: JSON.stringify([EXTRA]) } : undefined) });

beforeAll(async () => {
  await syncIndex({ sleep: async () => {}, cacheDir: cache, fetcher: recorded().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  const store = await openSqlite(index);
  await ingestCatalog(store, cache);
  await store.close();
}, 60_000);
afterAll(async () => {
  await closeSharedStores();
  rmSync(scratch, { recursive: true, force: true });
});

async function call(middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>, url: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown> } | "next"> {
  return new Promise((done) => {
    const res = { statusCode: 200, setHeader: () => undefined, end: (body: string) => done({ status: res.statusCode, body: JSON.parse(body) as Record<string, unknown> }) };
    void middleware({ url, method: options.method ?? "GET", headers: { host: "localhost:5173", ...options.headers } } as unknown as IncomingMessage, res as unknown as ServerResponse, () => done("next"));
  });
}

/** An answer's body, as the shape the test reads. */
function bodyOf<T>(answer: Awaited<ReturnType<typeof call>>): T {
  if (answer === "next") throw new Error("not answered");
  return answer.body as unknown as T;
}

const statusOf = async (middleware: ReturnType<typeof discoverEveryMiddleware>): Promise<EveryStatus> => {
  const answer = await call(middleware, "/__youi/discover-every");
  if (answer === "next") throw new Error("not answered");
  return answer.body as unknown as EveryStatus;
};

describe("/__youi/discover-every", () => {
  test("only the hub's own page starts it: another site's Origin, a sandboxed frame's null one, or cross-site is refused, and nothing is fetched", async () => {
    const network = recorded();
    const middleware = discoverEveryMiddleware("/", { cache, index, env: {}, fetcher: network.fetcher });
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }] as Array<Record<string, string>>) expect(await call(middleware, "/__youi/discover-every", { method: "POST", headers }), JSON.stringify(headers)).toMatchObject({ status: 403 });
    expect(await call(middleware, "/__youi/discover-every", { headers: { host: "evil.example" } })).toMatchObject({ status: 403 });
    expect(await call(middleware, "/__youi/discover-every", { method: "PUT" })).toMatchObject({ status: 405 });
    expect(await call(middleware, "/__youi/query")).toBe("next");
    expect(network.requests).toEqual([]);
    expect(existsSync(join(cache, "index-all.json"))).toBe(false);
  });

  test("none, then running with how far it has got, then ready: the listings are searchable among every registry's, never among your sources'", async () => {
    const network = recorded();
    const middleware = discoverEveryMiddleware("/", { cache, index, env: {}, fetcher: network.fetcher });
    expect(await statusOf(middleware)).toMatchObject({ state: "none", fetchedAt: null });
    const started = await call(middleware, "/__youi/discover-every", { method: "POST", headers: { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" } });
    expect(started).toMatchObject({ status: 202, body: { state: "running" } });
    // A second POST joins the fetch already running.
    expect(await call(middleware, "/__youi/discover-every", { method: "POST" })).toMatchObject({ status: 202, body: { state: "running" } });
    let status = await statusOf(middleware);
    for (let i = 0; status.state === "running" && i < 200; i++) {
      await new Promise((done) => setTimeout(done, 10));
      status = await statusOf(middleware);
    }
    expect(status).toMatchObject({ state: "ready", done: 1, total: 1, listings: 1, failed: 0, error: null });
    expect(status.fetchedAt).toMatch(/^\d{4}-/);
    // Metadata only: the registry's list, once, and no item.
    expect(network.requests.map((r) => r.url)).toEqual(["https://extra.test/r/registry.json"]);

    const query = queryMiddleware({ cache, index, env: {} });
    const every = await call(query, "/__youi/query?kind=discover&all=1&q=pricing");
    expect(every).toMatchObject({ status: 200 });
    expect(bodyOf<{ hits: Array<{ source: { ref: string } }> }>(every).hits.map((h) => h.source.ref)).toContain("@extra/pricing-table");
    const yours = await call(query, "/__youi/query?kind=discover&q=pricing");
    expect(bodyOf<{ hits: Array<{ source: { ref: string } }> }>(yours).hits.map((h) => h.source.ref)).not.toContain("@extra/pricing-table");
    // The registries list now counts it as listed.
    const registries = await call(query, "/__youi/query?kind=registries&q=pricing");
    expect(bodyOf<{ rows: unknown[] }>(registries).rows).toEqual([expect.objectContaining({ name: "@extra", state: "listed", listed: 1 })]);
  });

  test("with no Discover index yet, starting says what to run", async () => {
    const middleware = discoverEveryMiddleware("/", { cache: join(scratch, "empty"), index: join(scratch, "empty.db"), env: {} });
    expect(await call(middleware, "/__youi/discover-every", { method: "POST" })).toMatchObject({ status: 404, body: { error: expect.stringMatching(/youiyoux discover sync/) } });
  });
});
