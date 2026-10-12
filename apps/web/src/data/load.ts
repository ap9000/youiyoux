/**
 * Snapshot loading. The manifest is small and always revalidated; every file it
 * names is content-hashed, so once fetched it is served from Cache Storage forever
 * (and the app keeps working offline). Stale hashed files are pruned on each load.
 */
import type { Catalog, DetectReport, InventoryIndex, InventoryReport, Manifest, ScanReport } from "./types.ts";

const CACHE_NAME = "youiyoux-data-v1";
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

/** The URL of a snapshot data file, such as a detect screenshot. */
export const dataUrl = (file: string): string => `${DATA_BASE}${file}`;
const MANIFEST_URL = `${DATA_BASE}manifest.json`;

export class DataError extends Error {
  override name = "DataError";
}

async function openCache(): Promise<Cache | null> {
  try {
    return "caches" in globalThis ? await caches.open(CACHE_NAME) : null;
  } catch {
    // Cache Storage is unavailable in some private modes; fall back to the network.
    return null;
  }
}

function expectSchema<T extends { schema: string }>(value: unknown, schema: T["schema"], what: string): T {
  if (typeof value !== "object" || value === null || (value as { schema?: unknown }).schema !== schema) {
    throw new DataError(`${what} is not a ${schema} document. Rebuild the snapshot with \`pnpm data\`.`);
  }
  return value as T;
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new DataError(`Could not load ${url} (HTTP ${response.status}).`);
  return response;
}

export async function loadManifest(): Promise<Manifest> {
  const cache = await openCache();
  try {
    const response = await fetchOk(MANIFEST_URL, { cache: "no-cache" });
    await cache?.put(MANIFEST_URL, response.clone()).catch(() => undefined);
    return expectSchema<Manifest>(await response.json(), "youiyoux.manifest/v1", "manifest.json");
  } catch (error: unknown) {
    const cached = await cache?.match(MANIFEST_URL);
    if (cached) return expectSchema<Manifest>(await cached.json(), "youiyoux.manifest/v1", "manifest.json");
    throw error instanceof DataError ? error : new DataError("Could not reach the snapshot. Is `pnpm dev` running?");
  }
}

/** A content-hashed snapshot file: the cache first, the network once. */
async function loadHashed(file: string): Promise<unknown> {
  const url = `${DATA_BASE}${file}`;
  const cache = await openCache();
  const hit = await cache?.match(url);
  if (hit) return hit.json();
  const response = await fetchOk(url);
  await cache?.put(url, response.clone()).catch(() => undefined);
  return response.json();
}

export async function loadCatalog(file: string): Promise<Catalog> {
  return expectSchema<Catalog>(await loadHashed(file), "youiyoux.catalog/v1", file);
}

export async function loadUsage(file: string): Promise<ScanReport> {
  return expectSchema<ScanReport>(await loadHashed(file), "youi.usage/v1", file);
}

/** The Inventory page's index, or a whole youi.inventory/v1 file from a snapshot older than the split. */
export async function loadInventory(file: string): Promise<InventoryIndex | InventoryReport> {
  const value = await loadHashed(file);
  if ((value as { schema?: unknown } | null)?.schema === "youi.inventory/v1") return value as InventoryReport;
  return expectSchema<InventoryIndex>(value, "youiyoux.inventory-index/v1", file);
}

export async function loadDetect(file: string): Promise<DetectReport> {
  return expectSchema<DetectReport>(await loadHashed(file), "youi.detect/v1", file);
}

/** A file the inventory index names (a chunk, the extras), checked against its schema. */
export async function loadInventoryPart<T extends { schema: string }>(file: string, schema: T["schema"]): Promise<T> {
  return expectSchema<T>(await loadHashed(file), schema, file);
}

/** Where a snapshot file is served from, absolute (a specimen frame's srcdoc links its stylesheet by it). */
export const absoluteDataUrl = (file: string): string => new URL(`${DATA_BASE}${file}`, globalThis.location?.href ?? "http://localhost/").href;

/** Drop cached snapshot files the current manifest no longer names. */
export async function pruneCache(manifest: Manifest): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  const files = [...manifest.systems.flatMap((s) => [s.catalog, ...s.usage.map((u) => u.file)]), ...(manifest.inventory ? [manifest.inventory, ...(manifest.inventoryFiles ?? [])] : []), ...(manifest.detect ? [manifest.detect.file] : [])];
  const keep = new Set([MANIFEST_URL, ...files.map((f) => `${DATA_BASE}${f}`)]);
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => !keep.has(new URL(request.url).pathname)).map((request) => cache.delete(request)));
}
