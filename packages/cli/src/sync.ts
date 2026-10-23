/**
 * `youiyoux sync`: bring a project up to its design language.
 *
 *   generated  token outputs, DESIGN.md, the skill, youi-rules: rewritten every sync
 *   managed    the AGENTS.md block, the .mcp.json entry, the .claude skill link: only our part changes
 *   owned      vendored components: 3-way merged (base = what we last delivered, ours = the
 *              project's file, theirs = upstream now); conflicts never land in source
 *   lock       youi.lock.json records every file's hash, so edits show up as drift
 *   retired    a generated file no longer produced (a rule turned off) is removed, unless edited by hand
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { findFiles, implementationsDir, LockFile, normalizeRelPath, readDefinition, readTextOrNull, sha256, writeFileAtomic, type ElementId, type LockEntry } from "@youiyoux/core";
import { buildTokens } from "@youiyoux/tokens";
import { PROJECT_FILE, vendoredPath, type Project } from "@youiyoux/scanner";
import { TOOL_ROOT } from "./tool.ts";
import { toolCommand } from "./tool-command.ts";
import { agentsBlock, astGrepRules, designMd, GENERATED_MARK, skillMd, unknownToolMentions, upsertBlock, type UnknownToolMention } from "./agents.ts";

const LOCK_FILE = "youi.lock.json";
const BASE_DIR = ".youi/base";
const INCOMING_DIR = ".youi/incoming";
const CONFLICT_DIR = ".youi/conflicts";

type SyncActionKind = "created" | "updated" | "unchanged" | "adopted" | "merged" | "kept-local" | "conflict" | "skipped" | "removed";

export interface SyncAction {
  readonly file: string;
  readonly role: "tokens" | "agents" | "component" | "config";
  readonly action: SyncActionKind;
  readonly detail?: string;
}

export interface SyncOptions {
  /** Report what would change without writing. */
  readonly dryRun?: boolean;
  /** Replace hand-written files we would otherwise skip, and adopt diverged owned files as local forks. */
  readonly adopt?: boolean;
}

export interface SyncResult {
  readonly actions: readonly SyncAction[];
  readonly lock: LockFile;
  /** Rules whose agent instructions name an MCP tool the server does not expose. */
  readonly unknownTools: readonly UnknownToolMention[];
  /** Every file this sync wrote, or would write on a dry run, with its content, by project-relative path. */
  readonly contents: ReadonlyMap<string, string>;
}

const run = promisify(execFile);

