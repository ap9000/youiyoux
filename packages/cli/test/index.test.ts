/**
 * `youiyoux index` end to end: Discover search, facets and paging, and inventory history all come
 * from the store; deleting the store and running `youiyoux index rebuild` gives the same answers.
 */
import { mkdtemp, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { closeSharedStores, itemOf, loadIndex } from "@youiyoux/discover";
import { openSqlite, type ScanRecord } from "@youiyoux/store";
import { fixtureFetcher } from "../../discover/test/fixture-fetcher.ts";
import { noteSource, rebuildIndex } from "../src/index-store.ts";
import { main } from "../src/index.ts";

const INVENTORY = join(import.meta.dirname, "../../scanner/test/fixtures/inventory/console");
const EXPO = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
let dir: string;
let out = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-cli-index-"));
});
afterAll(async () => {
  await closeSharedStores();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

async function run(...args: string[]): Promise<string> {
  out = "";
  expect(await main([...args, "--cache", dir])).toBe(0);
  return out;
}
const runJson = async <T,>(...args: string[]): Promise<T> => JSON.parse(await run(...args, "--json")) as T;

interface Search { hits: Array<{ id: string }>; matched: number; total: number; offset?: number; facets: { role: Record<string, number>; source: Record<string, number>; licence: Record<string, number>; style: Record<string, number> } }

/** What the store answers, everything a person can ask of it here. */
async function answers() {
  return {
    command: await runJson<Search>("discover", "command menu", "--limit", "20"),
    page: await runJson<Search>("discover", "dialog", "--limit", "2", "--offset", "2"),
    role: await runJson<Search>("discover", "dialog", "--role", "command palette"),
    show: await runJson<{ entry: { id: string } }>("discover", "show", "@coss/command"),
    history: (await runJson<ScanRecord[]>("index", "history")).map((s) => [s.project, s.scannedAt, s.looks, s.families, s.commit]),
  };
}

test("Discover search, facets and inventory history run from the store, which can be deleted and rebuilt", async () => {
  expect(await main(["discover", "sync", "--cache", dir], { sleep: async () => {}, fetcher: fixtureFetcher().fetcher, timeoutMs: 100 })).toBe(0);
  expect(out).toMatch(/store → .*index\.db \(\d+ listings\)/);

  // Search pages and facets.
  const all = await runJson<Search>("discover", "dialog", "--limit", "4");
  const first = await runJson<Search>("discover", "dialog", "--limit", "2");
  const second = await runJson<Search>("discover", "dialog", "--limit", "2", "--offset", "2");
  expect([...first.hits, ...second.hits].map((h) => h.id)).toEqual(all.hits.map((h) => h.id));
  expect(second.offset).toBe(2);
  expect(all.facets.role.dialog).toBeGreaterThan(0);
  expect(Object.values(all.facets.licence).reduce((a, b) => a + b, 0)).toBe(all.matched);
  expect(Object.keys(all.facets.style).every((s) => ["headless", "styled"].includes(s))).toBe(true);
  expect(await run("discover", "dialog")).toMatch(/role dialog \d+.*\| {2}source .*\| {2}licence /);

  // Two inventory scans and a usage scan: history keeps both runs; the graph gets the rules.
  const scratch = await mkdtemp(join(tmpdir(), "youi-cli-index-out-"));
  try {
    for (let i = 0; i < 2; i++) expect(await run("inventory", "--project", INVENTORY, "--out", join(scratch, "inventory.json"))).toMatch(/history → .*index\.db \(\d+ scans? of these projects/);
    await run("scan", "--project", EXPO, "--out", join(scratch, "usage.json"));
    const history = await runJson<ScanRecord[]>("inventory", "--history");
    expect(history.map((s) => s.project)).toEqual(["console", "console"]);
    expect(history[0]!.scannedAt > history[1]!.scannedAt).toBe(true);
    expect(await run("index", "history", "console")).toMatch(/inventory history · 2 scans[\s\S]*console/);

    // The search reads the store: a listing written only into the store is found.
    const before = await answers();
    expect(before.command.hits[0]!.id).toBe("lib:shadcn/component/command");
    const store = await openSqlite(join(dir, "index.db"));
    const command = (await loadIndex(dir)).entries.find((e) => e.id === "lib:coss/component/command")!;
    const probe = { ...command, id: "lib:probe/component/command-menu", name: "command-menu", source: { ...command.source, name: "@probe", ref: "@probe/command-menu" } };
    await store.upsertDiscoverItems([itemOf(probe, "chosen", "2026-10-12T12:00:00.000Z")]);
    await store.close();
    expect((await runJson<Search>("discover", "command menu", "--limit", "50")).hits.map((h) => h.id)).toContain("lib:probe/component/command-menu");

    // Delete the store; rebuild it from its sources: the same answers, and the probe is gone.
    await closeSharedStores();
    for (const file of await readdir(dir)) if (file.startsWith("index.db")) await rm(join(dir, file));
    expect(await run("index", "rebuild")).toMatch(/rebuilt[\s\S]*1 project[\s\S]*graph/);
    expect(await answers()).toEqual(before);
    const stats = await runJson<{ engine: string; tables: Record<string, number> }>("index", "stats");
    expect(stats.engine).toBe("sqlite");
    expect(stats.tables.scans).toBe(2);
    expect(stats.tables.edges).toBeGreaterThan(0);
    expect(await run("index", "path")).toContain(join(dir, "index.db"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);

test("help lists the index commands", async () => {
  expect(await main(["--help"])).toBe(0);
  expect(out).toMatch(/index path[\s\S]*index stats[\s\S]*index rebuild[\s\S]*index history/);
});


test("atomic rebuild refreshes retained readers and a failed rebuild preserves the previous generation", async () => {
  const path = join(dir, "index.db");
  const reader = await openSqlite(path, { readOnly: true });
  const writer = await openSqlite(path);
  const before = await stat(path);
  await writer.setMeta("old-only", "yes");
  expect(await reader.meta("old-only")).toBe("yes");
  await rebuildIndex(path, { discoverCache: dir, env: {} });
  expect((await stat(path)).ino).not.toBe(before.ino);
  expect(await reader.meta("old-only")).toBeNull();
  const generation = await reader.meta("generation");
  expect(generation).toBeTruthy();
  await writer.setMeta("new-only", "yes");
  expect(await reader.meta("new-only")).toBe("yes");
  const catalog = join(dir, "index.json");
  const saved = await readFile(catalog);
  try {
    await writeFile(catalog, "invalid json");
    await expect(rebuildIndex(path, { discoverCache: dir, env: {} })).rejects.toThrow();
    expect(await reader.meta("generation")).toBe(generation);
    expect(await reader.meta("new-only")).toBe("yes");
    expect((await readdir(dir)).some((f) => f.startsWith("index.db.rebuild-"))).toBe(false);
  } finally {
    await writeFile(catalog, saved);
    await reader.close();
    await writer.close();
  }
});

test("a recorded project that was moved or deleted is skipped and reported, never a reason to refuse the rebuild", async () => {
  const home = await mkdtemp(join(tmpdir(), "youi-cli-index-gone-"));
  try {
    await noteSource(home, { project: { root: join(home, "moved-away"), options: {} } });
    const summary = await rebuildIndex(join(home, "index.db"), { env: {} });
    expect(summary.projects.replayed).toBe(0);
    expect(summary.projects.failed).toEqual([{ root: join(home, "moved-away"), reason: expect.stringContaining("folder not found") }]);
    expect((await stat(join(home, "index.db"))).isFile()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
