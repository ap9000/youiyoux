/** What the store holds and answers: the same on SQLite and Postgres. */
import type { CiRecord } from "@youiyoux/core";
import type { Engine } from "./driver.ts";

/** `chosen`: the synced sources, what a default search reads. `all`: listings `--all` added, kept apart. */
export type DiscoverScope = "chosen" | "all";
/** official: the shadcn registry itself; community: other registries; npm: npm-only packages. */
export type SourceClass = "official" | "community" | "npm" | "other";
export type Style = "headless" | "styled";

export interface DiscoverItem {
  readonly id: string;
  readonly scope: DiscoverScope;
  readonly ref: string | null;
  readonly name: string;
  readonly title: string | null;
  readonly summary: string;
  readonly kind: string;
  readonly sourceKind: string | null;
  readonly sourceClass: SourceClass;
  /** `@coss`, `@shadcn`, or `npm`. */
  readonly registry: string | null;
  /** An SPDX id, or `unknown`. */
  readonly licence: string;
  readonly style: Style;
  readonly downloads: number | null;
  readonly stars: number | null;
  readonly archived: boolean;
  /** Concept ids the item plays (`command`, `dialog`): the role facet. */
  readonly roles: readonly string[];
  /** Normalized words the full-text index reads (name, title, summary, categories, packages). */
  readonly searchText: string;
  /** The listing as Discover keeps it (a youi Library entry). Never source code. */
  readonly entry: unknown;
  readonly builtAt: string;
}

/** How browsed listings are ordered: official first then by downloads (recommended), by name, by registry then name, or by downloads alone. */
export type DiscoverSort = "recommended" | "name" | "registry" | "downloads";
export const DISCOVER_SORTS: readonly DiscoverSort[] = ["recommended", "name", "registry", "downloads"];

export interface DiscoverFilter {
  readonly scopes: readonly DiscoverScope[];
  /** Any of these roles. */
  readonly roles?: readonly string[];
  readonly sourceKinds?: readonly string[];
  readonly sourceClasses?: readonly SourceClass[];
  /** Registry names (`@coss`) or `npm`, any case. */
  readonly registries?: readonly string[];
  /** SPDX ids or `unknown`, any case. */
  readonly licences?: readonly string[];
  readonly kinds?: readonly string[];
  readonly styles?: readonly Style[];
}

export interface DiscoverMatchQuery extends DiscoverFilter {
  /** Lowercase words; an item matches when its text has any of them. */
  readonly terms: readonly string[];
  /**
   * At most this many per source class, best text rank first: the bounded set the scorer
   * ranks. Per class, so thousands of community listings never crowd the official ones out.
   */
  readonly perClass: number;
}

export interface DiscoverRow {
  readonly id: string;
  readonly sourceClass: SourceClass;
  readonly entry: unknown;
}

export interface DiscoverPage {
  readonly rows: readonly DiscoverRow[];
  readonly total: number;
}

export interface Facets {
  readonly role: Readonly<Record<string, number>>;
  readonly source: Readonly<Record<string, number>>;
  readonly licence: Readonly<Record<string, number>>;
  readonly style: Readonly<Record<string, number>>;
}

export interface Signal {
  /** `npm:cmdk`, `github:owner/repo`, `registry:@coss`. */
  readonly key: string;
  readonly kind: string;
  readonly data: unknown;
  readonly fetchedAt: string | null;
}

export interface Licence {
  readonly itemId: string;
  readonly spdx: string;
  readonly evidenceUrl: string | null;
  readonly verifiedAt: string | null;
}

export type NodeKind = "family" | "file" | "route" | "candidate" | "rule" | "component" | "project" | "library";
export type EdgeKind = "used-in" | "near-duplicate-of" | "could-replace" | "governs" | "uses-library";

