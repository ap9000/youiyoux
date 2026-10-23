/** Local metadata catalog. Sync refreshes selected sources; CLI --all expands listings.
 * Only show --source stores source code, separately under source/.
 */
import { CURATED, HEADLESS, SHADCN, parseDirectory, parseNpmSearch, parseRegistryItems, looksLikeRegistry, implicitDeps } from "./sources.ts";
import { cleanData } from "./text.ts";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LibraryEntry, sha256, writeFileAtomic } from "@youiyoux/core";
import { defaultIndexPath, INDEX_FILE as STORE_FILE } from "@youiyoux/store";
import type { CachedResponse } from "./http.ts";

export const INDEX_FILE = "index.json";
/** Listings `youiyoux discover --all` added: kept apart from the index, so a default search stays on the chosen sources. */
export const ALL_INDEX_FILE = "index-all.json";
export const HEALTH_FILE = "health.json";
export const SIGNALS_FILE = "signals.json";
export const HTTP_FILE = "http.json";
export const BODIES_DIR = "bodies";

/** `--cache`, else YOUI_DISCOVER_CACHE, else `$XDG_CACHE_HOME/youiyoux/discover` (default `~/.cache`). */
export function discoverCacheDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return explicit;
  if (env.YOUI_DISCOVER_CACHE) return env.YOUI_DISCOVER_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "youiyoux", "discover");
}

/**
 * The store Discover reads (and `youiyoux inventory` records into): beside an explicit cache
 * (`--cache`), else YOUI_INDEX, else beside YOUI_DISCOVER_CACHE, else the default
 * `$XDG_CACHE_HOME/youiyoux/index.db`. DATABASE_URL, when set, wins over all of them.
 */
export function discoverIndexPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return join(explicit, STORE_FILE);
  if (env.YOUI_INDEX) return env.YOUI_INDEX;
  if (env.YOUI_DISCOVER_CACHE) return join(env.YOUI_DISCOVER_CACHE, STORE_FILE);
  return defaultIndexPath(env);
}

const Iso = z.string().datetime({ offset: true });

export const SourceStatus = z.object({
  /** `shadcn`, `directory`, a registry name (`@coss`), `headless:<id>`, `npm-search`. */
  id: z.string(),
  url: z.string(),
  /** fetched: new content; revalidated: a 304 reused the cached copy; skipped: not fetched (on purpose); failed: tried and could not use it. */
  outcome: z.enum(["fetched", "revalidated", "skipped", "failed"]),
  reason: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  items: z.number().int(),
  iconOnly: z.boolean().optional(),
  /** The registry directory's health, for community registries. */
  health: z.object({ status: z.string(), score: z.number().nullable(), checkedAt: Iso.nullable() }).nullable(),
});
export type SourceStatus = z.infer<typeof SourceStatus>;

export const DiscoverIndex = z.object({
  schema: z.literal("youi.discover-index/v1"),
  format: z.literal(2).optional(),
  builtAt: Iso,
  sources: z.array(SourceStatus),
  /** Category name → the headless libraries that have a component of that name (`dialog` → base-ui, radix, …). */
  categories: z.record(z.string(), z.array(z.string())),
  entries: z.array(LibraryEntry),
});
export type DiscoverIndex = z.infer<typeof DiscoverIndex>;

export interface HealthFile {
  readonly checkedAt: string;
  readonly sources: readonly SourceStatus[];
}

export interface NpmSignal {
  readonly failedAt?: string;
  readonly weeklyDownloads: number | null;
  readonly license: string | null;
  /** `owner/repo` on GitHub, when the package names one. */
  readonly repo: string | null;
  readonly fetchedAt: string;
}

export interface GithubSignal {
  readonly found: boolean;
  readonly repo: string;
  readonly htmlUrl: string | null;
  readonly stars: number | null;
  readonly pushedAt: string | null;
  readonly archived: boolean | null;
  readonly spdx: string | null;
  readonly fetchedAt: string;
}

