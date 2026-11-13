/**
 * Where a popup's button is used, when the line that renders it is inside a component the code uses
 * in more than one place (a wrapper such as a rail button): read from the source, never from the
 * page or from other triggers on the screen.
 *
 * The component holding the button's position is a top-level declaration of that file (function,
 * class or const) whose name starts with a capital, as JSX components do, and whose source range
 * holds that line and column. Its uses are the `<W …>` elements in the project's include globs that
 * the module graph resolves to that declaration: through imports, aliases, re-exports and namespaces
 * it understands, never by the tag's name, so two components of the same name in different files
 * are counted apart. Anything uncertain counts as no use, so a doubt only ever keeps the line where
 * the button is written:
 *
 * - a module is read only when it is a plain file under the root, its real path its own (no link
 *   anywhere on it, nothing outside the root), checked before it is opened;
 * - a module that doesn't parse cleanly is unreadable: not the holder, not a site, and no
 *   resolution passes through it (a broken barrel included);
 * - an element whose tag name (or a namespace's head) is bound anywhere inside the top-level
 *   statement around it (a parameter, a destructured or local binding, a catch or loop binding, a
 *   nested function or class) isn't counted: it may not be the top-level name.
 */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { findFiles } from "@youiyoux/core";
import { ModuleGraph } from "../graph.ts";
import { langOf, parseModule, type ModuleInfo } from "../parse.ts";
import { ModuleResolver } from "../resolve.ts";
import type { PlaceLine } from "../screens/locate.ts";
import { resolveTag } from "../usage.ts";

/** The project's sources: youi.project.json's include and exclude globs and tsconfig. */
export interface WrapperSources {
  readonly root: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly tsconfig: string;
  /** Reads a source file by its absolute real path (tests count the reads); the file system by default. */
  readonly readFile?: (path: string) => Promise<string>;
}

/** A position in a file, 1-based line and column. */
interface Pos {
  readonly line: number;
  readonly column: number;
}
/** A node's span: from its start, up to (not including) its end. */
interface Span {
  readonly start: Pos;
  readonly end: Pos;
}

const spanOf = (node: SgNode): Span => {
  const { start, end } = node.range();
  return { start: { line: start.line + 1, column: start.column + 1 }, end: { line: end.line + 1, column: end.column + 1 } };
};
const atOrBefore = (a: Pos, b: Pos): boolean => a.line < b.line || (a.line === b.line && a.column <= b.column);
const inside = (p: Pos, span: Span): boolean => atOrBefore(span.start, p) && !atOrBefore(span.end, p);
/** A frame's position is usable only with a real line and column. */
const placed = (p: PlaceLine): boolean => Number.isInteger(p.line) && p.line >= 1 && Number.isInteger(p.column) && p.column >= 1;

interface Component {
  /** `<file>#<declared name>`. */
  readonly key: string;
  readonly span: Span;
}

const key = (file: string, name: string): string => `${file}#${name}`;

