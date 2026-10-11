/**
 * Measures the budgets and records them in perf/report.json:
 *
 *   pnpm build && pnpm measure
 *
 * - Initial download: the gzipped JS and CSS that dist/index.html loads before
 *   anything else (entry script, modulepreloads, stylesheets), and the snapshot
 *   the first screen fetches (manifest + catalog). Fonts are listed separately.
 * - Search: query latency of the same engine the worker runs, on the default
 *   snapshot and on a 50× synthetic catalog to show headroom.
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
const BUDGET = { initialKbGzip: 150, searchMs: 50 } as const;
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
  const js = assets.filter((a) => a.file.endsWith(".js")).reduce((sum, a) => sum + a.gzip, 0);
  const css = assets.filter((a) => a.file.endsWith(".css")).reduce((sum, a) => sum + a.gzip, 0);
  const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
  const system = manifest.systems[0]!;
  const data = gz(join(DATA, "manifest.json")) + gz(join(DATA, system.catalog));
  const usage = system.usage.reduce((sum, u) => sum + gz(join(DATA, u.file)), 0);

  const chunks = readdirSync(join(DIST, "assets"))
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => ({ file: `assets/${f}`, raw: statSync(join(DIST, "assets", f)).size, gzip: gz(join(DIST, "assets", f)) }))
    .sort((a, b) => b.gzip - a.gzip);
  const fonts = readdirSync(join(DIST, "assets"))
    .filter((f) => f.endsWith(".woff2") && f.includes("-latin-wght"))
    .map((f) => ({ file: `assets/${f}`, bytes: statSync(join(DIST, "assets", f)).size }));

  const catalog = JSON.parse(readFileSync(join(DATA, system.catalog), "utf8")) as Catalog;
  const docs = toSearchDocs(buildModel(catalog, manifest));
  const scaled = Array.from({ length: SCALE }, (_, i) => docs.map((d) => ({ ...d, id: `${d.id}#${i}`, name: `${d.name}${i}` }))).flat();

  const report = {
    budgets: BUDGET,
    initial: {
      jsKbGzip: kb(js),
      cssKbGzip: kb(css),
      totalKbGzip: kb(js + css),
      withSnapshotKbGzip: kb(js + css + data),
      withinBudget: kb(js + css + data) <= BUDGET.initialKbGzip,
      assets: assets.map((a) => ({ file: a.file, kbGzip: kb(a.gzip) })),
    },
    snapshot: { catalogAndManifestKbGzip: kb(data), usageMapsKbGzip: kb(usage), note: "Usage maps load after first paint (idle) or when a usage view opens." },
    fontsLatinKb: fonts.map((f) => ({ file: f.file, kb: kb(f.bytes) })),
    chunks: chunks.map((c) => ({ file: c.file, kbRaw: kb(c.raw), kbGzip: kb(c.gzip) })),
    search: { system: bench(docs), scaled: { factor: SCALE, ...bench(scaled) } },
  };

  mkdirSync(join(APP, "perf"), { recursive: true });
  writeFileSync(join(APP, "perf/report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const { initial, search } = report;
  process.stdout.write(
    [
      `initial JS ${initial.jsKbGzip} KB + CSS ${initial.cssKbGzip} KB = ${initial.totalKbGzip} KB gz; with snapshot ${initial.withSnapshotKbGzip} KB (budget ${BUDGET.initialKbGzip}) ${initial.withinBudget ? "OK" : "OVER"}`,
      `search ${catalog.system.name} (${search.system.docs} docs): p50 ${search.system.p50} ms, p95 ${search.system.p95} ms, max ${search.system.max} ms (budget ${BUDGET.searchMs})`,
      `search ${SCALE}x (${search.scaled.docs} docs): index ${search.scaled.indexMs} ms, p50 ${search.scaled.p50} ms, p95 ${search.scaled.p95} ms`,
      "wrote perf/report.json",
    ].join("\n") + "\n",
  );
}

main();
