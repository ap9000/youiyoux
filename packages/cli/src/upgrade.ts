/**
 * `youiyoux upgrade`: move a product to its System's new release in one step. What changes is
 * worked out in memory first, and nothing is written unless all of it holds:
 *
 *   sync        what a sync would bring (a git source's ref is resolved again, or --to's); a
 *               conflict in an owned component stops the upgrade
 *   migrations  each component's migrations past the version the lockfile records, up to the
 *               release's, in order, run as gated dry runs on the components as the sync would
 *               leave them (staged scans), each on the sources the one before it would write
 *
 * Without --write it is a preview. With it: the config's ref (for --to), the sync, then every
 * migration again on the written files, gated again; if any step fails, every file the upgrade
 * wrote is put back as it was.
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTextOrNull, unifiedDiff, writeFileAtomic, type LockFile, type MigrationSpec } from "@youiyoux/core";
import { PROJECT_FILE, runMigration, vendoredPath, type MigrationResult, type Project } from "@youiyoux/scanner";
import { readLock, syncProject, type SyncAction } from "./sync.ts";
import { padEnd, plural, style } from "./ui.ts";

const LOCK_FILE = "youi.lock.json";
const WRITES = new Set<SyncAction["action"]>(["created", "updated", "merged", "adopted", "removed"]);

export interface UpgradeOptions {
  /** Write it (default: a preview that writes nothing). */
  readonly write?: boolean;
  /** The git ref the product moves to; written to the config's source.ref with --write. */
  readonly to?: string;
}

export interface PlannedMigration {
  readonly spec: MigrationSpec;
  /** The component's version when this migration runs: the lockfile's, or the previous migration's `to`. */
  readonly at: string;
  /** `from` does not admit `at`: the component would be migrated from a version the migration was not written for. */
  readonly mismatch: boolean;
}

export interface UpgradeResult {
  readonly status: "current" | "preview" | "upgraded" | "blocked";
  readonly system: { readonly id: string; readonly name: string };
  readonly from: { readonly version: string | null; readonly commit: string | null };
  readonly to: { readonly version: string; readonly commit: string | null; readonly ref: string | null };
  /** What the sync writes (or would): unchanged and kept files left out. */
  readonly sync: readonly SyncAction[];
  readonly migrations: readonly MigrationResult[];
  /** Why nothing was written; empty unless blocked. */
  readonly blocked: readonly string[];
  readonly next: string;
}

/** a.b.c, numerically; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number[], string] => {
    const [core = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
    return [core.split(".").slice(0, 3).map((n) => Number(n) || 0), pre];
  };
  const [[x, xp], [y, yp]] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  if (xp === yp) return 0;
  return xp === "" ? 1 : yp === "" ? -1 : xp < yp ? -1 : 1;
}

/**
 * Does a migration's `from` admit a version? `1.x`, `1.2.x`, `*`, an exact version, `^1.2.0`,
 * `~1.2.0`, `>=1.2.0` and `<2.0.0` (space-separated: all must hold). Null: not a range this reads.
 */
export function admits(range: string, version: string): boolean | null {
  const parts = range.trim().split(/\s+/);
  const results = parts.map((part): boolean | null => {
    if (part === "*" || part === "x") return true;
    const xr = /^v?(\d+)(?:\.(\d+|x))?(?:\.(x))?$/.exec(part);
    if (xr && (xr[2] === "x" || xr[3] === "x" || xr[2] === undefined)) {
      const [major, minor] = version.split(".").map(Number);
      return major === Number(xr[1]) && (xr[2] === undefined || xr[2] === "x" || minor === Number(xr[2]));
    }
    const op = /^(\^|~|>=|<=|>|<|=)?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(part);
    if (!op) return null;
    const [, kind = "=", base = ""] = op;
    const cmp = compareVersions(version, base);
    const [bMajor, bMinor] = base.split(".").map(Number);
    const [vMajor, vMinor] = version.split(".").map(Number);
    if (kind === "^") return cmp >= 0 && (bMajor === 0 ? vMajor === 0 && vMinor === bMinor : vMajor === bMajor);
    if (kind === "~") return cmp >= 0 && vMajor === bMajor && vMinor === bMinor;
    return { "=": cmp === 0, ">=": cmp >= 0, "<=": cmp <= 0, ">": cmp > 0, "<": cmp < 0 }[kind] ?? null;
  });
  return results.includes(null) ? null : results.every(Boolean);
}

