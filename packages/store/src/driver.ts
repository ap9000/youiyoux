/**
 * The seam between the store and an engine. Each adapter gives the same four calls over its
 * connection, plus the few things the engines do differently: the JSON column type, the
 * full-text index and how a search matches and ranks. Everything else is one portable SQL.
 */
export type Param = string | number | null;
export type Row = Record<string, unknown>;
export type Engine = "sqlite" | "postgres";

export interface Driver {
  readonly engine: Engine;
  /** A file path, `:memory:`, or a redacted connection string. */
  readonly location: string;
  all<T = Row>(sql: string, params?: readonly Param[]): Promise<T[]>;
  run(sql: string, params?: readonly Param[]): Promise<void>;
  /** Several statements, no parameters. */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

/** How one engine matches and ranks the Discover catalog: a FROM clause aliased `d`, its condition, and a rank where lower is better. */
export interface Match {
  readonly from: string;
  readonly where: string;
  readonly whereParams: readonly Param[];
  readonly rank: string;
  readonly rankParams: readonly Param[];
}

export interface Dialect {
  /** `TEXT` (SQLite) or `JSONB` (Postgres). */
  readonly json: string;
  readonly begin: string;
  /** The full-text index over discover_items.search_text, created by migration 2. */
  readonly searchDdl: readonly string[];
  /** A match on any of these terms (lowercase letters and digits only), with every discover_items column on `d`. */
  match(terms: readonly string[]): Match;
  /**
   * The engine's own fast path for an unfiltered search (scope only): the best `perClass`
   * matches of each source class, best first, with their listings. Without one, the store
   * ranks with a window function over `match`.
   */
  top?(terms: readonly string[], scopes: readonly string[], classes: readonly string[], perClass: number): Promise<Array<{ id: string; source_class: string; entry: unknown }>>;
  /** Statements run once after migrating (optional extensions); failures are ignored. */
  readonly optional?: readonly string[];
}

export interface Adapter extends Driver, Dialect {}

/** Words a full-text query can carry on both engines: lowercase letters and digits, nothing an engine reads as syntax. */
export function searchTerms(words: readonly string[]): string[] {
  const terms = words.flatMap((w) => w.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length > 0);
  return [...new Set(terms)].slice(0, 64);
}

/** `?` placeholders, as Postgres numbers them (`$1`, `$2`…). The store's SQL never has a `?` inside a literal. */
export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** One write at a time per store: a transaction never interleaves with another caller's statements. */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** Bounded SQL paging integers, including untrusted JSON numbers. */
export function pageInteger(value: number | undefined, fallback: number, max = 500): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  const bounded = Math.max(0, Math.min(max, Math.floor(value)));
  return Number.isSafeInteger(bounded) ? bounded : fallback;
}
