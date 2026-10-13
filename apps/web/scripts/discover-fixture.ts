/**
 * A Discover cache built from recorded responses, for the capture and measure scripts: the
 * catalog synced from packages/discover/test/fixtures/http (never the network), loaded into the
 * store beside it (what /__youi/query reads), and, with `sources`, those items' source recorded
 * into its source/ cache as an earlier open would have left it, so opening them in the hub
 * fetches nothing. Point the hub at it with YOUI_DISCOVER_CACHE=<dir>.
 *
 *   node scripts/discover-fixture.ts <dir> [@shadcn/command …]
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { candidateSource, closeSharedStores, discoverIndexPath, openCatalog, syncIndex } from "../../../packages/discover/src/index.ts";
import { fixtureFetcher } from "../../../packages/discover/test/fixture-fetcher.ts";

/** Items whose source a capture opens (and the registry parts they import). */
export const RECORDED_SOURCES = ["@shadcn/command", "@shadcn/dialog", "@shadcn/button", "@shadcn/input"];

export async function discoverFixture(dir: string, sources: readonly string[] = []): Promise<{ cache: string; index: string }> {
  const cache = resolve(dir);
  mkdirSync(cache, { recursive: true });
  await syncIndex({ sleep: async () => {}, cacheDir: cache, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  const index = discoverIndexPath(undefined, { YOUI_DISCOVER_CACHE: cache });
  await openCatalog(cache, index, {});
  for (const id of sources) await candidateSource(cache, id, { fetcher: fixtureFetcher().fetcher });
  await closeSharedStores();
  return { cache, index };
}

if (import.meta.main) {
  const [dir, ...sources] = process.argv.slice(2);
  if (!dir) throw new Error("usage: node scripts/discover-fixture.ts <dir> [@shadcn/command …]");
  const { cache, index } = await discoverFixture(dir, sources);
  process.stdout.write(`Discover fixture cache ${cache} (store ${index}); YOUI_DISCOVER_CACHE=${cache}\n`);
}
