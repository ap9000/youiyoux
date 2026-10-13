/**
 * Measures the store at size: 100,000 Library items and an inventory of 5,000 looks, on SQLite
 * and on Postgres (PGlite), and exits 1 when a Discover search on SQLite takes 50 ms or more
 * at the 95th percentile:
 *
 *   node packages/store/bench/library.ts [--items 100000] [--looks 5000] [--runs 5] [--engines sqlite,pglite] [--json]
 *
 * A search is what `youi discover "<need>"` and discover_search do: the store narrows the
 * listings by full-text match (at most 400 per source class), the scorer ranks them, the first
 * page is shaped for output. Each of 20 needs runs `--runs` times after one warm-up; p50, p95
 * and max are over every run. It also times where_used and swap_impact on the 5,000-look graph.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { LibraryEntry } from "@youiyoux/core";
import { CONCEPTS, itemOf, linkCandidates, searchCatalog } from "@youiyoux/discover";
import { inventoryRun, openPglite, openSqlite, type Store } from "../src/index.ts";
import { inventory } from "../test/fixtures.ts";

export const BUDGET_MS = 50;

export const NEEDS = ["command menu", "toast", "date picker", "dialog", "button", "data table", "file upload", "color picker", "otp input", "kanban board", "sidebar", "tooltip", "carousel", "rich text editor", "tabs", "avatar", "badge", "slider", "breadcrumb", "stepper"];

const ADJECTIVES = ["animated", "minimal", "glass", "neon", "retro", "soft", "bold", "compact", "floating", "gradient", "outlined", "split", "stacked", "inline", "nested", "sticky", "draggable", "responsive", "accessible", "themed"];
const EXTRAS = ["hero", "pricing", "footer", "navbar", "testimonial", "feature", "login", "signup", "dashboard", "settings", "profile", "chat", "timeline", "gallery", "faq", "banner", "cta", "stats", "team", "blog"];

/** A deterministic pseudo-random sequence, so every run measures the same catalog. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32);
}

const hex = (seed: number, length: number): string => {
  const next = random(seed);
  return Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join("");
};

/** `count` listings shaped like Discover's: about 1% official, 70% community registries, the rest npm packages. */
export function synthesizeLibrary(count: number): LibraryEntry[] {
  const next = random(42);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const entries: LibraryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const concept = pick(CONCEPTS);
    const noun = next() < 0.7 ? pick(concept.names) : pick(EXTRAS);
    const name = `${pick(ADJECTIVES)}-${noun.replace(/ /g, "-")}-${i}`;
    const roll = next();
    const kind = roll < 0.01 ? "official" : roll < 0.71 ? "community" : "npm";
    const registry = kind === "official" ? "@shadcn" : `@reg${Math.floor(next() * 300)}`;
    const packages = concept.packages.length && next() < 0.3 ? [pick(concept.packages)] : [];
    const summary = `A ${pick(ADJECTIVES)} ${noun} for React with ${pick(EXTRAS)} support${next() < 0.2 ? ` and a ${pick(CONCEPTS).names[0]}` : ""}.`;
    const entry: LibraryEntry = {
      schema: "youi.library/v1",
      id: `lib:${kind === "npm" ? "npm" : registry.slice(1)}/${next() < 0.85 ? "component" : "pattern"}/${name}`,
      name: kind === "npm" ? name : name,
      title: next() < 0.6 ? noun.replace(/\b\w/g, (c) => c.toUpperCase()) : undefined,
      kind: next() < 0.85 ? "component" : "pattern",
      summary,
      source: kind === "npm" ? { kind: "npm", name: "npm", ref: name, url: `https://www.npmjs.com/package/${name}`, ingestedAt: "2026-10-12T00:00:00.000Z" } : { kind: "shadcn-registry", name: registry, ref: `${registry}/${name}`, url: `https://example.test/r/${name}.json`, ingestedAt: "2026-10-12T00:00:00.000Z" },
      categories: next() < 0.5 ? [concept.id] : [],
      license: next() < 0.6 ? { spdx: "MIT", evidenceUrl: "https://example.test/license", verifiedAt: "2026-10-12T00:00:00.000Z" } : "unknown",
      install: { command: kind === "npm" ? `npm install ${name}` : `npx shadcn add ${registry}/${name}`, npm: packages, registryDeps: [], implicitDeps: [] },
      signals: { weeklyDownloads: kind === "npm" ? Math.floor(next() * 1_000_000) : null, stars: next() < 0.3 ? Math.floor(next() * 50_000) : null, pushedAt: null, archived: next() < 0.02, package: null, repo: null },
      // As large as a real listing (about 1 KB): provenance with its file hashes and the registry's health.
      stage: "library",
      swapsWith: [],
      provenance: { fetchedAt: "2026-10-12T00:00:00.000Z", url: `https://example.test/${registry.slice(1)}/r/registry.json`, sha256: hex(i, 64), files: [{ path: `registry/default/ui/${name}.tsx`, sha256: hex(i + 1, 64) }, ...(next() < 0.4 ? [{ path: `registry/default/hooks/use-${name}.ts`, sha256: hex(i + 2, 64) }] : [])], registryHealth: kind === "community" ? { status: "healthy", score: Math.round(next() * 100), checkedAt: "2026-10-12T00:00:00.000Z" } : null },
    };
    entries.push(entry);
  }
  return entries;
}

