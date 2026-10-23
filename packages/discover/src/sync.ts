/**
 * `youiyoux discover sync` reads the official shadcn registry, the directory and selected
 * community registries, the headless catalogs (for category names) and npm, then refreshes
 * signals and writes the index. Each file is written whole and atomically, so a reader
 * sees the last index or the new one, never half of one.
 */
import { isIconEntry } from "./search.ts";
import { cleanData } from "./text.ts";
import { join } from "node:path";
import { LibraryEntry, sha256 } from "@youiyoux/core";
import { CONCEPTS, type Concept } from "./aliases.ts";
import { githubBuckets, PoliteClient, type Fetcher, type HttpResult } from "./http.ts";
import { applySignals, defaultBudgets, refreshSignals, registryOf, type SignalBudgets, type SignalReport } from "./signals.ts";
import { docsLinks, HEADLESS, isCandidate, looksLikeRegistry, mergeCategories, npmCandidates, npmEntry, npmSearchUrl, parseDirectory, parseNpmSearch, parseRegistryItems, registryEntry, registryUrl, SHADCN, skipReason, type DirectoryRegistry, type RegistryItem, type RegistrySource } from "./sources.ts";
import { catalogBytes, readSources, HEALTH_FILE, INDEX_FILE, readHttpCache, readHealth, readSignals, SIGNALS_FILE, writeHttpCache, writeJson, type DiscoverIndex, type SourceStatus } from "./store.ts";

export interface SyncOptions {
  readonly cacheDir: string;
  readonly fetcher?: Fetcher;
  readonly now?: () => Date;
  /** Requests in flight at once (default 6), and to one host (default 2). */
  readonly concurrency?: number;
  readonly perHost?: number;
  readonly timeoutMs?: number;
  /** GITHUB_TOKEN; used in request headers only, never written or printed. */
  readonly token?: string;
  /** Fetch at most this many selected community registries. */
  readonly maxRegistries?: number;
  /** Search npm for npm-only candidates (default true). */
  readonly npm?: boolean;
  readonly icons?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly budgets?: Partial<SignalBudgets>;
}

export interface SyncSummary {
  readonly cacheDir: string;
  readonly catalogBytes: number;
  readonly selectedSources: number;
  readonly index: { bytes: number; entries: number; mirrorsCollapsed: number; iconRegistriesSkipped: number };
  readonly warnings: readonly string[];
  readonly builtAt: string;
  readonly durationMs: number;
  readonly entries: { readonly total: number; readonly official: number; readonly community: number; readonly npm: number };
  readonly registries: { readonly listed: number; readonly fetched: number; readonly revalidated: number; readonly skipped: number; readonly failed: number };
  readonly categories: number;
  readonly requests: { readonly sent: number; readonly revalidated: number; readonly cached: number; readonly failed: number; readonly rateLimited: number; readonly maxInFlight: number };
  readonly signals: SignalReport;
  readonly licences: { readonly known: number; readonly unknown: number };
  readonly failures: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  readonly files: readonly string[];
}

function status(id: string, url: string, result: { ok: true; result: Extract<HttpResult, { ok: true }> } | { ok: false; reason: string; status: number | null; message: string }, items: number, health: SourceStatus["health"] = null): SourceStatus {
  if (!result.ok) return { id, url, outcome: "failed", reason: result.reason === "http" ? result.message : `${result.reason}: ${result.message}`, httpStatus: result.status, items: 0, health };
  return { id, url, outcome: result.result.revalidated ? "revalidated" : "fetched", reason: null, httpStatus: result.result.status, items, health };
}

const healthOf = (registry: DirectoryRegistry): SourceStatus["health"] => ({ status: registry.health.status, score: registry.health.score, checkedAt: registry.health.checkedAt });