export interface GraphNode {
  readonly project?: string | null;
  readonly id: string;
  readonly kind: NodeKind;
  /** What a person names it by: `button-2`, `src/app/page.tsx`, `/settings`, a lib: id, a rule id. */
  readonly ref: string;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface Reached extends GraphNode {
  readonly depth: number;
}

export interface ScanProject {
  readonly project: string;
  readonly root: string;
  readonly commit: string | null;
  readonly status: string;
  readonly files: number;
  readonly looks: number;
  readonly families: number;
  readonly nearDuplicates: number;
  /** Role → looks. */
  readonly roles: Readonly<Record<string, number>>;
}

export interface FamilyRecord {
  readonly id: string;
  readonly role: string;
  readonly looks: number;
  readonly nearDuplicate: boolean;
  readonly projects: readonly string[];
  readonly kits: readonly string[];
  readonly shape: Readonly<Record<string, number | null>>;
}

export interface LookRecord {
  readonly id: string;
  readonly project: string;
  readonly role: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly tag: string;
  readonly kit: string | null;
  readonly family: string | null;
  readonly routes: readonly string[];
  readonly shape: Readonly<Record<string, number | null>>;
}

/** One inventory run: a scan row per project, its families and looks, and the graph it implies. */
export interface InventoryRun {
  readonly run: string;
  /** What the run came from (the inventory file); a newer run from the same source replaces its looks and graph. */
  readonly source: string;
  readonly scannedAt: string;
  readonly projects: readonly ScanProject[];
  readonly families: readonly FamilyRecord[];
  /** Kept for the latest run of each source only; history keeps counts and families. */
  readonly looks: readonly LookRecord[];
  readonly graph: Graph;
}

export interface ScanRecord extends ScanProject {
  readonly id: string;
  readonly run: string;
  readonly source: string;
  readonly scannedAt: string;
}

export interface Page {
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProjectScope { readonly project?: string }
export interface Ambiguous { readonly choices: ReadonlyArray<GraphNode & { source: string }> }

export interface WhereUsed {
  readonly family: string;
  readonly role: string | null;
  readonly looks: number;
  readonly files: readonly string[];
  readonly routes: readonly string[];
  readonly nearDuplicates: readonly string[];
  readonly source: string;
}

export interface SwapImpact {
  readonly candidate: string;
  readonly family: string;
  /** A could-replace edge links them: the candidate plays the family's role. */
  readonly listed: boolean;
  /** The family and every family it is a near-duplicate of, transitively. */
  readonly families: ReadonlyArray<{ readonly id: string; readonly looks: number; readonly depth: number }>;
  readonly looks: number;
  readonly files: readonly string[];
  readonly routes: readonly string[];
  readonly otherCandidates: readonly string[];
}

export interface RuleCovers {
  readonly rule: string;
  readonly components: readonly string[];
  readonly files: readonly string[];
  readonly routes: readonly string[];
}

export interface StoreStats {
  readonly generation: string | null;
  readonly engine: Engine;
  readonly location: string;
  readonly schema: number;
  readonly tables: Readonly<Record<string, number>>;
}

/**
 * The store: large, derived youiyoux data (Discover listings, signals, licences, inventory
 * history, the usage graph), local on SQLite or hosted on Postgres, rebuildable from its
 * sources at any time. Every method answers the same on both engines.
 */
export interface Store {
  readonly engine: Engine;
  readonly location: string;
  close(): Promise<void>;
  /** Remove every row, keep the schema: the start of a rebuild. */
  reset(): Promise<void>;
  stats(): Promise<StoreStats>;
  meta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  /** Replace every listing of one scope at once. */
  replaceDiscoverItems(scope: DiscoverScope, items: readonly DiscoverItem[]): Promise<void>;
  upsertDiscoverItems(items: readonly DiscoverItem[]): Promise<void>;
  /** The bounded candidate set for a search: items with any term, filtered, best text rank first per source class. */
  matchDiscover(query: DiscoverMatchQuery): Promise<DiscoverRow[]>;
  /** Listings without a need, filtered and paged: official first, then by downloads, then id. */
  listDiscover(filter: DiscoverFilter, page?: Page & { readonly sort?: DiscoverSort }): Promise<DiscoverPage>;
  countDiscover(filter: DiscoverFilter): Promise<number>;
  discoverFacets(filter: DiscoverFilter): Promise<Facets>;
  /** By lib: id, else by ref; null when neither is listed in these scopes. */
  getDiscoverItem(idOrRef: string, scopes: readonly DiscoverScope[]): Promise<DiscoverRow | null>;
  /** Item ids playing a role, in these scopes. */
  discoverRoles(itemIds: readonly string[]): Promise<Record<string, string[]>>;

  replaceSignals(signals: readonly Signal[]): Promise<void>;
  signal(key: string): Promise<Signal | null>;
  replaceLicences(licences: readonly Licence[]): Promise<void>;
  licence(itemId: string): Promise<Licence | null>;

  recordInventory(run: InventoryRun): Promise<void>;
  /** Scans, newest first. */
  history(filter?: { readonly project?: string } & Page): Promise<ScanRecord[]>;
  latestRun(source?: string): Promise<{ run: string; source: string; scannedAt: string } | null>;
  families(filter?: { readonly run?: string; readonly role?: string } & Page): Promise<{ run: string | null; total: number; rows: FamilyRecord[] }>;
  looks(filter: { readonly run?: string; readonly family?: string; readonly role?: string } & Page): Promise<{ run: string | null; total: number; rows: LookRecord[] }>;

  /** Keep what CI sent a hosted hub (youi.record/v1), received now; a repository's last 100 are kept. A record for a commit already kept replaces it. */
  putRecord(record: CiRecord, receivedAt: string): Promise<void>;
  /** Each repository's newest record (by generatedAt, then receipt), by repository name. */
  latestRecords(): Promise<Array<{ readonly record: CiRecord; readonly receivedAt: string }>>;

  /** Replace everything one source said about the graph. */
  replaceGraph(source: string, graph: Graph): Promise<void>;
  /** Nodes reachable from these over edges of these kinds, depth-first order by distance; the start nodes at depth 0. */
  reach(start: readonly string[], kinds: readonly EdgeKind[], options?: { readonly maxDepth?: number; readonly reverse?: boolean }): Promise<Reached[]>;
  findNodes(kind: NodeKind, ref: string): Promise<Array<GraphNode & { source: string }>>;
  nodesOfKind(kind: NodeKind, source?: string): Promise<Array<GraphNode & { source: string }>>;
  resolveFamily(ref: string, project?: string): Promise<(GraphNode & { source: string }) | Ambiguous | null>;
  resolveRule(ref: string, project?: string): Promise<(GraphNode & { source: string }) | Ambiguous | null>;
  whereUsed(family: string, options?: ProjectScope): Promise<WhereUsed | Ambiguous | null>;
  swapImpact(candidate: string, family: string, options?: ProjectScope): Promise<SwapImpact | Ambiguous | null>;
  ruleCovers(rule: string, options?: ProjectScope): Promise<RuleCovers | Ambiguous | null>;
}
