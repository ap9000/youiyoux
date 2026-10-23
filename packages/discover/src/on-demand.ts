import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, writeFileAtomic } from "@youiyoux/core";
import { PoliteClient, type PoliteOptions } from "./http.ts";
import { isIconEntry, showCandidate } from "./search.ts";
import { SHADCN, isCandidate, parseRegistryItems, registryEntry, registryUrl, skipReason, type DirectoryRegistry } from "./sources.ts";
import { ALL_INDEX_FILE, loadIndex, readAllIndex, readHttpCache, readSignals, readSources, writeHttpCache, writeJson, writeSources } from "./store.ts";
import { applySignals } from "./signals.ts";
import { dedupe } from "./sync.ts";
import { cleanData } from "./text.ts";

async function directory(cacheDir: string): Promise<DirectoryRegistry[]> {
  return JSON.parse(await readFile(join(cacheDir, "directory.json"), "utf8"));
}

export async function selectSources(cacheDir: string, action = "list", name?: string): Promise<string[]> {
  const selected = await readSources(cacheDir);
  if (action === "list") return selected;
  if (!["add", "remove"].includes(action) || !name) throw new Error("Use discover sources list|add|remove <name>");
  name = `@${name.replace(/^@/, "").toLowerCase()}`;
  if (action === "add") {
    const row = (await directory(cacheDir)).find((r) => r.name === name);
    if (!row) throw new Error("Unknown source; run youiyoux discover sync to refresh the directory");
    const reason = skipReason(row);
    if (reason) throw new Error(`Cannot add ${name}: ${reason}`);
  }
  const next = action === "add" ? [...new Set([...selected, name])] : selected.filter((n) => n !== name);
  await writeSources(cacheDir, next);
  return next;
}

/**
 * CLI-only expansion. The listings it adds go to index-all.json, never into index.json, so a
 * default search stays on the chosen sources; `--all` searches both. MCP only reads.
 */
export async function expandAll(cacheDir: string, options: PoliteOptions & { icons?: boolean } = {}): Promise<void> {
  const index = await loadIndex(cacheDir);
  const cache = await readHttpCache(cacheDir);
  const client = new PoliteClient({ ...options, cache });
  const selected = await readSources(cacheDir);
  const categories = new Map(Object.entries(index.categories));
  const signals = await readSignals(cacheDir);
  const extra = await Promise.all((await directory(cacheDir)).filter((r) => !selected.includes(r.name) && !skipReason(r) && (options.icons || !/\bicons?\b/i.test(`${r.name} ${r.description}`))).map(async (r) => {
    const url = registryUrl(r.template);
    const hit = cache.get(url);
    const response = hit ? { ok: true as const, value: JSON.parse(hit.body) as unknown, result: hit } : await client.json(url);
    if (!response.ok) return [];
    const entries = parseRegistryItems(response.value).items.filter(isCandidate).map((item) => registryEntry({ name: r.name, homepage: r.homepage, url, fetchedAt: response.result.fetchedAt, official: false, health: r.health }, item, categories));
    return !options.icons && entries.length && entries.filter(isIconEntry).length / entries.length >= 0.8 ? [] : entries.map((entry) => applySignals(entry, signals));
  }));
  await writeHttpCache(cacheDir, cache);
  // Deduplicated against the index (official and selected listings win), then only what is new.
  const chosen = new Set(index.entries.map((e) => e.id));
  const entries = dedupe([...index.entries, ...extra.flat()]).entries.filter((e) => !chosen.has(e.id));
  // Written only when it changed: the store reloads the --all listings whenever this file does.
  const next = `${JSON.stringify(cleanData({ schema: index.schema, format: 2, builtAt: index.builtAt, sources: [], categories: index.categories, entries }))}\n`;
  if ((await readFile(join(cacheDir, ALL_INDEX_FILE), "utf8").catch(() => null)) !== next) await writeFileAtomic(join(cacheDir, ALL_INDEX_FILE), next);
}

/** A listing by id or ref, from the index or, failing that, the --all listings. */
export async function findListing(cacheDir: string, id: string) {
  try {
    return showCandidate(await loadIndex(cacheDir), id);
  } catch (error) {
    const all = await readAllIndex(cacheDir);
    if (!all) throw error;
    try { return showCandidate(all, id); } catch { throw error; }
  }
}

/** One registry item's source as `show --source` keeps it under source/ (older copies have files only). */
export interface CandidateSource {
  readonly url: string;
  readonly fetchedAt: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content?: string; readonly type?: string; readonly target?: string }>;
  readonly dependencies?: readonly string[];
  readonly registryDependencies?: readonly string[];
  readonly cssVars?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Fetch exactly one registry item. Source lives separately from the metadata catalog. */
export async function candidateSource(cacheDir: string, id: string, options: PoliteOptions = {}): Promise<CandidateSource> {
  const { entry } = await findListing(cacheDir, id);
  if (entry.source.kind !== "shadcn-registry") throw new Error("Source is available for registry items only");
  const ref = entry.source.ref!;
  const slash = ref.indexOf("/");
  const name = ref.slice(slash + 1);
  const registry = ref.slice(0, slash);
  const template = registry === SHADCN.name ? "https://ui.shadcn.com/r/styles/new-york-v4/{name}.json" : (await directory(cacheDir)).find((r) => r.name === registry)?.template;
  if (!template) throw new Error("Registry URL is unavailable; run youiyoux discover sync");
  const url = registryUrl(template, name);
  const file = join(cacheDir, "source", `${sha256(url)}.json`);
  try { return JSON.parse(await readFile(file, "utf8")) as CandidateSource; } catch { /* fetch on first use */ }
  const client = new PoliteClient(options);
  const response = await client.json(url, false);
  if (!response.ok) throw new Error(response.message);
  const item = parseRegistryItems([response.value]).items[0];
  if (!item || item.name !== name) throw new Error("Registry returned a different or invalid item");
  // What a preview needs besides the files: the declared packages, the parts it builds on and the theme variables it brings.
  const source = cleanData({ url, fetchedAt: response.result.fetchedAt, files: item.files ?? [], dependencies: item.dependencies ?? [], registryDependencies: item.registryDependencies ?? [], ...(item.cssVars && typeof item.cssVars === "object" ? { cssVars: item.cssVars as CandidateSource["cssVars"] } : {}) });
  await writeJson(file, source);
  return source;
}