/** Top-level components declared in a module, with the span of each declaration. */
function componentsOf(module: ModuleInfo): Component[] {
  const out: Component[] = [];
  const add = (name: string | undefined, node: SgNode) => {
    if (!name || !/^[A-Z]/.test(name) || !module.declarations.has(name)) return;
    out.push({ key: key(module.file, name), span: spanOf(node) });
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

const NAMED = new Set(["function_declaration", "generator_function_declaration", "class_declaration", "function_expression", "function", "generator_function", "class"]);
const PATTERN_NAMES = new Set(["identifier", "shorthand_property_identifier_pattern"]);

/** The top-level statement around a node (a child of the program). */
function topOf(node: SgNode): SgNode {
  let top: SgNode = node;
  for (let up = node.parent(); up && up.kind() !== "program"; up = up.parent()) top = up;
  return top;
}

/**
 * The names bound anywhere inside a top-level statement, other than by that statement's own
 * top-level declaration: a `<Name>` there may not mean the top-level Name. Conservative: every
 * binding counts, wherever it is in the statement (parameters, destructuring, local declarations,
 * nested functions and classes, catch and loop bindings).
 */
function boundInside(top: SgNode): Set<string> {
  const declaration = top.kind() === "export_statement" ? (top.field("declaration") ?? top.field("value") ?? top) : top;
  const own = (declarer: SgNode): boolean => declarer.id() === declaration.id() || declarer.parent()?.id() === declaration.id();
  const bound = new Set<string>();
  const names = (pattern: SgNode | null): void => {
    if (!pattern) return;
    const walk = (n: SgNode): void => {
      if (PATTERN_NAMES.has(String(n.kind()))) bound.add(n.text());
      for (const child of n.children()) walk(child);
    };
    walk(pattern);
  };
  // One walk over the statement, by node kind (kinds a grammar lacks simply never match).
  const visit = (n: SgNode): void => {
    const kind = String(n.kind());
    if (kind === "variable_declarator" && !own(n)) names(n.field("name"));
    else if (NAMED.has(kind) && !own(n)) {
      const name = n.field("name");
      if (name) bound.add(name.text());
    }
    else if (kind === "formal_parameters") names(n);
    else if (kind === "arrow_function") names(n.field("parameter"));
    else if (kind === "catch_clause") names(n.field("parameter"));
    else if (kind === "for_in_statement") names(n.field("left"));
    for (const child of n.children()) visit(child);
  };
  visit(top);
  return bound;
}

/** The declaration a JSX tag in `module` names, as `<file>#<declared name>`, or null when not certain. */
async function declarationOf(graph: ModuleGraph, module: ModuleInfo, tag: string): Promise<string | null> {
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
 * For one behaviour run: the sources are parsed once, on first use, and kept in memory; each
 * answer is about the code alone, so the same code always gives the same line.
 */
export class WrapperIndex {
  private readonly sources: WrapperSources;
  /** Each file's top-level components, read once. */
  private readonly components = new Map<string, Component[]>();
  private built: Promise<{ modules: Map<string, ModuleInfo | null>; sites: Map<string, Array<{ file: string; span: Span }>> }> | null = null;

  constructor(sources: WrapperSources) {
    this.sources = sources;
  }

  private build() {
    this.built ??= (async () => {
      const { root, include, exclude, tsconfig } = this.sources;
      const realRoot = await realpath(root);
      const files = (await findFiles(root, include, exclude)).filter((f) => langOf(f) === "tsx" || langOf(f) === "ts");
      const modules = new Map<string, ModuleInfo | null>();
      const reader = this.sources.readFile ?? ((path: string) => readFile(path, "utf8"));
      // Checked before anything is opened: a plain file under the root whose real path is its own.
      const read = async (file: string): Promise<string | null> => {
        if (!file || isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
        const real = await realpath(join(root, file)).catch(() => null);
        if (real !== join(realRoot, file)) return null;
        return reader(real).catch(() => null);
      };
      // A module that doesn't parse cleanly is unreadable: nothing resolves through it.
      const parse = async (file: string, source: string) => {
        const module = await parseModule(file, source);
        return module && module.parseErrors === 0 ? module : null;
      };
      const graph = new ModuleGraph(root, ModuleResolver.create(root, tsconfig), modules, new Map(), parse, read);
      await Promise.all(files.map((file) => graph.load(file)));
      const sites = new Map<string, Array<{ file: string; span: Span }>>();
      for (const file of files) {
        const module = modules.get(file);
        if (!module || module.parseErrors > 0) continue;
        const boundIn = new Map<number, Set<string>>();
        for (const element of module.jsx) {
          if (/^[a-z]/.test(element.tag) && !element.tag.includes(".")) continue;
          const top = topOf(element.node);
          let bound = boundIn.get(top.id());
          if (!bound) boundIn.set(top.id(), (bound = boundInside(top)));
          if (bound.has(element.tag.split(".")[0]!)) continue;
          const component = await declarationOf(graph, module, element.tag);
          if (!component) continue;
          const list = sites.get(component) ?? [];
          list.push({ file, span: spanOf(element.node) });
          sites.set(component, list);
        }
      }
      return { modules, sites };
    })();
    return this.built;
  }

  /**
   * Where the button is used, for `first` (the position that renders it, from React's owner chain)
   * and the positions after it: when `first` is inside a component W the code uses in more than one
   * place, the next position, if it is inside one of W's `<W …>` elements. Positions inside W itself
   * (its own helpers, a `.map` callback) are W's own stack and passed over; anything else ends the
   * look, as does a skipped (System) or uncertain frame, or one without a column. Null keeps `first`.
   */
  async usage(first: PlaceLine, rest: readonly PlaceLine[]): Promise<PlaceLine | null> {
    if (!placed(first)) return null;
    const { modules, sites } = await this.build();
    const module = modules.get(first.file);
    if (!module || module.parseErrors > 0) return null;
    let declared = this.components.get(module.file);
    if (!declared) this.components.set(module.file, (declared = componentsOf(module)));
    const holder = declared.find((c) => inside(first, c.span));
    if (!holder) return null;
    const uses = sites.get(holder.key) ?? [];
    if (uses.length < 2) return null;
    for (const next of rest) {
      if (next.skipped || next.uncertain || !placed(next)) return null;
      if (uses.some((u) => u.file === next.file && inside(next, u.span))) return next;
      if (next.file === first.file && inside(next, holder.span)) continue;
      return null;
    }
    return null;
  }
}
