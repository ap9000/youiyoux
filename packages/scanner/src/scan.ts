/** `youiyoux scan`: discover → parse (ast-grep, in parallel) → resolve identity → attribute routes → check. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findFiles, readTextOrNull, sha256, shortHash, type CheckIdentity, type ScanReport, type UnknownSite, type UsageSite, type Lookalike } from "@youiyoux/core";
import { buildTokens } from "@youiyoux/tokens";
import type { ScanCache } from "./cache.ts";
import { checkInputFor } from "./capabilities.ts";
import { buildTokenIndex, failedChecks, runChecks, type TokenIndex } from "./checks.ts";
import { buildElementIndex, type ElementIndex } from "./elements.ts";
import { ModuleGraph, type ModuleParser } from "./graph.ts";
import { changedFiles, checkIdentity, definitionsDigest, gitState, SCANNER_VERSION } from "./identity.ts";
import { byPosition, langOf, parseModule, type ModuleInfo } from "./parse.ts";
import { emptyRootProblem, ProjectRootError, type Project } from "./project.ts";
import { ModuleResolver } from "./resolve.ts";
import { RouteIndex } from "./routes.ts";
import { analyzeModule, type ModuleAnalysis } from "./usage.ts";

export interface ScanOptions {
  /** Source overrides by project-relative path: unsaved edits, staged content, codemod candidates, or virtual files to check. */
  readonly overrides?: Readonly<Record<string, string>>;
  /**
   * Analyse and check only these project-relative files (their imports are still followed).
   * A focused report has no route attribution and no other files' sites: it answers
   * "what is wrong in these files", not "where is X used".
   */
  readonly focus?: readonly string[];
  /** Reuse parses, resolution and per-file analyses across scans (watch mode, the MCP server). */
  readonly cache?: ScanCache;
}

export interface ScanResult {
  readonly report: ScanReport;
  readonly modules: ReadonlyMap<string, ModuleInfo>;
  readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
  readonly elements: ElementIndex;
  readonly tokens: TokenIndex;
  /** Which screens each file reaches, for impact on files that hold no usage site (stylesheets, token users). Empty for a focused scan. */
  readonly routes: RouteIndex;
  /** Tool, definitions digest and both repos' revisions this result is bound to. */
  readonly identity: CheckIdentity;
  /** Digest of every source the scan read (including overrides); the same as `report.content.digest`. */
  readonly contentDigest: string;
  /** The files this scan analysed and checked (all matched files, or the focus). */
  readonly files: readonly string[];
  /** Binding resolution over this scan's sources (overrides included), for passes that follow imports themselves. */
  readonly graph: ModuleGraph;
}

const MAX_DIRTY_LISTED = 50;

/** One digest of every scanned file's content (unreadable files marked), reusing the cache's hashes when it has them. */
function contentDigestOf(files: readonly string[], sources: ReadonlyMap<string, string>, cache: ScanCache | undefined): string {
  const entries = files.map((file) => `${file}:${sources.has(file) ? (cache?.hashOf(file) ?? sha256(sources.get(file)!)) : "unreadable"}`);
  return shortHash(entries.sort().join("\n"));
}

/** What exactly was scanned: the content digest, and which scanned files differ from HEAD or were overridden. */
function contentIdentity(files: readonly string[], digest: string, overrides: Readonly<Record<string, string>>, changed: Set<string> | null, commit: string | null): NonNullable<ScanReport["content"]> {
  const overridden = files.filter((f) => f in overrides);
  const dirty = commit && changed ? [...new Set([...files.filter((f) => changed.has(f)), ...overridden])].sort() : overridden;
  return { digest, dirty: dirty.slice(0, MAX_DIRTY_LISTED), dirtyCount: commit && changed ? dirty.length : null, overrides: overridden };
}