async function gitHead(dir: string): Promise<string | null> {
  try {
    return (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** git merge-file: 0 conflicts → merged text; otherwise the text with conflict markers and the count. */
export async function mergeThreeWay(ours: string, base: string, theirs: string): Promise<{ text: string; conflicts: number }> {
  const dir = await mkdtemp(join(tmpdir(), "youi-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n)) as [string, string, string];
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    try {
      const { stdout } = await run("git", ["merge-file", "-p", "-L", "project", "-L", "last sync", "-L", "upstream", o, b, t]);
      return { text: stdout, conflicts: 0 };
    } catch (error: unknown) {
      const failure = error as { code?: number; stdout?: string };
      if (typeof failure.code === "number" && failure.code > 0 && typeof failure.stdout === "string") return { text: failure.stdout, conflicts: failure.code };
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readLock(root: string): Promise<LockFile | null> {
  const text = await readTextOrNull(join(root, LOCK_FILE));
  return text === null ? null : readDefinition(join(root, LOCK_FILE), LockFile, root);
}

class Writer {
  readonly actions: SyncAction[] = [];
  readonly files: Record<string, LockEntry> = {};
  readonly contents = new Map<string, string>();
  private readonly project: Project;
  private readonly options: SyncOptions;
  private readonly previous: LockFile | null;

  constructor(project: Project, options: SyncOptions, previous: LockFile | null) {
    this.project = project;
    this.options = options;
    this.previous = previous;
  }

  private path(file: string): string {
    return join(this.project.root, file);
  }

  async write(file: string, content: string): Promise<void> {
    this.contents.set(file, content);
    if (!this.options.dryRun) await writeFileAtomic(this.path(file), content);
  }

  record(action: SyncAction): void {
    this.actions.push(action);
  }

  async generated(file: string, content: string, role: SyncAction["role"]): Promise<void> {
    const current = await readTextOrNull(this.path(file));
    const locked = this.previous?.files[file];
    this.files[file] = { kind: "generated", sha256: sha256(content) };
    if (current === content) return this.record({ file, role, action: "unchanged" });
    if (current !== null && !locked && !current.includes(GENERATED_MARK) && !this.options.adopt) {
      delete this.files[file];
      return this.record({ file, role, action: "skipped", detail: "hand-written file in the way; `youiyoux sync --adopt` replaces it" });
    }
    const edited = current !== null && locked !== undefined && sha256(current) !== locked.sha256;
    await this.write(file, content);
    this.record({ file, role, action: current === null ? "created" : "updated", ...(edited ? { detail: "had local edits; generated files are rewritten (change the design language instead)" } : {}) });
  }

  /**
   * Owned files are compared with the base: the upstream content youi last delivered (kept in
   * .youi/base). Equal to base means untouched, so upstream may replace it. Anything else holds
   * local edits, which are merged 3-way and never overwritten. `--adopt` records the project's
   * file as a fork of the current upstream (to adopt a diverged file or settle a conflict).
   */
  async owned(file: string, upstream: string, elements: ElementId[], version: string): Promise<void> {
    const local = await readTextOrNull(this.path(file));
    const locked = this.previous?.files[file];
    const recorded = locked?.kind === "vendored" ? await readTextOrNull(this.path(`${BASE_DIR}/${file}`)) : null;
    const base = recorded !== null && locked?.kind === "vendored" && sha256(recorded) === locked.baseSha256 ? recorded : null;
    const record = (action: SyncActionKind, detail?: string): void => this.record({ file, role: "component", action, ...(detail ? { detail } : {}) });
    const settle = async (text: string, action: SyncActionKind, detail?: string): Promise<void> => {
      if (text !== local) await this.write(file, text);
      if (upstream !== base) await this.write(`${BASE_DIR}/${file}`, upstream);
      this.files[file] = { kind: "vendored", elements, version, sha256: sha256(text), baseSha256: sha256(upstream) };
      record(action, detail);
    };
    if (local === null) return settle(upstream, "created");
    if (local === upstream) return settle(upstream, base === null ? "adopted" : "unchanged", base === null ? "identical to upstream" : undefined);
    if (this.options.adopt) return settle(local, "kept-local", "adopted as a fork of the current upstream; differences show as drift and merge on later syncs");
    if (base === null) {
      await this.write(`${INCOMING_DIR}/${file}`, upstream);
      return record("conflict", `differs from upstream with no recorded base; compare with ${INCOMING_DIR}/${file}, or \`youiyoux sync --adopt\` to keep yours`);
    }
    if (local === base) return settle(upstream, "updated", `${locked?.kind === "vendored" ? locked.version : "?"} → ${version}`);
    if (upstream === base) return settle(local, "kept-local", "local edits (drift); upstream unchanged");
    const merged = await mergeThreeWay(local, base, upstream);
    if (merged.conflicts === 0) return settle(merged.text, "merged", `local edits kept, upstream ${version} applied`);
    await this.write(`${CONFLICT_DIR}/${file}`, merged.text);
    if (locked) this.files[file] = locked;
    record("conflict", `${merged.conflicts} conflict(s): resolve ${CONFLICT_DIR}/${file} into the file, then \`youiyoux sync --adopt\` to record it`);
  }

  /**
   * Generated files the last sync wrote that this sync no longer produces (e.g. youi-rules/x.yml for a
   * rule now off): left behind, plain ast-grep would keep enforcing them. Removed when untouched;
   * an edited one is reported and left for a person.
   */
  async retire(): Promise<void> {
    for (const [file, entry] of Object.entries(this.previous?.files ?? {})) {
      if (entry.kind !== "generated" || file in this.files || !this.isGeneratedPath(file)) continue;
      const current = await readTextOrNull(this.path(file));
      if (current === null) continue;
      // A retired file left on disk stays in the lock, so every later sync and `youiyoux check` keeps reporting it.
      if (sha256(current) !== entry.sha256) {
        this.files[file] = entry;
        this.record({ file, role: "agents", action: "skipped", detail: "no longer generated, but edited by hand: remove it yourself" });
        continue;
      }
      if (!(await this.insideProject(file))) {
        this.files[file] = entry;
        this.record({ file, role: "agents", action: "skipped", detail: "no longer generated, but resolves outside the project: remove it yourself" });
        continue;
      }
      if (!this.options.dryRun) await rm(this.path(file));
      this.record({ file, role: "agents", action: "removed", detail: "no longer generated" });
    }
  }

  /**
   * Only paths youi itself generates may be retired. The lockfile is project content: a key such as
   * `../../x` must never make sync delete a file outside them, however its hash was written.
   */
  private isGeneratedPath(file: string): boolean {
    if (isAbsolute(file) || normalizeRelPath(file) !== file || file.split("/").includes("..")) return false;
    const { outputs, agents } = this.project.config;
    return file.startsWith("youi-rules/") || file.startsWith(`${outputs.dir}/`) || file === agents.designMd || file === `${agents.skillDir}/SKILL.md`;
  }

  /** The real location stays inside the project root, even through a symlinked directory. */
  private async insideProject(file: string): Promise<boolean> {
    const [root, parent] = await Promise.all([realpath(this.project.root), realpath(dirname(this.path(file))).catch(() => null)]);
    return parent !== null && (parent === root || parent.startsWith(`${root}${sep}`));
  }

  async managedBlock(file: string, block: string): Promise<void> {
    const current = await readTextOrNull(this.path(file));
    const next = upsertBlock(current, block);
    if (next === current) return this.record({ file, role: "agents", action: "unchanged" });
    await this.write(file, next);
    this.record({ file, role: "agents", action: current === null ? "created" : "updated", detail: "managed block only; the rest of the file is untouched" });
  }

  async mcpEntry(file: string, server: Record<string, unknown>): Promise<void> {
    const current = await readTextOrNull(this.path(file));
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (current !== null) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        config = parsed as typeof config;
      } catch {
        return this.record({ file, role: "config", action: "skipped", detail: "not valid JSON; add the youiyoux server by hand" });
      }
    }
    const next = `${JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, youiyoux: server } }, null, 2)}\n`;
    if (next === current) return this.record({ file, role: "config", action: "unchanged" });
    await this.write(file, next);
    this.record({ file, role: "config", action: current === null ? "created" : "updated", detail: "youiyoux MCP server entry; other servers kept" });
  }

  async link(file: string, target: string): Promise<void> {
    const path = this.path(file);
    const stat = await lstat(path).catch(() => null);
    if (stat?.isSymbolicLink() && (await readlink(path)) === target) return this.record({ file, role: "agents", action: "unchanged" });
    if (stat && !stat.isSymbolicLink()) return this.record({ file, role: "agents", action: "skipped", detail: "a real directory is in the way" });
    if (!this.options.dryRun) {
      await mkdir(dirname(path), { recursive: true });
      if (stat) await rm(path);
      await symlink(target, path);
    }
    this.record({ file, role: "agents", action: stat ? "updated" : "created", detail: `→ ${target}` });
  }
}

export async function syncProject(project: Project, options: SyncOptions = {}): Promise<SyncResult> {
  const { config, system, repo } = project;
  const previous = await readLock(project.root);
  const writer = new Writer(project, options, previous);
  const implementations = implementationsDir(system.config);
  for (const { contract } of system.components) {
    if ((await readTextOrNull(join(repo.root, implementations, contract.source.file))) === null) throw new Error(`${implementations}/${contract.source.file} is named by ${contract.id} but does not exist; nothing was written`);
  }
  // Component state variables ship with the tokens: the vendored implementations read them.
  const build = await buildTokens(repo.root, system.config, config.outputs, { contracts: system.components.map((c) => c.contract) });
  for (const file of build.files) await writer.generated(`${config.outputs.dir}/${file.path}`, file.content, "tokens");

  const narrative = system.config.design ? await readTextOrNull(join(repo.root, system.config.design)) : null;
  await writer.generated(config.agents.designMd, designMd(project, build, narrative), "agents");
  await writer.generated(`${config.agents.skillDir}/SKILL.md`, skillMd(project, await uncontractedFiles(project)), "agents");
  for (const rule of astGrepRules(project)) await writer.generated(`youi-rules/${rule.file}`, rule.content, "agents");
  await writer.managedBlock(config.agents.agentsMd, agentsBlock(project));
  if (config.agents.claudeSkillLink) await writer.link(".claude/skills/youiyoux", relative(join(project.root, ".claude/skills"), join(project.root, config.agents.skillDir)));
  await writer.mcpEntry(".mcp.json", { command: toolCommand(TOOL_ROOT).command, args: mcpArgs(project) });

  const sources = new Map<string, { elements: ElementId[]; version: string }>();
  for (const { contract } of system.components) {
    const entry = sources.get(contract.source.file) ?? { elements: [], version: contract.version };
    sources.set(contract.source.file, { elements: [...entry.elements, contract.id], version: newerVersion(entry.version, contract.version) });
  }
  for (const support of system.config.support) if (!sources.has(support)) sources.set(support, { elements: system.components.map((c) => c.contract.id), version: system.config.version });
  const upstreams = new Map<string, string>();
  for (const source of sources.keys()) {
    const upstream = await readTextOrNull(join(repo.root, implementations, source));
    if (upstream === null) throw new Error(`${implementations}/${source} is named by a contract but does not exist`);
    upstreams.set(source, upstream);
  }
  for (const [source, { elements, version }] of sources) {
    const file = vendoredPath(project, source);
    // A system adopted in this product: the file is the system's own implementation, so there is nothing to copy or lock.
    if (await sameFile(join(repo.root, implementations, source), join(project.root, file))) writer.record({ file, role: "component", action: "unchanged", detail: "the system's own implementation, in this project" });
    else await writer.owned(file, upstreams.get(source)!, elements, version);
  }
  await writer.retire();

  const lock: LockFile = {
    schema: "youi.lock/v1",
    system: system.config.id,
    systemVersion: system.config.version,
    sourceCommit: project.designCommit ?? (await gitHead(repo.root)),
    syncedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(writer.files).sort(([a], [b]) => a.localeCompare(b))),
  };
  if (!options.dryRun) await writeFileAtomic(join(project.root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return { actions: writer.actions, lock, unknownTools: unknownToolMentions(project), contents: writer.contents };
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)]);
  return x !== null && x === y;
}

/** How the project's MCP server finds what this sync used: a config kept elsewhere and an overridden design repo are passed explicitly. */
export function mcpArgs(project: Project): string[] {
  const rel = (path: string): string => relative(project.root, path) || ".";
  return [
    ...toolCommand(TOOL_ROOT).args.map((arg) => arg.startsWith("/") ? rel(arg) : arg),
    "mcp",
    "--project",
    ".",
    ...(project.configFile && project.configFile !== join(project.root, PROJECT_FILE) ? ["--config", rel(project.configFile)] : []),
    ...(project.designOverride ? ["--design", rel(project.repo.root)] : []),
    ...(project.rootOverride ? ["--root", "."] : []),
  ];
}

/** Files in the owned components dir that no contract (or support entry) covers. */
async function uncontractedFiles(project: Project): Promise<string[]> {
  const covered = new Set([...project.system.components.map((c) => basename(c.contract.source.file)), ...project.system.config.support.map((s) => basename(s))]);
  const entries = await readdir(join(project.root, project.config.componentsDir)).catch(() => [] as string[]);
  return entries.filter((name) => /\.(tsx|ts)$/.test(name) && !/^index\./.test(name) && !covered.has(name)).sort();
}

function newerVersion(a: string, b: string): string {
  const parts = (v: string): number[] => v.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
}

export interface LockIssue {
  readonly file: string;
  readonly severity: "error" | "warn";
  readonly message: string;
}

/** Lockfile check for `youiyoux check`: edited generated files are errors, owned-file drift is a warning. */
export async function verifyLock(project: Project): Promise<LockIssue[] | null> {
  const lock = await readLock(project.root);
  if (!lock) return null;
  const issues: LockIssue[] = [];
  for (const [file, entry] of Object.entries(lock.files)) {
    const content = await readTextOrNull(join(project.root, file));
    if (content === null) issues.push({ file, severity: "error", message: `${entry.kind} file is missing; run youiyoux sync` });
    else if (entry.kind === "generated" && sha256(content) !== entry.sha256) {
      issues.push({ file, severity: "error", message: "generated file was edited; change the design language and run youiyoux sync" });
    } else if (entry.kind === "vendored" && sha256(content) !== entry.baseSha256) {
      issues.push({ file, severity: "warn", message: `owned ${basename(file)} has local edits (drift from upstream ${entry.version}); sync will 3-way merge them` });
    }
  }
  return issues;
}

/**
 * Is the generated Tailwind theme part of the build? If no stylesheet imports it, the token
 * utilities that checks suggest (text-label, rounded-card, shadow-pill) silently do not exist.
 */
export async function verifyWiring(project: Project): Promise<LockIssue[]> {
  if (!project.config.outputs.targets.includes("tailwind-v4")) return [];
  const theme = `${project.config.outputs.dir}/theme.css`;
  if ((await readTextOrNull(join(project.root, theme))) === null) return [];
  const sheets = (await findFiles(project.root, project.config.include, project.config.exclude)).filter((f) => f.endsWith(".css") && f !== theme);
  for (const sheet of sheets) {
    const text = (await readTextOrNull(join(project.root, sheet))) ?? "";
    for (const match of text.matchAll(/@import\s+["']([^"']+)["']/g)) {
      if (join(dirname(join(project.root, sheet)), match[1]!) === join(project.root, theme)) return [];
    }
  }
  return [{ file: theme, severity: "warn", message: `no stylesheet imports it, so token utilities (text-label, rounded-card, shadow-pill) do not exist in the build: add @import of ${theme} to your Tailwind entry, after tailwindcss/theme.css` }];
}
