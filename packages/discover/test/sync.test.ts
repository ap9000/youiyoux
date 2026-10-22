import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LibraryEntry } from "@youiyoux/core";
import { writeSources, discoverCacheDir, HEADLESS, implicitDeps, linkedRepos, parseDirectory, readIndex, sameHomepage, sameSite, spdxOrNull, syncIndex, type DiscoverIndex, type SignalsFile } from "../src/index.ts";
import { fixtureFetcher } from "./fixture-fetcher.ts";

const NOW = new Date("2026-10-12T12:00:00Z");
const TOKEN = "ghp_fixtureTOKEN0123456789abcdefABCDEF";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-discover-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sync(fixtures = fixtureFetcher({ delayMs: 3 }), at = NOW, extra: { token?: string } = {}) {
  const summary = await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: fixtures.fetcher, now: () => at, timeoutMs: 100, concurrency: 4, ...extra });
  return { summary, fixtures, index: (await readIndex(dir)) as DiscoverIndex };
}

describe("youiyoux discover sync", () => {
  test("indexes the official registry and healthy community registries, skipping and recording the rest", async () => {
    const { summary, index } = await sync();
    const refs = index.entries.map((e) => e.source.ref);
    expect(refs).toEqual(expect.arrayContaining(["@shadcn/command", "@shadcn/dialog", "@coss/command", "@kibo-ui/combobox", "@magicui/marquee", "@aceternity/spotlight"]));
    // Examples, styles, libs and fonts are not candidates.
    expect(refs).not.toContain("@shadcn/command-demo");
    expect(refs).not.toContain("@shadcn/utils");
    expect(refs.some((r) => r?.startsWith("@fixture-") || r?.startsWith("@amicro") || r?.startsWith("@abstract"))).toBe(false);

    const outcome = Object.fromEntries(index.sources.map((s) => [s.id, [s.outcome, s.reason]]));
    expect(outcome["@amicro"]).toEqual(["skipped", "unavailable in the registry directory"]);
    expect(outcome["@abstract"]).toEqual(["skipped", "hidden in the registry directory"]);
    for (const name of ["@fixture-500", "@fixture-timeout", "@fixture-html"]) expect(outcome[name]).toEqual(["skipped", "not selected"]);
    expect(outcome["@coss"]).toEqual(["fetched", null]);
    expect(summary.registries).toEqual({ listed: 9, fetched: 4, revalidated: 0, skipped: 5, failed: 0 });

    const health = JSON.parse(await readFile(join(dir, "health.json"), "utf8")) as { sources: Array<{ id: string; health: { status: string } | null }> };
    expect(health.sources.find((s) => s.id === "@aceternity")!.health!.status).toBe("degraded");
    expect(health.sources.find((s) => s.id === "@fixture-500")!.health!.status).toBe("healthy");
  });

  test("is polite: within its concurrency cap, never fetches skipped registries, and revalidates on the next sync", async () => {
    const first = await sync();
    expect(first.fixtures.maxInFlight()).toBeLessThanOrEqual(4);
    expect(first.summary.requests.maxInFlight).toBeLessThanOrEqual(4);
    expect(first.fixtures.requests.some((r) => /amicro|build\.abs\.xyz/.test(r.url))).toBe(false);
    for (const r of first.fixtures.requests) expect(r.headers["user-agent"]).toMatch(/^youiyoux-discover/);

    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await sync(fixtureFetcher(), later);
    const registry = second.fixtures.requests.find((r) => r.url === "https://coss.com/ui/r/registry.json")!;
    expect(registry.headers["if-none-match"]).toMatch(/^"fixture-/);
    expect(second.summary.registries.revalidated).toBe(4);
    expect(second.summary.requests.revalidated).toBeGreaterThanOrEqual(7);
    // Signals inside their TTL are reused, not asked for again.
    expect(second.fixtures.requests.some((r) => r.url.startsWith("https://api.github.com/"))).toBe(false);
    expect(second.fixtures.requests.some((r) => r.url.startsWith("https://api.npmjs.org/downloads/point/last-week/cmdk"))).toBe(false);
    expect(second.index.entries.length).toBe(first.index.entries.length);
    expect(second.index.entries.find((e) => e.id === "lib:coss/component/command")).toMatchObject({ provenance: { sha256: first.index.entries.find((e) => e.id === "lib:coss/component/command")!.provenance!.sha256 } });
  });

  test("every entry is a valid youi.library/v1 entry with provenance, licence or unknown, install and signals", async () => {
    const { index } = await sync();
    for (const entry of index.entries) {
      expect(LibraryEntry.safeParse(entry).success).toBe(true);
      expect(entry.provenance?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.license === "unknown" || typeof entry.license?.spdx === "string").toBe(true);
      expect(entry.install?.command).toBeTruthy();
      expect(entry.signals).toBeDefined();
    }
    const command = index.entries.find((e) => e.id === "lib:shadcn/component/command")!;
    expect(command).toMatchObject({
      source: { kind: "shadcn-registry", ref: "@shadcn/command", url: "https://ui.shadcn.com/docs/components/radix/command" },
      install: { command: "npx shadcn add command", npm: ["cn", "cmdk"], registryDeps: ["dialog"] },
      license: { spdx: "MIT", evidenceUrl: "https://github.com/shadcn-ui/ui", verifiedAt: NOW.toISOString() },
      signals: { weeklyDownloads: null, via: { package: "cmdk", weeklyDownloads: 41566267 }, stars: 125435, archived: false, package: "cmdk", repo: "shadcn-ui/ui" },
      provenance: { url: "https://ui.shadcn.com/r/styles/new-york-v4/registry.json", registryHealth: null, files: [{ path: "registry/new-york-v4/ui/command.tsx", sha256: null }] },
    });
    const coss = index.entries.find((e) => e.id === "lib:coss/component/command")!;
    expect(coss).toMatchObject({ install: { command: "npx shadcn add @coss/command", npm: ["@base-ui/react"], registryDeps: ["@coss/autocomplete"] }, provenance: { registryHealth: { status: "healthy" } } });
    // coss.com/ui links cosscom/ui, whose homepage is coss.com: linked both ways, so its licence is that repository's.
    expect(coss.license).toEqual({ spdx: "AGPL-3.0", evidenceUrl: "https://github.com/cosscom/ui", verifiedAt: NOW.toISOString() });
    // Aceternity's homepage links no repository and no search result has its homepage: unknown, never borrowed.
    expect(index.entries.find((e) => e.source.ref === "@aceternity/spotlight")!.license).toBe("unknown");
    expect(index.entries.find((e) => e.id === "lib:magicui/component/marquee")!.license).toMatchObject({ spdx: "MIT", evidenceUrl: "https://github.com/magicuidesign/magicui" });
  });

  test("files served with content are digested and scanned for undeclared imports", async () => {
    const { index } = await sync();
    const choicebox = index.entries.find((e) => e.id === "lib:kibo-ui/component/choicebox")!;
    expect(choicebox.provenance!.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? ""))).toBe(true);
    expect(choicebox.install!.implicitDeps).toEqual(["@repo/shadcn-ui"]);
    expect(index.entries.find((e) => e.id === "lib:kibo-ui/component/marquee")!.install!.implicitDeps).toEqual([]);
    expect(implicitDeps({ name: "x", type: "registry:ui", dependencies: ["sonner@2"], files: [{ path: "x.tsx", content: 'import { toast } from "sonner";\nimport { X } from "lucide-react/icons";\nexport * from "@floating-ui/react/utils";\nimport "./x.css";\nimport { cn } from "@/lib/utils";\nimport * as React from "react";' }] })).toEqual(["@floating-ui/react", "lucide-react"]);
  });

  test("npm-only candidates come from npm search, with npm's licence and downloads", async () => {
    const { index } = await sync();
    const cmdk = index.entries.find((e) => e.id === "lib:npm/component/react-cmdk")!;
    expect(cmdk).toMatchObject({ source: { kind: "npm", ref: "react-cmdk" }, license: { spdx: "MIT", evidenceUrl: "https://www.npmjs.com/package/react-cmdk" }, install: { command: "npm install react-cmdk", npm: ["react-cmdk"] }, signals: { weeklyDownloads: 57296 } });
    // A colour picker that turned up in the command palette search is not offered as one.
    expect(index.entries.some((e) => e.name === "react-color-palette")).toBe(false);
    // Too few downloads to count as used.
    expect(index.entries.some((e) => e.name === "@rozie-ui/command-palette-react")).toBe(false);
  });

  test("headless catalogs give category names, and entries named like one carry it", async () => {
    const { index } = await sync();
    expect(index.sources.filter((s) => s.id.startsWith("headless:")).map((s) => s.outcome)).toEqual(HEADLESS.map(() => "fetched"));
    expect(index.categories.dialog).toEqual(expect.arrayContaining(["base-ui", "radix", "ark"]));
    expect(index.categories["date-picker"]).toEqual(expect.arrayContaining(["react-aria", "ark"]));
    expect(index.categories).not.toHaveProperty("use-controllable-state");
    expect(index.entries.find((e) => e.id === "lib:shadcn/component/dialog")!.categories).toContain("dialog");
  });

  test("signals are rate-limited: past the GitHub budget they stay unknown and the sync still completes", async () => {
    const summary = await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: fixtureFetcher().fetcher, now: () => NOW, timeoutMs: 100, budgets: { githubRepos: 1, githubSearches: 1 } });
    expect(summary.signals.github.looked).toBe(1);
    expect(summary.signals.github.searches).toBe(1);
    expect(summary.signals.github.leftUnknown).toBeGreaterThan(0);
    const signals = JSON.parse(await readFile(join(dir, "signals.json"), "utf8")) as SignalsFile;
    expect(Object.keys(signals.github)).toHaveLength(1);
  });

  test("GITHUB_TOKEN is sent to GitHub and written nowhere", async () => {
    const { fixtures, summary } = await sync(fixtureFetcher(), NOW, { token: TOKEN });
    expect(fixtures.requests.filter((r) => r.headers.authorization).every((r) => r.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(fixtures.requests.some((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
    const files = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const file of files.filter((f) => f.isFile())) expect(await readFile(join(file.parentPath, file.name), "utf8")).not.toContain(TOKEN);
  });

  test("a failed directory or official registry is recorded, not fatal", async () => {
    const down = fixtureFetcher({ override: (url) => (url.startsWith("https://ui.shadcn.com/") ? { status: 503, inline: "down" } : undefined) });
    const { summary, index } = await sync(down);
    expect(index.sources.find((s) => s.id === "directory")).toMatchObject({ outcome: "failed", httpStatus: 503 });
    expect(index.sources.find((s) => s.id === "shadcn")).toMatchObject({ outcome: "failed" });
    expect(summary.entries.official).toBe(0);
    expect(summary.entries.npm).toBeGreaterThan(0);
  });
});

describe("discover helpers", () => {
  test("the cache lives under XDG_CACHE_HOME unless told otherwise", () => {
    expect(discoverCacheDir(undefined, { XDG_CACHE_HOME: "/c" })).toBe("/c/youiyoux/discover");
    expect(discoverCacheDir(undefined, { YOUI_DISCOVER_CACHE: "/d", XDG_CACHE_HOME: "/c" })).toBe("/d");
    expect(discoverCacheDir("/e", { YOUI_DISCOVER_CACHE: "/d" })).toBe("/e");
  });

  test("directory rows that are not usable are counted and dropped, never fatal", () => {
    const { registries, invalid } = parseDirectory([{ name: "@ok", url: "https://ok.test/r/{name}.json", health: { status: "healthy" } }, { name: "@nohost", url: "{name}.json" }, { name: 42, url: "x" }, "junk"]);
    expect(registries.map((r) => r.name)).toEqual(["@ok"]);
    expect(invalid).toBe(3);
  });

  test("only SPDX expressions count as a licence; homepages compare without www or a trailing slash", () => {
    expect(spdxOrNull("MIT")).toBe("MIT");
    expect(spdxOrNull("(MIT OR Apache-2.0)")).toBe("(MIT OR Apache-2.0)");
    expect(spdxOrNull("NOASSERTION")).toBeNull();
    expect(spdxOrNull("SEE LICENSE IN LICENSE.md")).toBeNull();
    expect(spdxOrNull({ type: "MIT" })).toBeNull();
    expect(sameHomepage("https://www.kibo-ui.com/", "https://kibo-ui.com")).toBe(true);
    expect(sameHomepage("https://coss.com", "https://coss.com/ui")).toBe(false);
  });

  test("a repository's homepage covers the registry's when the host matches and the registry is at or under its path", () => {
    expect(sameSite("https://coss.com", "https://coss.com/ui")).toBe(true);
    expect(sameSite("https://www.kibo-ui.com/", "https://kibo-ui.com")).toBe(true);
    expect(sameSite("https://kibo-ui.com/docs", "https://kibo-ui.com/docs/registry")).toBe(true);
    // Only downward: a deeper repository homepage covers nothing above it.
    expect(sameSite("https://kibo-ui.com/docs", "https://kibo-ui.com")).toBe(false);
    expect(sameSite("https://coss.com/ui", "https://coss.com/uix")).toBe(false);
    expect(sameSite("https://coss.com/blog", "https://coss.com/ui")).toBe(false);
    expect(sameSite("https://coss.dev", "https://coss.com")).toBe(false);
    expect(sameSite(null, "https://coss.com")).toBe(false);
    // Where tenants are paths, only the exact page: a repository whose homepage is github.com claims no one's registry there.
    expect(sameSite("https://github.com", "https://github.com/evil/registry")).toBe(false);
    expect(sameSite("https://www.npmjs.com/", "https://www.npmjs.com/package/x")).toBe(false);
    expect(sameSite("https://github.com/acme/ui", "https://github.com/acme/ui")).toBe(true);
  });

  test("a page's GitHub repository links, most-linked first, without GitHub's own pages", () => {
    const html = '<a href="https://github.com/acme/ui">x</a> <a href="https://github.com/sponsors/acme">s</a> <a href="https://www.github.com/acme/ui/blob/main/LICENSE">l</a> see https://github.com/radix-ui/primitives. <a href="https://github.com/acme/ui.git">';
    expect(linkedRepos(html)).toEqual(["acme/ui", "radix-ui/primitives"]);
  });
});

test("unchanged second sync makes no npm requests and reports the actual index size", async () => {
  const successful = () => fixtureFetcher({ override: (url) => url.endsWith("last-week/@dnd-kit/core") ? { inline: '{"downloads":10000}' } : url.endsWith("@dnd-kit%2Fcore/latest") ? { inline: '{"name":"@dnd-kit/core","license":"MIT"}' } : undefined });
  await sync(successful());
  const second = await sync(successful(), new Date(NOW.getTime() + 60000));
  expect(second.fixtures.requests.filter((r) => /https:\/\/(registry|api)\.npmjs\.org\//.test(r.url))).toEqual([]);
  expect(second.summary.index.bytes).toBe(Buffer.byteLength(await readFile(join(dir, "index.json"), "utf8")));
  expect(second.summary.index.entries).toBe(second.index.entries.length);
});

test("partly failed npm lookups are retried on the next sync", async () => {
  const failing = () => fixtureFetcher({ override: (url) => url === "https://api.npmjs.org/downloads/point/last-week/cmdk" ? { status: 429, inline: "limited", headers: { "retry-after": "0" } } : undefined });
  await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: failing().fetcher, now: () => NOW, timeoutMs: 100, npm: false });
  const saved = JSON.parse(await readFile(join(dir, "signals.json"), "utf8")) as SignalsFile;
  expect(saved.npm.cmdk).toMatchObject({ fetchedAt: "", failedAt: NOW.toISOString(), weeklyDownloads: null });
  const before = fixtureFetcher();
  await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: before.fetcher, now: () => new Date(NOW.getTime() + 60000), timeoutMs: 100, npm: false });
  expect(before.requests.some((r) => r.url.endsWith("last-week/cmdk"))).toBe(true);
  const after = fixtureFetcher();
  await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: after.fetcher, now: () => new Date(NOW.getTime() + 3600001), timeoutMs: 100, npm: false });
  expect(after.requests.some((r) => r.url.endsWith("last-week/cmdk"))).toBe(false);
  const fresh = JSON.parse(await readFile(join(dir, "signals.json"), "utf8")) as SignalsFile;
  expect(fresh.npm.cmdk?.weeklyDownloads).toBe(41566267);
  expect(fresh.npm.cmdk?.failedAt).toBeUndefined();
});

