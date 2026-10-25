import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256, writeFileAtomic } from "@youiyoux/core";
import { PoliteClient, type PoliteOptions } from "./http.ts";
import { isIconEntry, showCandidate } from "./search.ts";
import { SHADCN, isCandidate, parseRegistryItems, registryEntry, registryUrl, skipReason, type DirectoryRegistry } from "./sources.ts";
import { ALL_INDEX_FILE, loadIndex, readAllIndex, readHttpCache, readSignals, readSources, writeHttpCache, writeJson, writeSources } from "./store.ts";
import { applySignals } from "./signals.ts";
import { dedupe } from "./sync.ts";
import { cleanData } from "./text.ts";
import { publicHttps } from "./urls.ts";

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

/** One registry of the directory as the registries list shows it. */
export interface RegistryRow {
  readonly name: string;
  readonly homepage: string | null;
  readonly description: string | null;
  /** Items the directory counts in it (every type), or null when it gives none. */
  readonly itemCount: number | null;
  /** official: shadcn's own; source: one of your sources; listed: its items are among every registry's; available: not fetched yet. */
  readonly state: "official" | "source" | "listed" | "available";
  /** Its listings in the local index (what Discover can show of it), or null when none are. */
  readonly listed: number | null;
}

export const REGISTRY_SORTS = ["items", "name"] as const;
export type RegistrySort = (typeof REGISTRY_SORTS)[number];

/** A registry the directory describes as an icon set: Discover leaves those out unless asked (`--icons`). */
const isIconRegistry = (r: DirectoryRegistry): boolean => /\bicons?\b/i.test(`${r.name} ${r.description ?? ""}`);

/**
 * The directory's registries, for someone who does not know their names: the ones a sync could
 * fetch (public https, not hidden or unavailable), icon sets only with `icons`, narrowed by every
 * word of `q` (name and description), most items first or by name, paged. `listed` is how many of
 * each registry's listings the local index holds (the store's source facet). Reads files only.
 */
