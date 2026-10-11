/** `youi scan`: discover → parse (ast-grep, in parallel) → resolve identity → attribute routes → check. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findFiles, sha256, shortHash, stableStringify, type ScanReport, type UnknownSite, type UsageSite, type Lookalike, type Violation } from "@youiyoux/core";
import { buildTokens, type ResolvedToken } from "@youiyoux/tokens";
import { checkInputFor } from "./capabilities.ts";
import { buildTokenIndex, failedChecks, runChecks, type TokenIndex } from "./checks.ts";
import { buildElementIndex, type ElementIndex } from "./elements.ts";
import { ModuleGraph } from "./graph.ts";
import { langOf, parseModule, type ModuleInfo } from "./parse.ts";
import type { Project } from "./project.ts";
import { ModuleResolver } from "./resolve.ts";
import { RouteIndex } from "./routes.ts";
import { analyzeModule, type ModuleAnalysis } from "./usage.ts";

export const SCANNER_VERSION = "youi-scanner/0.1.0";

export interface ScanOptions {
  /** Source overrides by project-relative path: unsaved edits, codemod candidates, or virtual files to check. */
  readonly overrides?: Readonly<Record<string, string>>;
}

export interface ScanResult {
  readonly report: ScanReport;
  readonly modules: ReadonlyMap<string, ModuleInfo>;
  readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
  readonly elements: ElementIndex;
  readonly tokens: TokenIndex;
  /** Which screens each file reaches, for impact on files that hold no usage site (stylesheets, token users). */
  readonly routes: RouteIndex;
}

const run = promisify(execFile);

async function headCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const MAX_DIRTY_LISTED = 50;

/** Scanned files that differ from HEAD: modified or staged (git diff HEAD) and untracked. Paths relative to root. */
async function changedFiles(root: string): Promise<Set<string> | null> {
  try {
    const options = { cwd: root, maxBuffer: 64 * 1024 * 1024 };
    const [diff, untracked] = await Promise.all([run("git", ["diff", "--name-only", "-z", "--relative", "HEAD", "--", "."], options), run("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], options)]);
    return new Set(`${diff.stdout}\0${untracked.stdout}`.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Everything that decides the findings, so a different digest means results may differ: the project
 * config, every contract and rule in full (not just ids and versions), the resolved tokens the
 * checks compare against, and the scanner version.
 */
function configDigest(project: Project, tokens: readonly ResolvedToken[]): string {
  const byId = <T extends { id: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.id.localeCompare(b.id));
  return shortHash(stableStringify({ config: project.config, system: project.system.config, contracts: byId(project.system.components.map((c) => c.contract)), rules: byId(project.system.rules), tokens, scanner: SCANNER_VERSION }));
}

/** What exactly was scanned: every file's path and content (unreadable files marked), and what differs from HEAD. */
function contentIdentity(files: readonly string[], sources: ReadonlyMap<string, string>, overrides: Readonly<Record<string, string>>, changed: Set<string> | null, commit: string | null): NonNullable<ScanReport["content"]> {
  const digest = shortHash(stableStringify(files.map((file) => [file, sources.has(file) ? sha256(sources.get(file)!) : "unreadable"])));
  const overridden = files.filter((f) => f in overrides);
  const dirty = commit && changed ? [...new Set([...files.filter((f) => changed.has(f)), ...overridden])].sort() : overridden;
  return { digest, dirty: dirty.slice(0, MAX_DIRTY_LISTED), dirtyCount: commit && changed ? dirty.length : null, overrides: overridden };
}

const byPosition = <T extends { file: string; line: number; column: number }>(a: T, b: T): number => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;

async function parseAll(project: Project, files: readonly string[], overrides: Readonly<Record<string, string>>): Promise<{ modules: Map<string, ModuleInfo | null>; sources: Map<string, string>; failed: Array<{ file: string; reason: string }> }> {
  const modules = new Map<string, ModuleInfo | null>();
  const sources = new Map<string, string>();
  const failed: Array<{ file: string; reason: string }> = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const source = overrides[file] ?? (await readFile(join(project.root, file), "utf8"));
        sources.set(file, source);
        const module = await parseModule(file, source);
        modules.set(file, module);
        if (module && module.parseErrors > 0) failed.push({ file, reason: `${module.parseErrors} parse error node(s); sites inside them may be missing` });
      } catch (error: unknown) {
        modules.set(file, null);
        failed.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return { modules, sources, failed };
}

export async function scanProject(project: Project, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const overrides = options.overrides ?? {};
  const discovered = await findFiles(project.root, project.config.include, project.config.exclude);
  const files = [...new Set([...discovered, ...Object.keys(overrides)])].filter((f) => langOf(f) !== null).sort();
  const [{ modules, sources, failed }, build, commit, changed] = await Promise.all([
    parseAll(project, files, overrides),
    buildTokens(project.repo.root, project.system.config, project.config.outputs),
    headCommit(project.root),
    changedFiles(project.root),
  ]);
  const resolver = ModuleResolver.create(project.root, project.config.tsconfig);
  for (const problem of resolver.problems) failed.push({ file: project.config.tsconfig, reason: problem });
  const graph = new ModuleGraph(project.root, resolver, modules, new Map(Object.entries(overrides)));
  const elements = buildElementIndex(project);
  const tokens = buildTokenIndex(build.tokens, project.config.outputs);
  const routes = RouteIndex.build(graph, modules, project.config.routes);

  const scanned = new Map<string, ModuleInfo>();
  for (const file of files) {
    const module = modules.get(file);
    if (module) scanned.set(file, module);
  }
  const analyses = new Map<string, ModuleAnalysis>();
  await Promise.all([...scanned.values()].map(async (module) => analyses.set(module.file, await analyzeModule(module, graph, elements))));

  const usages: UsageSite[] = [];
  const unknowns: UnknownSite[] = [];
  const lookalikes: Lookalike[] = [];
  for (const analysis of analyses.values()) {
    for (const usage of analysis.usages) usages.push({ ...usage, ...routes.of(usage.file) });
    unknowns.push(...analysis.unknowns);
    lookalikes.push(...analysis.lookalikes);
  }
  const { violations, suppressed, checks } = runChecks(checkInputFor(project, { modules: scanned, analyses, elements, tokens }, project.system.rules));

  const report: ScanReport = {
    schema: "youi.usage/v1",
    project: project.config.id,
    system: project.system.config.id,
    commit,
    scanner: SCANNER_VERSION,
    configDigest: configDigest(project, build.tokens),
    content: contentIdentity(files, sources, overrides, changed, commit),
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    // Unparsed files and rules that should have run but could not both leave findings unknown.
    status: failed.length > 0 || failedChecks(checks).length > 0 ? "partial" : "complete",
    coverage: { filesMatched: files.length, filesScanned: scanned.size, failed: failed.sort((a, b) => a.file.localeCompare(b.file)) },
    usages: usages.sort(byPosition),
    unknowns: unknowns.sort(byPosition),
    lookalikes: lookalikes.sort(byPosition),
    violations: (violations as Violation[]).sort(byPosition),
    suppressed,
    checks,
  };
  return { report, modules: scanned, analyses, elements, tokens, routes };
}
