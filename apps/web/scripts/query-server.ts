/**
 * Paged queries over the local index (packages/store), on the hub's own server.
 *
 * The dev and preview servers (vite.config.ts) answer `GET /__youi/query?kind=<kind>&…` with
 * one page of JSON:
 *
 *   kind=discover  q (a need; without one, listings browse official first), role, source,
 *                  licence (SPDX ids, `unknown`, or `known` for any known licence), style
 *                  (headless|styled), all=1 (the --all listings too)
 *   kind=families  role, run (default: the newest inventory run)
 *   kind=looks     family, role, run
 *   kind=history   project
 *
 * and `limit` (at most 100) and `offset` on every kind. Answers are read-only and never cached.
 * Only a request whose Host is this machine (localhost, 127.0.0.1, [::1], any port), or a name
 * given to `youiyoux ui --allow-host`, is answered; any other is a 403, so a page on another site
 * cannot read the index through a rebound DNS name. The store is the same one the CLI uses (YOUI_INDEX, DATABASE_URL, …); it
 * is opened on the first request, never created by one. A static host has no such endpoint: the
 * hub's pages keep working from the snapshot's JSON chunks and never wait on this one.
 */
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { loadPackage } from "./packages.ts";

const QUERY_PATH = "/__youi/query";
const MAX_LIMIT = 100;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Discover = typeof import("../../../packages/discover/src/index.ts");

/** A JSON answer the browser never caches: what every hub endpoint sends. */
export const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

/** The Host header's name without its port: `localhost:5173` → `localhost`, `[::1]:5173` → `[::1]`. */
function hostName(host: string | undefined): string | null {
  if (!host) return null;
  const match = /^(\[[^\]]*\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return match ? match[1]! : null;
}

/** Where `youiyoux ui --allow-host` names the hosts the hub also answers to, comma-separated. */
export const ALLOW_HOSTS_ENV = "YOUI_ALLOW_HOSTS";
/** A plain host name: labels of letters, digits and hyphens joined by dots; no scheme, port or wildcard. */
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The names given to `youiyoux ui --allow-host` (YOUI_ALLOW_HOSTS); anything but a plain host name is ignored. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[ALLOW_HOSTS_ENV] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => HOST_NAME.test(name));
}

/** Whether the hub answers a request with this Host: this machine, or a name given to `youiyoux ui --allow-host`. */
export function isHubHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = hostName(host);
  return name !== null && (LOCAL_HOSTS.has(name) || allowedHosts(env).includes(name));
}

/** Whether an Origin is the hub's own page: http(s) on a host isHubHost answers. */
export function isHubOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin && isHubHost(url.host, env);
}

/** The 403 sentence for a request to a host the hub does not answer. */
export const NOT_THIS_HOST = "Host must be localhost, or a name given to youiyoux ui --allow-host";

export interface QueryOptions {
  /** The store's SQLite file (default: as the CLI, from YOUI_INDEX / YOUI_DISCOVER_CACHE / XDG_CACHE_HOME). */
  readonly index?: string;
  /** The Discover cache directory (default: as the CLI). */
  readonly cache?: string;
  readonly env?: NodeJS.ProcessEnv;
}

class NotFound extends Error {}

const list = (value: string | null): string[] | undefined => {
  const items = value?.split(",").map((v) => v.trim()).filter(Boolean);
  return items?.length ? items : undefined;
};

function page(params: URLSearchParams): { limit: number; offset: number } {
  const number = (name: string, fallback: number): number => {
    const n = Number(params.get(name) ?? fallback);
    return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
  };
  return { limit: Math.min(MAX_LIMIT, number("limit", 20)), offset: Math.min(2_147_483_647, number("offset", 0)) };
}

