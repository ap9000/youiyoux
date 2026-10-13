/**
 * The one live check, opt-in: YOUI_DISCOVER_LIVE=1 pnpm vitest run packages/discover/test/live.test.ts
 * It reads the real endpoints (a couple of community registries, a few signals) into a temp cache.
 * Every other test replays recorded fixtures and never reaches the network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadIndex, searchIndex, syncIndex } from "../src/index.ts";

describe.skipIf(!process.env.YOUI_DISCOVER_LIVE)("live smoke (YOUI_DISCOVER_LIVE=1)", () => {
  test("syncs from the real endpoints and finds a command menu", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-discover-live-"));
    try {
      const summary = await syncIndex({ cacheDir: dir, maxRegistries: 2, npm: false, budgets: { npmPackages: 5, githubRepos: 2, githubSearches: 1 }, ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) });
      expect(summary.registries.listed).toBeGreaterThan(100);
      expect(summary.entries.official).toBeGreaterThan(20);
      expect(summary.categories).toBeGreaterThan(20);
      const result = searchIndex(await loadIndex(dir), "command menu");
      expect(result.hits[0]?.source.ref).toBe("@shadcn/command");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
