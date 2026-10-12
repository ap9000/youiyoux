/** Parsed modules plus binding resolution: local name → canonical `file#export`. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { relPath } from "@youiyoux/core";
import { parseModule, type ModuleInfo } from "./parse.ts";
import type { ModuleResolver } from "./resolve.ts";

export type UnknownReason = "unresolved-import" | "external-module" | "dynamic-component" | "namespace-member" | "parse-error" | "unresolved-export";

export type ResolvedSymbol =
  | { readonly kind: "symbol"; readonly file: string; readonly name: string }
  | { readonly kind: "namespace"; readonly file: string }
  | { readonly kind: "external"; readonly module: string; readonly name: string }
  | { readonly kind: "unknown"; readonly reason: UnknownReason; readonly detail: string };

/** Parses one module's source; a scan cache passes a memoizing one. */
export type ModuleParser = (file: string, source: string) => Promise<ModuleInfo | null>;

export class ModuleGraph {
  readonly root: string;
  private readonly resolver: ModuleResolver;
  private readonly modules: Map<string, ModuleInfo | null>;
  private readonly pending = new Map<string, Promise<ModuleInfo | null>>();
  private readonly exportMemo = new Map<string, Promise<ResolvedSymbol>>();
  /** Source overrides (unsaved or virtual files), by project-relative path. */
  private readonly overrides: ReadonlyMap<string, string>;
  private readonly parse: ModuleParser;

  constructor(root: string, resolver: ModuleResolver, modules: Map<string, ModuleInfo | null>, overrides: ReadonlyMap<string, string> = new Map(), parse: ModuleParser = parseModule) {
    this.root = root;
    this.resolver = resolver;
    this.modules = modules;
    this.overrides = overrides;
    this.parse = parse;
  }

  /** A module by project-relative path, parsing it on demand (files outside the include globs too). */
  load(file: string): Promise<ModuleInfo | null> {
    if (this.modules.has(file)) return Promise.resolve(this.modules.get(file) ?? null);
    let loading = this.pending.get(file);
    if (!loading) {
      loading = (async () => {
        try {
          const source = this.overrides.get(file) ?? (await readFile(join(this.root, file), "utf8"));
          const info = await this.parse(file, source);
          this.modules.set(file, info);
          return info;
        } catch {
          this.modules.set(file, null);
          return null;
        }
      })();
      this.pending.set(file, loading);
    }
    return loading;
  }

  /** Resolve an import specifier written in `fromFile`; files come back project-relative. */
  resolveSpecifier(specifier: string, fromFile: string): { kind: "file"; file: string } | { kind: "external"; module: string } | { kind: "unresolved" } {
    const result = this.resolver.resolve(specifier, join(this.root, fromFile));
    if (result.kind === "file") return { kind: "file", file: relPath(this.root, result.file) };
    return result.kind === "external" ? result : { kind: "unresolved" };
  }

  /** Project files this module depends on, including literal dynamic and CSS imports. */
  dependencies(module: ModuleInfo, options: { runtimeOnly?: boolean } = {}): string[] {
    const specifiers = new Set(options.runtimeOnly ? module.runtimeSpecifiers : [...module.runtimeSpecifiers, ...module.imports.map((i) => i.specifier), ...module.starExports, ...module.exports.flatMap((e) => (e.kind === "reexport" ? [e.specifier] : []))]);
    for (const specifier of module.dynamicSpecifiers) specifiers.add(specifier);
    const files = new Set<string>();
    for (const specifier of specifiers) {
      const resolved = this.resolveSpecifier(specifier, module.file);
      if (resolved.kind === "file") files.add(resolved.file);
    }
    return [...files];
  }

  resolveExport(file: string, name: string, seen: ReadonlySet<string> = new Set()): Promise<ResolvedSymbol> {
    const key = `${file}#${name}`;
    if (seen.has(key)) return Promise.resolve({ kind: "unknown", reason: "unresolved-export", detail: `export cycle at ${key}` });
    const memo = this.exportMemo.get(key);
    if (memo) return memo;
    const next = new Set(seen).add(key);
    const result = this.resolveExportUncached(file, name, next);
    // Only a search that started here is complete: inside a chain, `export *` cycles are cut
    // short, and caching that partial answer would make counts depend on traversal order.
    if (seen.size === 0) this.exportMemo.set(key, result);
    return result;
  }

  private async resolveExportUncached(file: string, name: string, seen: ReadonlySet<string>): Promise<ResolvedSymbol> {
    const module = await this.load(file);
    if (!module) return { kind: "unknown", reason: "parse-error", detail: `cannot read or parse ${file}` };
    const entry = module.exports.find((e) => e.name === name);
    if (entry?.kind === "local") {
      if (module.declarations.has(entry.local)) return { kind: "symbol", file, name };
      if (module.imports.some((i) => i.local === entry.local)) return this.resolveLocal(module, entry.local, seen);
      return { kind: "symbol", file, name };
    }
    if (entry?.kind === "reexport") return this.follow(entry.specifier, entry.imported, file, seen);
    for (const specifier of module.starExports) {
      const target = this.resolveSpecifier(specifier, file);
      if (target.kind !== "file") continue;
      const found = await this.resolveExport(target.file, name, seen);
      if (found.kind !== "unknown" || found.reason !== "unresolved-export") return found;
    }
    return { kind: "unknown", reason: "unresolved-export", detail: `${file} has no export named ${name}` };
  }

  private async follow(specifier: string, imported: string, fromFile: string, seen: ReadonlySet<string>): Promise<ResolvedSymbol> {
    const target = this.resolveSpecifier(specifier, fromFile);
    if (target.kind === "external") return { kind: "external", module: target.module, name: imported };
    if (target.kind === "unresolved") return { kind: "unknown", reason: "unresolved-import", detail: `cannot resolve "${specifier}" from ${fromFile}` };
    if (imported === "*") return { kind: "namespace", file: target.file };
    return this.resolveExport(target.file, imported, seen);
  }

  /** What a name used in `module` refers to. */
  async resolveLocal(module: ModuleInfo, local: string, seen: ReadonlySet<string> = new Set()): Promise<ResolvedSymbol> {
    const binding = module.imports.find((i) => i.local === local && !i.typeOnly);
    if (binding) return this.follow(binding.specifier, binding.imported, module.file, seen);
    if (module.declarations.has(local)) return { kind: "symbol", file: module.file, name: local };
    return { kind: "unknown", reason: "dynamic-component", detail: `${local} is a parameter, prop or computed value, not an import` };
  }
}
