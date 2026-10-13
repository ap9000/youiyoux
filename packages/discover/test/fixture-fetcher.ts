/** Replays recorded responses (fixtures/http/manifest.json): no test ever reaches the network. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetcher } from "../src/index.ts";

interface Recorded {
  readonly url?: string;
  readonly prefix?: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly inline?: string;
  /** timeout: never answers, so the client's timeout fires. */
  readonly behavior?: "timeout";
}

const DIR = join(import.meta.dirname, "fixtures/http");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { responses: Recorded[] };

export interface FixtureRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly at: number;
}

export interface FixtureFetcher {
  readonly fetcher: Fetcher;
  readonly requests: FixtureRequest[];
  /** Most requests in flight at once, as the fetcher saw them. */
  readonly maxInFlight: () => number;
}

/** `delayMs` keeps each answer in flight a moment, so the concurrency cap is actually exercised. */
export function fixtureFetcher(options: { delayMs?: number; override?: (url: string) => Recorded | undefined } = {}): FixtureFetcher {
  const requests: FixtureRequest[] = [];
  let inFlight = 0;
  let max = 0;
  const fetcher: Fetcher = async (url, init) => {
    requests.push({ url, headers: { ...init.headers }, at: Date.now() });
    inFlight++;
    max = Math.max(max, inFlight);
    try {
      const recorded = options.override?.(url) ?? manifest.responses.find((r) => r.url === url) ?? manifest.responses.find((r) => r.prefix && url.startsWith(r.prefix));
      if (recorded?.behavior === "timeout") {
        return await new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
      if (!recorded) return new Response("not recorded", { status: 404, headers: { "content-type": "text/plain" } });
      const headers = recorded.headers ?? {};
      if (headers.etag && init.headers["if-none-match"] === headers.etag) return new Response(null, { status: 304, headers: { etag: headers.etag } });
      if (!headers.etag && headers["last-modified"] && init.headers["if-modified-since"] === headers["last-modified"]) return new Response(null, { status: 304, headers });
      const body = recorded.inline ?? readFileSync(join(DIR, recorded.body!), "utf8");
      return new Response(body, { status: recorded.status ?? 200, headers });
    } finally {
      inFlight--;
    }
  };
  return { fetcher, requests, maxInFlight: () => max };
}