export interface SignalsFile {
  readonly npm: Record<string, NpmSignal>;
  readonly github: Record<string, GithubSignal>;
  /** Registry name → its GitHub repository, linked both ways with the registry's homepage (null: none found). */
  readonly registryRepos: Record<string, { readonly repo: string | null; readonly checkedAt: string }>;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`);
}

export class MissingIndexError extends Error {
  readonly cacheDir: string;
  constructor(cacheDir: string) {
    super(`no Discover index in ${cacheDir}: run \`youiyoux discover sync\` first (search and show read the local index unless --all or --source is requested)`);
    this.cacheDir = cacheDir;
  }
}

/** Read the index; null when there is none yet. Never fetches. */
export async function readIndex(cacheDir: string): Promise<DiscoverIndex | null> {
  const raw = await readJson(join(cacheDir, INDEX_FILE));
  if (raw === null) return null;
  const modern = (raw as { format?: number }).format === 2;
  const index = DiscoverIndex.parse(modern ? raw : cleanData(raw));
  if (!modern) for (const entry of index.entries) {
    const signals = entry.signals;
    if (entry.source.kind !== "npm" && signals?.weeklyDownloads != null) {
      entry.signals = { ...signals, weeklyDownloads: null, ...(signals.package ? { via: { package: signals.package, weeklyDownloads: signals.weeklyDownloads } } : {}) };
    }
  }
  return index;
}

const loaded = new Map<string, { mtimeMs: number; index: DiscoverIndex }>();

/** The listings --all added (an index of their own), or null when --all never ran. */
export async function readAllIndex(cacheDir: string): Promise<DiscoverIndex | null> {
  const raw = await readJson(join(cacheDir, ALL_INDEX_FILE));
  return raw === null ? null : DiscoverIndex.parse(cleanData(raw));
}

/** The index, parsed once per file version: a long-lived reader (the MCP server) re-reads only after a sync. */
export async function loadIndex(cacheDir: string): Promise<DiscoverIndex> {
  const file = join(cacheDir, INDEX_FILE);
  const mtimeMs = await stat(file).then((s) => s.mtimeMs, () => null);
  if (mtimeMs === null) throw new MissingIndexError(cacheDir);
  const hit = loaded.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.index;
  const index = await readIndex(cacheDir);
  if (!index) throw new MissingIndexError(cacheDir);
  loaded.set(file, { mtimeMs, index });
  return index;
}

export async function readSignals(cacheDir: string): Promise<SignalsFile> {
  const raw = (await readJson(join(cacheDir, SIGNALS_FILE))) as Partial<SignalsFile> | null;
  return { npm: { ...raw?.npm }, github: { ...raw?.github }, registryRepos: { ...raw?.registryRepos } };
}

/** Parsed metadata plus HTTP validators; never persist raw response bodies. */
export async function readHttpCache(cacheDir: string): Promise<Map<string, CachedResponse>> {
  const cache = new Map<string, CachedResponse>();
  const names = await readdir(join(cacheDir, "listings")).catch(() => []);
  await Promise.all(names.map(async (name) => {
    const saved = await readJson(join(cacheDir, "listings", name)) as { version?: number; url: string; data: unknown; etag: string | null; lastModified: string | null; fetchedAt: string } | null;
    if (saved?.version !== 2 || typeof saved.url !== "string" || saved.data === undefined) return;
    const body = JSON.stringify(saved.data);
    cache.set(saved.url, { ...saved, body, sha256: sha256(body) });
  }));
  return cache;
}