/**
 * The migrations an upgrade runs: for each component the lockfile vendored, those whose `to` is
 * past the version it records and no further than the release's, oldest first. A component
 * the product has not had yet, or one held in place (adopt), has nothing to migrate from.
 */
export function pendingMigrations(project: Project, lock: LockFile): PlannedMigration[] {
  const entries = Object.entries(lock.files).flatMap(([file, entry]) => (entry.kind === "vendored" ? [{ file, ...entry }] : []));
  const planned: PlannedMigration[] = [];
  for (const { contract, migrations } of project.system.components) {
    // The component's own file, else (a file renamed in this release) the narrowest entry naming it: support files name every component.
    const entry = entries.find((e) => e.file === vendoredPath(project, contract.source.file) && e.elements.includes(contract.id)) ?? entries.filter((e) => e.elements.includes(contract.id)).sort((a, b) => a.elements.length - b.elements.length)[0];
    if (!entry) continue;
    let at = entry.version;
    for (const spec of [...migrations].filter((m) => compareVersions(m.to, entry.version) > 0 && compareVersions(m.to, contract.version) <= 0).sort((a, b) => compareVersions(a.to, b.to) || a.id.localeCompare(b.id))) {
      planned.push({ spec, at, mismatch: admits(spec.from, at) === false });
      at = spec.to;
    }
  }
  return planned.sort((a, b) => compareVersions(a.spec.to, b.spec.to) || a.spec.id.localeCompare(b.spec.id));
}

/** Every file a step may write, as it is now (null: not there), so a failed upgrade can put each back. */
class Snapshot {
  private readonly saved = new Map<string, string | null>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async keep(files: Iterable<string>): Promise<void> {
    for (const file of files) if (!this.saved.has(file)) this.saved.set(file, await readTextOrNull(join(this.root, file)));
  }
  /** A file's content before a step wrote it, unless it was kept already. */
  remember(file: string, content: string): void {
    if (!this.saved.has(file)) this.saved.set(file, content);
  }
  /** Put back each file that changed; those that could not be are returned, to name them. */
  async restore(): Promise<string[]> {
    const stuck: string[] = [];
    for (const [file, content] of this.saved) {
      const path = join(this.root, file);
      try {
        if (content !== null) {
          if ((await readTextOrNull(path)) !== content) await writeFileAtomic(path, content);
        } else if (await lstat(path).then((s) => s.isFile(), () => false)) await rm(path);
      } catch {
        stuck.push(file);
      }
    }
    return stuck;
  }
}

const gateFailures = (result: MigrationResult): string => result.gates.filter((g) => !g.ok).map((g) => `${g.name}: ${g.detail}`).join("; ");

/** The config with source.ref moved to `ref`, the rest kept as written. */
async function withRef(configFile: string, ref: string): Promise<string> {
  const text = (await readTextOrNull(configFile)) ?? "{}";
  const config = JSON.parse(text) as { source?: Record<string, unknown> };
  return `${JSON.stringify({ ...config, source: { ...config.source, ref } }, null, 2)}\n`;
}

