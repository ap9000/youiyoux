/** Discover on the store: the same ranking as the JSON index, --all kept apart, and fair to official items under --all. */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openPglite, openSqlite, type Store } from "@youiyoux/store";
import { ALL_INDEX_FILE, closeSharedStores, ingestCatalog, loadIndex, needTerms, openCatalog, readCatalog, searchCatalog, searchIndex, showFromCatalog, styleOf, syncIndex, writeJson, type DiscoverIndex } from "../src/index.ts";
import { fixtureFetcher } from "./fixture-fetcher.ts";

let dir: string;
let index: DiscoverIndex;
const NEEDS = ["command menu", "toast", "date picker", "dialog", "button", "combobox", "tabs", "sidebar"];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "discover-catalog-"));
  await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  index = await loadIndex(dir);
}, 60_000);
afterAll(async () => {
  await closeSharedStores();
  await rm(dir, { recursive: true, force: true });
});

for (const engine of ["sqlite", "postgres (PGlite)"]) {
  test(`${engine}: the store ranks exactly as the JSON index, with the same matches, by role and licence too`, async () => {
    const store: Store = engine === "sqlite" ? await openSqlite(join(dir, "parity.db")) : await openPglite();
    try {
      await ingestCatalog(store, dir);
      for (const need of NEEDS) {
        const json = searchIndex(index, need, { limit: 20 });
        const stored = await searchCatalog(store, need, { limit: 20 });
        expect(stored.hits, need).toEqual(json.hits);
        expect(stored.matched, need).toBe(json.matched);
        expect(stored.total).toBe(json.total);
      }
      const role = { role: "command palette", limit: 20 };
      expect((await searchCatalog(store, "dialog", role)).hits).toEqual(searchIndex(index, "dialog", role).hits);
      const mit = { constraints: { licenses: ["MIT"], sources: ["shadcn-registry" as const] }, limit: 20 };
      expect((await searchCatalog(store, "command menu", mit)).hits).toEqual(searchIndex(index, "command menu", mit).hits);
      expect((await showFromCatalog(store, "command")).entry.id).toBe("lib:shadcn/component/command");
    } finally {
      await store.close();
    }
  });
}

test("a need's generic words are not sent to the full-text index; each phrase keeps a specific one", () => {
  expect(needTerms("date picker")).not.toContain("react");
  expect(needTerms("date picker")).toEqual(expect.arrayContaining(["date", "picker", "day", "datepicker"]));
  expect(needTerms("react")).toEqual([]);
  expect(needTerms("data table")).toEqual(expect.arrayContaining(["tanstack", "table", "grid"]));
});

test("headless or styled: a headless library's package, or one that says so; registry items are styled", () => {
  const cmdk = index.entries.find((e) => e.source.ref === "cmdk");
  if (cmdk) expect(styleOf(cmdk)).toBe("headless");
  expect(styleOf(index.entries.find((e) => e.source.ref === "@shadcn/command")!)).toBe("styled");
});

test("--all listings stay out of a default search; under --all, community bulk never pushes the official item out", async () => {
  const command = index.entries.find((e) => e.source.ref === "@coss/command")!;
  const bulk = Array.from({ length: 1200 }, (_, i) => ({ ...command, id: `lib:bulk${i % 40}/component/command-menu-${i}`, name: `command-menu-${i}`, title: "Command Menu", summary: "A command menu, command palette and command bar", source: { ...command.source, name: `@bulk${i % 40}`, ref: `@bulk${i % 40}/command-menu-${i}` } }));
  await writeJson(join(dir, ALL_INDEX_FILE), { ...index, entries: bulk });
  const store = await openCatalog(dir, join(dir, "all.db"));
  const plain = await searchCatalog(store, "command menu", { limit: 50 });
  expect(plain.hits.some((h) => h.id.startsWith("lib:bulk"))).toBe(false);
  const all = await searchCatalog(store, "command menu", { all: true, limit: 50 });
  expect(all.scope).toBe("all");
  expect(all.total).toBe(index.entries.length + bulk.length);
  expect(all.hits.some((h) => h.id.startsWith("lib:bulk"))).toBe(true);
  expect(all.hits[0]!.id).toBe("lib:shadcn/component/command");
  expect(plain.hits[0]!.id).toBe("lib:shadcn/component/command");
});


test("readCatalog never ingests changed JSON and its connection rejects writes", async () => {
  const path = join(dir, "readonly.db");
  const writer = await openSqlite(path);
  await ingestCatalog(writer, dir);
  await writer.close();
  const bytes = await readFile(path);
  const reader = await readCatalog(dir, path, {});
  const before = await reader.stats();
  const saved = await readFile(join(dir, "index.json"), "utf8");
  try {
    await writeJson(join(dir, "index.json"), { ...index, entries: [] });
    const same = await readCatalog(dir, path, {});
    expect((await same.stats()).tables).toEqual(before.tables);
    expect((await searchCatalog(same, "command")).hits.length).toBeGreaterThan(0);
    await expect(same.setMeta("forbidden", "yes")).rejects.toThrow();
    expect(await readFile(path)).toEqual(bytes);
  } finally { await writeJson(join(dir, "index.json"), JSON.parse(saved)); }
});
