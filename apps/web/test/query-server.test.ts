/**
 * /__youi/query: paged JSON over the local index on the hub's own server, for this machine only.
 */
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeSharedStores, ingestCatalog, syncIndex } from "../../../packages/discover/src/index.ts";
import { fixtureFetcher } from "../../../packages/discover/test/fixture-fetcher.ts";
import { inventoryRun, openSqlite } from "../../../packages/store/src/index.ts";
import { inventory } from "../../../packages/store/test/fixtures.ts";
import { allowedHosts, isHubHost, isHubOrigin, queryMiddleware } from "../scripts/query-server.ts";

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
    for (const host of ["localhost", "localhost:5173", "127.0.0.1:4173", "[::1]:5173", "LOCALHOST:1"]) expect(isHubHost(host, {}), host).toBe(true);
    for (const host of [undefined, "", "evil.test", "localhost.evil.test", "127.0.0.1.nip.io:5173", "[::2]:5173", "localhost:5173:80"]) expect(isHubHost(host, {}), String(host)).toBe(false);
    const refused = await call("/__youi/query?kind=history", { host: "evil.test:5173" });
    expect(refused).toMatchObject({ status: 403 });
  });

  test("youiyoux ui --allow-host adds exactly the names it gave, and nothing that is not a plain host name", async () => {
    const env = { YOUI_ALLOW_HOSTS: " My-Mac.example.ts.net,*,http://x.test,x.test:80,.,a..b" };
    expect(allowedHosts(env)).toEqual(["my-mac.example.ts.net"]);
    for (const host of ["my-mac.example.ts.net", "my-mac.example.ts.net:8446", "localhost:5173"]) expect(isHubHost(host, env), host).toBe(true);
    for (const host of ["evil.test", "my-mac.example.ts.net.evil.test", "x.my-mac.example.ts.net", "x.test:80", "*"]) expect(isHubHost(host, env), host).toBe(false);
    // The hub's own page, wherever it is answered; never another site, a null origin or a path.
    for (const origin of ["http://localhost:5173", "https://my-mac.example.ts.net:8446", "https://my-mac.example.ts.net"]) expect(isHubOrigin(origin, env), origin).toBe(true);
    for (const origin of ["https://evil.test", "null", "https://my-mac.example.ts.net.evil.test", "https://my-mac.example.ts.net/x", "ftp://my-mac.example.ts.net"]) expect(isHubOrigin(origin, env), origin).toBe(false);
    expect(isHubOrigin("https://my-mac.example.ts.net", {})).toBe(false);
    vi.stubEnv("YOUI_ALLOW_HOSTS", "my-mac.example.ts.net");
    try {
      expect(await call("/__youi/query?kind=history", { host: "my-mac.example.ts.net:8446" })).not.toMatchObject({ status: 403 });
      expect(await call("/__youi/query?kind=history", { host: "evil.test:8446" })).toMatchObject({ status: 403 });
    } finally {
      vi.unstubAllEnvs();
    }
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

  test("discover in an order: by name, by registry then name, or by downloads, browsing or on a need, paged without moving", async () => {
    type Hit = { id: string; name: string; title: string | null; source: { kind: string; name: string; ref: string | null }; signals: { weeklyDownloads: number | null; via?: { weeklyDownloads: number } } };
    const hits = (body: Record<string, unknown>) => body.hits as Hit[];
    const title = (h: Hit) => (h.title ?? h.name).toLowerCase();
    const registry = (h: Hit) => (h.source.kind === "npm" ? "npm" : (h.source.ref ?? "").split("/")[0]!).toLowerCase();
    const sorted = (values: readonly string[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const q of ["", "&q=dialog"]) {
      const byName = hits(await ok(`/__youi/query?kind=discover${q}&sort=name&limit=100`)).map(title);
      expect(byName.length, q).toBeGreaterThan(3);
      expect(byName, q).toEqual(sorted(byName));
      const byRegistry = hits(await ok(`/__youi/query?kind=discover${q}&sort=registry&limit=100`)).map(registry);
      expect(byRegistry, q).toEqual(sorted(byRegistry));
      const downloads = hits(await ok(`/__youi/query?kind=discover${q}&sort=downloads&limit=100`)).map((h) => h.signals.weeklyDownloads ?? h.signals.via?.weeklyDownloads ?? -1);
      expect(downloads, q).toEqual([...downloads].sort((a, b) => b - a));
    }
    const ids = (body: Record<string, unknown>) => hits(body).map((h) => h.id);
    const whole = ids(await ok("/__youi/query?kind=discover&sort=name&limit=10"));
    expect([...ids(await ok("/__youi/query?kind=discover&sort=name&limit=5")), ...ids(await ok("/__youi/query?kind=discover&sort=name&limit=5&offset=5"))]).toEqual(whole);
    // An order it does not know is the recommended one.
    expect(ids(await ok("/__youi/query?kind=discover&sort=newest&limit=5"))).toEqual(ids(await ok("/__youi/query?kind=discover&limit=5")));
  });

  test("discover by id: that one listing, by lib: id or ref, for a link that opens it; a 404 for one there is not", async () => {
    expect(await ok("/__youi/query?kind=discover&id=lib%3Acoss%2Fcomponent%2Fcommand")).toMatchObject({ kind: "discover", hit: { id: "lib:coss/component/command", name: "command" } });
    expect(await ok("/__youi/query?kind=discover&id=%40coss%2Fcommand")).toMatchObject({ hit: { id: "lib:coss/component/command" } });
    const missing = await call("/__youi/query?kind=discover&id=lib%3Anope%2Fcomponent%2Fx");
    expect(missing).toMatchObject({ status: 404, body: { error: 'no Discover candidate "lib:nope/component/x"' } });
  });

  test("discover facets: licence known or unknown, headless or styled, on a need and when browsing", async () => {
    const licences = (body: Record<string, unknown>) => (body.hits as Array<{ license: string }>).map((h) => h.license);
    // Browsing holds both; on a need, command menus are all known (coss's is AGPL-3.0) and Aceternity's spotlight is not
    // (no repository links both ways with its homepage).
    for (const [q, kinds] of [["", ["known", "unknown"]], ["&q=command", ["known"]], ["&q=spotlight", ["unknown"]]] as const) {
      for (const kind of kinds) {
        const hits = licences(await ok(`/__youi/query?kind=discover${q}&licence=${kind}&limit=100`));
        expect(hits.length, `${q} ${kind}`).toBeGreaterThan(0);
        expect(hits.every((l) => (l === "unknown") === (kind === "unknown")), `${q} ${kind}`).toBe(true);
      }
    }
    const names = (body: Record<string, unknown>) => (body.hits as Array<{ name: string }>).map((h) => h.name);
    const all = await ok("/__youi/query?kind=discover&q=toast&limit=100");
    const headless = await ok("/__youi/query?kind=discover&q=toast&style=headless&limit=100");
    const styled = await ok("/__youi/query?kind=discover&q=toast&style=styled&limit=100");
    expect(names(headless)).toContain("@radix-ui/react-toast");
    expect(names(styled)).not.toContain("@radix-ui/react-toast");
    expect(headless.matched as number + (styled.matched as number)).toBe(all.matched);
    // Every result card has what it needs: licence, signals and the install command.
    const command = (await ok("/__youi/query?kind=discover&q=command%20menu&limit=5")).hits as Array<{ id: string; license: string; signals: { via?: { package: string; weeklyDownloads: number } }; install: { command: string } | null }>;
    expect(command.find((h) => h.id === "lib:shadcn/component/command")).toMatchObject({ license: "MIT", signals: { via: { package: "cmdk", weeklyDownloads: 41566267 } }, install: { command: "npx shadcn add command" } });
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
    expect(await call("/__youi/query?kind=history", { mw: bare })).toMatchObject({ status: 404, body: { error: expect.stringMatching(/youiyoux inventory/) } });
    expect(await call("/__youi/query?kind=discover&q=toast", { mw: bare })).toMatchObject({ status: 404, body: { error: expect.stringMatching(/youiyoux discover sync/) } });
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
    const previous = { YOUI_INDEX: process.env.YOUI_INDEX, YOUI_DISCOVER_CACHE: process.env.YOUI_DISCOVER_CACHE, YOUI_ALLOW_HOSTS: process.env.YOUI_ALLOW_HOSTS };
    process.env.YOUI_INDEX = index;
    process.env.YOUI_DISCOVER_CACHE = cache;
    process.env.YOUI_ALLOW_HOSTS = "my-mac.example.ts.net";
    const server = await createServer({ configFile: resolve(import.meta.dirname, "../vite.config.ts"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      await server.listen();
      const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      const response = await fetch(`${origin}/__youi/query?kind=history&limit=1`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { rows: unknown[] }).rows).toHaveLength(1);
      // Vite itself answers a name given to youiyoux ui --allow-host (as tailscale serve sends it), and no other.
      const statusFor = (host: string): Promise<number> =>
        new Promise((done, fail) => {
          const { port } = new URL(origin);
          request({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
            res.resume();
            done(res.statusCode ?? 0);
          })
            .on("error", fail)
            .end();
        });
      expect(await statusFor("my-mac.example.ts.net:8446")).toBe(200);
      expect(await statusFor("evil.example:8446")).toBe(403);
    } finally {
      await server.close();
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});
