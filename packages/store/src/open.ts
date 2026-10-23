/** Where the store lives, and opening it: Postgres when DATABASE_URL is set, else a local SQLite file. */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openPostgres, redactUrl } from "./postgres.ts";
import { openSqlite } from "./sqlite.ts";
import type { Store } from "./types.ts";

export const INDEX_FILE = "index.db";

/** YOUI_INDEX, else `$XDG_CACHE_HOME/youiyoux/index.db` (default `~/.cache`). */
export function defaultIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.YOUI_INDEX) return env.YOUI_INDEX;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "youiyoux", INDEX_FILE);
}

/** The directory beside the store, where what it is rebuilt from is logged (scans.jsonl, index-sources.json). */
export function indexHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return path === ":memory:" ? dirname(defaultIndexPath(env)) : dirname(path);
}

export interface OpenOptions {
  readonly readOnly?: boolean;
  /** A SQLite file; ignored when DATABASE_URL is set. */
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Where `openStore` would open, for messages: a file path, or the redacted Postgres URL. */
export function storeLocation(options: OpenOptions = {}): string {
  const env = options.env ?? process.env;
  return env.DATABASE_URL ? redactUrl(env.DATABASE_URL) : (options.path ?? defaultIndexPath(env));
}

export async function openStore(options: OpenOptions = {}): Promise<Store> {
  const env = options.env ?? process.env;
  if (env.DATABASE_URL) return openPostgres(env.DATABASE_URL, options);
  return openSqlite(options.path ?? defaultIndexPath(env), options);
}
