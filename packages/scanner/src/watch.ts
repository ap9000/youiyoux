/**
 * Watch mode: re-run a job (a check, a snapshot) whenever the project's sources or
 * the design definitions change.
 *
 * - Edits are debounced and coalesced: a burst of saves is one run, and changes that
 *   land while a run is in flight are folded into exactly one follow-up run.
 * - Source edits reuse the scan cache, which re-analyses only the edited files and the
 *   files that import them (directly or through barrels).
 * - A change to the project config or any definition (tokens, contracts, rules)
 *   reloads the project through the normal loader, which drops every derived cache.
 * - A run that throws (an invalid rule mid-edit, an unreadable file) is a failed
 *   update, and the project stays failed until a reload succeeds: results are never
 *   reported against definitions that no longer load.
 * - A run starts only once the file watchers are live, so an edit is either in that run
 *   or reported by the watchers afterwards; none falls in between (see `whenLive`).
 */
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { matchesAny, toPosix } from "@youiyoux/core";
import { ScanCache } from "./cache.ts";
import { loadProject, PROJECT_FILE, type LoadProjectOptions, type Project } from "./project.ts";

export const DEFAULT_DEBOUNCE_MS = 120;
/** How long a run waits for its watchers to come live before it goes ahead anyway. */
const LIVE_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 50;
const IGNORED = ["**/node_modules/**", "**/.git/**", "**/.youi/**", "**/dist/**"];

export interface WatchOptions<R> {
  readonly root: string;
  readonly load?: LoadProjectOptions;
  readonly debounceMs?: number;
  /** The work to redo on every change; it receives the shared cache so unchanged files are not re-analysed. */
  readonly job: (project: Project, cache: ScanCache, changed: readonly string[]) => Promise<R>;
  readonly onUpdate: (update: WatchUpdate<R>) => void;
  /** Tests only: stands in for `fs.watch`. */
  readonly watch?: typeof watch;
}

interface UpdateBase {
  readonly generation: number;
  /** Project-relative files that changed since the previous run (empty for the first run and reloads). */
  readonly changed: readonly string[];
  /** The project and its definitions were (re)loaded for this run. */
  readonly reloaded: boolean;
  readonly durationMs: number;
}

export type WatchUpdate<R> = (UpdateBase & { readonly status: "ok"; readonly result: R }) | (UpdateBase & { readonly status: "failed"; readonly error: string });

