/**
 * Measures the budgets, records them in perf/report.json, and exits 1 when one regresses:
 *
 *   pnpm build && pnpm measure
 *
 * - Initial download, first route: index.html, the JS and CSS it loads before anything else
 *   (entry script, modulepreloads, stylesheets), the snapshot the first screen fetches
 *   (manifest + catalog), and the Latin font files its stylesheet declares. HTML, JS, CSS and
 *   JSON count gzipped (-9); woff2 counts as is (already compressed). Route chunks preloaded on
 *   idle, the usage map and the preview frame load later and are reported separately.
 *   Fails when the total grows past perf/budget.json's ceiling (the last accepted size); the
 *   agreed target is reported alongside, met or not.
 * - Search: query latency of the same engine the worker runs, on the default snapshot and on a 50×
 *   synthetic catalog to show headroom. Fails over the search budget.
 * - Navigation is measured in the browser (Home → Speed, src/lib/perf.ts), not here.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { buildModel } from "../src/data/model.ts";
import type { Catalog, Manifest } from "../src/data/types.ts";
import { type SearchDoc, toSearchDocs } from "../src/search/docs.ts";
import { createIndex, searchIndex } from "../src/search/engine.ts";

const APP = resolve(import.meta.dirname, "..");
const DIST = join(APP, "dist");
const DATA = join(APP, "snapshot/public/data");
interface Budget {
  /** The agreed first-route download target (KB). */
  initialKbTarget: number;
  /** The accepted size (KB): measuring above it fails. Raise it deliberately, in review, when growth is wanted. */
  initialKbCeiling: number;
  searchMs: number;
  navigationMs: number;
}
const BUDGET = JSON.parse(readFileSync(join(APP, "perf/budget.json"), "utf8")) as Budget;
/** U+0041 ("A"): a font face whose unicode-range covers it is the Latin subset every screen renders. */
const LATIN_PROBE = 0x41;
const RUNS_PER_QUERY = 200;
const SCALE = 50;
const QUERIES = ["button", "butt", "buton", "foreground", "danger soft", "c62828", "radius", "no raw", "typography body", "destructive", "g", "shadow card"];

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;
const gz = (path: string): number => gzipSync(readFileSync(path), { level: 9 }).length;

function initialAssets(): string[] {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  return [...new Set(refs)];
}

/** Does a CSS unicode-range (U+0-FF, U+??, U+2000-206F, …) include this code point? */
function coversCodePoint(range: string, point: number): boolean {
  return range.split(",").some((part) => {
    const [low = "", high] = part.trim().replace(/^U\+/i, "").split("-");
    // A wildcard (U+4??) spans U+400–U+4FF.
    const from = Number.parseInt(low.replace(/\?/g, "0"), 16);
    const to = Number.parseInt((high ?? low).replace(/\?/g, "f"), 16);
    return point >= from && point <= to;
  });
}

/** Font files the initial stylesheets declare for Latin text: what the first route downloads to render its text. */
function initialFonts(stylesheets: readonly string[]): Array<{ file: string; bytes: number }> {
  const files = stylesheets.flatMap((sheet) =>
    [...readFileSync(join(DIST, sheet), "utf8").matchAll(/@font-face\s*\{([^}]*)\}/g)].flatMap(([, body = ""]) => {
      const url = /url\(\/?(assets\/[^)]+\.woff2)\)/.exec(body)?.[1];
      const range = /unicode-range:\s*([^;}]+)/.exec(body)?.[1];
      return url && (!range || coversCodePoint(range, LATIN_PROBE)) ? [url] : [];
    }),
  );
  return [...new Set(files)].map((file) => ({ file, bytes: statSync(join(DIST, file)).size }));
}

