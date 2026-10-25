import { renderDiscoverShow, renderDiscoverSearch, renderRegistries } from "../src/discover.ts";
import { loadIndex, searchIndex, showCandidate } from "@youiyoux/discover";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { fixtureFetcher } from "../../discover/test/fixture-fetcher.ts";
import { main } from "../src/index.ts";

const TOKEN = "ghp_fixtureTOKEN0123456789abcdefABCDEF";
let dir: string;
let out = "";
let err = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-cli-discover-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("youiyoux discover", () => {
  test("search before any sync says how to build the index, and fetches nothing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const empty = await mkdtemp(join(tmpdir(), "youi-cli-discover-empty-"));
    expect(await main(["discover", "command menu", "--cache", empty])).toBe(1);
    expect(err).toContain("youiyoux discover sync");
    expect(await readdir(empty)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await rm(empty, { recursive: true, force: true });
  });

  test("sync --json builds the index politely from the shadcn registry, the directory and healthy community registries", async () => {
    vi.stubEnv("GITHUB_TOKEN", TOKEN);
    const fixtures = fixtureFetcher({ delayMs: 2 });
    expect(await main(["discover", "sync", "--cache", dir, "--json"], { sleep: async () => {}, fetcher: fixtures.fetcher, timeoutMs: 100 })).toBe(0);
    const summary = JSON.parse(out) as { entries: { official: number; community: number; npm: number }; registries: Record<string, number>; requests: { maxInFlight: number }; failures: Array<{ id: string }> };
    expect(summary.entries.official).toBeGreaterThan(0);
    expect(summary.entries.community).toBeGreaterThan(0);
    expect(summary.registries).toMatchObject({ listed: 9, fetched: 4, skipped: 5, failed: 0 });
    expect(summary.requests.maxInFlight).toBeLessThanOrEqual(6);
    expect(summary.failures.map((f) => f.id).sort()).toEqual([]);
    // The JSON catalog, and beside it (an explicit --cache) the store it was loaded into and what a rebuild reloads.
    expect((await readdir(dir)).filter((f) => !/^index\.db-(?:wal|shm)$/.test(f)).sort()).toEqual(["directory.json", "health.json", "index-sources.json", "index.db", "index.json", "listings", "signals.json"]);
    expect(out).not.toContain(TOKEN);
    for (const file of ["index.json", "health.json", "signals.json", "index.db"]) expect(await readFile(join(dir, file), "utf8")).not.toContain(TOKEN);
  }, 60_000);

  test("sync prints a readable summary", async () => {
    expect(await main(["discover", "sync", "--cache", dir], { sleep: async () => {}, fetcher: fixtureFetcher().fetcher, timeoutMs: 100 })).toBe(0);
    expect(out).toMatch(/synced \d+ candidates/);
    expect(out).toMatch(/4 unchanged \(304\)/);
    expect(out).toContain("0 failed");
    expect(out).toMatch(/index\s+\d+ entries · [\d,]+ bytes/);
  }, 60_000);

  test("\"command menu\" --json ranks command and cmdk-based items first, with licence, signals and install command, from the local index only", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await main(["discover", "command menu", "--cache", dir, "--json"])).toBe(0);
    const result = JSON.parse(out) as { hits: Array<{ source: { ref: string }; license: string; signals: Record<string, unknown>; install: { command: string } }> };
    expect(result.hits.slice(0, 2).map((h) => h.source.ref)).toEqual(["@shadcn/command", "@coss/command"]);
    expect(result.hits[0]).toMatchObject({ license: "MIT", install: { command: "npx shadcn add command" }, signals: { weeklyDownloads: null, via: { package: "cmdk", weeklyDownloads: 41566267 }, stars: 125435 } });
    expect(result.hits[1]).toMatchObject({ license: "AGPL-3.0", install: { command: "npx shadcn add @coss/command" } });
    for (const hit of result.hits) {
      expect(hit.license).toEqual(expect.any(String));
      expect(Object.keys(hit.signals).sort()).toEqual(["archived", "pushedAt", "stars", ...(hit.signals.via ? ["via"] : []), "weeklyDownloads"]);
      expect(hit.install.command).toMatch(/^(npx shadcn add|npm install) /);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("the text view shows licence, signals and install command per hit; --role and --license filter", async () => {
    expect(await main(["discover", "command", "menu", "--cache", dir])).toBe(0);
    expect(out).toMatch(/@shadcn\/command[\s\S]*MIT · 42M\/wk via cmdk · 125k★[\s\S]*npx shadcn add command/);
    expect(out).toMatch(/@coss\/command[\s\S]*AGPL-3\.0 \(copyleft\)/);
    expect(out).not.toMatch(/MIT \(copyleft\)/);
    out = "";
    expect(await main(["discover", "spotlight", "--cache", dir])).toBe(0);
    expect(out).toMatch(/@aceternity\/spotlight[\s\S]*licence unknown/);
    out = "";
    expect(await main(["discover", "command menu", "--license", "MIT", "--cache", dir, "--json"])).toBe(0);
    expect((JSON.parse(out) as { hits: Array<{ license: string }> }).hits.every((h) => h.license === "MIT")).toBe(true);
    out = "";
    expect(await main(["discover", "dialog", "--role", "command palette", "--cache", dir, "--json"])).toBe(0);
    expect((JSON.parse(out) as { hits: Array<{ source: { ref: string } }> }).hits.map((h) => h.source.ref)).toEqual(["@coss/p-command-1", "@coss/p-command-2"]);
  });

  test("show gives provenance, licence evidence and dependencies", async () => {
    expect(await main(["discover", "show", "@kibo-ui/choicebox", "--cache", dir])).toBe(0);
    expect(out).toContain("npx shadcn add @kibo-ui/choicebox");
    expect(out).toMatch(/licence\s+MIT/);
    expect(out).toMatch(/implicit\s+@repo\/shadcn-ui/);
    expect(out).toMatch(/health\s+healthy/);
    out = "";
    expect(await main(["discover", "show", "lib:shadcn/component/command", "--cache", dir, "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ entry: { id: "lib:shadcn/component/command", provenance: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } } });
    expect(await main(["discover", "show", "--cache", dir])).toBe(2);
    expect(await main(["discover", "--cache", dir])).toBe(2);
  });

  test("registries lists the directory for someone who does not know the names, from the cache only", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await main(["discover", "registries", "--cache", dir, "--json"])).toBe(0);
    const listed = JSON.parse(out) as { total: number; left: number; rows: Array<{ name: string; state: string; listed: number | null }> };
    expect(listed.rows.slice(0, 2).map((r) => [r.name, r.state])).toEqual([["@shadcn", "official"], ["@coss", "source"]]);
    expect(listed.rows.find((r) => r.name === "@coss")!.listed).toBeGreaterThan(0);
    // Hidden and unavailable registries are left out, and counted.
    expect(listed.rows.map((r) => r.name)).not.toContain("@abstract");
    expect(listed.left).toBe(2);
    out = "";
    expect(await main(["discover", "registries", "animated", "--cache", dir])).toBe(0);
    expect(out).toContain("@magicui");
    expect(out).not.toContain("@coss");
    expect(out).toContain("Next: youiyoux discover \"<need>\" --all");
    out = "";
    expect(await main(["discover", "registries", "--sort", "stars", "--cache", dir])).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("help lists discover", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toMatch(/discover sync[\s\S]*discover "<need>"[\s\S]*discover show/);
  });
});

test("legacy index text is cleaned in CLI text and JSON, including echoed need", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "youi-cli-escape-"));
  try {
    const raw = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    delete raw.format;
    const command = raw.entries.find((entry: { source: { ref: string } }) => entry.source.ref === "@shadcn/command");
    command.title = "\x1b]0;pwned\x07Command";
    command.summary = "\x1b[2JCommand menu";
    command.categories.push("\x90payload\x9ccommand");
    await writeFile(join(isolated, "index.json"), JSON.stringify(raw));
    expect(await main(["index", "rebuild", "--cache", isolated])).toBe(0);
    for (const args of [["command\x1b[2J menu"], ["command menu", "--json"], ["show", "command"], ["show", "command", "--json"]]) {
      out = "";
      expect(await main(["discover", ...args, "--cache", isolated])).toBe(0);
      expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(out).not.toMatch(/pwned|payload/);
      if (args.includes("--json")) expect(JSON.stringify(JSON.parse(out))).not.toMatch(/\\u00(?:0[0-8b-f]|1[0-9a-f]|7f|[89][0-9a-f])/i);
    }
  } finally { await rm(isolated, { recursive: true, force: true }); }
});

