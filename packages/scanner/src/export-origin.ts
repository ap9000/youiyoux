/** Export identity and its path through barrels, including names removed by a recent sync. */
import type { ExportChange } from "./import-rewrite.ts";
import type { ModuleGraph } from "./graph.ts";
import type { ElementIndex } from "./elements.ts";

export interface ExportOrigin {
  readonly old: string;
  /** Name this module will expose after the import pass, or null for an unreplaced removal. */
  readonly next: string | null;
  readonly chain: readonly string[];
}

export class ExportOrigins {
  private readonly memo = new Map<string, Promise<ExportOrigin | null>>();
  private readonly graph: ModuleGraph;
  private readonly target: string;
  private readonly changes: ReadonlyMap<string, ExportChange>;
  private readonly elements: ElementIndex;
  constructor(graph: ModuleGraph, target: string, changes: ReadonlyMap<string, ExportChange>, elements: ElementIndex) {
    this.graph = graph;
    this.target = target;
    this.changes = changes;
    this.elements = elements;
  }

  origin(file: string, name: string): Promise<ExportOrigin | null> {
    const key = `${file}#${name}`;
    let result = this.memo.get(key);
    if (!result) {
      result = this.trace(file, name, new Set());
      this.memo.set(key, result);
    }
    return result;
  }

  /** Old exports held under aliases or nested namespace exports count too. */
  async affected(file: string, seen: ReadonlySet<string> = new Set()): Promise<ExportOrigin[]> {
    if (seen.has(file)) return [];
    const nextSeen = new Set(seen).add(file);
    const module = await this.graph.load(file);
    if (!module) return [];
    const names = new Set([...this.changes.keys(), ...module.exports.map((e) => e.name)]);
    const found: ExportOrigin[] = [];
    for (const name of names) {
      const origin = await this.origin(file, name);
      if (origin) found.push(origin);
      const ns = await this.namespace(file, name);
      if (ns) for (const nested of await this.affected(ns.file, nextSeen)) found.push({ ...nested, chain: [...ns.chain, ...nested.chain] });
    }
    for (const specifier of module.starExports) {
      const next = this.graph.resolveSpecifier(specifier, file);
      if (next.kind === "file") for (const nested of await this.affected(next.file, nextSeen)) found.push({ ...nested, chain: [file, ...nested.chain] });
    }
    return [...new Map(found.map((o) => [o.old, o])).values()];
  }

  private async trace(file: string, name: string, seen: ReadonlySet<string>): Promise<ExportOrigin | null> {
    if (file === this.target) {
      const change = this.changes.get(name);
      return change ? { old: name, next: change.to, chain: [file] } : null;
    }
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen).add(key);
    const symbol = await this.graph.resolveExport(file, name);
    if (symbol.kind === "symbol" && (symbol.file !== this.target || !this.changes.has(symbol.name))) return null;
    if (symbol.kind !== "symbol" && (symbol.kind !== "unknown" || symbol.reason !== "unresolved-export")) return null;
    const module = await this.graph.load(file);
    if (!module) return null;
    const follow = async (specifier: string, imported: string): Promise<ExportOrigin | null> => {
      const resolved = this.graph.resolveSpecifier(specifier, file);
      const found = resolved.kind === "file" ? await this.trace(resolved.file, imported, nextSeen) : null;
      return found ? { ...found, chain: [file, ...found.chain] } : null;
    };
    const entry = module.exports.find((e) => e.name === name);
    if (entry) {
      const binding = entry.kind === "reexport" ? entry : module.imports.find((i) => i.local === entry.local);
      const found = binding ? await follow(binding.specifier, binding.imported) : null;
      if (!found) return null;
      const change = this.changes.get(found.old)!;
      // Product exports are a public API boundary. Owned barrels must come from sync;
      // projecting the new name lets imports-resolve reject a stale owned barrel.
      const rename = change.renameBarrels || this.elements.isOwned(file) || this.elements.implementationFiles.has(file);
      return { ...found, next: found.next === null ? null : rename && name === found.old ? change.to : name };
    }
    for (const specifier of module.starExports) {
      const found = await follow(specifier, name);
      if (!found) continue;
      const change = this.changes.get(found.old)!;
      const keep = !change.renameBarrels && !this.elements.isOwned(file) && !this.elements.implementationFiles.has(file);
      return { ...found, next: found.next === null ? null : keep ? name : found.next };
    }
    return null;
  }

  /** A named re-export can be a namespace too (`export * as ui`). */
  async namespace(file: string, name: string, seen: ReadonlySet<string> = new Set()): Promise<{ file: string; chain: string[] } | null> {
    if (name === "*") return { file, chain: [file] };
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen).add(key);
    const module = await this.graph.load(file);
    if (!module) return null;
    const entry = module.exports.find((e) => e.name === name);
    const binding = entry?.kind === "reexport" ? entry : entry?.kind === "local" ? module.imports.find((i) => i.local === entry.local) : undefined;
    const paths = binding ? [{ specifier: binding.specifier, name: binding.imported }] : entry ? [] : module.starExports.map((specifier) => ({ specifier, name }));
    for (const path of paths) {
      const next = this.graph.resolveSpecifier(path.specifier, file);
      const found = next.kind === "file" ? await this.namespace(next.file, path.name, nextSeen) : null;
      if (found) return { file: found.file, chain: [file, ...found.chain] };
    }
    return null;
  }
}