function percentiles(times: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (p: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 1000) / 1000;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

function bench(docs: readonly SearchDoc[]): { docs: number; indexMs: number; p50: number; p95: number; max: number } {
  const started = performance.now();
  const index = createIndex(docs);
  const indexMs = Math.round((performance.now() - started) * 10) / 10;
  for (const q of QUERIES) searchIndex(index, q); // warm up
  const times = QUERIES.flatMap((q) =>
    Array.from({ length: RUNS_PER_QUERY }, () => {
      const t = performance.now();
      searchIndex(index, q);
      return performance.now() - t;
    }),
  );
  return { docs: docs.length, indexMs, ...percentiles(times) };
}

function main(): void {
  const assets = initialAssets().map((ref) => ({ file: ref.slice(1), gzip: gz(join(DIST, ref)) }));
  const html = gz(join(DIST, "index.html"));
  const js = assets.filter((a) => a.file.endsWith(".js")).reduce((sum, a) => sum + a.gzip, 0);
  const css = assets.filter((a) => a.file.endsWith(".css")).reduce((sum, a) => sum + a.gzip, 0);
  const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
  const system = manifest.systems[0];
  if (!system) throw new Error("the snapshot has no system: run `pnpm data` first");
  const data = gz(join(DATA, "manifest.json")) + gz(join(DATA, system.catalog));
  const usage = system.usage.reduce((sum, u) => sum + gz(join(DATA, u.file)), 0);
  const stylesheets = assets.filter((a) => a.file.endsWith(".css")).map((a) => a.file);
  const fontFiles = initialFonts(stylesheets);
  // Fonts declared but none resolved means the accounting broke (a changed URL shape), not that fonts are free.
  if (fontFiles.length === 0 && stylesheets.some((sheet) => readFileSync(join(DIST, sheet), "utf8").includes("@font-face"))) {
    throw new Error("the initial stylesheets declare @font-face but no Latin font file was resolved: fix initialFonts before trusting the total");
  }
  const fonts = fontFiles.reduce((sum, f) => sum + f.bytes, 0);
  const total = kb(html + js + css + data + fonts);

  const chunks = readdirSync(join(DIST, "assets"))
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => ({ file: `assets/${f}`, raw: statSync(join(DIST, "assets", f)).size, gzip: gz(join(DIST, "assets", f)) }))
    .sort((a, b) => b.gzip - a.gzip);

  const catalog = JSON.parse(readFileSync(join(DATA, system.catalog), "utf8")) as Catalog;
  const docs = toSearchDocs(buildModel(catalog, manifest));
  const scaled = Array.from({ length: SCALE }, (_, i) => docs.map((d) => ({ ...d, id: `${d.id}#${i}`, name: `${d.name}${i}` }))).flat();

  const search = { system: bench(docs), scaled: { factor: SCALE, ...bench(scaled) } };
  const report = {
    budgets: { ...BUDGET, navigationNote: "navigation is measured in the browser (Home → Speed), not by this script" },
    initial: {
      boundary: "first route: index.html + entry JS/CSS + modulepreloads + manifest + catalog + Latin font files (woff2 as is, the rest gzip -9)",
      htmlKbGzip: kb(html),
      jsKbGzip: kb(js),
      cssKbGzip: kb(css),
      snapshotKbGzip: kb(data),
      fontsKb: kb(fonts),
      totalKb: total,
      withinTarget: total <= BUDGET.initialKbTarget,
      withinCeiling: total <= BUDGET.initialKbCeiling,
      assets: assets.map((a) => ({ file: a.file, kbGzip: kb(a.gzip) })),
      fonts: fontFiles.map((f) => ({ file: f.file, kb: kb(f.bytes) })),
    },
    later: { usageMapsKbGzip: kb(usage), note: "Usage maps load after first paint (idle) or when a usage view opens; route chunks preload on hover, focus and idle." },
    chunks: chunks.map((c) => ({ file: c.file, kbRaw: kb(c.raw), kbGzip: kb(c.gzip) })),
    search,
  };

  mkdirSync(join(APP, "perf"), { recursive: true });
  writeFileSync(join(APP, "perf/report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const { initial } = report;
  const failures = [
    ...(initial.withinCeiling ? [] : [`initial download ${initial.totalKb} KB grew past the accepted ${BUDGET.initialKbCeiling} KB (perf/budget.json)`]),
    ...(search.system.p95 <= BUDGET.searchMs ? [] : [`search p95 ${search.system.p95} ms is over the ${BUDGET.searchMs} ms budget`]),
  ];
  process.stdout.write(
    [
      `initial (first route) ${initial.totalKb} KB = HTML ${initial.htmlKbGzip} + JS ${initial.jsKbGzip} + CSS ${initial.cssKbGzip} + snapshot ${initial.snapshotKbGzip} + fonts ${initial.fontsKb}`,
      `  target ${BUDGET.initialKbTarget} KB: ${initial.withinTarget ? "met" : `NOT MET (over by ${kb((initial.totalKb - BUDGET.initialKbTarget) * 1024)} KB)`} · accepted ceiling ${BUDGET.initialKbCeiling} KB: ${initial.withinCeiling ? "OK" : "REGRESSION"}`,
      `search ${catalog.system.name} (${search.system.docs} docs): p50 ${search.system.p50} ms, p95 ${search.system.p95} ms, max ${search.system.max} ms (budget ${BUDGET.searchMs})`,
      `search ${SCALE}x (${search.scaled.docs} docs): index ${search.scaled.indexMs} ms, p50 ${search.scaled.p50} ms, p95 ${search.scaled.p95} ms`,
      "wrote perf/report.json",
      ...failures.map((f) => `FAIL ${f}`),
    ].join("\n") + "\n",
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
