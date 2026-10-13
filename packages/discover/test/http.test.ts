import { describe, expect, test } from "vitest";
import { githubBucketFor, githubBuckets, PoliteClient, type Fetcher } from "../src/index.ts";

const TOKEN = "ghp_fixtureTOKEN0123456789abcdefABCDEF";

function recorder(answer: (url: string, headers: Record<string, string>) => Response | Promise<Response>, delayMs = 0): { fetcher: Fetcher; seen: Array<{ url: string; headers: Record<string, string> }>; max: () => number } {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let inFlight = 0;
  let max = 0;
  const fetcher: Fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers });
    inFlight++;
    max = Math.max(max, inFlight);
    try {
      if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
      return await answer(url, init.headers);
    } finally {
      inFlight--;
    }
  };
  return { fetcher, seen, max: () => max };
}

describe("PoliteClient", () => {
  test("never has more requests in flight than its caps, overall and per host", async () => {
    const r = recorder(() => new Response("{}"), 10);
    const client = new PoliteClient({ fetcher: r.fetcher, concurrency: 3, perHost: 2 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.get(`https://host${i % 4}.test/x${i}`)));
    expect(r.seen).toHaveLength(12);
    expect(r.max()).toBeLessThanOrEqual(3);
    expect(client.stats.maxInFlight).toBeLessThanOrEqual(3);

    const one = recorder(() => new Response("{}"), 10);
    const sameHost = new PoliteClient({ fetcher: one.fetcher, concurrency: 6, perHost: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => sameHost.get(`https://one.test/${i}`)));
    expect(one.max()).toBe(2);
  });

  test("a request that does not answer in time fails as a timeout", async () => {
    const hang: Fetcher = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const client = new PoliteClient({ fetcher: hang, timeoutMs: 30 });
    const result = await client.get("https://slow.test/r/registry.json");
    expect(result).toMatchObject({ ok: false, reason: "timeout", status: null });
  });

  test("revalidates with ETag and If-Modified-Since, and a 304 reuses the cached body", async () => {
    const r = recorder((_url, headers) => (headers["if-none-match"] === '"v1"' ? new Response(null, { status: 304 }) : new Response('{"items":[]}', { headers: { etag: '"v1"', "last-modified": "Mon, 12 Oct 2026 00:00:00 GMT" } })));
    const client = new PoliteClient({ fetcher: r.fetcher });
    const first = await client.get("https://reg.test/r/registry.json");
    const second = await client.get("https://reg.test/r/registry.json");
    expect(r.seen[0]!.headers).not.toHaveProperty("if-none-match");
    expect(r.seen[1]!.headers).toMatchObject({ "if-none-match": '"v1"', "if-modified-since": "Mon, 12 Oct 2026 00:00:00 GMT" });
    expect(first).toMatchObject({ ok: true, revalidated: false });
    expect(second).toMatchObject({ ok: true, status: 304, revalidated: true, body: '{"items":[]}' });
    expect(client.stats.revalidated).toBe(1);
  });

  test("an answer that is not JSON fails on its own, and is not kept", async () => {
    const r = recorder(() => new Response("<!doctype html>", { headers: { "content-type": "text/html", etag: '"x"' } }));
    const client = new PoliteClient({ fetcher: r.fetcher });
    expect(await client.json("https://html.test/r/registry.json")).toMatchObject({ ok: false, reason: "not-json" });
    expect(client.cache.size).toBe(0);
  });

  test("GitHub budgets: 10 searches and 60 calls without a token; a spent bucket refuses without asking", async () => {
    expect(githubBuckets(undefined)).toEqual({ "github-search": { limit: 10, windowMs: 60_000 }, "github-core": { limit: 60, windowMs: 3_600_000 } });
    const r = recorder(() => new Response("{}"));
    const client = new PoliteClient({ fetcher: r.fetcher, buckets: githubBuckets(undefined), bucketFor: githubBucketFor, concurrency: 1 });
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await client.get(`https://api.github.com/search/repositories?q=r${i}`));
    expect(results.filter((x) => x.ok)).toHaveLength(10);
    expect(results.slice(10).every((x) => !x.ok && x.reason === "rate-limited")).toBe(true);
    expect(r.seen).toHaveLength(10);
    expect(await client.get("https://registry.npmjs.org/cmdk/latest")).toMatchObject({ ok: true });
  });

  test("the server's own word spends a bucket: no calls remaining stops further calls this run", async () => {
    const r = recorder(() => new Response("{}", { headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" } }));
    const client = new PoliteClient({ fetcher: r.fetcher, buckets: githubBuckets(undefined), bucketFor: githubBucketFor });
    await client.get("https://api.github.com/repos/a/b");
    expect(await client.get("https://api.github.com/repos/c/d")).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(r.seen).toHaveLength(1);
  });

  test("GITHUB_TOKEN goes to api.github.com only, and never into a message", async () => {
    const r = recorder((url) => {
      if (url.includes("explode")) throw new Error(`socket closed while sending authorization: Bearer ${TOKEN}`);
      return new Response("{}");
    });
    const client = new PoliteClient({ fetcher: r.fetcher, token: TOKEN });
    await client.get("https://api.github.com/repos/dip/cmdk");
    await client.get("https://registry.npmjs.org/cmdk/latest");
    const failed = await client.get("https://api.github.com/explode");
    expect(r.seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.seen[1]!.headers).not.toHaveProperty("authorization");
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(JSON.stringify([...client.cache])).not.toContain(TOKEN);
  });
});

test("npm honours Retry-After with jitter, survives three 429s, and paces later lookups", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new PoliteClient({ random: () => 0.75, sleep: async (ms) => { sleeps.push(ms); }, fetcher: async () => ++calls <= 3 ? new Response("limited", { status: 429, headers: { "retry-after": "2" } }) : new Response('{"downloads":123}') });
  expect(await client.json("https://api.npmjs.org/downloads/point/last-week/cmdk")).toMatchObject({ ok: true, value: { downloads: 123 } });
  expect(sleeps).toEqual([2000, 2500, 5000]);
  expect(client.hasBudget("npm")).toBe(true);
  expect(await client.json("https://registry.npmjs.org/sonner/latest")).toMatchObject({ ok: true });
  expect(sleeps.at(-1)).toBe(500);
  expect(calls).toBe(5);
});

test("npm failed retries do not spend the bucket and Retry-After dates are not shortened", async () => {
  const sleeps: number[] = [];
  let fail = true;
  const client = new PoliteClient({ now: () => new Date("2026-10-12T12:00:00Z"), random: () => 0, sleep: async (ms) => { sleeps.push(ms); }, fetcher: async () => fail ? new Response("limited", { status: 429, headers: { "retry-after": "Mon, 12 Oct 2026 12:01:00 GMT", "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" } }) : new Response("{}") });
  expect(await client.get("https://registry.npmjs.org/cmdk/latest")).toMatchObject({ ok: false, reason: "rate-limited" });
  expect(sleeps).toEqual([60000, 60000, 60000, 60000]);
  expect(client.cache.size).toBe(0);
  expect(client.hasBudget("npm")).toBe(true);
  fail = false;
  expect(await client.get("https://registry.npmjs.org/sonner/latest")).toMatchObject({ ok: true });
});

test("npm hosts share a budget and cache successful searches without validators", async () => {
  const client = new PoliteClient({ buckets: { npm: { limit: 2, windowMs: 60000 } }, fetcher: async () => new Response('{"objects":[]}') });
  await client.json("https://registry.npmjs.org/-/v1/search?text=command");
  await client.json("https://registry.npmjs.org/-/v1/search?text=command");
  await client.json("https://api.npmjs.org/downloads/point/last-week/cmdk");
  expect(client.stats.sent).toBe(2);
  expect(await client.get("https://registry.npmjs.org/sonner/latest")).toMatchObject({ ok: false, reason: "rate-limited" });
});

test.each([401, 403])("rejected GitHub token (%s) reports once and stops both buckets", async (status) => {
  const client = new PoliteClient({ token: TOKEN, fetcher: async () => new Response('{"message":"Bad credentials"}', { status }) });
  await client.get("https://api.github.com/repos/a/b");
  await client.get("https://api.github.com/search/repositories?q=a");
  await client.get("https://api.github.com/repos/c/d");
  expect(client.warnings).toEqual(["GitHub token rejected; licences stay unknown"]);
  expect(client.stats.sent).toBe(1);
  expect(JSON.stringify(client.warnings)).not.toContain(TOKEN);
});

test("unsafe request and final redirect hosts are refused", async () => {
  const r = recorder(() => {
    const response = new Response("{}");
    Object.defineProperty(response, "url", { value: "http://127.0.0.1/private" });
    return response;
  });
  const client = new PoliteClient({ fetcher: r.fetcher });
  for (const url of ["http://public.test", "https://localhost/x", "https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254", "https://[::1]", "https://[fc00::1]", "https://host.internal", "https://host.local"]) expect((await client.get(url)).ok).toBe(false);
  expect(r.seen).toHaveLength(0);
  expect(await client.get("https://public.test")).toMatchObject({ ok: false, message: "redirect must use https on a public host" });
});
