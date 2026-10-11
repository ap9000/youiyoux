/** `youi scan`: discover → parse (ast-grep, in parallel) → resolve identity → attribute routes → check. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findFiles, shortHash, stableStringify, type ScanReport, type UnknownSite, type UsageSite, type Lookalike, type Violation } from "@youiyoux/core";
import { buildTokens } from "@youiyoux/tokens";
import { buildTokenIndex, runChecks, type TokenIndex } from "./checks.ts";
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

function configDigest(project: Project): string {
  const contracts = project.system.components.map((c) => `${c.contract.id}@${c.contract.version}`);
  const rules = project.system.rules.map((r) => `${r.id}:${r.severity}`);
  return shortHash(stableStringify({ config: project.config, contracts, rules, scanner: SCANNER_VERSION }));
}

const byPosition = <T extends { file: string; line: number; column: number }>(a: T, b: T): number => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;

async function parseAll(project: Project, files: readonly string[], overrides: Readonly<Record<string, string>>): Promise<{ modules: Map<string, ModuleInfo | null>; failed: Array<{ file: string; reason: string }> }> {
  const modules = new Map<string, ModuleInfo | null>();
  const failed: Array<{ file: string; reason: string }> = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const source = overrides[file] ?? (await readFile(join(project.root, file), "utf8"));
        const module = await parseModule(file, source);
        modules.set(file, module);
        if (module && module.parseErrors > 0) failed.push({ file, reason: `${module.parseErrors} parse error node(s); sites inside them may be missing` });
      } catch (error: unknown) {
        modules.set(file, null);
        failed.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return { modules, failed };
}

export async function scanProject(project: Project, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const overrides = options.overrides ?? {};
  const discovered = await findFiles(project.root, project.config.include, project.config.exclude);
  const files = [...new Set([...discovered, ...Object.keys(overrides)])].filter((f) => langOf(f) !== null).sort();
  const [{ modules, failed }, build, commit] = await Promise.all([
    parseAll(project, files, overrides),
    buildTokens(project.repo.root, project.system.config, project.config.outputs),
    headCommit(project.root),
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
  const { violations, suppressed } = runChecks({
    modules: scanned,
    analyses,
    elements,
    tokens,
    rules: project.system.rules,
    componentsDir: project.config.componentsDir,
    tokenSources: project.config.tokenSources,
    generatedDir: project.config.outputs.dir,
  });

  const report: ScanReport = {
    schema: "youi.usage/v1",
    project: project.config.id,
    system: project.system.config.id,
    commit,
    scanner: SCANNER_VERSION,
    configDigest: configDigest(project),
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    status: failed.length > 0 ? "partial" : "complete",
    coverage: { filesMatched: files.length, filesScanned: scanned.size, failed: failed.sort((a, b) => a.file.localeCompare(b.file)) },
    usages: usages.sort(byPosition),
    unknowns: unknowns.sort(byPosition),
    lookalikes: lookalikes.sort(byPosition),
    violations: (violations as Violation[]).sort(byPosition),
    suppressed,
  };
  return { report, modules: scanned, analyses, elements, tokens };
}
