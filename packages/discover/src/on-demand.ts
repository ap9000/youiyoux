import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@youiyoux/core";
import { PoliteClient, type PoliteOptions } from "./http.ts";
import { isIconEntry, showCandidate } from "./search.ts";
import { SHADCN, isCandidate, parseRegistryItems, registryEntry, registryUrl, skipReason, type DirectoryRegistry } from "./sources.ts";
import { loadIndex, readHttpCache, readSignals, readSources, writeHttpCache, writeJson, writeSources } from "./store.ts";
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
    if (!row) throw new Error("Unknown source; run youi discover sync to refresh the directory");
    const reason = skipReason(row);
    if (reason) throw new Error(`Cannot add ${name}: ${reason}`);
  }
  const next = action === "add" ? [...new Set([...selected, name])] : selected.filter((n) => n !== name);
  await writeSources(cacheDir, next);
  return next;
}

/** CLI-only expansion. MCP only reads the resulting local index. */
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
  await writeHttpCache(cacheDir, cache, new Map());
  await writeJson(join(cacheDir, "index.json"), cleanData({ ...index, format: 2, entries: dedupe([...index.entries, ...extra.flat()]).entries }));
}

/** Fetch exactly one registry item. Source lives separately from the metadata catalog. */
export async function candidateSource(cacheDir: string, id: string, options: PoliteOptions = {}): Promise<unknown> {
  const { entry } = showCandidate(await loadIndex(cacheDir), id);
  if (entry.source.kind !== "shadcn-registry") throw new Error("Source is available for registry items only");
  const ref = entry.source.ref!;
  const slash = ref.indexOf("/");
  const name = ref.slice(slash + 1);
  const registry = ref.slice(0, slash);
  const template = registry === SHADCN.name ? "https://ui.shadcn.com/r/styles/new-york-v4/{name}.json" : (await directory(cacheDir)).find((r) => r.name === registry)?.template;
  if (!template) throw new Error("Registry URL is unavailable; run youi discover sync");
  const url = registryUrl(template, name);
  const file = join(cacheDir, "source", `${sha256(url)}.json`);
  try { return JSON.parse(await readFile(file, "utf8")); } catch { /* fetch on first use */ }
  const client = new PoliteClient(options);
  const response = await client.json(url, false);
  if (!response.ok) throw new Error(response.message);
  const item = parseRegistryItems([response.value]).items[0];
  if (!item || item.name !== name) throw new Error("Registry returned a different or invalid item");
  const source = cleanData({ url, fetchedAt: response.result.fetchedAt, files: item.files ?? [] });
  await writeJson(file, source);
  return source;
}