async function parseAll(project: Project, files: readonly string[], overrides: Readonly<Record<string, string>>, parse: ModuleParser): Promise<{ modules: Map<string, ModuleInfo | null>; sources: Map<string, string>; failed: Array<{ file: string; reason: string }> }> {
  const modules = new Map<string, ModuleInfo | null>();
  const sources = new Map<string, string>();
  const failed: Array<{ file: string; reason: string }> = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const source = overrides[file] ?? (await readFile(join(project.root, file), "utf8"));
        sources.set(file, source);
        const module = await parse(file, source);
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
  const { cache } = options;
  cache?.beginScan();
  const parse = cache?.parse ?? parseModule;
  const discovered = await findFiles(project.root, project.config.include, project.config.exclude);
  const all = [...new Set([...discovered, ...Object.keys(overrides)])].filter((f) => langOf(f) !== null).sort();
  const focus = options.focus ? new Set(options.focus) : null;
  const files = focus ? all.filter((f) => focus.has(f)) : all;
  // A whole-project scan of nothing is a wrong root (a config kept outside its product), never a clean pass.
  const empty = focus ? null : await emptyRootProblem(project, all.length);
  if (empty) throw new ProjectRootError(empty);
  const [{ modules, sources, failed }, build, consumerGit, designGit, changed, tsconfigText] = await Promise.all([
    parseAll(project, files, overrides, parse),
    buildTokens(project.repo.root, project.system.config, project.config.outputs),
    gitState(project.root),
    gitState(project.repo.root),
    changedFiles(project.root),
    cache ? readTextOrNull(join(project.root, project.config.tsconfig)) : Promise.resolve(null),
  ]);
  const definitions = definitionsDigest(project, build.tokens);
  cache?.useDefinitions(definitions);
  const resolver = cache ? cache.resolver(project.root, project.config, tsconfigText, all) : ModuleResolver.create(project.root, project.config.tsconfig);
  for (const problem of resolver.problems) failed.push({ file: project.config.tsconfig, reason: problem });
  const graph = new ModuleGraph(project.root, resolver, modules, new Map(Object.entries(overrides)), parse);
  const elements = buildElementIndex(project);
  const tokens = buildTokenIndex(build.tokens, project.config.outputs);
  const routes = focus ? new RouteIndex("Routes are not checked in a focused scan. Run a full scan to place this file.") : RouteIndex.build(graph, modules, project.config.routes);

  const scanned = new Map<string, ModuleInfo>();
  for (const file of files) {
    const module = modules.get(file);
    if (module) scanned.set(file, module);
  }
  const analyses = new Map<string, ModuleAnalysis>();
  const analyse = (module: ModuleInfo): Promise<ModuleAnalysis> => (cache ? cache.analysis(module, graph, () => analyzeModule(module, graph, elements)) : analyzeModule(module, graph, elements));
  await Promise.all([...scanned.values()].map(async (module) => analyses.set(module.file, await analyse(module))));

  const usages: UsageSite[] = [];
  const unknowns: UnknownSite[] = [];
  const lookalikes: Lookalike[] = [];
  for (const analysis of analyses.values()) {
    for (const usage of analysis.usages) usages.push({ ...usage, ...routes.of(usage.file) });
    unknowns.push(...analysis.unknowns);
    lookalikes.push(...analysis.lookalikes);
  }
  const { violations, suppressed, checks } = runChecks(checkInputFor(project, { modules: scanned, analyses, elements, tokens }, project.system.rules));

  const contentDigest = contentDigestOf(files, sources, cache);
  const report: ScanReport = {
    schema: "youi.usage/v1",
    project: project.config.id,
    system: project.system.config.id,
    commit: consumerGit.commit,
    scanner: SCANNER_VERSION,
    configDigest: definitions,
    content: contentIdentity(files, contentDigest, overrides, changed, consumerGit.commit),
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    // Unparsed files and rules that should have run but could not both leave findings unknown.
    status: failed.length > 0 || failedChecks(checks).length > 0 ? "partial" : "complete",
    coverage: { filesMatched: files.length, filesScanned: scanned.size, failed: failed.sort((a, b) => a.file.localeCompare(b.file)) },
    usages: usages.sort(byPosition),
    fileRoutes: Object.fromEntries(files.map((file) => [file, routes.of(file)])),
    unknowns: unknowns.sort(byPosition),
    lookalikes: lookalikes.sort(byPosition),
    violations: violations.sort(byPosition),
    suppressed,
    checks,
  };
  const identity = checkIdentity(project, definitions, designGit, consumerGit);
  return { report, modules: scanned, analyses, elements, tokens, routes, identity, contentDigest, files, graph };
}
