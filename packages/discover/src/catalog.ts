/**
 * Discover on the store. The JSON files `youi discover sync` writes (index.json, and
 * index-all.json for `--all`) stay the source; the store holds their listings, signals and
 * licences, is refreshed whenever those files change, and can be deleted at any time.
 *
 * A search asks the store for the listings that share a word with the need (its concepts'
 * names and packages, and its plain words), at most CANDIDATES_PER_CLASS per source class by
 * full-text rank, then ranks that bounded set with the same scorer as ever (rankEntries).
 * Per class, so under `--all` thousands of community listings never push the official ones
 * out before they are scored. Listings only: source code is fetched on demand, never stored.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { LibraryEntry } from "@youiyoux/core";
import { nodeId, openStore, pageInteger, searchTerms, type DiscoverFilter, type DiscoverItem, type DiscoverScope, type GraphEdge, type GraphNode, type Signal, type SourceClass, type Store } from "@youiyoux/store";
import { CONCEPTS, conceptForRole, normalize, readNeed } from "./aliases.ts";
import { conceptScore, DISCOVER_RULE, fieldsOf, hitOf, rankEntries, registryName, styleOf, type DiscoverFacets, type DiscoverSearch, type DiscoverShow, type SearchOptions } from "./search.ts";
import { SHADCN } from "./sources.ts";
import { ALL_INDEX_FILE, INDEX_FILE, MissingIndexError, readAllIndex, readIndex, readSignals } from "./store.ts";
import { cleanText } from "./text.ts";

/** The most listings of one source class a search scores. */
export const CANDIDATES_PER_CLASS = 400;
/** Candidates linked to each inventory role (`could-replace` edges). */
export const LINKS_PER_ROLE = 10;

const FINGERPRINT = "discover.fingerprint";
const FINGERPRINT_ALL = "discover.fingerprint.all";
const BUILT_AT = "discover.builtAt";

export function sourceClassOf(entry: LibraryEntry): SourceClass {
  if (entry.source.kind === "npm") return "npm";
  if (entry.source.kind === "shadcn-registry") return entry.source.ref?.startsWith(`${SHADCN.name}/`) ? "official" : "community";
  return "other";
}

/** The concepts an entry plays: the same test as `--role` (playsRole). */
export function rolesOf(entry: LibraryEntry): string[] {
  const f = fieldsOf(entry);
  return CONCEPTS.filter((concept) => conceptScore(concept, f, []) > 0).map((c) => c.id);
}

export function licenceOf(entry: LibraryEntry): string {
  return entry.license && entry.license !== "unknown" ? entry.license.spdx : "unknown";
}

/** The words the full-text index reads: the scorer's fields, normalized as it reads them; the name weighs most. */
export function searchTextOf(entry: LibraryEntry): string {
  const f = fieldsOf(entry);
  return [f.name, f.name, f.name, f.title, f.title, f.description, ...f.categories, ...f.packages.map(normalize)].filter(Boolean).join(" ");
}

const count = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.min(2_000_000_000, Math.max(0, Math.round(n))) : null);

export function itemOf(entry: LibraryEntry, scope: DiscoverScope, builtAt: string): DiscoverItem {
  return {
    id: entry.id,
    scope,
    ref: entry.source.ref ?? null,
    name: entry.name,
    title: entry.title ?? null,
    summary: entry.summary,
    kind: entry.kind,
    sourceKind: entry.source.kind ?? null,
    sourceClass: sourceClassOf(entry),
    registry: registryName(entry),
    licence: licenceOf(entry),
    style: styleOf(entry),
    downloads: count(entry.signals?.weeklyDownloads ?? entry.signals?.via?.weeklyDownloads),
    stars: count(entry.signals?.stars),
    archived: Boolean(entry.signals?.archived),
    roles: rolesOf(entry),
    searchText: searchTextOf(entry),
    entry,
    builtAt,
  };
}

