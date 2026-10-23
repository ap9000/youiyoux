/**
 * Every request Discover makes goes through one polite client: a global and a per-host
 * concurrency cap, a timeout on each request, conditional requests (ETag and
 * If-Modified-Since, a 304 reuses the cached body) and rate buckets that refuse rather
 * than wait when a budget is spent; npm 429s get bounded Retry-After backoff. The network itself is one injected `Fetcher`, so tests
 * replay recorded responses and never reach the network.
 *
 * A GitHub token is only ever put in the Authorization header of api.github.com requests:
 * it is never cached, written or logged, and any message that could carry it is redacted.
 */
import { slimResponse } from "./store.ts";
import { publicHttps } from "./urls.ts";
import { cleanText } from "./text.ts";
import { sha256 } from "@youiyoux/core";

export interface FetchInit {
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

/** The one network seam: Node's fetch in production, recorded fixtures in tests. */
export type Fetcher = (url: string, init: FetchInit) => Promise<Response>;

export const nodeFetcher: Fetcher = async (url, init) => {
  const headers = { ...init.headers };
  for (let hop = 0; hop <= 5; hop++) {
    if (!publicHttps(url)) throw new Error("URL must use https on a public host");
    const response = await fetch(url, { headers, signal: init.signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("redirect missing location");
    const next = new URL(location, url);
    if (!publicHttps(next.href)) throw new Error("redirect must use https on a public host");
    if (next.origin !== new URL(url).origin) delete headers.authorization;
    url = next.href;
  }
  throw new Error("too many redirects");
};

/** Registry validators and successful npm responses (reused for 24 hours). */
export interface CachedResponse {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly body: string;
}

export type HttpFailure = "timeout" | "http" | "network" | "rate-limited";

export type HttpResult =
  | { readonly ok: true; readonly url: string; readonly status: number; readonly body: string; readonly sha256: string; readonly fetchedAt: string; readonly revalidated: boolean; readonly headers: Headers }
  | { readonly ok: false; readonly url: string; readonly status: number | null; readonly reason: HttpFailure; readonly message: string; readonly retryAfterMs?: number };

export interface RateBucket {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface PoliteOptions {
  readonly fetcher?: Fetcher;
  /** Requests in flight at once, across hosts. */
  readonly concurrency?: number;
  /** Requests in flight at once to one host. */
  readonly perHost?: number;
  readonly timeoutMs?: number;
  /** Named budgets; githubBucketFor picks one per URL (none: only the concurrency caps apply). */
  readonly buckets?: Readonly<Record<string, RateBucket>>;
  /** GITHUB_TOKEN, read from the environment by the caller; sent to api.github.com only. */
  readonly token?: string;
  readonly cache?: Map<string, CachedResponse>;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HttpStats {
  sent: number;
  revalidated: number;
  cached: number;
  failed: number;
  rateLimited: number;
  maxInFlight: number;
}

const USER_AGENT = "youiyoux-discover/0.1 (+youiyoux discover sync)";

/** GitHub: 10 searches a minute and 60 calls an hour without a token; far more with one. */
export function githubBuckets(token: string | undefined): Record<string, RateBucket> {
  return token
    ? { "github-search": { limit: 30, windowMs: 60_000 }, "github-core": { limit: 1000, windowMs: 3_600_000 } }
    : { "github-search": { limit: 10, windowMs: 60_000 }, "github-core": { limit: 60, windowMs: 3_600_000 } };
}

export function githubBucketFor(url: URL): string | null {
  if (url.hostname !== "api.github.com") return null;
  return url.pathname.startsWith("/search/") ? "github-search" : "github-core";
}

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resume) => this.waiting.push(resume));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export class PoliteClient {
  readonly warnings: string[] = [];
  private readonly npmGate = new Gate(1);
  readonly stats: HttpStats = { sent: 0, revalidated: 0, cached: 0, failed: 0, rateLimited: 0, maxInFlight: 0 };
  readonly cache: Map<string, CachedResponse>;
  private readonly fetcher: Fetcher;
  private readonly gate: Gate;
  private readonly hosts = new Map<string, Gate>();
  private readonly used = new Map<string, number[]>();
  private readonly spent = new Set<string>();
  private readonly options: PoliteOptions;
  private inFlight = 0;
  private npmStarted = false;

  constructor(options: PoliteOptions = {}) {
    this.options = { ...options, buckets: { npm: { limit: 120, windowMs: 60_000 }, ...options.buckets } };
    this.fetcher = options.fetcher ?? nodeFetcher;
    this.cache = options.cache ?? new Map();
    this.gate = new Gate(options.concurrency ?? 6);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Replace the token wherever it appears, so no message, log line or file can carry it. */
  redact(text: string): string {
    const token = this.options.token;
    return cleanText(token ? text.split(token).join("***") : text);
  }

  /** True when the bucket still has room in its window; a spent bucket stays spent for this run. */
  private take(bucket: string | null): boolean {
    if (bucket === null) return true;
    if (this.spent.has(bucket)) return false;
    const spec = this.options.buckets?.[bucket];
    if (!spec) return true;
    const at = this.now().getTime();
    const recent = (this.used.get(bucket) ?? []).filter((t) => at - t < spec.windowMs);
    if (recent.length >= spec.limit) {
      this.used.set(bucket, recent);
      return false;
    }
    recent.push(at);
    this.used.set(bucket, recent);
    return true;
  }

  /** Mark a bucket spent for the rest of the run (the server said so: 403/429 or no calls remaining). */
  exhaust(bucket: string): void {
    this.spent.add(bucket);
  }

  hasBudget(bucket: string): boolean {
    if (this.spent.has(bucket)) return false;
    const spec = this.options.buckets?.[bucket];
    if (!spec) return true;
    const at = this.now().getTime();
    return (this.used.get(bucket) ?? []).filter((t) => at - t < spec.windowMs).length < spec.limit;
  }

  async get(url: string, accept = "application/json"): Promise<HttpResult> {
    if (!publicHttps(url)) return { ok: false, url, status: null, reason: "network", message: "not a valid URL" };
    const parsed = new URL(url);
    const npm = ["registry.npmjs.org", "api.npmjs.org"].includes(parsed.hostname);
    const cached = this.cache.get(url);
    if (npm && cached && this.now().getTime() - Date.parse(cached.fetchedAt) < 86_400_000) {
      this.stats.cached++;
      return { ok: true, url, status: 200, body: cached.body, sha256: cached.sha256, fetchedAt: cached.fetchedAt, revalidated: true, headers: new Headers() };
    }
    const bucket = npm ? "npm" : githubBucketFor(parsed);
    let host = this.hosts.get(parsed.host);
    if (!host) this.hosts.set(parsed.host, (host = new Gate(this.options.perHost ?? 2)));
    const gate = host;
    const request = () => this.gate.run(() =>
      gate.run(async () => {
        if (npm && this.npmStarted) await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(500);
        if (npm) this.npmStarted = true;
        if (!this.take(bucket)) {
          this.stats.rateLimited++;
          return { ok: false, url, status: null, reason: "rate-limited", message: `rate budget ${bucket} spent for this run` } as const;
        }
        for (let attempt = 0; ; attempt++) {
          const result = await this.send(url, parsed, bucket, accept);
          if (!npm || result.ok || result.status !== 429) return result;
          if (attempt === 4) return result;
          await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.max(result.retryAfterMs ?? 0, Math.min(30_000, 1000 * 2 ** attempt * (0.5 + (this.options.random ?? Math.random)()))));
        }
      }),
    );
    return npm ? this.npmGate.run(request) : request();
  }

  private async send(url: string, parsed: URL, bucket: string | null, accept: string): Promise<HttpResult> {
    const cached = this.cache.get(url);
    const headers: Record<string, string> = { accept, "user-agent": USER_AGENT };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
    if (this.options.token && parsed.hostname === "api.github.com") headers.authorization = `Bearer ${this.options.token}`;
    this.stats.sent++;
    this.inFlight++;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.inFlight);
    // A timer of our own rather than AbortSignal.timeout, whose unref'd timer may never fire in a process with nothing else to do.
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`timed out after ${timeoutMs} ms`, "TimeoutError")), timeoutMs);
    try {
      const response = await this.fetcher(url, { headers, signal: controller.signal });
      if (response.url && !publicHttps(response.url)) { await response.body?.cancel(); throw new Error("redirect must use https on a public host"); }
      if (bucket && bucket !== "npm" && (response.headers.get("x-ratelimit-remaining") === "0" || ((response.status === 403 || response.status === 429) && response.headers.has("x-ratelimit-limit")))) this.exhaust(bucket);
      const fetchedAt = this.now().toISOString();
      if (response.status === 304 && cached) {
        await response.body?.cancel();
        this.stats.revalidated++;
        this.cache.set(url, { ...cached, fetchedAt });
        return { ok: true, url, status: 304, body: cached.body, sha256: cached.sha256, fetchedAt, revalidated: true, headers: response.headers };
      }
      const body = await response.text();
      if (this.options.token && parsed.hostname === "api.github.com" && (response.status === 401 || (response.status === 403 && /bad credentials/i.test(body)))) {
        this.exhaust("github-core");
        this.exhaust("github-search");
        const warning = "GitHub token rejected; licences stay unknown";
        if (!this.warnings.includes(warning)) this.warnings.push(warning);
      }
      if (!response.ok) {
        this.stats.failed++;
        const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
        return { ok: false, url, status: response.status, reason: limited ? "rate-limited" : "http", message: `HTTP ${response.status}`, ...(response.status === 429 ? { retryAfterMs: retryAfter(response.headers.get("retry-after"), this.now()) } : {}) };
      }
      const digest = sha256(body);
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      this.cache.set(url, { etag, lastModified, fetchedAt, sha256: digest, body });
      return { ok: true, url, status: response.status, body, sha256: digest, fetchedAt, revalidated: false, headers: response.headers };
    } catch (error: unknown) {
      this.stats.failed++;
      const name = error instanceof Error ? error.name : "";
      const timeout = name === "TimeoutError" || name === "AbortError";
      return { ok: false, url, status: null, reason: timeout ? "timeout" : "network", message: this.redact(timeout ? `timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error)) };
    } finally {
      clearTimeout(timer);
      this.inFlight--;
    }
  }

  /** GET and parse JSON; a body that is not JSON is a failure of its own (an HTML error page, a login wall). */
  async json(url: string, metadata = true): Promise<{ ok: true; value: unknown; result: Extract<HttpResult, { ok: true }> } | { ok: false; reason: HttpFailure | "not-json"; status: number | null; message: string }> {
    const result = await this.get(url);
    if (!result.ok) return { ok: false, reason: result.reason, status: result.status, message: result.message };
    try {
      const value = metadata ? slimResponse(url, result.body) : JSON.parse(result.body) as unknown;
      const body = JSON.stringify(value);
      const cached = this.cache.get(url);
      if (cached) this.cache.set(url, { ...cached, body, sha256: sha256(body) });
      return { ok: true, value, result: { ...result, body } };
    } catch {
      this.cache.delete(url);
      return { ok: false, reason: "not-json", status: result.status, message: `not JSON (${result.headers.get("content-type") ?? "no content type"})` };
    }
  }
}

function retryAfter(value: string | null, now: Date): number {
  if (!value) return 1000;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now.getTime();
  return Number.isFinite(delay) ? Math.max(0, delay) : 1000;
}