export async function upgradeProject(project: Project, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const lock = await readLock(project.root);
  const source = project.config.source;
  const system = { id: project.system.config.id, name: project.system.config.name };
  const to = { version: project.system.config.version, commit: project.designCommit ?? null, ref: options.to ?? ("git" in source ? source.ref : null) };
  const from = { version: lock?.systemVersion ?? null, commit: lock?.sourceCommit ?? null };
  const result = (status: UpgradeResult["status"], parts: Partial<Pick<UpgradeResult, "sync" | "migrations" | "blocked">>, next: string): UpgradeResult => ({ status, system, from, to, sync: parts.sync ?? [], migrations: parts.migrations ?? [], blocked: parts.blocked ?? [], next });

  if (!lock) return result("blocked", { blocked: ["this product has never been synced with its System, so there is no earlier version to upgrade from"] }, "youiyoux sync");
  if (lock.system !== system.id) return result("blocked", { blocked: [`youi.lock.json is for System ${lock.system}, and the config names ${system.id}: an upgrade moves within one System`] }, "youiyoux sync, to switch Systems");

  const dry = await syncProject(project, { dryRun: true });
  const conflicts = dry.actions.filter((a) => a.action === "conflict");
  const sync = dry.actions.filter((a) => WRITES.has(a.action) || a.action === "conflict" || a.action === "kept-local");
  const planned = pendingMigrations(project, lock);
  const blocked = [
    ...conflicts.map((a) => `${a.file}: ${a.detail ?? "conflicts with upstream"}`),
    ...planned.filter((p) => p.mismatch).map((p) => `${p.spec.id} migrates from ${p.spec.from}, but ${p.spec.element} would be at ${p.at} here: no migration takes it from ${p.at} to ${p.spec.from}`),
  ];
  if (blocked.length > 0) return result("blocked", { sync, blocked }, conflicts.length > 0 ? "youiyoux sync: resolve the conflicts it reports, then youiyoux sync --adopt records them, then youiyoux upgrade" : "ask the System's owners for the missing migration, or migrate by hand, then youiyoux sync");

  // The migrations, in memory, on the components as the sync would vendor them; each on the sources the one before would write.
  let staged: Record<string, string> = Object.fromEntries(dry.actions.filter((a) => a.role === "component" && dry.contents.has(a.file)).map((a) => [a.file, dry.contents.get(a.file)!]));
  const previews: MigrationResult[] = [];
  for (const { spec } of planned) {
    const preview = await runMigration({ ...project, staged }, spec);
    previews.push(preview);
    if (preview.status === "rejected") return result("blocked", { sync, migrations: previews, blocked: [`${spec.id} would not hold: ${gateFailures(preview)}`] }, "fix what the failing gate names, or ask the System's owners; nothing was written");
    staged = { ...staged, ...Object.fromEntries(preview.changes.map((c) => [c.file, c.after])) };
  }

  const ref = options.to !== undefined && "git" in source && options.to !== source.ref ? options.to : null;
  const changes = sync.some((a) => WRITES.has(a.action)) || previews.some((m) => m.status !== "noop") || ref !== null || lock.systemVersion !== to.version;
  if (!changes) return result("current", { sync, migrations: previews }, "nothing to do");
  if (!options.write) return result("preview", { sync, migrations: previews }, `youiyoux upgrade${options.to !== undefined ? ` --to ${options.to}` : ""} --write`);

  // Write: every file any step may touch is kept first, so a step that fails puts them all back.
  const configFile = project.configFile ?? join(project.root, PROJECT_FILE);
  const snapshot = new Snapshot(project.root);
  const configBefore = await readTextOrNull(configFile);
  await snapshot.keep([LOCK_FILE, ...dry.contents.keys(), ...dry.actions.filter((a) => a.action === "removed").map((a) => a.file), ...previews.flatMap((m) => m.changes.map((c) => c.file))]);
  const fail = async (why: string, done: Partial<Pick<UpgradeResult, "sync" | "migrations">>): Promise<UpgradeResult> => {
    const stuck = await snapshot.restore();
    if (ref !== null && configBefore !== null) await writeFileAtomic(configFile, configBefore).catch(() => stuck.push(PROJECT_FILE));
    const back = stuck.length === 0 ? "every file the upgrade wrote was put back" : `the files it wrote were put back except ${stuck.join(", ")}: restore those from git`;
    return result("blocked", { sync, migrations: previews, ...done, blocked: [`${why}; ${back}`] }, "run youiyoux upgrade again to see what changed");
  };
  try {
    if (ref !== null) await writeFileAtomic(configFile, await withRef(configFile, ref));
    const synced = await syncProject(project);
    const late = synced.actions.filter((a) => a.action === "conflict");
    if (late.length > 0) return await fail(`the sync conflicted in ${late.map((a) => a.file).join(", ")}`, {});
    const applied: MigrationResult[] = [];
    for (const { spec } of planned) {
      const run = await runMigration(project, spec, { write: true });
      applied.push(run);
      // A file the preview did not touch is put back too, should this run have written one.
      for (const change of run.changes) snapshot.remember(change.file, change.before);
      if (run.status === "rejected") return await fail(`${spec.id} did not hold on the written files: ${gateFailures(run)}`, { migrations: applied });
    }
    const residuals = applied.reduce((n, m) => n + m.residuals.length, 0);
    return result("upgraded", { sync: synced.actions.filter((a) => WRITES.has(a.action) || a.action === "kept-local"), migrations: applied }, residuals > 0 ? `fix the ${residuals === 1 ? "site" : `${residuals} sites`} listed for a person, then youiyoux check` : "youiyoux check");
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error), {});
  }
}

