/**
 * `youiyoux index`: the local store of derived data, and what fills it. Everything in it comes
 * from files the CLI already writes, and is noted beside the store so `youiyoux index rebuild`
 * can replay it after the store is deleted:
 *
 *   index-sources.json  the Discover cache, inventory files and projects recorded so far
 *   scans.jsonl         one line per inventory run (projects, counts, families): the history
 *
 * Decisions (tokens, contracts, rules, adopted Library items, approvals) stay in git: rules are
 * read from the design repo each time, never kept as the authority here.
 */
import { appendFile, mkdir, readFile, stat, rename, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { InventoryReport, ScanReport, writeFileAtomic } from "@youiyoux/core";
import { ingestCatalog, linkCandidates, sharedStore } from "@youiyoux/discover";
import { loadProject, type LoadProjectOptions, type Project } from "@youiyoux/scanner";
import { checkpointSqlite, openSqlite, indexHome, inventoryRun, projectGraph, type InventoryRun, type ScanRecord, type Store } from "@youiyoux/store";
import { padEnd, padStart, plural, style } from "./ui.ts";

export const SOURCES_FILE = "index-sources.json";
export const SCANS_LOG = "scans.jsonl";

export interface ProjectSource {
  readonly root: string;
  readonly options: LoadProjectOptions;
  /** The usage map youiyoux scan wrote (default <root>/.youi/usage.json). */
  readonly usage?: string;
}

export interface IndexSources {
  /** The Discover cache whose catalog the store holds (the last one synced or searched). */
  readonly discover: string | null;
  readonly inventories: readonly string[];
  readonly projects: readonly ProjectSource[];
}

const EMPTY: IndexSources = { discover: null, inventories: [], projects: [] };

export async function readIndexSources(home: string): Promise<IndexSources> {
  try {
    const raw = JSON.parse(await readFile(join(home, SOURCES_FILE), "utf8")) as Partial<IndexSources>;
    return { discover: raw.discover ?? null, inventories: raw.inventories ?? [], projects: raw.projects ?? [] };
  } catch {
    return EMPTY;
  }
}

/** Remember a source for the next rebuild. */
export async function noteSource(home: string, change: { discover?: string; inventory?: string; project?: ProjectSource }): Promise<void> {
  const sources = await readIndexSources(home);
  const next: IndexSources = {
    discover: change.discover ?? sources.discover,
    inventories: change.inventory && !sources.inventories.includes(change.inventory) ? [...sources.inventories, change.inventory] : sources.inventories,
    projects: change.project ? [...sources.projects.filter((p) => p.root !== change.project!.root), change.project] : sources.projects,
  };
  await writeFileAtomic(join(home, SOURCES_FILE), `${JSON.stringify(next, null, 2)}\n`);
}

type LoggedRun = Omit<InventoryRun, "looks" | "graph">;

/** Record an inventory run: into the store, onto the scan log, and its file as a rebuild source. */
export async function recordInventory(store: Store, home: string, report: InventoryReport, file: string): Promise<InventoryRun> {
  const run = inventoryRun(report, resolve(file));
  const logged: LoggedRun = { run: run.run, source: run.source, scannedAt: run.scannedAt, projects: run.projects, families: run.families };
  await mkdir(home, { recursive: true });
  await appendFile(join(home, SCANS_LOG), `${JSON.stringify({ schema: "youi.scan-log/v1", ...logged })}\n`);
  await store.recordInventory(run);
  await noteSource(home, { inventory: run.source });
  await linkCandidates(store);
  return run;
}

/** A project's rules and its usage map (.youi/usage.json, written by youiyoux scan) as graph edges. */
export async function recordProject(store: Store, project: Project, usage: ScanReport | null): Promise<void> {
  await store.replaceGraph(`project:${project.root}`, projectGraph({ project: project.config.id, rules: project.system.rules, components: project.system.components.map((c) => ({ id: c.contract.id, name: c.contract.name })), usage }));
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readLog(home: string): Promise<LoggedRun[]> {
  const text = await readFile(join(home, SCANS_LOG), "utf8").catch(() => "");
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const entry = JSON.parse(line) as LoggedRun & { schema?: string };
      return entry.schema === "youi.scan-log/v1" ? [entry] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
}

export interface RebuildSummary {
  readonly location: string;
  readonly discover: { readonly cache: string | null; readonly chosen: number; readonly all: number };
  readonly scans: number;
  readonly inventories: { readonly replayed: number; readonly missing: readonly string[] };
  readonly projects: { readonly replayed: number; readonly failed: ReadonlyArray<{ readonly root: string; readonly reason: string }> };
  readonly tables: Readonly<Record<string, number>>;
  readonly durationMs: number;
}

/**
 * Build a replacement store from its sources and publish it with an atomic rename: the Discover catalog's JSON, the scan
 * log, the inventory files still on disk, and each recorded project's rules and usage map.
 * On Postgres the rows are removed instead of a file.
 */
export async function rebuildIndex(path: string, options: { discoverCache?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RebuildSummary> {
  const started = performance.now();
  const env = options.env ?? process.env;
  const home = indexHome(path, env);
  await mkdir(dirname(path), { recursive: true });
  const scratch = !env.DATABASE_URL ? await mkdtemp(`${path}.rebuild-`) : null;
  const target = scratch ? join(scratch, "index.db") : path;
  const store = scratch ? await openSqlite(target) : await sharedStore(path, env);
  try {
    if (env.DATABASE_URL) await store.reset();
    await store.setMeta("generation", crypto.randomUUID());
    const sources = await readIndexSources(home);

    const cache = options.discoverCache ?? sources.discover;
    let discover = { cache, chosen: 0, all: 0 };
    if (cache && (await stat(join(cache, "index.json")).then(() => true, () => false))) {
      const loaded = await ingestCatalog(store, cache);
      discover = { cache, chosen: loaded.chosen, all: loaded.all };
    }

    // The history first, oldest to newest; then each inventory file still on disk gives its looks and graph back.
    const log = await readLog(home);
    for (const entry of log) await store.recordInventory({ ...entry, looks: [], graph: { nodes: [], edges: [] } });
    const missing: string[] = [];
    let replayed = 0;
    for (const file of sources.inventories) {
      const parsed = InventoryReport.safeParse(await readJsonFile(file));
      if (!parsed.success) {
        missing.push(file);
        continue;
      }
      await store.recordInventory(inventoryRun(parsed.data, file));
      replayed++;
    }

    const failed: Array<{ root: string; reason: string }> = [];
    let projects = 0;
    const gone: string[] = [];
    for (const source of sources.projects) {
      // A project moved or deleted since it was recorded is skipped and reported, never a reason to refuse the rebuild.
      if (!(await stat(source.root).then((s) => s.isDirectory(), () => false))) {
        gone.push(source.root);
        failed.push({ root: source.root, reason: "folder not found (moved or deleted), skipped" });
        continue;
      }
      try {
        const project = await loadProject(source.root, source.options);
        const usage = ScanReport.safeParse(await readJsonFile(source.usage ?? join(project.root, ".youi/usage.json")));
        await recordProject(store, project, usage.success ? usage.data : null);
        projects++;
      } catch (error: unknown) {
        failed.push({ root: source.root, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      }
    }
    const broken = failed.filter((f) => !gone.includes(f.root));
    if (broken.length) throw new Error(`Index rebuild failed: ${broken.map((f) => `${f.root}: ${f.reason}`).join("; ")}`);
    await linkCandidates(store);
    const tables = (await store.stats()).tables;
    if (scratch) {
      await store.close();
      checkpointSqlite(target);
      // No WAL pages may be left behind at the published name. Existing readers retain
      // their old descriptors until their next call detects the changed inode.
      if (await stat(path).then(() => true, () => false)) checkpointSqlite(path);
      const moved: string[] = [];
      try {
        for (const suffix of ["-wal", "-shm"]) {
          try { await rename(`${path}${suffix}`, `${target}.old${suffix}`); moved.push(suffix); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        await rename(target, path);
      } catch (error) {
        for (const suffix of moved) await rename(`${target}.old${suffix}`, `${path}${suffix}`);
        throw error;
      }
    }
    return { location: scratch ? path : store.location, discover, scans: log.length, inventories: { replayed, missing }, projects: { replayed: projects, failed }, tables, durationMs: Math.round(performance.now() - started) };
  } finally {
    if (scratch) { await store.close(); await rm(scratch, { recursive: true, force: true }); }
  }
}

/* ------------------------------------------------------------------- output */

export function renderRebuild(summary: RebuildSummary): string {
  const t = summary.tables;
  return [
    `${style.ok("rebuilt")} ${summary.location} ${style.dim(`in ${summary.durationMs} ms`)}`,
    `  discover    ${summary.discover.cache ? `${plural(summary.discover.chosen, "listing")} · ${summary.discover.all} from --all ${style.dim(`(${summary.discover.cache})`)}` : style.dim("no Discover catalog yet (youiyoux discover sync)")}`,
    `  history     ${plural(summary.scans, "inventory run")} replayed · ${plural(t.scans ?? 0, "scan")} by project`,
    `  inventory   ${plural(summary.inventories.replayed, "file")} replayed${summary.inventories.missing.length ? style.warn(` · ${summary.inventories.missing.length} gone (history kept, looks not)`) : ""}`,
    `  projects    ${plural(summary.projects.replayed, "project")} (rules and usage)`,
    ...summary.projects.failed.map((f) => style.warn(`  ! ${f.root}: ${f.reason}`)),
    `  graph       ${plural(t.nodes ?? 0, "node")} · ${plural(t.edges ?? 0, "edge")}`,
  ].join("\n");
}

const delta = (now: number, before: number | undefined): string => (before === undefined || now === before ? "" : now > before ? style.warn(` +${now - before}`) : style.ok(` −${before - now}`));

/** Trends per project, newest first: looks, families and near-duplicates, with the change since the scan before. */
export function renderHistory(scans: readonly ScanRecord[]): string {
  if (scans.length === 0) return style.dim("no inventory history yet: youiyoux inventory records each scan");
  const lines = [`${style.bold("inventory history")} ${style.dim(`· ${plural(scans.length, "scan")}`)}`, ""];
  const projects = [...new Set(scans.map((s) => s.project))];
  for (const project of projects) {
    const own = scans.filter((s) => s.project === project);
    lines.push(style.bold(project));
    own.forEach((s, i) => {
      const before = own[i + 1];
      lines.push(`  ${padEnd(s.scannedAt.slice(0, 16).replace("T", " "), 17)} ${padEnd(s.commit ? s.commit.slice(0, 7) : "-", 8)} ${padStart(plural(s.looks, "look"), 11)}${delta(s.looks, before?.looks)}  ${plural(s.families, "family", "families")}${delta(s.families, before?.families)}  ${plural(s.nearDuplicates, "near-duplicate")}${delta(s.nearDuplicates, before?.nearDuplicates)}${s.status === "partial" ? style.warn("  partial") : ""}`);
    });
  }
  return lines.join("\n");
}