test("icons require opt-in, discovered icon registries are remembered, and unsafe directory URLs are skipped", async () => {
  const rows = [
    { name: "@icons", description: "An icon set", url: "https://icons.test/{name}.json" },
    { name: "@drawings", url: "https://drawings.test/{name}.json" },
    { name: "@private", url: "https://127.0.0.1/{name}.json" },
    { name: "@http", url: "http://public.test/{name}.json" },
    { name: "@private-home", url: "https://okay.test/{name}.json", homepage: "https://secret.internal" },
  ];
  const recorded = () => fixtureFetcher({ override: (url) => url.endsWith("/r/registries.json") ? { inline: JSON.stringify(rows) } : /https:\/\/(icons|drawings)\.test\//.test(url) ? { inline: JSON.stringify({ items: [{ name: "command-icon", type: "registry:ui", categories: ["icons"] }] }) } : undefined });
  const first = recorded();
  await writeSources(dir, ["@icons", "@drawings", "@private", "@http", "@private-home"]);
  const options = { sleep: async () => {}, cacheDir: dir, now: () => NOW, timeoutMs: 100, npm: false };
  const result = await syncIndex({ ...options, fetcher: first.fetcher });
  expect(result.index.iconRegistriesSkipped).toBe(2);
  expect(first.requests.some((r) => /icons.test|127\.0\.0\.1|public.test|okay.test|secret.internal/.test(r.url))).toBe(false);
  const index = (await readIndex(dir))!;
  for (const id of ["@private", "@http", "@private-home"]) expect(index.sources.find((s) => s.id === id)).toMatchObject({ outcome: "skipped", reason: "URL must use https on a public host" });
  const second = recorded();
  await syncIndex({ ...options, fetcher: second.fetcher });
  expect(second.requests.some((r) => r.url.includes("drawings.test"))).toBe(false);
  const third = recorded();
  await syncIndex({ ...options, fetcher: third.fetcher, icons: true });
  expect((await readIndex(dir))!.entries.map((e) => e.source.ref)).toContain("@icons/command-icon");
});

test("bad GitHub token appears once in summary and no cached text carries terminal controls", async () => {
  const injected = fixtureFetcher({ override: (url) => url.startsWith("https://api.github.com/") ? { status: 401, inline: "Bad credentials" } : url.endsWith("/r/registries.json") ? { inline: JSON.stringify([{ name: "@evil", url: "https://evil.test/{name}.json", description: "\x1b]0;title\x07clean", health: { status: "\x1b[2Jhealthy" } }]) } : url === "https://evil.test/registry.json" ? { inline: JSON.stringify({ items: [{ name: "command", type: "registry:ui", title: "\x1b]0;pwned\x07Command", description: "\x1b[2JCommand menu", categories: ["\x90payload\x9ccommand"] }, { name: "bad;name", type: "registry:ui" }] }) } : undefined });
  await writeSources(dir, ["@evil"]);
  const { summary, index } = await sync(injected, NOW, { token: TOKEN });
  expect(summary.warnings).toEqual(["GitHub token rejected; licences stay unknown"]);
  const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : [];
  for (const value of strings(index)) expect(value).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  expect(index.entries.find((entry) => entry.source.ref === "@evil/command")).toMatchObject({ title: "Command", summary: "Command menu" });
  expect(JSON.stringify(summary)).not.toContain(TOKEN);
});

test("selected unavailable responses retain their failure reasons without stopping sync", async () => {
  await writeSources(dir, ["@coss", "@fixture-500", "@fixture-timeout", "@fixture-html"]);
  const { index } = await sync();
  expect(index.sources.find((s) => s.id === "@fixture-500")).toMatchObject({ outcome: "failed", reason: "HTTP 500" });
  expect(index.sources.find((s) => s.id === "@fixture-timeout")?.reason).toMatch(/^timeout/);
  expect(index.sources.find((s) => s.id === "@fixture-html")?.reason).toMatch(/^not-json/);
  expect(index.entries.some((e) => e.source.ref === "@coss/command")).toBe(true);
});

test("a repository the registry's homepage links to is credited only when its own homepage is that site", async () => {
  // The page links a lookalike first; it names another site as its homepage, so only the real one counts.
  const page = '<a href="https://github.com/lookalike/kibo">fork</a><a href="https://github.com/lookalike/kibo">fork</a><a href="https://github.com/shadcnblocks/kibo">source</a>';
  const fixtures = fixtureFetcher({ override: (url) => url === "https://www.kibo-ui.com/" ? { headers: { "content-type": "text/html" }, inline: page } : url === "https://api.github.com/repos/lookalike/kibo" ? { inline: JSON.stringify({ full_name: "lookalike/kibo", html_url: "https://github.com/lookalike/kibo", homepage: "https://lookalike.dev", stargazers_count: 3, pushed_at: null, archived: false, license: { spdx_id: "MIT" } }) } : undefined });
  const { index } = await sync(fixtures);
  const signals = JSON.parse(await readFile(join(dir, "signals.json"), "utf8")) as SignalsFile;
  expect(signals.registryRepos["@kibo-ui"]?.repo).toBe("shadcnblocks/kibo");
  expect(index.entries.find((e) => e.source.ref === "@kibo-ui/combobox")!.license).toMatchObject({ spdx: "MIT", evidenceUrl: "https://github.com/shadcnblocks/kibo" });
  // Found from the page, so no search was spent on it; and the page itself is never kept.
  expect(fixtures.requests.some((r) => r.url.includes("search/repositories?q=kibo"))).toBe(false);
  const saved = await Promise.all((await readdir(join(dir, "listings"))).map(async (name) => JSON.parse(await readFile(join(dir, "listings", name), "utf8")) as { url: string }));
  expect(saved.map((listing) => listing.url)).not.toContain("https://www.kibo-ui.com/");

  const lookalikeOnly = fixtureFetcher({ override: (url) => url === "https://www.kibo-ui.com/" ? { headers: { "content-type": "text/html" }, inline: '<a href="https://github.com/lookalike/kibo">x</a>' } : url === "https://api.github.com/repos/lookalike/kibo" ? { inline: JSON.stringify({ full_name: "lookalike/kibo", html_url: "https://github.com/lookalike/kibo", homepage: null, stargazers_count: 3, pushed_at: null, archived: false, license: { spdx_id: "MIT" } }) } : url.includes("search/repositories?q=kibo") ? { inline: JSON.stringify({ items: [] }) } : undefined });
  await rm(dir, { recursive: true, force: true });
  const second = await sync(lookalikeOnly);
  expect(second.index.entries.find((e) => e.source.ref === "@kibo-ui/combobox")!.license).toBe("unknown");
});

test("a registry with no repository found is asked again after a day, a found one after thirty", async () => {
  await sync();
  const signals = JSON.parse(await readFile(join(dir, "signals.json"), "utf8")) as SignalsFile;
  expect(signals.registryRepos["@aceternity"]?.repo).toBeNull();
  expect(signals.registryRepos["@coss"]?.repo).toBe("cosscom/ui");
  const nextDay = await sync(fixtureFetcher(), new Date(NOW.getTime() + 25 * 3_600_000));
  expect(nextDay.fixtures.requests.some((r) => r.url === "https://ui.aceternity.com")).toBe(true);
  expect(nextDay.fixtures.requests.some((r) => r.url === "https://coss.com/ui")).toBe(false);
});

test("a chosen source the directory no longer lists is reported with how to drop it, not counted as fetched", async () => {
  await writeSources(dir, ["@coss", "@origin"]);
  const { summary, index } = await sync();
  expect(index.sources.find((s) => s.id === "@origin")).toMatchObject({ outcome: "skipped", reason: "not in the registry directory", items: 0 });
  expect(summary.warnings).toEqual(["@origin is chosen but the registry directory no longer lists it: `youiyoux discover sources remove @origin`"]);
  expect(summary.registries.fetched).toBe(1);
});