export function slimResponse(url: string, body: string): unknown {
  const catalog = HEADLESS.find((c) => c.url === url);
  if (catalog) {
    try { const cached = JSON.parse(body); if (cached.catalogNames) return cached; } catch { /* text catalog */ }
    return { catalogNames: catalog.parse(body) };
  }
  const data: unknown = JSON.parse(body);
  if (url === SHADCN.directory) return parseDirectory(data).registries.map((r) => ({ name: r.name, homepage: r.homepage, url: r.template, description: r.description, health: r.health, ranking: { itemCount: r.itemCount } }));
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname === "registry.npmjs.org" && parsedUrl.pathname === "/-/v1/search") return { objects: parseNpmSearch(data).map((o) => ({ package: { name: o.package.name, description: o.package.description, keywords: o.package.keywords, license: o.package.license, links: { npm: o.package.links?.npm, repository: o.package.links?.repository, homepage: o.package.links?.homepage } }, downloads: { weekly: o.downloads?.weekly } })) };
  const pick = (value: unknown, keys: string[]): Record<string, unknown> => value && typeof value === "object" ? Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, (value as Record<string, unknown>)[key]])) : {};
  if (parsedUrl.hostname === "api.github.com") {
    if (parsedUrl.pathname.startsWith("/search/")) return cleanData({ items: ((data as { items?: unknown[] }).items ?? []).map((item) => pick(item, ["full_name", "homepage"])) });
    return cleanData(pick(data, ["full_name", "html_url", "stargazers_count", "pushed_at", "archived", "license", "homepage"]));
  }
  if (parsedUrl.hostname === "registry.npmjs.org") return cleanData(pick(data, ["name", "license", "repository"]));
  if (parsedUrl.hostname === "api.npmjs.org") return cleanData(pick(data, ["downloads"]));
  if (!looksLikeRegistry(data)) return cleanData(data);
  return { items: parseRegistryItems(data).items.map((item) => ({
    itemSha256: item.itemSha256 ?? sha256(JSON.stringify(item)),
    name: item.name, type: item.type, title: item.title, description: item.description,
    categories: item.categories, dependencies: item.dependencies, devDependencies: item.devDependencies,
    registryDependencies: item.registryDependencies, implicitDeps: implicitDeps(item),
    meta: item.meta?.links && typeof item.meta.links === "object" ? { links: Object.fromEntries(Object.entries(item.meta.links).map(([key, value]) => [key, pick(value, ["docs"])])) } : undefined,
    files: item.files?.map((file) => ({ path: file.path, type: file.type, target: file.target,
      sha256: file.sha256 ?? (file.content === undefined ? null : sha256(file.content)) })),
  })) };
}

export async function writeHttpCache(cacheDir: string, cache: ReadonlyMap<string, CachedResponse>): Promise<void> {
  const keep = new Set<string>();
  for (const [url, entry] of cache) {
    let data: unknown;
    try { data = slimResponse(url, entry.body); } catch { continue; }
    keep.add(`${sha256(url)}.json`);
    await writeJson(join(cacheDir, "listings", `${sha256(url)}.json`), { version: 2, url, etag: entry.etag, lastModified: entry.lastModified, fetchedAt: entry.fetchedAt, data });
  }
  for (const name of await readdir(join(cacheDir, "listings")).catch(() => [])) if (!keep.has(name)) await rm(join(cacheDir, "listings", name), { force: true });
  await rm(join(cacheDir, BODIES_DIR), { recursive: true, force: true });
  await rm(join(cacheDir, HTTP_FILE), { force: true });
}

export async function readSources(cacheDir: string): Promise<string[]> {
  const value = await readJson(join(cacheDir, "sources.json"));
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [...CURATED];
}
export async function writeSources(cacheDir: string, names: readonly string[]): Promise<void> {
  await writeJson(join(cacheDir, "sources.json"), [...new Set(names)].sort());
}
export async function catalogBytes(cacheDir: string): Promise<number> {
  const files = await readdir(cacheDir, { recursive: true, withFileTypes: true });
  // The store beside the catalog (index.db) is derived from it, not part of it.
  const sizes = await Promise.all(files.filter((f) => f.isFile() && !f.parentPath.includes(join(cacheDir, "source")) && !f.name.startsWith(STORE_FILE)).map((f) => stat(join(f.parentPath, f.name)).then((s) => s.size)));
  return sizes.reduce((a, b) => a + b, 0);
}

export async function readHealth(cacheDir: string): Promise<HealthFile | null> {
  return await readJson(join(cacheDir, HEALTH_FILE)) as HealthFile | null;
}
