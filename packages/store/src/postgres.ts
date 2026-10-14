/**
 * The hosted engine: Postgres, chosen by DATABASE_URL (node-postgres), and in tests PGlite,
 * the same Postgres in-process with no server. Search is a generated `tsvector` with a GIN
 * index, ranked by ts_rank, in the `youi` configuration: English snowball stemming, as FTS5's
 * porter, and no stop-word list, so the match is never narrower than the words asked for.
 * When pg_trgm is installed, a name that starts with a term also matches, through a trigram index.
 */
import { searchTerms, numbered, type Adapter, type Param } from "./driver.ts";
import { SqlStore } from "./store.ts";

/** What the adapter needs from a connection: node-postgres's Client and PGlite both fit. */
export interface PgConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

const TRIGRAM_TERMS = 8;

export function postgresAdapter(connection: PgConnection, location: string): Adapter & { trigram: boolean } {
  const adapter = {
    engine: "postgres" as const,
    location,
    json: "JSONB",
    begin: "BEGIN",
    trigram: false,
    searchDdl: [
      // English stemming like FTS5's porter, but no stop-word list, so no asked-for word is ever dropped.
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_ts_dict WHERE dictname = 'youi_stem') THEN
           CREATE TEXT SEARCH DICTIONARY youi_stem (TEMPLATE = snowball, Language = english);
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'youi') THEN
           CREATE TEXT SEARCH CONFIGURATION youi (COPY = simple);
           ALTER TEXT SEARCH CONFIGURATION youi ALTER MAPPING FOR asciiword, word, numword, asciihword, hword, numhword, hword_asciipart, hword_part, hword_numpart WITH youi_stem;
         END IF;
       END $$`,
      `ALTER TABLE discover_items ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('youi', search_text)) STORED`,
      `CREATE INDEX IF NOT EXISTS discover_items_search ON discover_items USING GIN (search_tsv)`,
    ],
    optional: [`CREATE EXTENSION IF NOT EXISTS pg_trgm`, `CREATE INDEX IF NOT EXISTS discover_items_name_trgm ON discover_items USING GIN (name gin_trgm_ops)`],
    match(terms: readonly string[]) {
      terms = searchTerms(terms);
      const query = terms.join(" | ");
      const prefixes = adapter.trigram ? terms.slice(0, TRIGRAM_TERMS).map((t) => `${t}%`) : [];
      return {
        from: `discover_items d`,
        where: prefixes.length ? `(d.search_tsv @@ to_tsquery('youi', ?) OR ${prefixes.map(() => "d.name ILIKE ? ESCAPE '!'").join(" OR ")})` : `d.search_tsv @@ to_tsquery('youi', ?)`,
        whereParams: [query, ...prefixes],
        rank: `-ts_rank(d.search_tsv, to_tsquery('youi', ?))`,
        rankParams: [query],
      };
    },
    all: async <T>(sql: string, params: readonly Param[] = []) => (await connection.query(numbered(sql), [...params])).rows as T[],
    run: async (sql: string, params: readonly Param[] = []) => {
      await connection.query(numbered(sql), [...params]);
    },
    exec: (script: string) => connection.exec(script),
    close: () => connection.close(),
  };
  return adapter;
}

async function openWith(connection: PgConnection, location: string, options: { readOnly?: boolean } = {}): Promise<SqlStore> {
  const adapter = postgresAdapter(connection, location);
  const store = new SqlStore(adapter);
  try {
    if (options.readOnly) {
      await connection.exec("SET default_transaction_read_only = on");
      await store.checkSchema();
    } else await store.migrate();
  } catch (error) { await store.close(); throw error; }
  adapter.trigram = (await adapter.all(`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`)).length > 0;
  return store;
}

/** The URL without its password, for messages and `youiyoux index path`. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "postgres://…";
  }
}

/** A store on a Postgres server (DATABASE_URL), migrated. */
export async function openPostgres(url: string, options: { readOnly?: boolean } = {}): Promise<SqlStore> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return openWith({ query: (sql, params) => client.query(sql, params), exec: async (script) => void (await client.query(script)), close: () => client.end() }, redactUrl(url), options);
}

/** A store on PGlite: Postgres in this process (a directory, or memory when none is given). For tests and measurement. */
export async function openPglite(dataDir?: string, options: { readOnly?: boolean } = {}): Promise<SqlStore> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return openWith({ query: (sql, params) => db.query(sql, params), exec: async (script) => void (await db.exec(script)), close: () => db.close() }, dataDir ? `pglite:${dataDir}` : "pglite:memory", options);
}
