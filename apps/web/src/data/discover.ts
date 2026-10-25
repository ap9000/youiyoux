/**
 * Discover's data on the hub: listings found by need, paged and faceted. The hub's own server
 * answers `/__youi/query?kind=discover` from the local index; a static host has no such endpoint,
 * so the snapshot's listings file (discover.<hash>.json, written when a Discover cache was synced)
 * is searched here, in memory, instead. Listings only, at this level: nothing is fetched for a
 * candidate until a person opens it (discover-preview.ts).
 */
import { discoverListingsFile } from "./store.ts";
import { loadDiscoverListings } from "./load.ts";

/** A listing as a result card shows it (the server's DiscoverHit, or a snapshot listing). */
export interface DiscoverHit {
  readonly id: string;
  readonly name: string;
  readonly title: string | null;
  readonly kind: "component" | "pattern" | "token";
  readonly summary: string;
  readonly source: { readonly kind: string | null; readonly name: string; readonly ref: string | null; readonly url: string | null };
  /** An SPDX id, or "unknown". */
  readonly license: string;
  readonly signals: { readonly via?: { readonly package: string; readonly weeklyDownloads: number }; readonly weeklyDownloads: number | null; readonly stars: number | null; readonly pushedAt: string | null; readonly archived: boolean | null };
  readonly install: { readonly command: string; readonly npm: readonly string[]; readonly registryDeps: readonly string[]; readonly implicitDeps: readonly string[] } | null;
}

interface DiscoverFacets {
  readonly role: Readonly<Record<string, number>>;
  readonly source: Readonly<Record<string, number>>;
  readonly licence: Readonly<Record<string, number>>;
  readonly style: Readonly<Record<string, number>>;
}

export interface DiscoverQuery {
  readonly q: string;
  readonly role: string | null;
  readonly source: string | null;
  readonly licence: "known" | "unknown" | null;
  readonly style: "headless" | "styled" | null;
  /** An inventory family pinned for comparison (`button-1`). */
  readonly family: string | null;
  /** The candidate open in the preview. */
  readonly open: string | null;
  /** How results are laid out; null: the gallery when there are pictures, else the list. */
  readonly view: "gallery" | "list" | null;
  /** How results are ordered; null: recommended (the best match first; browsing, official first). */
  readonly sort: DiscoverSort | null;
  /** Listings per page (PER_PAGE); PAGE_SIZE unless chosen. */
  readonly per: number;
  readonly offset: number;
}

/** The orders a person can choose; recommended is the default and has no value in the address. */
export const SORTS = ["name", "registry", "downloads"] as const;
export type DiscoverSort = (typeof SORTS)[number];
export const SORT_LABELS: Readonly<Record<DiscoverSort | "recommended", string>> = { recommended: "Recommended", name: "Name A–Z", registry: "Registry", downloads: "Most downloaded" };
/** How the results line names a chosen order: `By name, A–Z: 1–20 of 1283`. */
export const SORT_SUMMARIES: Readonly<Record<DiscoverSort, string>> = { name: "By name, A–Z", registry: "By registry, then name", downloads: "Most downloaded first" };
export const PAGE_SIZE = 20;
export const PER_PAGE = [20, 50, 100] as const;

export const EMPTY_QUERY: DiscoverQuery = { q: "", role: null, source: null, licence: null, style: null, family: null, open: null, view: null, sort: null, per: PAGE_SIZE, offset: 0 };

export interface DiscoverPage {
  readonly hits: readonly DiscoverHit[];
  /** Listings that match, before paging. */
  readonly matched: number;
  readonly offset: number;
  readonly facets: DiscoverFacets;
  /** index: the hub's server read the local index; snapshot: the static listings, searched here. */
  readonly from: "index" | "snapshot";
  /** The snapshot holds only the first listings of a bigger catalog. */
  readonly capped?: boolean;
}

/* --------------------------------------------------------------------------- URL */

const ROLE_OF_INVENTORY: Readonly<Record<string, string>> = { "link-as-button": "button" };

/** Inventory roles as Discover knows them: a link styled as a button is a button. */
export const discoverRole = (role: string): string => ROLE_OF_INVENTORY[role] ?? role;

