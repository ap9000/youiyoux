/**
 * Proves the Inventory page's first paint does not grow with the library, and exits 1 when it
 * does:
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 *   node scripts/measure-inventory.ts [--sizes 50,5000] [--runs 5] [--keep]
 *
 * For each size it makes a synthetic inventory of the scanner's fixtures (synthetic-inventory.ts),
 * snapshots it (scripts/snapshot.ts --out, specimens included), builds the hub against that
 * snapshot, serves the build with `vite preview` and opens /inventory in Playwright's headless
 * Chromium, cold, `--runs` times. Per run it records the bytes transferred until the page first
 * paints its inventory (the headline, drawn from the index alone), that moment, and first
 * contentful paint.
 *
 * Fails when the largest size transfers more than the smallest's bytes + 10%, or its median
 * inventory paint or FCP is over 1.5× the smallest's (plus one frame, 16 ms, for timer noise).
 * Also fails when a page nobody clicked asks for any of Try it (its chunk or a bundle), mounts a
 * state strip, or when the build carries try.json: those load on click only, from the server.
 * Results go to perf/inventory.json. Its snapshots and builds are made in apps/web/.measure (a
 * snapshot's preview components resolve the hub's own packages, as `youi ui`'s .hub does),
 * removed afterwards unless --keep.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright-core";
import { preview } from "vite";
import { libraries } from "./snapshot.ts";
import { synthesizeInventory } from "./synthetic-inventory.ts";

const APP = resolve(import.meta.dirname, "..");
const TOOL = resolve(APP, "../..");
const FIXTURES = ["console", "site"].map((name) => join(TOOL, "packages/scanner/test/fixtures/inventory", name));
const BYTES_SLACK = 1.1;
const TIME_RATIO = 1.5;
const FRAME_MS = 16;
const PORT = 4795;

interface Run {
  bytes: number;
  requests: number;
  inventoryPaintMs: number;
  fcpMs: number;
  /** Try it requests (its chunk, a bundle) and state strips, a second after the paint, with nothing clicked: 0. */
  tryRequests: number;
  strips: number;
}

