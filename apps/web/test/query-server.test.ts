/**
 * /__youi/query: paged JSON over the local index on the hub's own server, for this machine only.
 */
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeSharedStores, ingestCatalog, syncIndex } from "../../../packages/discover/src/index.ts";
import { fixtureFetcher } from "../../../packages/discover/test/fixture-fetcher.ts";
import { inventoryRun, openSqlite } from "../../../packages/store/src/index.ts";
import { inventory } from "../../../packages/store/test/fixtures.ts";
import { isLocalHost, queryMiddleware } from "../scripts/query-server.ts";

const scratch = mkdtempSync(join(tmpdir(), "youi-query-server-"));
const cache = join(scratch, "discover");
const index = join(scratch, "index.db");
const middleware = queryMiddleware({ cache, index, env: {} });

beforeAll(async () => {
  await syncIndex({ sleep: async () => {}, cacheDir: cache, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  const store = await openSqlite(index);
  await ingestCatalog(store, cache);
  await store.recordInventory(inventoryRun(inventory("2026-10-10T09:00:00.000Z"), "/work/inventory.json"));
  await store.recordInventory(inventoryRun(inventory("2026-10-12T09:00:00.000Z", 3), "/work/inventory.json"));
  await store.close();
}, 60_000);
afterAll(async () => {
  await closeSharedStores();
  rmSync(scratch, { recursive: true, force: true });
});

async function call(url: string, options: { method?: string; host?: string; mw?: ReturnType<typeof queryMiddleware> } = {}): Promise<{ status: number; body: Record<string, unknown>; cache: string } | "next"> {
  let headers: Record<string, string> = {};
  return new Promise((done) => {
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => (headers = { ...headers, [name.toLowerCase()]: value }),
      end: (body: string) => done({ status: res.statusCode, body: JSON.parse(body) as Record<string, unknown>, cache: headers["cache-control"] ?? "" }),
    };
    void (options.mw ?? middleware)({ url, method: options.method ?? "GET", headers: { host: options.host ?? "localhost:5173" } } as unknown as IncomingMessage, res as unknown as ServerResponse, () => done("next"));
  });
}

const ok = async (url: string) => {
  const result = await call(url);
  if (result === "next") throw new Error("not answered");
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.cache).toBe("no-store");
  return result.body;
};

describe("/__youi/query", () => {
  test("only this machine: localhost, 127.0.0.1 and [::1] on any port; any other Host is a 403", async () => {
    for (const host of ["localhost", "localhost:5173", "127.0.0.1:4173", "[::1]:5173", "LOCALHOST:1"]) expect(isLocalHost(host), host).toBe(true);
    for (const host of [undefined, "", "evil.test", "localhost.evil.test", "127.0.0.1.nip.io:5173", "[::2]:5173", "localhost:5173:80"]) expect(isLocalHost(host), String(host)).toBe(false);
    const refused = await call("/__youi/query?kind=history", { host: "evil.test:5173" });
    expect(refused).toMatchObject({ status: 403 });
  });

  test("other paths and methods pass through", async () => {
    expect(await call("/__youi/try?project=x")).toBe("next");
    expect(await call("/__youi/query?kind=history", { method: "POST" })).toBe("next");
    expect(await call("/inventory")).toBe("next");
  });

  test("discover: a need, paged and faceted from the store; without one, listings browse official first", async () => {
    const whole = await ok("/__youi/query?kind=discover&q=dialog&limit=6");
    const first = await ok("/__youi/query?kind=discover&q=dialog&limit=3");
    const second = await ok("/__youi/query?kind=discover&q=dialog&limit=3&offset=3");
    const ids = (body: Record<string, unknown>) => (body.hits as Array<{ id: string }>).map((h) => h.id);
    expect([...ids(first), ...ids(second)]).toEqual(ids(whole));
    expect(whole.facets).toMatchObject({ role: expect.objectContaining({ dialog: expect.any(Number) }) });
    const browse = await ok("/__youi/query?kind=discover&limit=5");
    expect(browse.total).toBeGreaterThan(5);
    expect((browse.hits as Array<{ id: string }>)[0]!.id).toMatch(/^lib:shadcn\//);
    const mit = await ok("/__youi/query?kind=discover&licence=MIT&limit=100");
    expect((mit.hits as Array<{ license: string }>).every((h) => h.license === "MIT")).toBe(true);
    expect(await ok("/__youi/query?kind=discover&q=command&limit=500")).toMatchObject({ limit: 100 });
  });

  test("history, families and looks page through the inventory runs", async () => {
    const history = await ok("/__youi/query?kind=history&limit=2");
    expect((history.rows as Array<{ project: string; scannedAt: string }>).map((r) => [r.project, r.scannedAt.slice(0, 10)])).toEqual([["console", "2026-10-12"], ["site", "2026-10-12"]]);
    expect(history.more).toBe(true);
    const older = await ok("/__youi/query?kind=history&project=console&offset=1");
    expect((older.rows as Array<{ scannedAt: string }>).map((r) => r.scannedAt.slice(0, 10))).toEqual(["2026-10-10"]);
    const families = await ok("/__youi/query?kind=families&role=button");
    expect(families).toMatchObject({ total: 2 });
    const looks = await ok("/__youi/query?kind=looks&family=button-1&limit=2&offset=2");
    expect(looks).toMatchObject({ total: 5, offset: 2 });
    expect((looks.rows as unknown[]).length).toBe(2);
  });

  test("an unknown kind, or no index yet, is a 404 that says what to run, and creates nothing", async () => {
    expect(await call("/__youi/query?kind=nope")).toMatchObject({ status: 404 });
    const empty = join(scratch, "empty");
    const bare = queryMiddleware({ cache: join(empty, "discover"), index: join(empty, "index.db"), env: {} });
    expect(await call("/__youi/query?kind=history", { mw: bare })).toMatchObject({ status: 404, body: { error: expect.stringMatching(/youi inventory/) } });
    expect(await call("/__youi/query?kind=discover&q=toast", { mw: bare })).toMatchObject({ status: 404, body: { error: expect.stringMatching(/youi discover sync/) } });
    expect(existsSync(empty)).toBe(false);
  });

  test("queries do not ingest changed catalog JSON or modify the store", async () => {
    const file = join(cache, "index.json");
    const saved = readFileSync(file);
    const before = readFileSync(index);
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(saved.toString()), entries: [] }));
      const result = await ok("/__youi/query?kind=discover&q=command");
      expect((result.hits as unknown[]).length).toBeGreaterThan(0);
      expect(readFileSync(index)).toEqual(before);
    } finally { writeFileSync(file, saved); }
  });

  test("the hub's dev server answers it, beside Try it", async () => {
    const { createServer } = await import("vite");
    const previous = { YOUI_INDEX: process.env.YOUI_INDEX, YOUI_DISCOVER_CACHE: process.env.YOUI_DISCOVER_CACHE };
    process.env.YOUI_INDEX = index;
    process.env.YOUI_DISCOVER_CACHE = cache;
    const server = await createServer({ configFile: resolve(import.meta.dirname, "../vite.config.ts"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      await server.listen();
      const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      const response = await fetch(`${origin}/__youi/query?kind=history&limit=1`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    } finally {
      await server.close();
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});