export function parseQuery(search: string): DiscoverQuery {
  const params = new URLSearchParams(search);
  const pick = <T extends string>(name: string, allowed?: readonly T[]): T | null => {
    const value = params.get(name)?.trim().slice(0, 200) || null;
    return value === null || (allowed && !allowed.includes(value as T)) ? null : (value as T);
  };
  const offset = Number(params.get("offset") ?? 0);
  const per = Number(params.get("per") ?? PAGE_SIZE);
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    role: pick("role"),
    source: pick("source"),
    licence: pick("licence", ["known", "unknown"] as const),
    style: pick("style", ["headless", "styled"] as const),
    family: pick("family"),
    open: pick("open"),
    view: pick("view", ["gallery", "list"] as const),
    sort: pick("sort", SORTS),
    per: (PER_PAGE as readonly number[]).includes(per) ? per : PAGE_SIZE,
    offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
  };
}

export function queryToSearch(query: DiscoverQuery): string {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set("q", query.q);
  for (const key of ["role", "source", "licence", "style", "family", "open", "view", "sort"] as const) if (query[key]) params.set(key, query[key]!);
  if (query.per !== PAGE_SIZE) params.set("per", String(query.per));
  if (query.offset > 0) params.set("offset", String(query.offset));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/* ----------------------------------------------------------------------- signals */

/** `41566267` → `42M`, `3834761` → `3.8M`, `57296` → `57k`, `8521` → `8.5k`. */
export function compact(n: number): string {
  const short = (value: number, unit: string): string => `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
  return n >= 1e6 ? short(n / 1e6, "M") : n >= 1e3 ? short(n / 1e3, "k") : String(n);
}

/** What a card says about popularity and upkeep: `42M/wk via cmdk`, `★ 22.6k`, `archived`. */
export function signalLines(hit: Pick<DiscoverHit, "signals">): string[] {
  const s = hit.signals;
  const lines: string[] = [];
  if (s.weeklyDownloads != null) lines.push(`${compact(s.weeklyDownloads)}/wk`);
  else if (s.via) lines.push(`${compact(s.via.weeklyDownloads)}/wk via ${s.via.package}`);
  if (s.stars != null) lines.push(`★ ${compact(s.stars)}`);
  if (s.archived) lines.push("archived");
  return lines;
}

/**
 * A listing's own description, or null when its registry gives none: the sync then fills in
 * `<name> from <registry>` (or the title), which says nothing the card does not already.
 */
export function descriptionOf(hit: Pick<DiscoverHit, "name" | "title" | "summary">): string | null {
  const text = hit.summary.trim();
  if (!text || text === hit.title || text === hit.name || text.startsWith(`${hit.name} from `)) return null;
  return text;
}

/** The registry or `npm` a listing comes from. */
export const sourceOf = (hit: Pick<DiscoverHit, "source">): string => (hit.source.kind === "npm" ? "npm" : hit.source.ref?.includes("/") ? hit.source.ref.slice(0, hit.source.ref.indexOf("/")) : hit.source.name);

/* ------------------------------------------------------------- static fallback */

interface Listing extends DiscoverHit {
  readonly registry: string;
  readonly roles: readonly string[];
  readonly style: "headless" | "styled";
  readonly text: string;
}

export interface ListingsFile {
  readonly schema: "youiyoux.discover-listings/v1";
  readonly builtAt: string;
  readonly total: number;
  readonly capped: boolean;
  readonly entries: readonly Listing[];
}

const words = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 1);

const tally = (values: Iterable<string>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
};

/**
 * A need over the snapshot's listings: each listing scores by the need's words it holds (its
 * name counts most), ties keep the file's order (official first, then by downloads). Facets
 * count the matches before paging, as the server's do.
 */
export function searchListings(file: ListingsFile, query: DiscoverQuery, limit = query.per): DiscoverPage {
  const need = words(query.q);
  const scored: Array<{ listing: Listing; score: number; order: number }> = [];
  file.entries.forEach((listing, order) => {
    if (query.role && !listing.roles.includes(query.role) && !listing.roles.includes(discoverRole(query.role))) return;
    if (query.source && listing.registry !== query.source) return;
    if (query.licence && (listing.license === "unknown") !== (query.licence === "unknown")) return;
    if (query.style && listing.style !== query.style) return;
    if (need.length === 0) return void scored.push({ listing, score: 0, order });
    const text = ` ${words(listing.text).join(" ")} `;
    const name = ` ${words(`${listing.name} ${listing.title ?? ""}`).join(" ")} `;
    let score = 0;
    for (const word of need) {
      if (name.includes(` ${word} `)) score += 3;
      else if (text.includes(` ${word} `)) score += 1;
      else if (text.includes(` ${word}`)) score += 0.5;
    }
    if (score > 0) scored.push({ listing, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const matches = sortListings(scored.map((s) => s.listing), query.sort);
  const strip = ({ registry: _r, roles: _ro, style: _s, text: _t, ...hit }: Listing): DiscoverHit => hit;
  return {
    hits: matches.slice(query.offset, query.offset + limit).map(strip),
    matched: matches.length,
    offset: query.offset,
    facets: { role: tally(matches.flatMap((m) => m.roles)), source: tally(matches.map((m) => m.registry)), licence: tally(matches.map((m) => m.license)), style: tally(matches.map((m) => m.style)) },
    from: "snapshot",
    capped: file.capped,
  };
}

/** Listings in a chosen order, as the hub's server orders them (packages/discover sortEntries). */
export function sortListings<T extends Pick<DiscoverHit, "id" | "name" | "title" | "signals" | "source">>(listings: readonly T[], sort: DiscoverSort | null): T[] {
  if (!sort) return [...listings];
  const title = (l: T): string => (l.title ?? l.name).toLowerCase();
  const downloads = (l: T): number => l.signals.weeklyDownloads ?? l.signals.via?.weeklyDownloads ?? -1;
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...listings].sort((a, b) => (sort === "registry" ? by(sourceOf(a).toLowerCase(), sourceOf(b).toLowerCase()) : 0) || (sort === "downloads" ? downloads(b) - downloads(a) : 0) || by(title(a), title(b)) || by(a.id, b.id));
}

/* ------------------------------------------------------------------------ search */

/** Why there are no listings to show at all. */
class NoListings extends Error {
  override name = "NoListings";
}

let listings: Promise<ListingsFile | null> | null = null;
/** The endpoint answered once with something other than its JSON: this host only serves files. */
let staticHost = false;

function endpointUrl(query: DiscoverQuery): string {
  const params = new URLSearchParams({ kind: "discover", limit: String(query.per) });
  if (query.sort) params.set("sort", query.sort);
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.role) params.set("role", discoverRole(query.role));
  if (query.source) params.set("source", query.source);
  if (query.licence) params.set("licence", query.licence);
  if (query.style) params.set("style", query.style);
  if (query.offset) params.set("offset", String(query.offset));
  return `${import.meta.env.BASE_URL}__youi/query?${params}`;
}

/** One page of listings: from the hub's server when it answers, else from the snapshot's listings. */
export async function searchDiscover(query: DiscoverQuery, options: { signal?: AbortSignal } = {}): Promise<DiscoverPage> {
  if (!staticHost) {
    let response: Response | null = null;
    try {
      response = await fetch(endpointUrl(query), { cache: "no-store", ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error: unknown) {
      if ((error as { name?: string }).name === "AbortError") throw error;
      response = null;
    }
    const body = response && (response.headers.get("content-type") ?? "").includes("application/json") ? ((await response.json().catch(() => null)) as (Partial<DiscoverPage> & { hits?: DiscoverHit[]; matched?: number; total?: number; error?: string }) | null) : null;
    if (response?.ok && body?.hits) return { hits: body.hits, matched: body.matched ?? body.total ?? body.hits.length, offset: query.offset, facets: body.facets ?? { role: {}, source: {}, licence: {}, style: {} }, from: "index" };
    // The endpoint answered, but there is no index yet: say what to run (the snapshot may still have listings).
    if (response && body?.error && response.status !== 404) throw new NoListings(body.error);
    if (!response || !body) staticHost = true;
  }
  listings ??= discoverListingsFile().then((file) => (file ? loadDiscoverListings<ListingsFile>(file) : null));
  const file = await listings.catch(() => null);
  if (!file) throw new NoListings("No Discover listings here: run youiyoux discover sync, then open the hub with youiyoux ui (its own server reads the local index).");
  return searchListings(file, query);
}

/** Tests: forget what was learnt about the host. */
export function resetDiscoverSource(): void {
  listings = null;
  staticHost = false;
}