/** The directory a glob can match under: `src/browser/**\/*.tsx` → `src/browser`, `*.tsx` → `.`. */
export function staticBase(glob: string): string {
  const parts = toPosix(glob).split("/");
  const firstMagic = parts.findIndex((p) => /[*?{[]/.test(p));
  const fixed = firstMagic === -1 ? parts.slice(0, -1) : parts.slice(0, firstMagic);
  return fixed.join("/") || ".";
}

/** The smallest set of directories that covers every one given (a parent covers its children). */
function covering(dirs: readonly string[]): string[] {
  const sorted = [...new Set(dirs)].sort((a, b) => a.length - b.length);
  return sorted.filter((dir, i) => !sorted.slice(0, i).some((parent) => dir.startsWith(`${parent}${sep}`)));
}

const defaultWatch: typeof watch = watch;

export class ProjectWatcher<R> {
  private readonly options: WatchOptions<R>;
  private readonly cache = new ScanCache();
  private readonly configFile: string;
  private watchers: FSWatcher[] = [];
  private probeDir: string | null = null;
  private stopProbing: (() => void) | null = null;
  private project: Project | null = null;
  private pending = new Set<string>();
  private reloadPending = true;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private generation = 0;
  private closed = false;

  private constructor(options: WatchOptions<R>) {
    this.options = options;
    this.configFile = resolve(options.load?.configPath ?? join(options.root, PROJECT_FILE));
  }

  /** Run the job once, then again on every change until `close()`. */
  static async start<R>(options: WatchOptions<R>): Promise<ProjectWatcher<R>> {
    const watcher = new ProjectWatcher(options);
    await watcher.runNow();
    return watcher;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopProbing?.();
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.probeDir) rmSync(this.probeDir, { recursive: true, force: true });
    this.probeDir = null;
  }

  /** Resolves once no run is in flight or scheduled. */
  async idle(): Promise<void> {
    while (this.running || this.timer) await (this.running ?? new Promise((done) => setTimeout(done, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)));
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private async runNow(): Promise<void> {
    if (this.running) {
      // Changes that arrived mid-run are already pending; one follow-up run covers them all.
      await this.running;
      if (this.pending.size > 0 || this.reloadPending) this.schedule();
      return;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async runOnce(): Promise<void> {
    const started = performance.now();
    const changed = [...this.pending].sort();
    const reloaded = this.reloadPending;
    this.pending = new Set();
    this.reloadPending = false;
    const generation = ++this.generation;
    const base = (): UpdateBase => ({ generation, changed, reloaded, durationMs: Math.round(performance.now() - started) });
    try {
      if (reloaded || !this.project) {
        this.project = await loadProject(this.options.root, this.options.load ?? {});
        await this.rewatch(this.project);
      }
      const project = this.project;
      this.cache.forget(changed.filter((file) => !existsSync(join(project.root, file))));
      const result = await this.options.job(project, this.cache, changed);
      if (!this.closed) this.options.onUpdate({ ...base(), status: "ok", result });
    } catch (error: unknown) {
      if (reloaded) {
        // Until the definitions load again, every run retries the load (and fails), so nothing is checked against stale rules.
        this.reloadPending = true;
        if (!this.project) this.watchConfigOnly();
      }
      if (!this.closed) this.options.onUpdate({ ...base(), status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async rewatch(project: Project): Promise<void> {
    const watch = this.options.watch ?? defaultWatch;
    for (const w of this.watchers) w.close();
    const { root, config, repo, system } = project;
    const sourceDirs = covering(config.include.map((g) => resolve(root, staticBase(g))).filter((d) => existsSync(d)));
    const definitionDirs = covering([dirname(system.config.tokens), system.config.components, system.config.rules, ...(system.config.design ? [dirname(system.config.design)] : [])].map((p) => resolve(repo.root, p)).filter((d) => existsSync(d) && d !== repo.root));
    const topLevel = [...new Set([repo.root, dirname(this.configFile), root])];
    this.watchers = [
      ...sourceDirs.map((dir) => watch(dir, { recursive: true }, (_event, name) => name && this.sourceChanged(project, join(dir, name.toString())))),
      ...definitionDirs.map((dir) => watch(dir, { recursive: true }, () => this.definitionsChanged())),
      ...topLevel.map((dir) => watch(dir, (_event, name) => name && this.topLevelChanged(project, join(dir, name.toString())))),
    ];
    for (const w of this.watchers) w.on("error", (error) => this.watcherFailed(error));
    await this.whenLive();
  }

  private watchConfigOnly(): void {
    const watch = this.options.watch ?? defaultWatch;
    for (const w of this.watchers) w.close();
    this.watchers = [watch(dirname(this.configFile), { recursive: true }, () => this.definitionsChanged())];
    for (const w of this.watchers) w.on("error", (error) => this.watcherFailed(error));
    void this.whenLive();
  }

  /**
   * Resolves once the watchers just opened report changes. On macOS, fs.watch returns before
   * the FSEvents stream behind it runs: libuv starts it on another thread, and restarts the one
   * stream every watcher shares whenever a watcher opens or closes. An edit in that gap is never
   * reported, and under load the gap outlasts a whole scan. So the last watcher opened watches a
   * private probe directory (never the person's project), and a file there is rewritten until
   * its change arrives: the stream that reports it covers every watcher opened before it. Runs
   * start after this, so they read every edit made before the watchers came live. The probe
   * watcher stays open, because closing it would restart the stream and open a new gap.
   */
  private whenLive(): Promise<void> {
    const watch = this.options.watch ?? defaultWatch;
    this.stopProbing?.();
    if (this.closed) return Promise.resolve();
    this.probeDir ??= mkdtempSync(join(tmpdir(), "youi-watch-probe-"));
    const probe = join(this.probeDir, "probe");
    return new Promise<void>((done) => {
      let writes = 0;
      const stop = (): void => {
        clearInterval(timer);
        if (this.stopProbing === stop) this.stopProbing = null;
        done();
      };
      const write = (): void => {
        if (++writes * PROBE_INTERVAL_MS > LIVE_TIMEOUT_MS) return stop();
        try {
          writeFileSync(probe, String(writes));
        } catch {
          stop();
        }
      };
      this.stopProbing = stop;
      const watcher = watch(this.probeDir!, () => stop());
      watcher.on("error", () => stop());
      this.watchers.push(watcher);
      const timer = setInterval(write, PROBE_INTERVAL_MS);
      write();
    });
  }

  private watcherFailed(error: Error): void {
    if (!this.closed) this.options.onUpdate({ generation: this.generation, status: "failed", error: `file watcher: ${error.message}; changes may be missed until restart`, changed: [], reloaded: false, durationMs: 0 });
  }

  private sourceChanged(project: Project, absolute: string): void {
    const file = toPosix(relative(project.root, absolute));
    const { include, exclude, outputs } = project.config;
    if (file.startsWith("..") || file.startsWith(`${outputs.dir}/`) || matchesAny(file, [...IGNORED, ...exclude]) || !matchesAny(file, include)) return;
    this.pending.add(file);
    this.schedule();
  }

  private topLevelChanged(project: Project, absolute: string): void {
    const { design } = project.system.config;
    const definitions = [this.configFile, resolve(project.repo.root, "youi.config.json"), ...(design ? [resolve(project.repo.root, design)] : [])];
    if (definitions.includes(absolute)) this.definitionsChanged();
    else if (absolute === resolve(project.root, project.config.tsconfig)) {
      this.pending.add(project.config.tsconfig);
      this.schedule();
    }
  }

  private definitionsChanged(): void {
    this.reloadPending = true;
    this.schedule();
  }
}
