/**
 * State a long-lived checker (watch mode, the MCP server, the hub) reuses between
 * scans. Everything is keyed by content, never by time:
 *
 * - a parse is reused while its file's source hash is unchanged;
 * - module resolution is reused while the tsconfig and the set of files are unchanged;
 * - a file's analysis is reused while the definitions digest, the resolver and the
 *   source hash of every file in its import closure are unchanged, so editing a barrel
 *   or a component re-analyses exactly the files that import it, directly or not.
 *
 * When the definitions digest changes (a rule, contract, token or the project config),
 * every derived cache is dropped together; only content-keyed parses survive.
 */
import { sha256, shortHash, stableStringify, type ProjectConfig } from "@youiyoux/core";
import type { ModuleGraph } from "./graph.ts";
import { parseModule, type ModuleInfo } from "./parse.ts";
import { ModuleResolver } from "./resolve.ts";
import type { ModuleAnalysis } from "./usage.ts";

export interface CacheStats {
  parsed: number;
  reusedParses: number;
  analysed: number;
  reusedAnalyses: number;
}

const emptyStats = (): CacheStats => ({ parsed: 0, reusedParses: 0, analysed: 0, reusedAnalyses: 0 });

export class ScanCache {
  private readonly parses = new Map<string, { hash: string; module: Promise<ModuleInfo | null> }>();
  private readonly analyses = new Map<string, { key: string; analysis: ModuleAnalysis }>();
  private resolverEntry: { key: string; resolver: ModuleResolver } | null = null;
  private definitions: string | null = null;
  /** Counts for the latest scan (reset by `beginScan`). */
  stats: CacheStats = emptyStats();

  /** Start counting a new scan. */
  beginScan(): void {
    this.stats = emptyStats();
  }

  /** Scan against these definitions; a different digest drops every derived cache. */
  useDefinitions(definitions: string): void {
    if (definitions === this.definitions) return;
    this.definitions = definitions;
    this.analyses.clear();
    this.resolverEntry = null;
  }

  /** Parse through the cache: an unchanged source returns the same module. */
  readonly parse = (file: string, source: string): Promise<ModuleInfo | null> => {
    const hash = sha256(source);
    const hit = this.parses.get(file);
    if (hit?.hash === hash) {
      this.stats.reusedParses++;
      return hit.module;
    }
    this.stats.parsed++;
    const module = parseModule(file, source);
    this.parses.set(file, { hash, module });
    return module;
  };

  hashOf(file: string): string | undefined {
    return this.parses.get(file)?.hash;
  }

  /** Module resolution for this tsconfig and file set; adding or removing a file can change what an import resolves to. */
  resolver(root: string, config: ProjectConfig, tsconfigText: string | null, files: readonly string[]): ModuleResolver {
    const key = shortHash(stableStringify({ root, tsconfig: config.tsconfig, tsconfigText, files }));
    if (this.resolverEntry?.key !== key) {
      this.resolverEntry = { key, resolver: ModuleResolver.create(root, config.tsconfig) };
      this.analyses.clear();
    }
    return this.resolverEntry.resolver;
  }

  /** The analysis for `module`, reused while nothing in its import closure changed. */
  async analysis(module: ModuleInfo, graph: ModuleGraph, analyse: () => Promise<ModuleAnalysis>): Promise<ModuleAnalysis> {
    const key = await this.closureKey(module, graph);
    const hit = this.analyses.get(module.file);
    if (hit?.key === key) {
      this.stats.reusedAnalyses++;
      return hit.analysis;
    }
    this.stats.analysed++;
    const analysis = await analyse();
    this.analyses.set(module.file, { key, analysis });
    return analysis;
  }

  /** Drop everything known about files that no longer exist. */
  forget(files: Iterable<string>): void {
    for (const file of files) {
      this.parses.delete(file);
      this.analyses.delete(file);
    }
  }

  private async closureKey(module: ModuleInfo, graph: ModuleGraph): Promise<string> {
    const seen = new Map<string, string>();
    const stack = [module];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.file)) continue;
      seen.set(current.file, this.hashOf(current.file) ?? sha256(current.source));
      for (const dependency of graph.dependencies(current)) {
        if (seen.has(dependency)) continue;
        const loaded = await graph.load(dependency);
        if (loaded) stack.push(loaded);
        else seen.set(dependency, "unreadable");
      }
    }
    const closure = [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => `${file}:${hash}`);
    return shortHash(`${this.definitions}\0${this.resolverEntry?.key ?? ""}\0${closure.join("\n")}`);
  }
}