/** The /__youi/query endpoint, as connect middleware under the hub's `base`. */
export function queryMiddleware(options: QueryOptions = {}, base = "/", load: () => Promise<Discover> = () => loadPackage<Discover>("discover")) {
  let discover: Promise<Discover> | null = null;
  const loaded = () => (discover ??= load());
  const env = options.env ?? process.env;

  async function answer(kind: string, params: URLSearchParams): Promise<unknown> {
    const d = await loaded();
    const cache = resolve(options.cache ?? d.discoverCacheDir(undefined, env));
    const path = options.index ?? d.discoverIndexPath(undefined, env);
    const { limit, offset } = page(params);
    if (kind === "discover") {
      if (!existsSync(join(cache, d.INDEX_FILE))) throw new NotFound("no Discover index: run youiyoux discover sync");
      const store = await d.readCatalog(cache, path, env);
      const need = params.get("q")?.trim();
      const all = params.get("all") === "1";
      const role = params.get("role") ?? undefined;
      const licences = list(params.get("licence"));
      const sources = list(params.get("source"));
      const styles = list(params.get("style"))?.filter((s): s is "headless" | "styled" => s === "headless" || s === "styled");
      // `known` or `unknown` alone is a yes/no on the licence; anything else names SPDX ids.
      const known = licences?.length === 1 && (licences[0] === "known" || licences[0] === "unknown") ? licences[0] === "known" : undefined;
      if (need) {
        const licence = known !== undefined ? { licenseKnown: known } : licences ? { licenses: licences.filter((l) => l !== "unknown"), allowUnknownLicense: licences.includes("unknown") } : {};
        const result = await d.searchCatalog(store, need, { ...(role ? { role } : {}), constraints: { ...licence, ...(sources ? { registries: sources } : {}), ...(styles?.length ? { styles } : {}) }, all, limit, offset, facets: true });
        return { kind, limit, ...result, offset };
      }
      const concept = role ? d.conceptForRole(role) : undefined;
      const scope = { all, ...(role ? { roles: [concept?.id ?? role] } : {}), ...(sources ? { registries: sources } : {}), ...(styles?.length ? { styles } : {}) };
      // Any known licence: every licence the listings in scope hold but `unknown`.
      const held = known === true ? Object.keys((await store.discoverFacets({ ...scope, scopes: all ? ["chosen", "all"] : ["chosen"] })).licence).filter((l) => l !== "unknown") : [];
      if (known === true && held.length === 0) return { kind, limit, offset, total: 0, hits: [], facets: { role: {}, source: {}, licence: {}, style: {} }, indexBuiltAt: "", note: "" };
      const named = known === true ? held : known === false ? ["unknown"] : licences;
      return { kind, limit, ...(await d.browseCatalog(store, { ...scope, ...(named ? { licences: named } : {}) }, { limit, offset })) };
    }
    if (!env.DATABASE_URL && !existsSync(path)) throw new NotFound("no local index yet: run youiyoux inventory, youiyoux scan or youiyoux index rebuild");
    const store = await d.sharedStore(path, env, { readOnly: true });
    if (kind === "history") {
      const project = params.get("project") ?? undefined;
      const rows = await store.history({ ...(project ? { project } : {}), limit: limit + 1, offset });
      return { kind, limit, offset, more: rows.length > limit, rows: rows.slice(0, limit) };
    }
    const run = params.get("run") ?? undefined;
    const role = params.get("role") ?? undefined;
    if (kind === "families") return { kind, limit, offset, ...(await store.families({ ...(run ? { run } : {}), ...(role ? { role } : {}), limit, offset })) };
    if (kind === "looks") {
      const family = params.get("family") ?? undefined;
      return { kind, limit, offset, ...(await store.looks({ ...(run ? { run } : {}), ...(family ? { family } : {}), ...(role ? { role } : {}), limit, offset })) };
    }
    throw new NotFound(`unknown kind "${kind}": discover, families, looks or history`);
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL((req.url ?? "/").replace(base, "/"), "http://hub.local");
    if (url.pathname !== QUERY_PATH || req.method !== "GET") return next();
    if (!isHubHost(req.headers.host)) return send(res, 403, { error: `the index answers this machine only (${NOT_THIS_HOST})` });
    try {
      send(res, 200, await answer(url.searchParams.get("kind") ?? "", url.searchParams));
    } catch (error: unknown) {
      if (error instanceof NotFound) return send(res, 404, { error: error.message });
      send(res, 500, { error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  };
}
