import { mkdtemp, readFile, readdir, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { candidateSource, catalogBytes, CURATED, readAllIndex, dedupe, expandAll, listRegistries, loadIndex, readSources, registryEntry, parseRegistryItems, searchIndex, selectSources, SHADCN, syncIndex, writeJson } from "../src/index.ts";
import * as text from "../src/text.ts";
import { fixtureFetcher } from "./fixture-fetcher.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "discover-demand-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const options = { sleep: async () => {}, now: () => new Date("2026-10-12T12:00:00Z"), npm: false, budgets: { npmPackages: 0, githubRepos: 0, githubSearches: 0 } };
const rows = [
  { name: "@coss", url: "https://coss.com/ui/r/{name}.json" },
  { name: "@extra", url: "https://extra.test/r/{name}.json", description: "Animated blocks for landing pages", ranking: { itemCount: 12 } },
  { name: "@icons", url: "https://icons.test/r/{name}.json", description: "icons" },
  { name: "@unsafe", url: "https://localhost/r/{name}.json" },
  { name: "@bad-home", url: "https://bad-home.test/r/{name}.json", homepage: "http://bad-home.test" },
];
const SOURCE = 'import { Floating } from "@floating-ui/react"; // SOURCE_SENTINEL';
function fixtures() {
  return fixtureFetcher({ override: (url) => url === SHADCN.directory ? { inline: JSON.stringify(rows) } : url === "https://extra.test/r/registry.json" ? { inline: JSON.stringify({ items: [{ name: "command", type: "registry:ui", description: "command palette", files: [{ path: "command.tsx", content: SOURCE }] }] }) } : url === "https://extra.test/r/command.json" ? { inline: JSON.stringify({ name: "command", type: "registry:ui", files: [{ path: "command.tsx", content: SOURCE }] }) } : undefined });
}

test("default sources are opt-in; add/remove persist and unsafe sources cannot be selected", async () => {
  const first = fixtures();
  await syncIndex({ ...options, cacheDir: dir, fetcher: first.fetcher });
  expect(await readSources(dir)).toEqual([...CURATED]);
  expect(first.requests.filter((r) => /extra.test|icons.test|localhost|bad-home.test/.test(r.url))).toEqual([]);
  await selectSources(dir, "add", "extra");
  expect(await selectSources(dir)).toContain("@extra");
  for (const name of ["unsafe", "bad-home", "absent"]) await expect(selectSources(dir, "add", name)).rejects.toThrow();
  const second = fixtures();
  await syncIndex({ ...options, cacheDir: dir, fetcher: second.fetcher });
  expect(second.requests.some((r) => r.url === "https://extra.test/r/registry.json")).toBe(true);
  await selectSources(dir, "remove", "extra");
  const third = fixtures();
  await syncIndex({ ...options, cacheDir: dir, fetcher: third.fetcher });
  expect(third.requests.some((r) => r.url.includes("extra.test"))).toBe(false);
  expect((await loadIndex(dir)).entries.some((e) => e.source.ref === "@extra/command")).toBe(false);
});

test("all fetches other listings once, metadata stays lean, source fetches exactly one item once", async () => {
  await mkdir(join(dir, "bodies"));
  await writeFile(join(dir, "bodies", "legacy.body"), SOURCE);
  const summary = await syncIndex({ ...options, cacheDir: dir, fetcher: fixtures().fetcher });
  expect(summary.catalogBytes).toBe(await catalogBytes(dir));
  expect(summary.catalogBytes).toBeLessThan(5_000_000);
  const first = fixtures();
  await expandAll(dir, { fetcher: first.fetcher });
  expect(first.requests.map((r) => r.url)).toEqual(["https://extra.test/r/registry.json"]);
  // Kept apart from the index: a default search stays on the chosen sources.
  expect((await loadIndex(dir)).entries.some((e) => e.source.ref === "@extra/command")).toBe(false);
  const entry = (await readAllIndex(dir))!.entries.find((e) => e.source.ref === "@extra/command")!;
  expect(entry.install?.implicitDeps).toEqual(["@floating-ui/react"]);
  expect(entry.provenance?.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const second = fixtures();
  const written = (await stat(join(dir, "index-all.json"))).mtimeMs;
  await expandAll(dir, { fetcher: second.fetcher });
  expect(second.requests).toEqual([]);
  // Unchanged listings are not rewritten, so the store has nothing to reload.
  expect((await stat(join(dir, "index-all.json"))).mtimeMs).toBe(written);
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  expect(files.some((f) => f.name === "bodies" || f.name === "http.json")).toBe(false);
  for (const file of files.filter((f) => f.isFile())) {
    const saved = await readFile(join(file.parentPath, file.name), "utf8");
    expect(saved).not.toContain("SOURCE_SENTINEL");
    expect(saved).not.toMatch(/"(?:content|body)":/);
  }
  const source = fixtures();
  expect(await candidateSource(dir, "@extra/command", { fetcher: source.fetcher })).toMatchObject({ files: [{ content: SOURCE }] });
  await candidateSource(dir, entry.id, { fetcher: source.fetcher });
  expect(source.requests.map((r) => r.url)).toEqual(["https://extra.test/r/command.json"]);
});

test("registries: the directory for someone who does not know the names, yours and the official first, words narrow it, icon sets and unsafe ones left out", async () => {
  await expect(listRegistries(dir)).rejects.toThrow(/youiyoux discover sync/);
  await syncIndex({ ...options, cacheDir: dir, fetcher: fixtures().fetcher });
  const all = await listRegistries(dir);
  expect(all.rows.map((r) => [r.name, r.state, r.itemCount])).toEqual([["@shadcn", "official", null], ["@coss", "source", null], ["@extra", "available", 12]]);
  expect(all).toMatchObject({ total: 3, left: 2, icons: 1, every: null });
  expect(all.rows[2]).toMatchObject({ description: "Animated blocks for landing pages", homepage: null, listed: null });
  // Every word, in the name or the description; any case.
  expect((await listRegistries(dir, { q: "LANDING animated" })).rows.map((r) => r.name)).toEqual(["@extra"]);
  expect((await listRegistries(dir, { q: "landing nothing" })).total).toBe(0);
  expect((await listRegistries(dir, { icons: true })).rows.map((r) => r.name)).toContain("@icons");
  expect((await listRegistries(dir, { sort: "name" })).rows.map((r) => r.name)).toEqual(["@coss", "@extra", "@shadcn"]);
  expect(await listRegistries(dir, { limit: 1, offset: 1 })).toMatchObject({ total: 3, offset: 1, rows: [{ name: "@coss" }] });

  // Fetching every registry's listings: how far it has got, and what it added.
  const progress: Array<[number, number]> = [];
  expect(await expandAll(dir, { fetcher: fixtures().fetcher, onProgress: (done, total) => progress.push([done, total]) })).toEqual({ registries: 1, failed: 0, listings: 1 });
  expect(progress).toEqual([[0, 1], [1, 1]]);
  const fetched = await listRegistries(dir, { listed: { "@extra": 1, "@shadcn": 7 } });
  expect(fetched.every).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(fetched.rows.map((r) => [r.name, r.state, r.listed])).toEqual([["@shadcn", "official", 7], ["@coss", "source", null], ["@extra", "listed", 1]]);
  // The official registry's count is its listings when the directory gives none.
  expect(fetched.rows[0]!.itemCount).toBe(7);
});

test("mirror URLs normalize host, query, template and trailing slash before content fallback", () => {
  const item = parseRegistryItems([{ name: "command", type: "registry:ui", description: "original" }]).items[0]!;
  const source = { name: "@coss", homepage: null, url: "https://EXAMPLE.test/r/registry.json?version=1", fetchedAt: options.now().toISOString(), official: false, health: null };
  const original = registryEntry(source, item, new Map());
  const mirror = registryEntry({ ...source, name: "@registrydirectory", url: "https://example.test/r/{name}.json/" }, { ...item, description: "different mirror summary" }, new Map());
  expect(dedupe([mirror, original])).toMatchObject({ entries: [original], mirrorsCollapsed: 1 });
});

test("cold JSON load and search of 5000 entries is under 400 ms without cleaning candidate text", async () => {
  const item = parseRegistryItems([{ name: "command", type: "registry:ui", description: "command palette for React", dependencies: ["cmdk"] }]).items[0]!;
  const entry = registryEntry({ name: "@test", homepage: null, url: "https://test.example/r/registry.json", fetchedAt: options.now().toISOString(), official: false, health: null }, item, new Map());
  await writeJson(join(dir, "index.json"), { schema: "youi.discover-index/v1", format: 2, builtAt: options.now().toISOString(), categories: {}, sources: [], entries: Array.from({ length: 5000 }, (_, i) => ({ ...entry, id: `lib:test/component/command-${i}` })) });
  const clean = vi.spyOn(text, "cleanData");
  const start = performance.now();
  const index = await loadIndex(dir);
  const result = searchIndex(index, "command menu");
  const elapsed = performance.now() - start;
  expect(result.matched).toBe(5000);
  expect(clean).not.toHaveBeenCalled();
  expect(elapsed).toBeLessThan(400);
  const cleanText = vi.spyOn(text, "cleanText");
  searchIndex(index, "command menu");
  expect(cleanText.mock.calls).toEqual([["command menu"]]);
});

test("legacy borrowed downloads migrate in memory without writing during reads", async () => {
  const item = parseRegistryItems([{ name: "command", type: "registry:ui" }]).items[0]!;
  const entry = registryEntry({ name: "@test", homepage: null, url: "https://test.example/registry.json", fetchedAt: options.now().toISOString(), official: false, health: null }, item, new Map());
  entry.signals = { weeklyDownloads: 42000000, package: "cmdk", stars: null, pushedAt: null, archived: null, repo: null };
  const legacy = { schema: "youi.discover-index/v1", builtAt: options.now().toISOString(), categories: {}, sources: [], entries: [entry] };
  await writeJson(join(dir, "index.json"), legacy);
  const before = await readFile(join(dir, "index.json"), "utf8");
  const index = await loadIndex(dir);
  expect(searchIndex(index, "command").hits[0]?.signals).toMatchObject({ weeklyDownloads: null, via: { package: "cmdk", weeklyDownloads: 42000000 } });
  expect(await readFile(join(dir, "index.json"), "utf8")).toBe(before);
});