/** What a file was when the store last loaded it: its path, size and modification time. */
async function fingerprint(cacheDir: string, file: string): Promise<string> {
  const at = await stat(join(cacheDir, file)).then((s) => `${s.size}:${Math.round(s.mtimeMs)}`, () => "-");
  return JSON.stringify([cacheDir, at]);
}

function signalRows(signals: Awaited<ReturnType<typeof readSignals>>): Signal[] {
  return [
    ...Object.entries(signals.npm).map(([name, data]) => ({ key: `npm:${name}`, kind: "npm", data, fetchedAt: data.fetchedAt ?? null })),
    ...Object.entries(signals.github).map(([repo, data]) => ({ key: `github:${repo}`, kind: "github", data, fetchedAt: data.fetchedAt ?? null })),
    ...Object.entries(signals.registryRepos).map(([registry, data]) => ({ key: `registry:${registry}`, kind: "registry", data, fetchedAt: data.checkedAt ?? null })),
  ];
}

/**
 * Load the cache's JSON into the store: the index's listings, signals and licences, then the
 * could-replace links; and the --all listings, kept apart. `only: "all"` reloads just those
 * (what a `--all` search changed).
 */
export async function ingestCatalog(store: Store, cacheDir: string, only?: "all"): Promise<{ chosen: number; all: number; builtAt: string }> {
  const stamps = { chosen: await fingerprint(cacheDir, INDEX_FILE), all: await fingerprint(cacheDir, ALL_INDEX_FILE) };
  const index = await readIndex(cacheDir);
  if (!index) throw new MissingIndexError(cacheDir);
  const chosenIds = new Set(index.entries.map((e) => e.id));
  const extra = ((await readAllIndex(cacheDir))?.entries ?? []).filter((e) => !chosenIds.has(e.id));
  if (only !== "all") {
    await store.replaceDiscoverItems("chosen", index.entries.map((e) => itemOf(e, "chosen", index.builtAt)));
    await store.replaceSignals(signalRows(await readSignals(cacheDir)));
  }
  await store.replaceDiscoverItems("all", extra.map((e) => itemOf(e, "all", index.builtAt)));
  await store.replaceLicences([...index.entries, ...extra].flatMap((e) => (e.license && e.license !== "unknown" ? [{ itemId: e.id, spdx: e.license.spdx, evidenceUrl: e.license.evidenceUrl, verifiedAt: e.license.verifiedAt }] : [])));
  await store.setMeta(BUILT_AT, index.builtAt);
  if (only !== "all") await linkCandidates(store);
  await store.setMeta(FINGERPRINT, stamps.chosen);
  await store.setMeta(FINGERPRINT_ALL, stamps.all);
  return { chosen: index.entries.length, all: extra.length, builtAt: index.builtAt };
}

const opened = new Map<string, Promise<Store>>();
const refreshing = new Map<string, Promise<unknown>>();

/** One open store per location in this process (the MCP server asks many times). */
export function sharedStore(path: string, env: NodeJS.ProcessEnv = process.env, options: { readOnly?: boolean } = {}): Promise<Store> {
  const key = `${options.readOnly ? "read" : "write"}:${env.DATABASE_URL ? `postgres:${env.DATABASE_URL}` : path}`;
  let store = opened.get(key);
  if (!store) {
    store = openStore({ path, env, ...options });
    store.catch(() => opened.delete(key));
    opened.set(key, store);
  }
  return store;
}

/** Close every store sharedStore opened (tests, and a CLI run that is done). */
export async function closeSharedStores(): Promise<void> {
  const stores = [...opened.values()];
  opened.clear();
  await Promise.all(stores.map(async (s) => (await s.catch(() => null))?.close()));
}

/**
 * The store with this cache's catalog in it. No index.json yet is an error that says to sync
 * (and nothing is created); an index.json newer than what the store holds is loaded first.
 */