/** Keep the first entry per id: official before community, a registry's ui before its later duplicates. */
export function dedupe(entries: readonly LibraryEntry[]): { entries: LibraryEntry[]; mirrorsCollapsed: number } {
  const ids = new Set<string>();
  const originals = new Set<string>();
  const originalUrls = new Set<string>();
  const mirrorUrls = new Set<string>();
  const urlKey = (entry: LibraryEntry): string | null => {
    if (!entry.provenance?.url) return null;
    try {
      const url = new URL(entry.provenance.url);
      const path = decodeURIComponent(url.pathname).replace(/\/+$/, "").replace(/\/(?:registry|\{name\})\.json$/, "");
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}/${entry.source.ref?.split("/").at(-1) ?? entry.name}`;
    } catch { return null; }
  };
  const mirrors = new Set<string>();
  let mirrorsCollapsed = 0;
  const fingerprint = (entry: LibraryEntry): string => {
    const files = entry.provenance?.files ?? [];
    return files.length && files.every((file) => file.sha256)
      ? sha256(JSON.stringify(files.map((file) => file.sha256).sort()))
      : sha256(JSON.stringify([entry.name.toLowerCase(), [...(entry.install?.npm ?? [])].sort(), entry.summary]));
  };
  for (const entry of entries) if (entry.source.kind === "shadcn-registry" && registryOf(entry) !== "@registrydirectory") { originals.add(fingerprint(entry)); const key = urlKey(entry); if (key) originalUrls.add(key); }
  const unique = entries.filter((entry) => {
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    if (registryOf(entry) !== "@registrydirectory") return true;
    const key = fingerprint(entry);
    const url = urlKey(entry);
    if (originals.has(key) || mirrors.has(key) || (url && (originalUrls.has(url) || mirrorUrls.has(url)))) { mirrorsCollapsed++; return false; }
    mirrors.add(key);
    if (url) mirrorUrls.add(url);
    return true;
  });
  return { entries: unique, mirrorsCollapsed };
}

export async function syncIndex(options: SyncOptions): Promise<SyncSummary> {
  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const builtAt = now().toISOString();
  const cache = await readHttpCache(options.cacheDir);
  const client = new PoliteClient({
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.token ? { token: options.token } : {}),
    concurrency: options.concurrency ?? 6,
    perHost: options.perHost ?? 2,
    timeoutMs: options.timeoutMs ?? 15_000,
    buckets: githubBuckets(options.token),
    cache,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const sources: SourceStatus[] = [];

  // Headless catalogs: category names only.
  const headless = await Promise.all(
    HEADLESS.map(async (catalog) => {
      const result = await client.get(catalog.url, catalog.accept);
      let names: string[] = [];
      let failure: string | null = result.ok ? null : result.message;
      if (result.ok) {
        try {
          try { names = (JSON.parse(result.body) as { catalogNames?: string[] }).catalogNames ?? catalog.parse(result.body); } catch { names = catalog.parse(result.body); }
          if (names.length === 0) failure = "no component names found";
          const cached = client.cache.get(catalog.url);
          const body = JSON.stringify({ catalogNames: names });
          if (cached) client.cache.set(catalog.url, { ...cached, body, sha256: sha256(body) });
        } catch {
          failure = "could not be parsed";
        }
      }
      sources.push(failure === null && result.ok ? { id: `headless:${catalog.id}`, url: catalog.url, outcome: result.revalidated ? "revalidated" : "fetched", reason: null, httpStatus: result.status, items: names.length, health: null } : { id: `headless:${catalog.id}`, url: catalog.url, outcome: "failed", reason: failure, httpStatus: result.status, items: 0, health: null });
      return { id: catalog.id, names };
    }),
  );
  const categories = mergeCategories(headless);

  // The official registry and its docs links, and the directory.
  const [officialIndex, official, directory] = await Promise.all([client.json(SHADCN.index), client.json(SHADCN.registry), client.json(SHADCN.directory)]);
  const docs = officialIndex.ok ? docsLinks(parseRegistryItems(officialIndex.value).items) : new Map<string, string>();
  sources.push(status("shadcn:index", SHADCN.index, officialIndex, docs.size));
  const entries: LibraryEntry[] = [];
  let officialCount = 0;
  if (official.ok && looksLikeRegistry(official.value)) {
    const source: RegistrySource = { name: SHADCN.name, homepage: SHADCN.homepage, url: SHADCN.registry, fetchedAt: official.result.fetchedAt, official: true, health: null };
    const items = parseRegistryItems(official.value).items.filter(isCandidate);
    for (const item of items) entries.push(registryEntry(source, item, categories, docs.get(item.name)));
    officialCount = items.length;
    sources.push(status("shadcn", SHADCN.registry, official, items.length));
  } else sources.push(official.ok ? { id: "shadcn", url: SHADCN.registry, outcome: "failed", reason: "not a registry", httpStatus: official.result.status, items: 0, health: null } : status("shadcn", SHADCN.registry, official, 0));

  const listed = directory.ok ? parseDirectory(directory.value).registries : [];
  sources.push(status("directory", SHADCN.directory, directory, listed.length));
  await writeJson(join(options.cacheDir, "directory.json"), listed);
  const selected = await readSources(options.cacheDir);
  const toFetch: DirectoryRegistry[] = [];
  const previousHealth = await readHealth(options.cacheDir);
  const iconReason = "icon set (opt in with --icons)";
  for (const registry of listed) {
    const iconOnly = /\bicons?\b/i.test(`${registry.name} ${registry.description ?? ""}`) || previousHealth?.sources.some((s) => s.id === registry.name && s.iconOnly);
    const reason = skipReason(registry) ?? (!options.icons && iconOnly ? iconReason : null) ?? (!selected.includes(registry.name) ? "not selected" : null);
    if (reason) sources.push({ id: registry.name, url: registryUrl(registry.template), outcome: "skipped", reason, ...(iconOnly ? { iconOnly: true } : {}), httpStatus: null, items: 0, health: healthOf(registry) });
    else if (options.maxRegistries !== undefined && toFetch.length >= options.maxRegistries) sources.push({ id: registry.name, url: registryUrl(registry.template), outcome: "skipped", reason: "over --max-registries", httpStatus: null, items: 0, health: healthOf(registry) });
    else toFetch.push(registry);
  }
  // A chosen source the directory no longer lists gives nothing; say so rather than count it as fetched.
  const missing = directory.ok ? selected.filter((name) => !listed.some((r) => r.name === name)) : [];
  for (const name of missing) sources.push({ id: name, url: SHADCN.directory, outcome: "skipped", reason: "not in the registry directory", httpStatus: null, items: 0, health: null });

  // Community registries, each on its own: a failure is recorded and the rest go on.
  const community = await Promise.all(
    toFetch.map(async (registry) => {
      const url = registryUrl(registry.template);
      const result = await client.json(url);
      if (!result.ok) return { status: status(registry.name, url, result, 0, healthOf(registry)), entries: [] };
      if (!looksLikeRegistry(result.value)) return { status: { id: registry.name, url, outcome: "failed" as const, reason: "not a registry (no items)", httpStatus: result.result.status, items: 0, health: healthOf(registry) }, entries: [] };
      const source: RegistrySource = { name: registry.name, homepage: registry.homepage, url, fetchedAt: result.result.fetchedAt, official: false, health: registry.health };
      const items: RegistryItem[] = parseRegistryItems(result.value).items.filter(isCandidate);
      const candidates = items.map((item) => registryEntry(source, item, categories));
      const iconOnly = candidates.length > 0 && candidates.filter(isIconEntry).length / candidates.length >= 0.8;
      return { status: { ...status(registry.name, url, result, items.length, healthOf(registry)), iconOnly, ...(!options.icons && iconOnly ? { outcome: "skipped" as const, reason: iconReason } : {}) }, entries: !options.icons && iconOnly ? [] : candidates };
    }),
  );
  for (const c of community) {
    sources.push(c.status);
    entries.push(...c.entries);
  }

  // npm-only candidates: one search per concept.
  if (options.npm !== false) {
    const found = new Map<string, { object: Parameters<typeof npmEntry>[0]; concepts: Concept[]; url: string; fetchedAt: string }>();
    let searched = 0;
    let failed = 0;
    await Promise.all(
      CONCEPTS.map(async (concept) => {
        const url = npmSearchUrl(concept);
        const result = await client.json(url);
        searched++;
        if (!result.ok) {
          failed++;
          return;
        }
        for (const object of npmCandidates(concept, parseNpmSearch(result.value))) {
          const prior = found.get(object.package.name);
          if (prior) prior.concepts.push(concept);
          else found.set(object.package.name, { object, concepts: [concept], url, fetchedAt: result.result.fetchedAt });
        }
      }),
    );
    for (const { object, concepts, url, fetchedAt } of [...found.values()].sort((a, b) => a.object.package.name.localeCompare(b.object.package.name))) entries.push(npmEntry(object, concepts, url, fetchedAt));
    sources.push({ id: "npm-search", url: "https://registry.npmjs.org/-/v1/search", outcome: failed === searched ? "failed" : "fetched", reason: failed ? `${failed} of ${searched} searches failed` : null, httpStatus: null, items: found.size, health: null });
  }

  const { entries: unique, mirrorsCollapsed } = dedupe(entries);
  const itemCounts = new Map<string, number>();
  for (const entry of unique) {
    const registry = registryOf(entry);
    if (registry) itemCounts.set(registry, (itemCounts.get(registry) ?? 0) + 1);
  }
  const homes = [{ name: SHADCN.name, homepage: SHADCN.homepage, items: officialCount }, ...toFetch.map((r) => ({ name: r.name, homepage: r.homepage, items: itemCounts.get(r.name) ?? 0 }))].filter((r) => r.items > 0);
  const { signals, report } = await refreshSignals(unique, homes, await readSignals(options.cacheDir), client, now(), { ...defaultBudgets(Boolean(options.token)), ...options.budgets });
  // An entry that would not validate is left out, so one odd item can never make the index unreadable.
  const final = unique.map((entry) => applySignals(entry, signals)).filter((entry) => LibraryEntry.safeParse(entry).success);

  const index: DiscoverIndex = cleanData({ schema: "youi.discover-index/v1", format: 2, builtAt, sources, categories: Object.fromEntries(categories), entries: final });
  await writeJson(join(options.cacheDir, SIGNALS_FILE), signals);
  await writeJson(join(options.cacheDir, HEALTH_FILE), cleanData({ checkedAt: builtAt, sources }));
  await writeHttpCache(options.cacheDir, client.cache);
  // The index last: a reader that sees the new index also sees the signals and health it was built from.
  await writeJson(join(options.cacheDir, INDEX_FILE), index);

  const registryStatuses = sources.filter((s) => s.health !== null);
  const known = final.filter((e) => e.license && e.license !== "unknown").length;
  return cleanData({
    cacheDir: options.cacheDir,
    catalogBytes: await catalogBytes(options.cacheDir),
    selectedSources: selected.length,
    index: { bytes: Buffer.byteLength(JSON.stringify(index) + "\n"), entries: final.length, mirrorsCollapsed, iconRegistriesSkipped: sources.filter((s) => s.reason === iconReason).length },
    warnings: [...client.warnings, ...missing.map((name) => `${name} is chosen but the registry directory no longer lists it: \`youiyoux discover sources remove ${name}\``)],
    builtAt,
    durationMs: Math.round(performance.now() - started),
    entries: { total: final.length, official: final.filter((e) => e.source.ref?.startsWith(`${SHADCN.name}/`)).length, community: final.filter((e) => e.source.kind === "shadcn-registry" && !e.source.ref?.startsWith(`${SHADCN.name}/`)).length, npm: final.filter((e) => e.source.kind === "npm").length },
    registries: { listed: listed.length, fetched: registryStatuses.filter((s) => s.outcome === "fetched").length, revalidated: registryStatuses.filter((s) => s.outcome === "revalidated").length, skipped: registryStatuses.filter((s) => s.outcome === "skipped").length, failed: registryStatuses.filter((s) => s.outcome === "failed").length },
    categories: categories.size,
    requests: { ...client.stats },
    signals: report,
    licences: { known, unknown: final.length - known },
    failures: sources.filter((s) => s.outcome === "failed").map((s) => ({ id: s.id, reason: client.redact(s.reason ?? "failed") })),
    files: [INDEX_FILE, HEALTH_FILE, SIGNALS_FILE, "directory.json", "listings/"],
  });
}
