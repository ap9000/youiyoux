/**
 * Proves Discover's first paint is flat and lazy, and exits 1 when it is not:
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 *   node scripts/measure-discover.ts [--sizes 40,5000] [--runs 5] [--keep]
 *
 * Builds the hub (the committed demo snapshot) and, per size, a Discover cache from recorded
 * responses (discover-fixture.ts; the larger sizes padded with synthetic registry listings), then
 * serves the build with `vite preview` on that cache (/__youi/query reads its store) and opens
 * /discover?q=command%20menu in headless Chromium, cold, `--runs` times. Per run it records the
 * frame after the page's shell is in the DOM, the frame after the first result card is, FCP, the
 * requests and bytes before the shell paints, and, a second after the results with nothing
 * opened: requests for a preview (/__youi/discover-preview), sandboxed frames and specimen tiles
 * mounted (all 0), and whether the cache gained a preview/ or source/ directory (it must not:
 * nothing is fetched until a candidate is opened).
 *
 * Fails when the largest size's median shell paint or FCP is over 1.5× the smallest's (plus one
 * frame, 16 ms), when anything was fetched or mounted for a candidate with nothing opened, or
 * when the route's download (index.html, the JS, CSS and fonts requested before the shell paints,
 * gzip -9, woff2 as is) is over perf/budget.json's initial budget. Results go to
 * perf/discover.json; its work is done in apps/web/.measure-discover, removed unless --keep.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, type Browser } from "playwright-core";
import { preview } from "vite";
import { closeSharedStores, discoverIndexPath, ingestCatalog, readIndex, writeJson } from "../../../packages/discover/src/index.ts";
import { openSqlite } from "../../../packages/store/src/index.ts";
import { discoverFixture } from "./discover-fixture.ts";

const APP = resolve(import.meta.dirname, "..");
const TIME_RATIO = 1.5;
const FRAME_MS = 16;
const PORT = 4794;
const SETTLE_MS = 1000;
const BUDGET = JSON.parse(readFileSync(join(APP, "perf/budget.json"), "utf8")) as { initialKb: number };
const PREVIEW_REQUEST = /\/__youi\/discover-preview/;

interface Run {
  shellPaintMs: number;
  resultsPaintMs: number;
  fcpMs: number;
  requests: number;
  bytes: number;
  /** Same-origin paths fetched before the shell painted. */
  paths: string[];
  previewRequests: number;
  frames: number;
  tiles: number;
  hits: number;
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

/** A Discover cache of `size` listings: the recorded catalog, padded with synthetic registry items. */
async function cacheOf(dir: string, size: number): Promise<string> {
  const { cache } = await discoverFixture(dir);
  const index = (await readIndex(cache))!;
  const template = index.entries.find((e) => e.source.ref === "@shadcn/button")!;
  const extra = Math.max(0, size - index.entries.length);
  const padded = Array.from({ length: extra }, (_, i) => ({ ...template, id: `lib:synthetic/component/part-${i}`, name: `part-${i}`, title: `Part ${i}`, summary: `Synthetic listing ${i}: a ${["menu", "panel", "field", "badge"][i % 4]} for measuring`, source: { ...template.source, name: "@synthetic", ref: `@synthetic/part-${i}` }, license: "unknown" as const }));
  await writeJson(join(cache, "index.json"), { ...index, entries: [...index.entries, ...padded] });
  const store = await openSqlite(discoverIndexPath(undefined, { YOUI_DISCOVER_CACHE: cache }));
  await ingestCatalog(store, cache);
  await store.close();
  return cache;
}