export async function listRegistries(cacheDir: string, options: { readonly q?: string; readonly sort?: RegistrySort; readonly limit?: number; readonly offset?: number; readonly icons?: boolean; readonly listed?: Readonly<Record<string, number>> } = {}) {
  const rows = await directory(cacheDir).catch(() => null);
  if (!rows) throw new Error("The registry directory is not on this machine yet: run youiyoux discover sync");
  const selected = new Set(await readSources(cacheDir));
  const every = await stat(join(cacheDir, ALL_INDEX_FILE)).then((s) => s.mtime.toISOString(), () => null);
  const words = (options.q ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let left = 0;
  let icons = 0;
  const shown: RegistryRow[] = [];
  // The official registry is read from its own index, so the directory may not list it.
  const official: DirectoryRegistry = { name: SHADCN.name, homepage: SHADCN.homepage, template: SHADCN.registry.replace("registry.json", "{name}.json"), description: "The official shadcn/ui registry: its components, blocks and charts.", health: { status: "healthy", score: null, checkedAt: null, hidden: false }, itemCount: options.listed?.[SHADCN.name] ?? null };
  for (const r of rows.some((row) => row.name === SHADCN.name) ? rows : [official, ...rows]) {
    const isOfficial = r.name === SHADCN.name;
    if (!isOfficial && skipReason(r)) { left++; continue; }
    if (!isOfficial && !options.icons && isIconRegistry(r)) { icons++; continue; }
    const text = `${r.name} ${r.description ?? ""}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    const listed = options.listed?.[r.name] ?? null;
    const state = isOfficial ? "official" : selected.has(r.name) ? "source" : listed ? "listed" : "available";
    shown.push({ name: r.name, homepage: r.homepage, description: r.description, itemCount: r.itemCount, state, listed });
  }
  const rank = { official: 0, source: 1, listed: 2, available: 2 } as const;
  shown.sort((a, b) => (options.sort === "name" ? 0 : rank[a.state] - rank[b.state] || (b.itemCount ?? -1) - (a.itemCount ?? -1)) || a.name.localeCompare(b.name));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.max(1, Math.trunc(options.limit ?? 50));
  return { total: shown.length, offset, rows: shown.slice(offset, offset + limit), left, icons, every };
}

/** How far a fetch of every registry's listings has got: registries asked, of how many. */
export type ExpandProgress = (done: number, total: number) => void;

/**
 * Every healthy registry's listings, beside the chosen ones (the CLI's `--all`, and the hub's
 * Every registry). The listings it adds go to index-all.json, never into index.json, so a default
 * search stays on the chosen sources; `--all` searches both. MCP only reads. Metadata only: each
 * registry's registry.json, cache-first; no item's code.
 */
export async function expandAll(cacheDir: string, options: PoliteOptions & { icons?: boolean; onProgress?: ExpandProgress } = {}): Promise<{ registries: number; failed: number; listings: number }> {
  const index = await loadIndex(cacheDir);
  const cache = await readHttpCache(cacheDir);
  const client = new PoliteClient({ ...options, cache });
  const selected = await readSources(cacheDir);
  const categories = new Map(Object.entries(index.categories));
  const signals = await readSignals(cacheDir);
  const asked = (await directory(cacheDir)).filter((r) => !selected.includes(r.name) && !skipReason(r) && (options.icons || !isIconRegistry(r)));
  let done = 0;
  let failed = 0;
  options.onProgress?.(0, asked.length);
  const extra = await Promise.all(asked.map(async (r) => {
    const url = registryUrl(r.template);
    const hit = cache.get(url);
    const response = hit ? { ok: true as const, value: JSON.parse(hit.body) as unknown, result: hit } : await client.json(url);
    options.onProgress?.(++done, asked.length);
    if (!response.ok) return (failed++, []);
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
  return { registries: asked.length, failed, listings: entries.length };
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
  const source = await registryItemSource(cacheDir, ref.slice(0, slash), ref.slice(slash + 1), options);
  if (source === "missing") throw new Error("HTTP 404");
  return source;
}

/**
 * One item of a registry by name, listed or not (a component's demo is never a listing): from its
 * registry's item URL, cache-first under source/. "missing" when the registry answers that it has
 * no such item (404 or 410); any other failure throws.
 */
export async function registryItemSource(cacheDir: string, registry: string, name: string, options: PoliteOptions = {}): Promise<CandidateSource | "missing"> {
  const template = registry === SHADCN.name ? "https://ui.shadcn.com/r/styles/new-york-v4/{name}.json" : (await directory(cacheDir)).find((r) => r.name === registry)?.template;
  if (!template) throw new Error("Registry URL is unavailable; run youiyoux discover sync");
  return registryItemAt(cacheDir, registryUrl(template, name), name, options);
}

/**
 * One registry item at its URL (a part an item names by URL, `https://x.dev/r/number-roll.json`),
 * which must be public https and answer with an item of that name: cache-first under source/,
 * "missing" on a 404 or 410, any other failure thrown.
 */
export async function registryItemAt(cacheDir: string, url: string, name: string, options: PoliteOptions = {}): Promise<CandidateSource | "missing"> {
  if (!publicHttps(url)) throw new Error("refused: a registry item must be on public https");
  const file = join(cacheDir, "source", `${sha256(url)}.json`);
  try { return JSON.parse(await readFile(file, "utf8")) as CandidateSource; } catch { /* fetch on first use */ }
  const client = new PoliteClient(options);
  const response = await client.json(url, false);
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) return "missing";
    throw new Error(response.message);
  }
  const item = parseRegistryItems([response.value]).items[0];
  if (!item || item.name !== name) throw new Error("Registry returned a different or invalid item");
  // What a preview needs besides the files: the declared packages, the parts it builds on and the theme variables it brings.
  const source = cleanData({ url, fetchedAt: response.result.fetchedAt, files: item.files ?? [], dependencies: item.dependencies ?? [], registryDependencies: item.registryDependencies ?? [], ...(item.cssVars && typeof item.cssVars === "object" ? { cssVars: item.cssVars as CandidateSource["cssVars"] } : {}) });
  await writeJson(file, source);
  return source;
}