/** A request that is Try it's: the live frame's chunk, or the bundle endpoint. */
const TRY_REQUEST = /\/__youi\/try|\/assets\/try-live[-.]/;
const SETTLE_MS = 1000;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** Bytes over the wire (headers included) until the headline paints, that moment, and FCP. */
async function measure(browser: Browser, url: string): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const tryRequests: string[] = [];
  page.on("request", (request) => TRY_REQUEST.test(request.url()) && tryRequests.push(request.url()));
  // Cold: nothing from the HTTP cache (each context's Cache Storage starts empty anyway).
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  // The first frame after the headline exists, on the page's clock.
  await page.addInitScript(() => {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") (window as unknown as { __fcp: number }).__fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
    const done = (): void => {
      requestAnimationFrame(() => setTimeout(() => ((window as unknown as { __inventoryPaint: number }).__inventoryPaint = performance.now()), 0));
    };
    new MutationObserver((_, observer) => {
      if (document.querySelector('[data-testid="inventory-headline"]')) {
        observer.disconnect();
        done();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { __inventoryPaint?: number; __fcp?: number }).__inventoryPaint !== undefined && (window as unknown as { __fcp?: number }).__fcp !== undefined, undefined, { timeout: 30_000 });
  // Every response that finished before that frame, the document included (same origin, so transferSize is known).
  const { paint, fcp, entries } = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return {
      paint: (window as unknown as { __inventoryPaint: number }).__inventoryPaint,
      fcp: (window as unknown as { __fcp: number }).__fcp,
      entries: [navigation, ...resources].map((r) => ({ end: r.responseEnd, size: r.transferSize })),
    };
  });
  const before = entries.filter((e) => e.end <= paint);
  // A moment on, rows and their chunks loading: still nothing of Try it, and no strip.
  await page.waitForTimeout(SETTLE_MS);
  const strips = await page.locator("[data-strip]").count();
  await context.close();
  return { bytes: before.reduce((n, e) => n + e.size, 0), requests: before.length, inventoryPaintMs: Math.round(paint * 10) / 10, fcpMs: Math.round(fcp * 10) / 10, tryRequests: tryRequests.length, strips };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { sizes: { type: "string", default: "50,5000" }, runs: { type: "string", default: "5" }, keep: { type: "boolean", default: false } } });
  const sizes = values.sizes.split(",").map(Number);
  const runs = Number(values.runs);
  const work = join(APP, ".measure");
  mkdirSync(work, { recursive: true });
  const libs = await libraries();
  const scanner = (await import("../../../packages/scanner/src/inventory/inventory.ts")) as unknown as { familiesOf: Parameters<typeof synthesizeInventory>[2] };
  const base = libs.core.InventoryReport.parse(await libs.scanner.buildInventory(FIXTURES, { cwd: TOOL }));
  // Absolute roots, so the snapshot finds the projects wherever it runs.
  const rooted = { ...base, projects: base.projects.map((p, i) => ({ ...p, root: FIXTURES[i]! })) };
  const results: Array<{ looks: number; families: number; indexBytes: number; tryJsonInBuild: boolean; runs: Run[] }> = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const size of sizes) {
      const dir = join(work, `looks-${size}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const report = libs.core.InventoryReport.parse(synthesizeInventory(rooted, size, scanner.familiesOf));
      writeFileSync(join(dir, "inventory.json"), JSON.stringify(report));
      const out = join(dir, "snapshot");
      const dist = join(dir, "dist");
      execFileSync(process.execPath, [join(APP, "scripts/snapshot.ts"), "--out", out, "--inventory", join(dir, "inventory.json")], { cwd: TOOL, stdio: ["ignore", "ignore", "inherit"] });
      execFileSync(process.execPath, [join(APP, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: APP, env: { ...process.env, YOUI_HUB_SNAPSHOT: out }, stdio: ["ignore", "ignore", "inherit"] });
      const manifest = JSON.parse(readFileSync(join(dist, "data/manifest.json"), "utf8")) as { inventory: string };
      const indexBytes = statSync(join(dist, "data", manifest.inventory)).size;
      const server = await preview({ root: APP, configFile: join(APP, "vite.config.ts"), build: { outDir: dist }, preview: { port: PORT, strictPort: true }, logLevel: "error" });
      try {
        const measured: Run[] = [];
        for (let i = 0; i < runs; i++) measured.push(await measure(browser, `http://localhost:${PORT}/inventory`));
        results.push({ looks: size, families: report.families.length, indexBytes, tryJsonInBuild: existsSync(join(dist, "try.json")) || existsSync(join(dist, "data/try.json")), runs: measured });
      } finally {
        await server.close();
      }
    }
  } finally {
    await browser.close();
  }
  const summary = results.map((r) => ({ looks: r.looks, families: r.families, indexBytes: r.indexBytes, bytesBeforePaint: median(r.runs.map((x) => x.bytes)), requestsBeforePaint: median(r.runs.map((x) => x.requests)), inventoryPaintMs: median(r.runs.map((x) => x.inventoryPaintMs)), fcpMs: median(r.runs.map((x) => x.fcpMs)), tryRequests: Math.max(...r.runs.map((x) => x.tryRequests)), strips: Math.max(...r.runs.map((x) => x.strips)) }));
  const [small, large] = [summary[0]!, summary.at(-1)!];
  const problems = [
    large.bytesBeforePaint > small.bytesBeforePaint * BYTES_SLACK && `${large.looks} looks transfer ${large.bytesBeforePaint} bytes before the inventory paints, over ${small.looks} looks' ${small.bytesBeforePaint} + 10%`,
    large.inventoryPaintMs > small.inventoryPaintMs * TIME_RATIO + FRAME_MS && `${large.looks} looks paint the inventory at ${large.inventoryPaintMs} ms, over 1.5× ${small.looks} looks' ${small.inventoryPaintMs} ms`,
    large.fcpMs > small.fcpMs * TIME_RATIO + FRAME_MS && `${large.looks} looks' FCP is ${large.fcpMs} ms, over 1.5× ${small.looks} looks' ${small.fcpMs} ms`,
    ...results.flatMap((r) => [
      r.runs.some((x) => x.tryRequests > 0) && `${r.looks} looks: Try it was requested with nothing clicked`,
      r.runs.some((x) => x.strips > 0) && `${r.looks} looks: a state strip mounted with nothing opened`,
      r.tryJsonInBuild && `${r.looks} looks: try.json is in the build, where anyone could read it`,
    ]),
  ].filter((p): p is string => typeof p === "string");
  const report = { measuredAt: new Date().toISOString(), runs, bounds: { bytes: "≤ smallest + 10%", time: "≤ 1.5× smallest + 16 ms (median)" }, summary, raw: results, problems };
  mkdirSync(join(APP, "perf"), { recursive: true });
  writeFileSync(join(APP, "perf/inventory.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const s of summary) process.stdout.write(`${String(s.looks).padStart(5)} looks, ${s.families} families: index ${s.indexBytes} B; before the inventory paints ${s.requestsBeforePaint} requests, ${s.bytesBeforePaint} B; inventory paint ${s.inventoryPaintMs} ms; FCP ${s.fcpMs} ms (median of ${runs}); Try it requests ${s.tryRequests}, state strips ${s.strips}\n`);
  if (!values.keep) rmSync(work, { recursive: true, force: true });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`measure-inventory: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write("measure-inventory: first paint does not grow with the library\n");
}

await main();