export async function openCatalog(cacheDir: string, path: string, env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  if (!(await stat(join(cacheDir, INDEX_FILE)).then((s) => s.isFile(), () => false))) throw new MissingIndexError(cacheDir);
  const store = await sharedStore(path, env);
  const key = `${path}\0${cacheDir}`;
  while (refreshing.has(key)) await refreshing.get(key);
  const chosen = (await store.meta(FINGERPRINT)) === (await fingerprint(cacheDir, INDEX_FILE));
  const all = (await store.meta(FINGERPRINT_ALL)) === (await fingerprint(cacheDir, ALL_INDEX_FILE));
  if (!chosen || !all) {
    const refresh = ingestCatalog(store, cacheDir, chosen ? "all" : undefined).finally(() => refreshing.delete(key));
    refreshing.set(key, refresh);
    await refresh;
  }
  return store;
}

/** Read the materialized catalog without importing JSON or creating a database. */
export async function readCatalog(cacheDir: string, path: string, env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  if (!env.DATABASE_URL && !(await stat(path).then(() => true, () => false))) throw new MissingIndexError(cacheDir);
  const store = await sharedStore(path, env, { readOnly: true });
  if (!(await store.meta(BUILT_AT))) throw new MissingIndexError(cacheDir);
  return store;
}

export interface CatalogSearchOptions extends SearchOptions {
  /** Search the --all listings too. */
  readonly all?: boolean;
  readonly offset?: number;
  readonly facets?: boolean;
  /** Override CANDIDATES_PER_CLASS (measurement). */
  readonly perClass?: number;
}

function scopesOf(all: boolean | undefined): DiscoverScope[] {
  return all ? ["chosen", "all"] : ["chosen"];
}

/** The filter the store can apply itself: scope, role, source kind, registry, licence and kind. The scorer re-checks all of them. */
function filterOf(options: CatalogSearchOptions): DiscoverFilter {
  const c = options.constraints;
  const role = options.role ? conceptForRole(options.role) : undefined;
  return {
    scopes: scopesOf(options.all),
    ...(role ? { roles: [role.id] } : {}),
    ...(c?.sources?.length ? { sourceKinds: c.sources } : {}),
    ...(c?.registries?.length ? { registries: c.registries } : {}),
    ...(c?.licenses?.length ? { licences: [...c.licenses, ...(c.allowUnknownLicense ? ["unknown"] : [])] } : {}),
    ...(c?.kinds?.length ? { kinds: c.kinds } : {}),
  };
}

const tally = (values: Iterable<string>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
};

/** Words in package and concept names that say nothing about the component (`react` in react-day-picker). */
const GENERIC = new Set(["react", "ui", "js", "component", "components", "lib", "the", "a", "an", "for", "with", "and", "or", "of", "to", "in"]);

/**
 * The words a search sends to the full-text index: every word of the need's concept names and
 * packages and its plain words, but a phrase's generic words. The scorer matches a phrase only
 * when all of its words are there, so one specific word of each is enough to keep every
 * listing it could score, and `react` alone would match the whole catalog.
 */
export function needTerms(need: string): string[] {
  const read = readNeed(cleanText(need));
  const phrases = [...read.concepts.flatMap((c) => [...c.names, ...c.packages]), ...read.words].map(normalize);
  return searchTerms(phrases.flatMap((phrase) => {
    const words = phrase.split(" ").filter(Boolean);
    const specific = words.filter((w) => !GENERIC.has(w));
    return specific.length ? specific : words;
  }));
}