const ACTION = { created: style.ok, updated: style.live, merged: style.live, adopted: style.ok, removed: style.live, "kept-local": style.warn, conflict: style.error } as Partial<Record<SyncAction["action"], (s: string) => string>>;

export function renderUpgrade(r: UpgradeResult, showDiff: boolean): string {
  const version = (v: string | null): string => (v === null ? "never synced" : `v${v}`);
  const move = r.from.version === r.to.version ? `${version(r.to.version)}${r.from.commit && r.to.commit && r.from.commit !== r.to.commit ? style.dim(` (${r.from.commit.slice(0, 7)} → ${r.to.commit.slice(0, 7)})`) : ""}` : `${version(r.from.version)} → v${r.to.version}`;
  const verdict = { current: style.ok("up to date"), preview: style.live("preview: nothing written"), upgraded: style.ok("upgraded"), blocked: style.error("blocked: nothing written") }[r.status];
  const lines = [`${style.accent("upgrade")} ${r.system.name} ${move}${r.to.ref ? style.dim(` · ref ${r.to.ref}`) : ""}  ${verdict}`, ""];
  // Components one per line; the files sync generates in one line (youiyoux sync --dry-run lists each).
  const row = (a: SyncAction): string => `  ${padEnd((ACTION[a.action] ?? style.dim)(a.action), 11)} ${a.file}${a.detail ? style.dim(`  ${a.detail}`) : ""}`;
  const generated = r.sync.filter((a) => a.role !== "component" && a.action !== "conflict");
  lines.push(style.bold("sync"), ...(r.sync.length === 0 ? [style.dim("  nothing to bring")] : r.sync.filter((a) => !generated.includes(a)).map(row)));
  if (generated.length === 1) lines.push(row(generated[0]!));
  else if (generated.length > 1) lines.push(`  ${padEnd(style.live("updated"), 11)} ${plural(generated.length, "generated file")}${style.dim(`  ${generated.slice(0, 3).map((a) => a.file).join(", ")}${generated.length > 3 ? ", …" : ""}`)}`);
  lines.push("", style.bold("migrations"));
  if (r.migrations.length === 0) lines.push(style.dim(r.status === "blocked" && r.sync.length > 0 ? "  not run" : r.status === "current" ? "  none pending" : "  none: no component this product has changed its API in this release"));
  for (const m of r.migrations) {
    const mark = m.status === "rejected" ? style.error("✖") : m.status === "noop" ? style.dim("·") : style.ok("✓");
    const what = m.status === "noop" ? style.dim("nothing here uses what it changes") : `${plural(m.edited, "site")} rewritten in ${plural(m.changes.length, "file")}${m.residuals.length > 0 ? ` · ${style.warn(`${plural(m.residuals.length, "site")} for a person`)}` : ""}`;
    lines.push(`  ${mark} ${m.migration}  ${what}`);
    for (const gate of m.gates.filter((g) => !g.ok)) lines.push(`      ${style.error(gate.name)} ${style.dim(gate.detail)}`);
    for (const residual of m.residuals) lines.push(`      ${style.dim(`${residual.file}:${residual.line}`)}  ${residual.reason}`);
  }
  // One diff per file, from what it is now to what the whole upgrade leaves, however many migrations touch it.
  const files = new Map<string, { before: string; after: string }>();
  for (const change of r.migrations.flatMap((m) => m.changes)) files.set(change.file, { before: files.get(change.file)?.before ?? change.before, after: change.after });
  if (showDiff) for (const [file, { before, after }] of files) lines.push("", ...unifiedDiff(file, before, after).trimEnd().split("\n").map((l) => (l.startsWith("+") && !l.startsWith("+++") ? style.ok(l) : l.startsWith("-") && !l.startsWith("---") ? style.error(l) : style.dim(l))));
  if (r.blocked.length > 0) lines.push("", ...r.blocked.map((b) => `${style.error("✖")} ${b}`));
  lines.push("", `${style.bold("Next:")} ${r.next}`);
  return lines.join("\n");
}
