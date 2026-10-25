/**
 * Every registry, on the hub's own server: Discover's switch from your sources to every registry
 * in shadcn's directory. The listings are what `youiyoux discover "<need>" --all` fetches (each
 * healthy registry's registry.json, cache-first, through Discover's polite client: names,
 * descriptions and file lists, never an item's code), kept apart from your sources' and loaded
 * into the local index, so `kind=discover&all=1` searches them.
 *
 *   GET  /__youi/discover-every  { state, done, total, listings, failed, fetchedAt, error }
 *   POST /__youi/discover-every  starts the fetch (one at a time; a second POST joins it) and
 *                                answers the same, 202
 *
 * `state` is none (never fetched), running, ready or failed. Only a request whose Host is this
 * machine is answered, and a POST only from the hub's own page: an Origin that is not this machine
 * (a sandboxed frame's `null` included) or `Sec-Fetch-Site: cross-site` is refused, so another
 * site the person has open cannot make the hub fetch. A static host has no such endpoint.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { loadPackage } from "./packages.ts";
import { isHubHost, isHubOrigin, NOT_THIS_HOST, send } from "./query-server.ts";

export const EVERY_PATH = "/__youi/discover-every";
/** One registry request. */
const FETCH_TIMEOUT_MS = 15_000;

type Discover = typeof import("../../../packages/discover/src/index.ts");

export interface EveryStatus {
  readonly state: "none" | "running" | "ready" | "failed";
  /** Registries asked so far, of `total`. */
  readonly done: number;
  readonly total: number;
  /** Listings the last fetch added; null before one finished in this server's life. */
  readonly listings: number | null;
  /** Registries that did not answer with a listing. */
  readonly failed: number;
  /** When the listings on this machine were last written; null when there are none. */
  readonly fetchedAt: string | null;
  readonly error: string | null;
}

export interface EveryOptions {
  /** The Discover cache (default: discoverCacheDir, YOUI_DISCOVER_CACHE). */
  readonly cache?: string;
  /** The local index (default: discoverIndexPath, YOUI_INDEX). */
  readonly index?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Tests: the network. */
  readonly fetcher?: import("../../../packages/discover/src/index.ts").Fetcher;
  /** Tests: the discover package. */
  readonly load?: () => Promise<Discover>;
}

/** The /__youi/discover-every endpoint, as connect middleware under the hub's `base`. */
export function discoverEveryMiddleware(base = "/", options: EveryOptions = {}) {
  const env = options.env ?? process.env;
  let discover: Promise<Discover> | null = null;
  const loaded = () => (discover ??= (options.load ?? (() => loadPackage<Discover>("discover")))());
  let job: { done: number; total: number; listings: number | null; failed: number; error: string | null; running: boolean } | null = null;

  const paths = async (): Promise<{ d: Discover; cache: string; index: string }> => {
    const d = await loaded();
    return { d, cache: resolve(options.cache ?? d.discoverCacheDir(undefined, env)), index: options.index ?? d.discoverIndexPath(undefined, env) };
  };

  async function status(): Promise<EveryStatus> {
    const { d, cache } = await paths();
    const fetchedAt = await stat(join(cache, d.ALL_INDEX_FILE)).then((s) => s.mtime.toISOString(), () => null);
    if (job?.running) return { state: "running", done: job.done, total: job.total, listings: null, failed: job.failed, fetchedAt, error: null };
    if (job?.error) return { state: "failed", done: job.done, total: job.total, listings: null, failed: job.failed, fetchedAt, error: job.error };
    return { state: fetchedAt ? "ready" : "none", done: job?.done ?? 0, total: job?.total ?? 0, listings: job?.listings ?? null, failed: job?.failed ?? 0, fetchedAt, error: null };
  }

  /** False when there is no Discover index to add to yet. */
  async function start(): Promise<boolean> {
    if (job?.running) return true;
    const { d, cache, index } = await paths();
    if (!existsSync(join(cache, d.INDEX_FILE))) return false;
    const current = { done: 0, total: 0, listings: null as number | null, failed: 0, error: null as string | null, running: true };
    job = current;
    void (async () => {
      try {
        const result = await d.expandAll(cache, { timeoutMs: FETCH_TIMEOUT_MS, ...(options.fetcher ? { fetcher: options.fetcher } : {}), onProgress: (done, total) => ((current.done = done), (current.total = total)) });
        // Into the local index, kept apart from your sources' listings: what kind=discover&all=1 reads.
        await d.ingestCatalog(await d.sharedStore(index, env), cache, "all");
        current.listings = result.listings;
        current.failed = result.failed;
      } catch (error: unknown) {
        current.error = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
      } finally {
        current.running = false;
      }
    })();
    return true;
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL((req.url ?? "/").replace(base, "/"), "http://hub.local");
    if (url.pathname !== EVERY_PATH) return next();
    if (!isHubHost(req.headers.host, env)) return send(res, 403, { error: `Every registry answers this machine only (${NOT_THIS_HOST}).` });
    try {
      if (req.method === "GET") return send(res, 200, await status());
      if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
      const origin = req.headers.origin;
      if (req.headers["sec-fetch-site"] === "cross-site" || (origin !== undefined && !isHubOrigin(origin, env))) return send(res, 403, { error: "Only the hub's own page can fetch every registry." });
      if (!(await start())) return send(res, 404, { error: "There is no Discover index on this machine yet: run youiyoux discover sync." });
      send(res, 202, await status());
    } catch (error: unknown) {
      send(res, 500, { error: (error instanceof Error ? error.message : String(error)).split("\n")[0] });
    }
  };
}