export interface EngineResult {
  readonly engine: string;
  readonly items: number;
  readonly looks: number;
  readonly loadMs: number;
  readonly search: { readonly p50: number; readonly p95: number; readonly max: number; readonly runs: number };
  readonly graph: { readonly whereUsedMs: number; readonly swapImpactMs: number };
  /** Matches per need on the last run, to show the searches had work to do. */
  readonly matched: Readonly<Record<string, number>>;
}

const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
const round = (n: number): number => Math.round(n * 100) / 100;

export async function measureEngine(engine: string, store: Store, entries: readonly LibraryEntry[], looks: number, runs: number): Promise<EngineResult> {
  const started = performance.now();
  await store.replaceDiscoverItems("chosen", entries.map((e) => itemOf(e, "chosen", "2026-10-12T00:00:00.000Z")));
  const report = inventory("2026-10-12T09:00:00.000Z", Math.max(0, looks - 4));
  await store.recordInventory(inventoryRun(report, "/bench/inventory.json"));
  await linkCandidates(store);
  const loadMs = performance.now() - started;

  const times: number[] = [];
  const matched: Record<string, number> = {};
  for (const need of NEEDS) await searchCatalog(store, need);
  for (let run = 0; run < runs; run++) {
    for (const need of NEEDS) {
      const t = performance.now();
      const result = await searchCatalog(store, need);
      times.push(performance.now() - t);
      matched[need] = result.matched;
    }
  }
  times.sort((a, b) => a - b);
  let t = performance.now();
  await store.whereUsed("button-1");
  const whereUsedMs = performance.now() - t;
  const candidate = (await store.nodesOfKind("candidate"))[0]?.ref ?? "lib:shadcn/component/button";
  t = performance.now();
  await store.swapImpact(candidate, "button-1");
  const swapImpactMs = performance.now() - t;
  return { engine, items: entries.length, looks: report.looks.length, loadMs: Math.round(loadMs), search: { p50: round(percentile(times, 50)), p95: round(percentile(times, 95)), max: round(times.at(-1)!), runs: times.length }, graph: { whereUsedMs: round(whereUsedMs), swapImpactMs: round(swapImpactMs) }, matched };
}

export async function measure(options: { items?: number; looks?: number; runs?: number; engines?: readonly string[] } = {}): Promise<EngineResult[]> {
  const entries = synthesizeLibrary(options.items ?? 100_000);
  const results: EngineResult[] = [];
  for (const engine of options.engines ?? ["sqlite", "pglite"]) {
    const dir = await mkdtemp(join(tmpdir(), "youi-bench-"));
    const store = engine === "sqlite" ? await openSqlite(join(dir, "index.db")) : await openPglite();
    try {
      results.push(await measureEngine(engine === "sqlite" ? "sqlite" : "postgres (PGlite)", store, entries, options.looks ?? 5_000, options.runs ?? 5));
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { items: { type: "string", default: "100000" }, looks: { type: "string", default: "5000" }, runs: { type: "string", default: "5" }, engines: { type: "string", default: "sqlite,pglite" }, json: { type: "boolean", default: false } } });
  const results = await measure({ items: Number(values.items), looks: Number(values.looks), runs: Number(values.runs), engines: values.engines.split(",") });
  if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else for (const r of results) process.stdout.write(`${r.engine}: ${r.items.toLocaleString("en-US")} items, ${r.looks.toLocaleString("en-US")} looks, loaded in ${r.loadMs} ms; search p50 ${r.search.p50} ms, p95 ${r.search.p95} ms, max ${r.search.max} ms (${r.search.runs} searches); where_used ${r.graph.whereUsedMs} ms, swap_impact ${r.graph.swapImpactMs} ms\n`);
  const sqlite = results.find((r) => r.engine === "sqlite");
  if (sqlite && sqlite.search.p95 >= BUDGET_MS) {
    process.stderr.write(`library bench: SQLite search p95 ${sqlite.search.p95} ms is not under ${BUDGET_MS} ms\n`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