test("CLI renderers independently clean all data strings before styling", async () => {
  const index = await loadIndex(dir);
  const inject = <T,>(value: T): T => {
    if (typeof value === "string") return `${value}\x1b]0;pwned\x07\x1b[2J\x7f` as T;
    if (Array.isArray(value)) return value.map(inject) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inject(item)])) as T;
    return value;
  };
  const registries = { total: 1, offset: 0, left: 0, icons: 0, every: null, rows: [{ name: "@x", homepage: null, description: "a registry", itemCount: 3, state: "available" as const, listed: null }] };
  for (const result of [renderDiscoverShow(inject(showCandidate(index, "command"))), renderDiscoverSearch(inject(searchIndex(index, "command menu"))), renderRegistries(inject(registries), inject("q"))]) {
    expect(result).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(result).not.toContain("pwned");
  }
});

test("sources commands persist selection, --all caches listings, and --source fetches one item", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "youi-cli-sources-"));
  try {
    const fixture = fixtureFetcher({ override: (url) => url.endsWith("/r/registries.json") ? { inline: JSON.stringify([{ name: "@extra", url: "https://extra.test/{name}.json" }]) } : url === "https://extra.test/registry.json" ? { inline: '{"items":[{"name":"command","type":"registry:ui"}]}' } : url === "https://extra.test/command.json" ? { inline: '{"name":"command","type":"registry:ui","files":[{"path":"command.tsx","content":"export const command = 1;"}]}' } : undefined });
    const io = { fetcher: fixture.fetcher, sleep: async () => {}, timeoutMs: 100 };
    expect(await main(["discover", "sync", "--cache", isolated], io)).toBe(0);
    expect(fixture.requests.some((r) => r.url.includes("extra.test"))).toBe(false);
    for (const action of ["add", "list", "remove"]) expect(await main(["discover", "sources", action, ...(action === "list" ? [] : ["extra"]), "--cache", isolated, "--json"], io)).toBe(0);
    for (let i = 0; i < 2; i++) {
      out = "";
      expect(await main(["discover", "command", "--all", "--cache", isolated, "--json"], io)).toBe(0);
      expect(JSON.parse(out).hits.some((h: { source: { ref: string } }) => h.source.ref === "@extra/command")).toBe(true);
    }
    expect(fixture.requests.filter((r) => r.url === "https://extra.test/registry.json")).toHaveLength(1);
    out = "";
    expect(await main(["discover", "show", "@extra/command", "--source", "--cache", isolated], io)).toBe(0);
    expect(JSON.parse(out).files[0].content).toBe("export const command = 1;");
    expect(fixture.requests.filter((r) => r.url === "https://extra.test/command.json")).toHaveLength(1);
  } finally { await rm(isolated, { recursive: true, force: true }); }
});