/** Search the store by need: the same answer shape as searchIndex, paged, with facets when asked. */
export async function searchCatalog(store: Store, need: string, options: CatalogSearchOptions = {}): Promise<DiscoverSearch> {
  const filter = filterOf(options);
  const rows = await store.matchDiscover({ ...filter, terms: needTerms(need), perClass: options.perClass ?? CANDIDATES_PER_CLASS });
  const ranked = rankEntries(rows.map((r) => r.entry as LibraryEntry), need, options);
  const offset = pageInteger(options.offset, 0, 2_147_483_647);
  const page = ranked.scored.slice(offset, offset + pageInteger(options.limit, 10));
  let facets: DiscoverFacets | undefined;
  if (options.facets) {
    const entries = ranked.scored.map((s) => s.entry);
    const roles = await store.discoverRoles(entries.map((e) => e.id));
    facets = { role: tally(entries.flatMap((e) => roles[e.id] ?? [])), source: tally(entries.map((e) => registryName(e))), licence: tally(entries.map(licenceOf)), style: tally(entries.map(styleOf)) };
  }
  return {
    need: ranked.need,
    concepts: ranked.concepts,
    hits: page.map((s) => hitOf(s.entry, s.score, s.why)),
    matched: ranked.scored.length,
    total: await store.countDiscover({ scopes: filter.scopes }),
    indexBuiltAt: (await store.meta(BUILT_AT)) ?? "",
    note: DISCOVER_RULE,
    ...(offset ? { offset } : {}),
    ...(options.all ? { scope: "all" as const } : {}),
    ...(facets ? { facets } : {}),
  };
}

/** One listing by lib: id or ref (`@coss/command`, an npm name, or an official item's bare name), from the store. */
export async function showFromCatalog(store: Store, query: string, options: { readonly all?: boolean } = {}): Promise<DiscoverShow> {
  const q = cleanText(query).trim();
  const scopes = scopesOf(options.all ?? true);
  const row = (await store.getDiscoverItem(q, scopes)) ?? (await store.getDiscoverItem(`${SHADCN.name}/${q}`, scopes));
  if (!row) throw new Error(`no Discover candidate "${q}": pass a lib: id or a ref (@coss/command) from youi discover / discover_search`);
  return { entry: row.entry as LibraryEntry, indexBuiltAt: (await store.meta(BUILT_AT)) ?? "", note: DISCOVER_RULE };
}

/** The listings a filter selects without a need, paged (official first, then by downloads): what the hub browses. */
export async function browseCatalog(store: Store, filter: Omit<DiscoverFilter, "scopes"> & { readonly all?: boolean }, page: { readonly limit?: number; readonly offset?: number } = {}) {
  const { all, ...rest } = filter;
  const scoped = { ...rest, scopes: scopesOf(all) };
  const listed = await store.listDiscover(scoped, page);
  return { total: listed.total, offset: pageInteger(page.offset, 0, 2_147_483_647), hits: listed.rows.map((r) => hitOf(r.entry as LibraryEntry, 0, [])), facets: await store.discoverFacets(scoped), indexBuiltAt: (await store.meta(BUILT_AT)) ?? "", note: DISCOVER_RULE };
}

/** Inventory roles as the concepts Discover knows them by: a link styled as a button is a button. */
const ROLE_CONCEPT: Readonly<Record<string, string>> = { "link-as-button": "button" };

/**
 * `candidate could-replace family`: for each role the inventoried families play, the best
 * LINKS_PER_ROLE chosen listings that play it. Rewritten whole on every catalog load and
 * inventory run.
 */
export async function linkCandidates(store: Store): Promise<number> {
  const byConcept = new Map<string, string[]>();
  for (const family of await store.nodesOfKind("family")) {
    const role = family.ref.replace(/-\d+$/, "");
    const concept = conceptForRole(ROLE_CONCEPT[role] ?? role);
    if (concept) byConcept.set(concept.id, [...(byConcept.get(concept.id) ?? []), family.id]);
  }
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const [conceptId, families] of byConcept) {
    const concept = CONCEPTS.find((c) => c.id === conceptId)!;
    const { hits } = await searchCatalog(store, concept.names[0]!, { role: concept.id, limit: LINKS_PER_ROLE });
    for (const hit of hits) {
      const id = nodeId.candidate(hit.id);
      nodes.set(id, { id, kind: "candidate", ref: hit.id });
      for (const family of families) edges.push({ from: id, to: family, kind: "could-replace" });
    }
  }
  await store.replaceGraph("discover", { nodes: [...nodes.values()], edges });
  return edges.length;
}