async function measure(browser: Browser, url: string): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const previews: string[] = [];
  page.on("request", (request) => PREVIEW_REQUEST.test(request.url()) && previews.push(request.url()));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, number>;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") w.__fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
    const frameAfter = (key: string): void => {
      requestAnimationFrame(() =>
        setTimeout(() => {
          w[key] = performance.now();
        }, 0),
      );
    };
    let shell = false;
    new MutationObserver((_, observer) => {
      if (!shell && document.querySelector('[data-screen="discover"]')) {
        shell = true;
        frameAfter("__shell");
      }
      if (document.querySelector("[data-hit]")) {
        observer.disconnect();
        frameAfter("__results");
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => ["__shell", "__results", "__fcp"].every((k) => (window as unknown as Record<string, number | undefined>)[k] !== undefined), undefined, { timeout: 30_000 });
  const { shell, results, fcp, entries } = await page.evaluate(() => {
    const w = window as unknown as Record<string, number>;
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return { shell: w.__shell!, results: w.__results!, fcp: w.__fcp!, entries: [navigation, ...resources].map((r) => ({ name: r.name, end: r.responseEnd, size: r.transferSize })) };
  });
  const before = entries.filter((e) => e.end <= shell);
  await page.waitForTimeout(SETTLE_MS);
  const frames = await page.locator("iframe").count();
  const tiles = await page.locator("[data-tile]").count();
  const hits = await page.locator("[data-hit]").count();
  await context.close();
  const origin = new URL(url).origin;
  return {
    shellPaintMs: Math.round(shell * 10) / 10,
    resultsPaintMs: Math.round(results * 10) / 10,
    fcpMs: Math.round(fcp * 10) / 10,
    requests: before.length,
    bytes: before.reduce((n, e) => n + e.size, 0),
    paths: before.filter((e) => e.name.startsWith(origin)).map((e) => new URL(e.name).pathname),
    previewRequests: previews.length,
    frames,
    tiles,
    hits,
  };
}

/** The route's download as measure.ts counts it: gzip -9 for HTML, JS, CSS and JSON, woff2 as is. */
function routeKb(dist: string, paths: readonly string[]): { totalKb: number; files: Array<{ path: string; kb: number }> } {
  const files = [...new Set(paths)].flatMap((path) => {
    const file = join(dist, path === "/discover" || path === "/" ? "index.html" : path);
    if (!existsSync(file)) return [];
    const body = readFileSync(file);
    return [{ path, kb: kb(path.endsWith(".woff2") ? body.length : gzipSync(body, { level: 9 }).length) }];
  });
  return { totalKb: Math.round(files.reduce((n, f) => n + f.kb, 0) * 10) / 10, files };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, sizes: { type: "string", default: "40,5000" }, runs: { type: "string", default: "5" }, keep: { type: "boolean", default: false } } });
  const sizes = values.sizes.split(",").map(Number);
  const runs = Number(values.runs);
  const work = join(APP, ".measure-discover");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const dist = join(work, "dist");
  execFileSync(process.execPath, [join(APP, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: APP, stdio: ["ignore", "ignore", "inherit"] });
  const results: Array<{ listings: number; runs: Run[]; cacheWrites: string[] }> = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const size of sizes) {
      const cache = await cacheOf(join(work, `listings-${size}`), size);
      await closeSharedStores();
      const listings = (await readIndex(cache))!.entries.length;
      // The preview server's endpoints read the cache from the environment, as `youiyoux ui`'s do.
      process.env.YOUI_DISCOVER_CACHE = cache;
      const server = await preview({ root: APP, configFile: join(APP, "vite.config.ts"), build: { outDir: dist }, preview: { port: PORT, strictPort: true }, logLevel: "error" });
      try {
        const measured: Run[] = [];
        for (let i = 0; i < runs; i++) measured.push(await measure(browser, `http://localhost:${PORT}/discover?q=command%20menu`));
        results.push({ listings, runs: measured, cacheWrites: ["preview", "source"].filter((d) => existsSync(join(cache, d))) });
      } finally {
        await server.close();
        await closeSharedStores();
      }
    }
  } finally {
    await browser.close();
  }
  const route = routeKb(dist, results[0]!.runs[0]!.paths);
  const summary = results.map((r) => ({ listings: r.listings, requestsBeforeShell: median(r.runs.map((x) => x.requests)), bytesBeforeShell: median(r.runs.map((x) => x.bytes)), shellPaintMs: median(r.runs.map((x) => x.shellPaintMs)), resultsPaintMs: median(r.runs.map((x) => x.resultsPaintMs)), fcpMs: median(r.runs.map((x) => x.fcpMs)), hits: Math.min(...r.runs.map((x) => x.hits)), previewRequests: Math.max(...r.runs.map((x) => x.previewRequests)), frames: Math.max(...r.runs.map((x) => x.frames)), tiles: Math.max(...r.runs.map((x) => x.tiles)), cacheWrites: r.cacheWrites }));
  const [small, large] = [summary[0]!, summary.at(-1)!];
  const problems = [
    large.shellPaintMs > small.shellPaintMs * TIME_RATIO + FRAME_MS && `${large.listings} listings paint the page at ${large.shellPaintMs} ms, over 1.5× ${small.listings} listings' ${small.shellPaintMs} ms`,
    large.fcpMs > small.fcpMs * TIME_RATIO + FRAME_MS && `${large.listings} listings' FCP is ${large.fcpMs} ms, over 1.5× ${small.listings} listings' ${small.fcpMs} ms`,
    route.totalKb > BUDGET.initialKb && `the route downloads ${route.totalKb} KB before it paints, over the ${BUDGET.initialKb} KB budget`,
    ...summary.flatMap((s) => [
      s.hits === 0 && `${s.listings} listings: no result card for "command menu"`,
      s.previewRequests > 0 && `${s.listings} listings: a preview was requested with nothing opened`,
      s.frames > 0 && `${s.listings} listings: ${s.frames} frame(s) mounted with nothing opened`,
      s.tiles > 0 && `${s.listings} listings: ${s.tiles} specimen tile(s) mounted with nothing opened`,
      s.cacheWrites.length > 0 && `${s.listings} listings: the Discover cache gained ${s.cacheWrites.join(" and ")}/ with nothing opened`,
    ]),
  ].filter((p): p is string => typeof p === "string");
  const report = { measuredAt: new Date().toISOString(), runs, url: "/discover?q=command%20menu", bounds: { time: "≤ 1.5× smallest + 16 ms (median)", routeKb: `≤ ${BUDGET.initialKb} KB (perf/budget.json initialKb)`, lazy: "0 preview requests, frames, tiles and cache writes with nothing opened" }, route, summary, raw: results, problems };
  const output = values.out ? resolve(values.out) : join(APP, "perf/discover.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`route: ${route.totalKb} KB before the page paints (budget ${BUDGET.initialKb} KB)\n`);
  for (const s of summary) process.stdout.write(`${String(s.listings).padStart(5)} listings: before the page paints ${s.requestsBeforeShell} requests, ${s.bytesBeforeShell} B; page ${s.shellPaintMs} ms, results ${s.resultsPaintMs} ms, FCP ${s.fcpMs} ms (median of ${runs}); ${s.hits} cards; previews ${s.previewRequests}, frames ${s.frames}, tiles ${s.tiles}, cache writes ${s.cacheWrites.length}\n`);
  if (!values.keep) rmSync(work, { recursive: true, force: true });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`measure-discover: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write("measure-discover: first paint is flat, and nothing is fetched for a candidate until it is opened\n");
}

await main();
