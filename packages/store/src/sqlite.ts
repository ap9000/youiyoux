/**
 * The local engine: node:sqlite (Node 24), one file, WAL so a reader (the MCP server, the
 * hub) never waits on a writer. Search is FTS5 (`porter unicode61`), kept in step with the
 * listings by triggers and ranked by bm25. The file is a cache: VACUUM is never run (it could
 * renumber the rowids the full-text index points at); `youi index rebuild` makes a new one.
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { Lock, searchTerms, type Adapter, type Param } from "./driver.ts";
import { SqlStore } from "./store.ts";

const STATEMENT_CACHE = 200;

/** Words as an FTS5 OR-list, each quoted, so FTS5 reads it as a plain token, never as syntax. */
const words = (terms: readonly string[]): string => searchTerms(terms).map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");

export function sqliteAdapter(path: string, options: { readOnly?: boolean } = {}): Adapter {
  if (!options.readOnly && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000, readOnly: options.readOnly ?? false });
  if (!options.readOnly) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      if (statements.size >= STATEMENT_CACHE) statements.delete(statements.keys().next().value!);
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const values = (params: readonly Param[]): SQLInputValue[] => params as SQLInputValue[];
  return {
    engine: "sqlite",
    location: path,
    json: "TEXT",
    begin: "BEGIN IMMEDIATE",
    searchDdl: [
      // The listing's words, and its scope and source class as tag words (`schosen ccommunity`),
      // so an unfiltered search ranks inside the index alone. Kept in step by rowid.
      `CREATE VIRTUAL TABLE IF NOT EXISTS discover_fts USING fts5(search_text, tags, tokenize='porter unicode61')`,
      `CREATE TRIGGER IF NOT EXISTS discover_items_ai AFTER INSERT ON discover_items BEGIN
         INSERT INTO discover_fts (rowid, search_text, tags) VALUES (new.rowid, new.search_text, 's' || new.scope || ' c' || new.source_class);
       END`,
      `CREATE TRIGGER IF NOT EXISTS discover_items_ad AFTER DELETE ON discover_items BEGIN
         DELETE FROM discover_fts WHERE rowid = old.rowid;
       END`,
      `CREATE TRIGGER IF NOT EXISTS discover_items_au AFTER UPDATE ON discover_items BEGIN
         DELETE FROM discover_fts WHERE rowid = old.rowid;
         INSERT INTO discover_fts (rowid, search_text, tags) VALUES (new.rowid, new.search_text, 's' || new.scope || ' c' || new.source_class);
       END`,
    ],
    match: (terms) => ({
      from: `discover_fts JOIN discover_items d ON d.rowid = discover_fts.rowid`,
      where: searchTerms(terms).length ? `discover_fts MATCH ?` : `0 = 1 AND ? = ?`,
      whereParams: searchTerms(terms).length ? [`search_text : (${words(terms)})`] : [0, 1],
      rank: `bm25(discover_fts)`,
      rankParams: [],
    }),
    // One query per source class: the tag words narrow it, bm25 ranks only that class's matches, LIMIT keeps the best.
    top: async (terms, scopes, classes, perClass) => {
      if (!searchTerms(terms).length) return [];
      const statement = prepare(`SELECT d.id, d.source_class, d.entry FROM (SELECT rowid AS rid, bm25(discover_fts) AS r FROM discover_fts WHERE discover_fts MATCH ? ORDER BY r LIMIT ?) m JOIN discover_items d ON d.rowid = m.rid ORDER BY m.r, d.id`);
      const scope = words(scopes.map((s) => `s${s}`));
      return classes.flatMap((c) => statement.all(`search_text : (${words(terms)}) AND tags : (${scope}) AND tags : ${words([`c${c}`])}`, perClass) as Array<{ id: string; source_class: string; entry: unknown }>);
    },
    all: async <T>(sql: string, params: readonly Param[] = []) => prepare(sql).all(...values(params)) as T[],
    run: async (sql, params = []) => {
      prepare(sql).run(...values(params));
    },
    exec: async (script) => db.exec(script),
    close: async () => {
      statements.clear();
      if (db.isOpen) db.close();
    },
  };
}

/** A SQLite store at `path` (`:memory:` for one that lives only as long as the process), migrated. */
export async function openSqlite(path: string, options: { readOnly?: boolean } = {}): Promise<SqlStore> {
  const connect = async () => {
    const store = new SqlStore(sqliteAdapter(path, options));
    try {
      if (options.readOnly) await store.checkSchema();
      else await store.migrate();
      return store;
    } catch (error) { await store.close(); throw error; }
  };
  const identity = () => { const s = statSync(path); return `${s.dev}:${s.ino}`; };
  // Capture the name before opening: if a rebuild races the open, the next call
  // must still notice the replacement rather than label an old handle with its inode.
  let inode: string | null = null;
  if (path !== ":memory:") {
    try { inode = identity(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let current = await connect();
  if (path === ":memory:") return current;
  inode ??= identity();
  let generation = await current.meta("generation");
  let checked = Date.now();
  let closed = false;
  const lock = new Lock();
  // Keep the public handle valid across atomic replacement, including callers retaining it.
  return new Proxy(current, {
    get(_target, key) {
      const value = Reflect.get(current, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => lock.run(async () => {
        if (key === "close") { closed = true; return current.close(); }
        if (closed) throw new Error("Store is closed");
        const next = identity();
        const now = Date.now();
        const nextGeneration = next === inode && now - checked >= 100 ? await current.meta("generation") : generation;
        if (next !== inode || nextGeneration !== generation) {
          await current.close();
          const openingInode = identity();
          current = await connect();
          inode = openingInode;
          generation = await current.meta("generation");
        }
        if (now - checked >= 100) checked = now;
        return Reflect.apply(Reflect.get(current, key), current, args);
      });
    },
  });
}

/** Seal a replacement file before publishing it; no WAL contents remain outside the file. */
export function checkpointSqlite(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(result?.busy ?? 0)) throw new Error("Index checkpoint is busy; retry rebuild");
  } finally { db.close(); }
}
