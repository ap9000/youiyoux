/**
 * Where a popup's button is used, when the line that renders it is inside a component the code uses
 * in more than one place (a wrapper such as a rail button): read from the source, never from the
 * page or from other triggers on the screen.
 *
 * The component holding a line is a top-level declaration of that file (function, class or const)
 * whose name starts with a capital, as JSX components do. Its uses are the `<W …>` elements in the
 * project's include globs that the module graph resolves to that declaration: through imports,
 * aliases, re-exports and namespaces it understands, never by the tag's name, so two components of
 * the same name in different files are counted apart. Anything uncertain counts as no use: a file
 * that doesn't parse cleanly is neither the holder nor a site, an element that doesn't resolve isn't
 * a site, and a file outside the project root isn't read through. So a doubt only ever keeps the line
 * where the button is written.
 */
import { findFiles } from "@youiyoux/core";
import { ModuleGraph } from "../graph.ts";
import { langOf, parseModule, type ModuleInfo } from "../parse.ts";
import { ModuleResolver } from "../resolve.ts";
import type { PlaceLine } from "../screens/locate.ts";
import { resolveTag } from "../usage.ts";
import type { SgNode } from "@ast-grep/napi";

/** The project's sources: youi.project.json's include and exclude globs and tsconfig. */
export interface WrapperSources {
  readonly root: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly tsconfig: string;
}

interface Component {
  /** `<file>#<declared name>`. */
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

const key = (file: string, name: string): string => `${file}#${name}`;

/** Top-level components declared in a module, with the lines each spans (1-based, inclusive). */
function componentsOf(module: ModuleInfo): Component[] {
  const out: Component[] = [];
  const add = (name: string | undefined, node: SgNode) => {
    if (!name || !/^[A-Z]/.test(name) || !module.declarations.has(name)) return;
    const range = node.range();
    out.push({ key: key(module.file, name), start: range.start.line + 1, end: range.end.line + 1 });
  };
  for (const child of module.root.root().children()) {
    const target = child.kind() === "export_statement" ? (child.field("declaration") ?? child.field("value")) : child;
    if (!target) continue;
    const kind = String(target.kind());
    if (kind === "function_declaration" || kind === "class_declaration" || kind === "generator_function_declaration") add(target.field("name")?.text(), target);
    else if (kind === "lexical_declaration" || kind === "variable_declaration")
      for (const declarator of target.children().filter((c) => c.kind() === "variable_declarator")) {
        const name = declarator.field("name");
        if (name?.kind() === "identifier") add(name.text(), declarator);
      }
  }
  return out;
}

/**
 * For one behaviour run: the sources are parsed once, on first use, and kept in memory; each
 * answer is about the code alone, so the same code always gives the same line.
 */
export class WrapperIndex {
  private readonly sources: WrapperSources;
  /** Each file's top-level components, read once. */
  private readonly components = new Map<string, Component[]>();
  private built: Promise<{ graph: ModuleGraph; modules: Map<string, ModuleInfo | null>; sites: Map<string, Array<{ file: string; line: number }>> }> | null = null;

  constructor(sources: WrapperSources) {
    this.sources = sources;
  }

  private build() {
    this.built ??= (async () => {
      const { root, include, exclude, tsconfig } = this.sources;
      const files = (await findFiles(root, include, exclude)).filter((f) => langOf(f) === "tsx" || langOf(f) === "ts");
      const modules = new Map<string, ModuleInfo | null>();
      // Never read through a file outside the project root (it isn't part of what a result is fresh against).
      const parse = (file: string, source: string) => (file.startsWith("../") || file === ".." ? Promise.resolve(null) : parseModule(file, source));
      const graph = new ModuleGraph(root, ModuleResolver.create(root, tsconfig), modules, new Map(), parse);
      await Promise.all(files.map((file) => graph.load(file)));
      const sites = new Map<string, Array<{ file: string; line: number }>>();
      for (const file of files) {
        const module = modules.get(file);
        // A file that doesn't parse cleanly holds no sites: its elements may be misread.
        if (!module || module.parseErrors > 0) continue;
        for (const element of module.jsx) {
          if (/^[a-z]/.test(element.tag) && !element.tag.includes(".")) continue;
          const component = await this.declarationOf(graph, module, element.tag);
          if (!component) continue;
          const list = sites.get(component) ?? [];
          list.push({ file, line: element.line });
          sites.set(component, list);
        }
      }
      return { graph, modules, sites };
    })();
    return this.built;
  }

  /** The declaration a JSX tag in `module` names, as `<file>#<declared name>`, or null when not certain. */
  private async declarationOf(graph: ModuleGraph, module: ModuleInfo, tag: string): Promise<string | null> {
    // A local declaration, not shadowed by an import (as the graph resolves it).
    if (!tag.includes(".") && !module.imports.some((i) => i.local === tag && !i.typeOnly)) return module.declarations.has(tag) ? key(module.file, tag) : null;
    const { symbol } = await resolveTag(graph, module, tag);
    if (symbol.kind !== "symbol") return null;
    // The graph names it by its export; the declaration is the local that export names.
    const holder = await graph.load(symbol.file);
    if (!holder || holder.parseErrors > 0) return null;
    const entry = holder.exports.find((e) => e.kind === "local" && e.name === symbol.name);
    return entry?.kind === "local" && holder.declarations.has(entry.local) ? key(symbol.file, entry.local) : null;
  }

  /**
   * Where the button is used, for `first` (the line that renders it, from React's owner chain) and
   * the lines after it: when `first` is inside a component W the code uses in more than one place,
   * the next line, if it is one of W's uses. Lines inside W itself (its own helpers, a `.map`
   * callback) are W's own stack and passed over; anything else ends the look, as does a line in a
   * skipped file. Null keeps `first`.
   */
  async usage(first: PlaceLine, rest: readonly PlaceLine[]): Promise<PlaceLine | null> {
    const { modules, sites } = await this.build();
    const module = modules.get(first.file);
    if (!module || module.parseErrors > 0) return null;
    let declared = this.components.get(module.file);
    if (!declared) this.components.set(module.file, (declared = componentsOf(module)));
    const holder = declared.find((c) => c.start <= first.line && first.line <= c.end);
    if (!holder) return null;
    const uses = sites.get(holder.key) ?? [];
    if (uses.length < 2) return null;
    for (const next of rest) {
      if (next.skipped) return null;
      if (uses.some((u) => u.file === next.file && u.line === next.line)) return next;
      if (next.file === first.file && holder.start <= next.line && next.line <= holder.end) continue;
      return null;
    }
    return null;
  }
}
