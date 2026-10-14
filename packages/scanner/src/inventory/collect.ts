/**
 * One project's inventory: definitions, kits, primitives and looks, each with file:line and
 * route. It reuses the scanner's parse (parse.ts), binding resolution (graph.ts, resolve.ts),
 * route attribution (routes.ts) and JSX props and tag resolution (usage.ts), with no design
 * system: nothing here reads or writes a youi.usage/v1 map.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { matchesAny, type InventoryDefinition, type InventoryKit, type InventoryLook, type InventoryPrimitive, type InventoryProject, type InventoryRecipe, type InventoryRecipeWrapper, type InventoryRole, type PropValue } from "@youiyoux/core";
import { readRules, splitTopLevel } from "@youiyoux/tokens";
import { ModuleGraph, type ResolvedSymbol } from "../graph.ts";
import { gitState } from "../identity.ts";
import { parseModule, unquote, type ModuleInfo } from "../parse.ts";
import { ModuleResolver } from "../resolve.ts";
import { RouteIndex } from "../routes.ts";
import { propsOf, resolveTag } from "../usage.ts";
import { parseAstro, type AstroFile, type TemplateTag } from "./astro.ts";
import { classValueOf, jsxClassAttribute, parseExpression, type ClassValue } from "./classes.ts";
import { componentName, roleOfBlock, roleOfClass, roleOfComponent, roleOfIntrinsic, roleOfName } from "./roles.ts";
import { findStoryFiles, readCsf, storyConfig, type CsfFile, type CsfStory } from "./stories.ts";
import { ClassRules, resolveClasses, SHAPE_PROPERTIES } from "./style.ts";
import type { InventoryTarget } from "./target.ts";
import { buildTheme, readStylesheet, type Stylesheet, type Theme } from "./theme.ts";

/** Packages that are the framework itself, not a UI library. */
const FRAMEWORK = new Set(["react", "react-dom", "astro", "preact", "solid-js", "vue"]);
const MAX_PRIMITIVE_SITES = 50;
/** The element a role draws as when nothing names its root tag, for a recipe's static fallback. */
const ROLE_TAG: Readonly<Record<InventoryRole, string>> = { button: "button", "link-as-button": "a", input: "input", card: "div", badge: "span", dialog: "div", tabs: "button" };
/** Props a recipe never passes on: computed values are already out; these change what renders, not how it looks. */
const UNPASSED = /^(?:asChild|key|ref|on[A-Z].*|\{.*)$/;

export interface CvaTable {
  readonly key: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly base: readonly string[];
  readonly variants: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly defaults: ReadonlyMap<string, string>;
}

/** How a definition styles its root element. */
interface Recipe {
  readonly tag: string | null;
  readonly classes: ClassValue;
  readonly cva: { readonly table: CvaTable; readonly fixed: ReadonlyMap<string, string>; readonly fromProps: ReadonlyMap<string, string> } | null;
}

export interface Definition {
  readonly entry: InventoryDefinition;
  readonly recipe: Recipe | null;
  /** Source range of the declaration (React only), to tell its own elements from sites. */
  readonly range: { readonly start: number; readonly end: number } | null;
  /** Its root element: the ast-grep node id in React, `line * 100000 + column` in an Astro template. */
  readonly rootId: number | null;
}

export interface ImportedKit {
  readonly role: InventoryRole;
  readonly kit: string;
  readonly name: string;
  readonly specifier: string;
  readonly line: number;
}

export interface ProjectInventory {
  readonly id: string;
  readonly target: InventoryTarget;
  readonly commit: string | null;
  readonly failed: Array<{ file: string; reason: string }>;
  readonly warnings: string[];
  readonly definitions: InventoryDefinition[];
  readonly kits: InventoryKit[];
  readonly primitives: InventoryPrimitive[];
  readonly looks: Array<Omit<InventoryLook, "family">>;
  /** Per file, the kits it imports a role from: the input for mixed-kit flags. */
  readonly kitImports: Map<string, ImportedKit[]>;
  /** Its Storybook stories, when it has any (their looks are in `looks`, with `story`). */
  readonly stories: StoriesRead | null;
}

export type StoriesRead = NonNullable<InventoryProject["stories"]>;

/** Module graph that also resolves `.astro` specifiers, which TypeScript resolution does not. */
class InventoryGraph extends ModuleGraph {
  private readonly aliases: ReadonlyArray<readonly [string, string]>;
  private readonly known: ReadonlySet<string>;

  constructor(root: string, resolver: ModuleResolver, modules: Map<string, ModuleInfo | null>, parse: (file: string, source: string) => Promise<ModuleInfo | null>, aliases: ReadonlyArray<readonly [string, string]>, known: ReadonlySet<string>) {
    super(root, resolver, modules, new Map(), parse);
    this.aliases = aliases;
    this.known = known;
  }

  override resolveSpecifier(specifier: string, fromFile: string): ReturnType<ModuleGraph["resolveSpecifier"]> {
    if (!specifier.endsWith(".astro")) return super.resolveSpecifier(specifier, fromFile);
    const candidates = specifier.startsWith(".") ? [posix.normalize(posix.join(posix.dirname(fromFile), specifier))] : this.aliases.filter(([prefix]) => specifier.startsWith(prefix)).map(([prefix, target]) => posix.normalize(posix.join(target, specifier.slice(prefix.length))));
    const file = candidates.find((c) => this.known.has(c));
    return file ? { kind: "file", file } : { kind: "unresolved" };
  }
}

/** `paths` aliases (`@/*` → `src/*`) from a tsconfig, read leniently (comments and trailing commas allowed; comment markers inside strings, as in an include glob, are kept). */
export async function pathAliases(root: string, tsconfig: string): Promise<Array<[string, string]>> {
  const text = await readFile(join(root, tsconfig), "utf8").catch(() => null);
  if (!text) return [];
  try {
    const json = JSON.parse(text.replace(/("(?:[^"\\\n]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/.*$/gm, (_, string: string | undefined) => string ?? "").replace(/,(\s*[}\]])/g, "$1")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const base = json.compilerOptions?.baseUrl ?? ".";
    return Object.entries(json.compilerOptions?.paths ?? {}).flatMap(([key, [target]]) => (target ? [[key.replace(/\*$/, ""), posix.normalize(posix.join(base, target.replace(/\*$/, "")))] as [string, string]] : []));
  } catch {
    return [];
  }
}

const position = (node: SgNode): { line: number; column: number } => ({ line: node.range().start.line + 1, column: node.range().start.column + 1 });
const pascal = (text: string): string => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
export const packageOf = (specifier: string): string => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
const literalOf = (value: PropValue | undefined): string | null => (value && "literal" in value ? String(value.literal) : null);
const exportOf = (definition: Definition): string => definition.entry.id.slice(definition.entry.id.lastIndexOf("#") + 1);

/** A site's literal props, for a recipe. */
function recipeProps(props: Readonly<Record<string, PropValue>>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(props).flatMap(([name, value]) => ("literal" in value && !UNPASSED.test(name) ? [[name, value.literal]] : [])));
}

/** Retain names only: expressions are never evaluated by a specimen. */
function recipeDynamic(props: Readonly<Record<string, PropValue>>): { dynamic?: string[] } {
  const dynamic = Object.entries(props).filter(([name, value]) => "dynamic" in value && !UNPASSED.test(name)).map(([name]) => name).sort();
  return dynamic.length ? { dynamic } : {};
}

/**
 * The text a JSX element wraps (`<Button><Plus /> New run</Button>` → `New run`), and its only
 * child element's (`<Button asChild><a>Settings</a></Button>`); a container's children are not a label.
 */
function jsxLabel(opening: SgNode): string | null {
  const element = opening.parent();
  if (opening.kind() !== "jsx_opening_element" || element?.kind() !== "jsx_element") return null;
  const children = element.children();
  const nestedOk = children.filter((c) => c.kind() === "jsx_element" || c.kind() === "jsx_self_closing_element").length === 1;
  const parts: string[] = [];
  for (const child of children) {
    if (child.kind() === "jsx_text") parts.push(child.text());
    else if (child.kind() === "jsx_expression") {
      const inner = child.children().find((c) => c.isNamed() && c.kind() !== "comment");
      if (inner?.kind() === "string") parts.push(unquote(inner.text()));
    } else if (child.kind() === "jsx_element" && nestedOk) {
      const nested = child.children().find((c) => c.kind() === "jsx_opening_element");
      parts.push((nested && jsxLabel(nested)) ?? "");
    }
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

/* ----------------------------------------------------------------- CVA tables */

function stringsOf(node: SgNode | null): string[] {
  if (!node) return [];
  return classValueOf(node).certain;
}

function pairs(object: SgNode | null): Array<{ key: string; value: SgNode | null; node: SgNode }> {
  if (!object || object.kind() !== "object") return [];
  return object.children().flatMap((c) => {
    if (c.kind() === "pair") return [{ key: unquote(c.field("key")?.text() ?? ""), value: c.field("value"), node: c }];
    if (c.kind() === "shorthand_property_identifier") return [{ key: c.text(), value: c, node: c }];
    return [];
  });
}

function cvaTables(module: ModuleInfo): CvaTable[] {
  const locals = new Set(module.imports.filter((i) => (i.specifier === "class-variance-authority" || i.specifier === "cva") && (i.imported === "cva" || i.imported === "default")).map((i) => i.local));
  if (locals.size === 0) return [];
  const tables: CvaTable[] = [];
  for (const call of module.root.root().findAll({ rule: { kind: "call_expression" } })) {
    if (!locals.has(call.field("function")?.text() ?? "")) continue;
    const declarator = call.parent();
    const name = declarator?.kind() === "variable_declarator" ? declarator.field("name")?.text() : undefined;
    if (!name) continue;
    const [baseArg, config] = call.field("arguments")?.children().filter((c) => c.isNamed() && c.kind() !== "comment") ?? [];
    const options = pairs(config ?? null);
    const variants = new Map(pairs(options.find((p) => p.key === "variants")?.value ?? null).map((variant) => [variant.key, new Map(pairs(variant.value).map((v) => [v.key, stringsOf(v.value)] as const))] as const));
    const defaults = new Map(pairs(options.find((p) => p.key === "defaultVariants")?.value ?? null).flatMap((p) => (p.value && /^(?:string|true|false|number)$/.test(String(p.value.kind())) ? [[p.key, unquote(p.value.text())] as const] : [])));
    tables.push({ key: `${module.file}#${name}`, name, file: module.file, line: position(call).line, base: stringsOf(baseArg ?? null), variants, defaults });
  }
  return tables;
}

/* ---------------------------------------------------------------- the pass */

export class ProjectPass {
  readonly target: InventoryTarget;
  readonly modules = new Map<string, ModuleInfo | null>();
  readonly astro = new Map<string, AstroFile>();
  readonly sheets: Stylesheet[] = [];
  readonly failed: Array<{ file: string; reason: string }> = [];
  readonly definitions = new Map<string, Definition>();
  readonly tables = new Map<string, CvaTable>();
  readonly looks: Array<Omit<InventoryLook, "family">> = [];
  readonly primitives = new Map<string, { exports: Set<string>; sites: InventoryPrimitive["sites"]; count: number }>();
  readonly kitImports = new Map<string, ImportedKit[]>();
  /** Class kit blocks: class name → its definition. */
  readonly blocks = new Map<string, Definition>();
  readonly kits: InventoryKit[] = [];
  stories: StoriesRead | null = null;
  graph!: InventoryGraph;
  routes!: RouteIndex;
  theme!: Theme;
  globalRules = new ClassRules();
  private readonly fileRules = new Map<string, ClassRules>();
  private readonly routeFiles: Set<string>;

  /** Also record each role-bearing definition's own root as a look (its default shape), rendered or not. */
  private readonly definitionRoots: boolean;

  constructor(target: InventoryTarget, options: CollectOptions = {}) {
    this.target = target;
    this.definitionRoots = options.definitionRoots === true;
    const map = target.routes.strategy === "map" ? target.routes.map.map((m) => m.file) : [];
    this.routeFiles = new Set(target.files.filter((f) => matchesAny(f, [...map, ...target.routes.shell]) || (target.routes.strategy === "expo-router" && f.startsWith(`${target.routes.appDir}/`))));
  }

  get id(): string {
    return this.target.id;
  }

  private parse = async (file: string, source: string): Promise<ModuleInfo | null> => {
    if (!file.endsWith(".astro")) return parseModule(file, source);
    const astro = await parseAstro(file, source);
    this.astro.set(file, astro);
    if (astro.problems.length > 0) this.failed.push({ file, reason: astro.problems.join("; ") });
    return astro.module;
  };

  async read(): Promise<void> {
    const { root, files, tsconfig } = this.target;
    await Promise.all(
      files.map(async (file) => {
        try {
          const source = await readFile(join(root, file), "utf8");
          if (file.endsWith(".css")) this.sheets.push(await readStylesheet(file, source));
          const module = await this.parse(file, source);
          this.modules.set(file, module);
          if (module && module.parseErrors > 0) this.failed.push({ file, reason: `${module.parseErrors} parse error node(s); looks inside them may be missing` });
        } catch (error: unknown) {
          this.modules.set(file, null);
          this.failed.push({ file, reason: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    this.sheets.sort((a, b) => a.file.localeCompare(b.file));
    const resolver = ModuleResolver.create(root, tsconfig);
    if (files.some((f) => /\.(tsx|jsx|ts)$/.test(f))) for (const problem of resolver.problems) this.failed.push({ file: tsconfig, reason: problem });
    this.graph = new InventoryGraph(root, resolver, this.modules, this.parse, await pathAliases(root, tsconfig), new Set(files));
    this.routes = RouteIndex.build(this.graph, this.modules, this.target.routes);
    const pkg = JSON.parse((await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) || "{}") as Record<string, Record<string, string> | undefined>;
    const tailwindPackage = Boolean(pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss);
    this.theme = await buildTheme(root, this.sheets, tailwindPackage);
    for (const sheet of this.sheets) this.globalRules.addSheet(sheet);
  }

  /** Global stylesheets plus a file's own `<style>` blocks. */
  private rulesFor(file: string): ClassRules {
    const astro = this.astro.get(file);
    if (!astro || astro.styles.length === 0) return this.globalRules;
    let rules = this.fileRules.get(file);
    if (!rules) {
      rules = new ClassRules();
      for (const sheet of this.sheets) rules.addSheet(sheet);
      for (const style of astro.styles) rules.add(readRules(style.css));
      this.fileRules.set(file, rules);
    }
    return rules;
  }

  private sortedModules(): ModuleInfo[] {
    return [...this.modules.values()].filter((m): m is ModuleInfo => m !== null).sort((a, b) => a.file.localeCompare(b.file));
  }

  /* ------------------------------------------------------------ class kits */

  classKits(): void {
    for (const sheet of this.sheets) {
      const blocks = new Map<string, { line: number; modifiers: Set<string> }>();
      // Plain classes named for an element (`.badge`, `.btn--ghost`) and whether a rule gives them a shape.
      const plain = new Map<string, { line: number; modifiers: Set<string>; shaped: boolean }>();
      for (const rule of sheet.rules) {
        if (rule.preludes.slice(0, -1).some((p) => !p.startsWith("@"))) continue;
        const prelude = rule.preludes.at(-1) ?? "";
        for (const match of prelude.matchAll(/(?:^|[\s,>+~])\.([a-z][a-z0-9]*-[a-z0-9-]*?)(?:--([a-z0-9-]+))?(?=[\s,:.[>+~{]|$)/g)) {
          const [, block, modifier] = match as unknown as [string, string, string | undefined];
          if (block.includes("__")) continue;
          const entry = blocks.get(block) ?? { line: rule.declarations[0]?.line ?? 1, modifiers: new Set<string>() };
          if (modifier) entry.modifiers.add(modifier);
          blocks.set(block, entry);
        }
        const shaped = rule.declarations.some((d) => SHAPE_PROPERTIES.test(d.property));
        for (const selector of splitTopLevel(prelude, ",")) {
          const match = /^\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:--([a-z0-9-]+))?$/.exec(selector.trim());
          if (!match || !roleOfClass(match[1]!)) continue;
          const [, name, modifier] = match as unknown as [string, string, string | undefined];
          const entry = plain.get(name) ?? { line: rule.declarations[0]?.line ?? 1, modifiers: new Set<string>(), shaped: false };
          if (modifier) entry.modifiers.add(modifier);
          entry.shaped ||= shaped;
          plain.set(name, entry);
        }
      }
      const byPrefix = new Map<string, string[]>();
      for (const block of blocks.keys()) {
        const prefix = `${block.split("-")[0]}-`;
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), block]);
      }
      const kit = `${this.id}:${sheet.file}`;
      const found: Array<{ name: string; role: InventoryRole | null; line: number; modifiers: Set<string> }> = [];
      const prefixes: string[] = [];
      for (const [prefix, names] of byPrefix) {
        // A prefixed kit is a family of blocks: at least two, and at least one an element we know.
        const roles = names.map((b) => roleOfBlock(b, prefix));
        if (names.length < 2 || roles.every((r) => r === null)) continue;
        prefixes.push(prefix);
        for (const block of names) found.push({ name: block, role: roleOfBlock(block, prefix), ...blocks.get(block)! });
      }
      // A plain class is a member on its own when it is named for an element and sets a shape.
      for (const [name, entry] of plain) if (entry.shaped && !found.some((f) => f.name === name)) found.push({ name, role: roleOfClass(name), line: entry.line, modifiers: entry.modifiers });
      if (found.length === 0) continue;
      const members: InventoryKit["members"] = [];
      for (const { name, role, line, modifiers } of found.sort((a, b) => a.name.localeCompare(b.name))) {
        const variants: Record<string, string[]> = modifiers.size > 0 ? { modifier: [...modifiers].sort() } : {};
        const entry: InventoryDefinition = { id: `${kit}#.${name}`, project: this.id, name: `.${name}`, file: sheet.file, line, kind: "class", kit, role, variants };
        const definition = { entry, recipe: { tag: null, classes: { certain: [name], conditional: [], dynamic: [], calls: [], passthrough: true }, cva: null }, range: null, rootId: null };
        this.definitions.set(entry.id, definition);
        this.blocks.set(name, definition);
        members.push({ name: entry.name, role, file: sheet.file, line, variants });
      }
      this.kits.push({ id: kit, project: this.id, kind: "class-kit", path: sheet.file, ...(prefixes.length === 1 ? { prefix: prefixes[0]! } : {}), members });
    }
  }

  /* ---------------------------------------------------------- definitions */

  private kitOfClasses(classes: readonly string[]): string | null {
    for (const name of classes) {
      const block = this.blocks.get(name);
      if (block) return block.entry.kit;
    }
    return null;
  }

  private async recipeOf(module: ModuleInfo, node: SgNode): Promise<{ recipe: Recipe; root: SgNode } | null> {
    const root = node.find({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }] } });
    if (!root) return null;
    const tag = root.field("name")?.text() ?? "";
    let intrinsic: string | null = /^[a-z]/.test(tag) ? tag : null;
    if (!intrinsic) {
      // `const Comp = asChild ? Slot : "button"`: the element it renders by default.
      const declarator = node.findAll({ rule: { kind: "variable_declarator" } }).find((d) => d.field("name")?.text() === tag);
      intrinsic = /"([a-z][a-z0-9]*)"/.exec(declarator?.field("value")?.text() ?? "")?.[1] ?? null;
    }
    const classes = classValueOf(jsxClassAttribute(root));
    let cva: Recipe["cva"] = null;
    for (const call of classes.calls) {
      const table = await this.tableFor(module, call.callee);
      if (!table) {
        classes.dynamic.push(`${call.callee}(…)`);
        continue;
      }
      const fixed = new Map<string, string>();
      const fromProps = new Map<string, string>();
      for (const pair of pairs(call.args)) {
        if (pair.key === "className" || pair.key === "class") continue;
        const kind = pair.value?.kind();
        if (kind === "string") fixed.set(pair.key, unquote(pair.value!.text()));
        else if (kind === "identifier" || kind === "shorthand_property_identifier") fromProps.set(pair.key, pair.value!.text());
      }
      cva = { table, fixed, fromProps };
    }
    return { recipe: { tag: intrinsic, classes, cva }, root };
  }

  private async tableFor(module: ModuleInfo, callee: string): Promise<CvaTable | null> {
    const local = this.tables.get(`${module.file}#${callee}`);
    if (local) return local;
    const symbol = await this.graph.resolveLocal(module, callee);
    return symbol.kind === "symbol" ? (this.tables.get(`${symbol.file}#${symbol.name}`) ?? null) : null;
  }

  private async resolvedRoot(module: ModuleInfo, tag: string): Promise<InventoryDefinition["root"]> {
    if (/^[a-z]/.test(tag) && !tag.includes(".")) return { kind: "intrinsic", tag };
    const { symbol } = await resolveTag(this.graph, module, tag);
    if (symbol.kind === "symbol") return { kind: "definition", id: `${this.id}:${symbol.file}#${symbol.name}` };
    if (symbol.kind === "external" && !FRAMEWORK.has(packageOf(symbol.module))) return { kind: "primitive", module: symbol.module, name: symbol.name };
    return undefined;
  }

  async reactDefinitions(): Promise<void> {
    for (const module of this.sortedModules()) for (const table of cvaTables(module)) this.tables.set(table.key, table);
    const cvaFolders = new Set([...this.tables.values()].map((t) => posix.dirname(t.file)));
    for (const module of this.sortedModules()) {
      if (module.lang === "css" || module.file.endsWith(".astro")) continue;
      const declarations = new Map<string, { node: SgNode; name: SgNode }>();
      for (const child of module.root.root().children()) {
        const target = child.kind() === "export_statement" ? child.field("declaration") : child;
        if (!target) continue;
        if (target.kind() === "function_declaration") declarations.set(target.field("name")?.text() ?? "", { node: target, name: target.field("name")! });
        if (target.kind() === "lexical_declaration") {
          for (const declarator of target.findAll({ rule: { kind: "variable_declarator" } }).filter((d) => d.parent()?.id() === target.id())) {
            const name = declarator.field("name");
            if (name?.kind() === "identifier") declarations.set(name.text(), { node: declarator, name });
          }
        }
      }
      for (const entry of module.exports) {
        if (entry.kind !== "local") continue;
        const name = entry.name === "default" ? entry.local : entry.name;
        const declaration = declarations.get(entry.local);
        if (!declaration || !/^[A-Z]/.test(name) || (entry.name === "default" && this.routeFiles.has(module.file))) continue;
        const value = declaration.node.kind() === "variable_declarator" ? declaration.node.field("value") : declaration.node;
        // Only a TSX tree has JSX node kinds; querying them on a TypeScript tree throws.
        const hasJsx = module.lang === "tsx" && declaration.node.find({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }] } }) !== null;
        const wrapper = value?.kind() === "member_expression" || (value?.kind() === "call_expression" && /(?:forwardRef|memo)$/.test(value.field("function")?.text() ?? ""));
        const alias = this.definitionRoots && value?.kind() === "identifier" && /^[A-Z]/.test(value.text());
        if (!hasJsx && !wrapper && !alias) continue;
        const found = hasJsx ? await this.recipeOf(module, declaration.node) : null;
        const folder = posix.dirname(module.file);
        const kit = cvaFolders.has(folder) ? `${this.id}:${folder}` : found ? this.kitOfClasses(found.recipe.classes.certain) : null;
        const variants = found?.recipe.cva ? Object.fromEntries([...found.recipe.cva.table.variants].filter(([key]) => !found.recipe.cva!.fixed.has(key)).map(([key, values]) => [key, [...values.keys()]])) : {};
        const def: InventoryDefinition = { id: `${this.id}:${module.file}#${entry.name}`, project: this.id, name, file: module.file, ...position(declaration.name), kind: "react", kit, role: roleOfName(name), variants };
        if (this.definitionRoots) {
          let target = value;
          while (target?.kind() === "call_expression" && /(?:forwardRef|memo)$/.test(target.field("function")?.text() ?? "")) {
            target = target.field("arguments")?.children().find((c) => c.isNamed() && c.kind() !== "comment") ?? null;
          }
          const tag = found?.root.field("name")?.text() ?? (target && (target.kind() === "identifier" || target.kind() === "member_expression") ? target.text() : null);
          const root = tag ? await this.resolvedRoot(module, tag) : undefined;
          if (root) def.root = root;
        }
        const range = declaration.node.range();
        this.definitions.set(`${module.file}#${entry.name}`, { entry: def, recipe: found?.recipe ?? null, range: { start: range.start.index, end: range.end.index }, rootId: found?.root.id() ?? null });
      }
    }
    for (const folder of [...cvaFolders].sort()) {
      const id = `${this.id}:${folder}`;
      const members = [...this.definitions.values()].filter((d) => d.entry.kit === id && d.entry.kind === "react").map((d) => ({ name: d.entry.name, role: d.entry.role, file: d.entry.file, line: d.entry.line, variants: d.entry.variants }));
      this.kits.push({ id, project: this.id, kind: "cva-folder", path: folder, members });
    }
  }

  private async templateClasses(tag: TemplateTag): Promise<ClassValue> {
    const value: ClassValue = { certain: [], conditional: [], dynamic: [], calls: [], passthrough: false };
    for (const attribute of tag.attributes) {
      if (attribute.name !== "class" && attribute.name !== "class:list" && attribute.name !== "className") continue;
      if ("literal" in attribute.value) {
        if (attribute.value.literal !== true) value.certain.push(...attribute.value.literal.split(/\s+/).filter(Boolean));
        continue;
      }
      const parsed = classValueOf(await parseExpression(attribute.value.expression));
      value.certain.push(...parsed.certain);
      value.conditional.push(...parsed.conditional);
      value.dynamic.push(...parsed.dynamic);
      value.passthrough ||= parsed.passthrough;
    }
    return value;
  }

  async astroDefinitions(): Promise<void> {
    for (const [file, astro] of [...this.astro].sort(([a], [b]) => a.localeCompare(b))) {
      if (this.routeFiles.has(file)) continue;
      const name = pascal(posix.basename(file, ".astro"));
      const root = astro.tags.find((t) => /^[a-z]/.test(t.tag) && !["slot", "style", "script", "fragment"].includes(t.tag));
      const classes = root ? await this.templateClasses(root) : null;
      const recipe: Recipe | null = root && classes ? { tag: root.tag, classes, cva: null } : null;
      const entry: InventoryDefinition = { id: `${this.id}:${file}#default`, project: this.id, name, file, line: 1, kind: "astro", kit: classes ? this.kitOfClasses(classes.certain) : null, role: roleOfName(name), variants: {} };
      this.definitions.set(`${file}#default`, { entry, recipe, range: null, rootId: root ? root.line * 100_000 + root.column : null });
    }
  }

  /* ------------------------------------------------------------------ looks */

  private addLook(input: { file: string; line: number; column: number; role: InventoryRole; source: InventoryLook["source"]; tag: string; definition: Definition | null; classes: readonly string[]; rootTag: string | null; unresolved: readonly string[]; recipe: InventoryRecipe; story?: InventoryLook["story"] }): void {
    const resolved = resolveClasses(input.classes, input.rootTag, this.theme, this.rulesFor(input.file));
    // A story is an authored state, rendered on no route.
    const routes = input.story ? { routes: [], routeSource: "unrouted" as const } : this.routes.of(input.file);
    this.looks.push({
      id: `${this.id}:${input.file}:${input.line}:${input.column}`,
      role: input.role,
      project: this.id,
      file: input.file,
      line: input.line,
      column: input.column,
      routes: routes.routes,
      routeSource: routes.routeSource,
      source: input.source,
      tag: input.tag,
      definition: input.definition?.entry.id ?? null,
      kit: input.definition?.entry.kit ?? null,
      shape: resolved.shape,
      derived: resolved.derived,
      unresolved: [...new Set([...input.unresolved, ...resolved.unresolved])],
      responsive: resolved.responsive,
      states: resolved.states,
      recipe: input.recipe,
      ...(input.story ? { story: input.story } : {}),
    });
  }

  /** A recipe for a look: the project's own React export when there is one, else its tag and classes. */
  private recipeFor(role: InventoryRole, definition: Definition | null, rootTag: string | null, classes: readonly string[], props: Readonly<Record<string, PropValue>>, label: string | null, wrappers: InventoryRecipeWrapper[]): InventoryRecipe {
    const tag = rootTag ?? ROLE_TAG[role];
    const text = /^(?:input|img|hr|br)$/.test(tag) ? null : label;
    if (definition?.entry.kind !== "react") return { kind: "class", tag, classes: [...new Set(classes)], label: text };
    return { kind: "component", file: definition.entry.file, export: exportOf(definition), props: recipeProps(props), ...recipeDynamic(props), label: text, wrappers, tag, classes: [...new Set(classes)] };
  }

  /**
   * The components of the look's own module the site renders it inside, outermost first, with
   * their literal props (Tabs and TabsList around a TabsTrigger). A dialog's compound root is
   * opened, so its content renders.
   */
  private async wrappersOf(module: ModuleInfo, opening: SgNode, definition: Definition | null, role: InventoryRole): Promise<InventoryRecipeWrapper[]> {
    if (definition?.entry.kind !== "react") return [];
    const wrappers: InventoryRecipeWrapper[] = [];
    const own = exportOf(definition);
    for (let node = opening.parent()?.parent() ?? null; node; node = node.parent()) {
      if (node.kind() !== "jsx_element") continue;
      const open = node.children().find((c) => c.kind() === "jsx_opening_element");
      const tag = open?.field("name")?.text();
      if (!open || !tag || /^[a-z]/.test(tag)) continue;
      const { symbol } = await resolveTag(this.graph, module, tag);
      const wrapper = symbol.kind === "symbol" ? this.definitions.get(`${symbol.file}#${symbol.name}`) : undefined;
      if (!wrapper || wrapper === definition || wrapper.entry.kind !== "react" || wrapper.entry.file !== definition.entry.file) continue;
      const props = recipeProps(propsOf(open).props);
      const name = exportOf(wrapper);
      if (role === "dialog" && own.startsWith(name) && own !== name) props.open = true;
      wrappers.unshift({ file: wrapper.entry.file, export: name, props, ...recipeDynamic(propsOf(open).props) });
    }
    return wrappers;
  }

  private async parentOf(module: ModuleInfo, opening: SgNode, helper = true): Promise<InventoryRecipeWrapper | undefined> {
    for (let node = opening.kind() === "jsx_self_closing_element" ? opening.parent() : opening.parent()?.parent() ?? null; node; node = node.parent()) {
      if (node.kind() !== "jsx_element") continue;
      const open = node.children().find((c) => c.kind() === "jsx_opening_element");
      const tag = open?.field("name")?.text();
      if (!open || !tag || /^[a-z]/.test(tag)) continue;
      const { symbol } = await resolveTag(this.graph, module, tag);
      const parent = symbol.kind === "symbol" ? this.definitions.get(`${symbol.file}#${symbol.name}`) : undefined;
      if (parent?.entry.kind === "react") return { file: parent.entry.file, export: exportOf(parent), props: recipeProps(propsOf(open).props), ...recipeDynamic(propsOf(open).props) };
    }
    // A helper whose root is this site inherits the parent shared by all its uses.
    const owner = this.enclosing(module.file, opening.range().start.index);
    if (!helper || !owner || owner.rootId !== opening.id()) return undefined;
    const parents: Array<InventoryRecipeWrapper | undefined> = [];
    for (const source of this.sortedModules()) for (const site of source.jsx) {
      if (/^[a-z]/.test(site.tag)) continue;
      const { symbol } = await resolveTag(this.graph, source, site.tag);
      if (symbol.kind === "symbol" && symbol.file === owner.entry.file && symbol.name === exportOf(owner)) parents.push(await this.parentOf(source, site.node, false));
    }
    const first = parents[0];
    return first && parents.every((p) => p?.file === first.file && p?.export === first.export) ? first : undefined;
  }

  /** Classes for a rendered definition: CVA base, the variants chosen, its own classes, then the call site's. */
  private componentClasses(definition: Definition | null, props: Readonly<Record<string, PropValue>>, site: ClassValue): { classes: string[]; unresolved: string[] } {
    const recipe = definition?.recipe ?? null;
    const classes: string[] = [];
    const unresolved: string[] = [];
    if (recipe?.cva) {
      const { table, fixed, fromProps } = recipe.cva;
      classes.push(...table.base);
      for (const [variant, values] of table.variants) {
        const prop = fromProps.get(variant);
        const given = props[prop ?? variant];
        let choice = fixed.get(variant) ?? (prop !== undefined ? literalOf(given) : null);
        if (choice === null && given && "dynamic" in given) unresolved.push(`${prop ?? variant}={${given.dynamic}}`);
        choice ??= table.defaults.get(variant) ?? null;
        if (choice !== null) classes.push(...(values.get(choice) ?? []));
      }
    }
    if (recipe) {
      classes.push(...recipe.classes.certain);
      unresolved.push(...recipe.classes.dynamic, ...recipe.classes.conditional.map((c) => `${c} (conditional)`));
    }
    if (!recipe || recipe.classes.passthrough || definition?.entry.kind === "class") {
      classes.push(...site.certain);
      unresolved.push(...site.dynamic, ...site.conditional.map((c) => `${c} (conditional)`));
    }
    return { classes, unresolved };
  }

  private intrinsicLook(file: string, at: { line: number; column: number }, tag: string, props: Readonly<Record<string, PropValue>>, site: ClassValue, inside: InventoryRole | null, label: string | null): void {
    let role = roleOfIntrinsic(tag, props);
    const block = site.certain.map((c) => this.blocks.get(c)).find(Boolean) ?? null;
    role ??= block?.entry.role ?? null;
    if (!role || role === inside) return;
    const recipe: InventoryRecipe = { kind: "class", tag, classes: [...new Set(site.certain)], label: /^(?:input|img|hr|br)$/.test(tag) ? null : label };
    this.addLook({ file, ...at, role, source: "intrinsic", tag, definition: block, classes: site.certain, rootTag: tag, unresolved: [...site.dynamic, ...site.conditional.map((c) => `${c} (conditional)`)], recipe });
  }

  private primitiveSite(file: string, at: { line: number; column: number }, symbol: Extract<ResolvedSymbol, { kind: "external" }>): string | null {
    const pkg = packageOf(symbol.module);
    if (FRAMEWORK.has(pkg)) return null;
    const name = symbol.name.replace(/^\*\./, "");
    const record = this.primitives.get(pkg) ?? { exports: new Set<string>(), sites: [], count: 0 };
    record.exports.add(name);
    record.count++;
    if (record.sites.length < MAX_PRIMITIVE_SITES) record.sites.push({ project: this.id, file, ...at, export: name });
    this.primitives.set(pkg, record);
    return pkg;
  }

  private async noteImports(module: ModuleInfo): Promise<void> {
    // Each local name's own import statement: one specifier may be imported on several lines.
    const lines = new Map<string, number>();
    for (const statement of module.root.root().findAll({ rule: { kind: "import_statement" } })) {
      const line = position(statement).line;
      for (const name of statement.findAll({ rule: { kind: "identifier" } })) if (!lines.has(name.text())) lines.set(name.text(), line);
    }
    const found: ImportedKit[] = [];
    for (const binding of module.imports) {
      if (binding.typeOnly) continue;
      const symbol = await this.graph.resolveLocal(module, binding.local);
      if (symbol.kind === "external" || (symbol.kind === "unknown" && binding.imported === "*")) {
        // PascalCase imports from UI packages are primitives even when only passed around
        // (`export const Tabs = TabsPrimitive.Root`); a namespace import lists the members used.
        const pkg = packageOf(binding.specifier);
        if (FRAMEWORK.has(pkg) || binding.specifier.startsWith(".") || /^[@~#]\//.test(binding.specifier)) continue;
        const used = binding.imported === "*" ? module.root.root().findAll({ rule: { kind: "member_expression" } }).filter((m) => m.field("object")?.text() === binding.local).map((m) => m.field("property")?.text() ?? "") : [binding.imported];
        const names = used.filter((n) => /^[A-Z]/.test(n));
        if (names.length === 0) continue;
        const record = this.primitives.get(pkg) ?? { exports: new Set<string>(), sites: [], count: 0 };
        for (const name of names) record.exports.add(name);
        this.primitives.set(pkg, record);
        continue;
      }
      if (symbol.kind !== "symbol") continue;
      const definition = this.definitions.get(`${symbol.file}#${symbol.name}`);
      if (definition?.entry.kit && definition.entry.role) found.push({ role: definition.entry.role, kit: definition.entry.kit, name: definition.entry.name, specifier: binding.specifier, line: lines.get(binding.local) ?? 1 });
    }
    if (found.length > 0) this.kitImports.set(module.file, found);
  }

  private byFile: Map<string, Definition[]> | null = null;

  private enclosing(file: string, index: number): Definition | null {
    if (!this.byFile) {
      this.byFile = new Map();
      for (const d of this.definitions.values()) if (d.range) this.byFile.set(d.entry.file, [...(this.byFile.get(d.entry.file) ?? []), d]);
    }
    return this.byFile.get(file)?.find((d) => d.range!.start <= index && index < d.range!.end) ?? null;
  }

  async reactLooks(module: ModuleInfo): Promise<void> {
    for (const element of module.jsx) {
      const owner = this.enclosing(module.file, element.node.range().start.index);
      // A role-bearing definition's root element is the definition itself, not a site.
      const isRoot = owner !== null && owner.entry.role !== null && owner.rootId === element.node.id();
      const inside = owner?.entry.role ?? null;
      const { props } = propsOf(element.node);
      const site = classValueOf(jsxClassAttribute(element.node));
      const at = { line: element.line, column: element.column };
      const intrinsic = /^[a-z]/.test(element.tag) && !element.tag.includes(".");
      const { symbol, name } = intrinsic ? { symbol: null, name: element.tag } : await resolveTag(this.graph, module, element.tag);
      // A primitive counts wherever it is rendered, a definition's own root included.
      if (symbol?.kind === "external") this.primitiveSite(module.file, at, symbol);
      if (isRoot) {
        if (this.definitionRoots) this.rootLook(module.file, at, owner);
        continue;
      }
      const label = jsxLabel(element.node);
      if (label === null && element.node.kind() === "jsx_opening_element" && element.node.parent()?.children().some((c) => c.kind() === "jsx_expression" && c.children().some((n) => n.isNamed() && n.kind() !== "comment"))) {
        props.children = { dynamic: "expression children" };
      }
      if (!symbol) {
        this.intrinsicLook(module.file, at, element.tag, props, site, inside, label);
        continue;
      }
      const firstChild = firstChildTag(element.node);
      if (symbol.kind === "external") {
        const role = roleOfComponent(componentName(element.tag), props, firstChild);
        if (role && role !== inside) this.addLook({ file: module.file, ...at, role, source: "primitive", tag: element.tag, definition: null, classes: site.certain, rootTag: null, unresolved: [...site.dynamic, ...site.conditional.map((c) => `${c} (conditional)`)], recipe: this.recipeFor(role, null, null, site.certain, props, label, []) });
        continue;
      }
      const definition = symbol.kind === "symbol" ? (this.definitions.get(`${symbol.file}#${symbol.name}`) ?? null) : null;
      const role = roleOfComponent(definition?.entry.name ?? componentName(name === element.tag ? element.tag : name), props, firstChild);
      if (!role || role === inside) continue;
      const { classes, unresolved } = this.componentClasses(definition, props, site);
      if (!definition && symbol.kind !== "symbol") unresolved.unshift(`${element.tag}: ${symbol.kind === "unknown" ? symbol.detail : "a namespace object"}`);
      const rootTag = definition?.recipe?.tag ?? null;
      const recipe = this.recipeFor(role, definition, rootTag, classes, props, label, await this.wrappersOf(module, element.node, definition, role));
      const parent = await this.parentOf(module, element.node);
      this.addLook({ file: module.file, ...at, role, source: "component", tag: element.tag, definition, classes, rootTag, unresolved, recipe: recipe.kind === "component" && parent ? { ...recipe, parent } : recipe });
    }
  }

  /** A definition drawn as it is with no props: what a new component looks like before anything renders it. */
  private rootLook(file: string, at: { line: number; column: number }, definition: Definition): void {
    const role = definition.entry.role!;
    const { classes, unresolved } = this.componentClasses(definition, {}, classValueOf(null));
    const rootTag = definition.recipe?.tag ?? null;
    this.addLook({ file, ...at, role, source: "component", tag: definition.entry.name, definition, classes, rootTag, unresolved, recipe: this.recipeFor(role, definition, rootTag, classes, {}, null, []) });
  }

  async astroLooks(file: string, astro: AstroFile): Promise<void> {
    const own = this.definitions.get(`${file}#default`) ?? null;
    for (const tag of astro.tags) {
      if (["style", "script", "slot", "Fragment"].includes(tag.tag)) continue;
      if (own?.entry.role && own.rootId === tag.line * 100_000 + tag.column) continue;
      const props: Record<string, PropValue> = Object.fromEntries(tag.attributes.map((a) => [a.name, "literal" in a.value ? { literal: a.value.literal } : { dynamic: a.value.expression }]));
      const site = await this.templateClasses(tag);
      const at = { line: tag.line, column: tag.column };
      if (/^[a-z]/.test(tag.tag) && !tag.tag.includes(".")) {
        this.intrinsicLook(file, at, tag.tag, props, site, own?.entry.role ?? null, tag.text);
        continue;
      }
      const { symbol, name } = await resolveTag(this.graph, astro.module, tag.tag);
      if (symbol.kind === "external") {
        this.primitiveSite(file, at, symbol);
        continue;
      }
      const definition = symbol.kind === "symbol" ? (this.definitions.get(`${symbol.file}#${symbol.name}`) ?? null) : null;
      const role = roleOfComponent(definition?.entry.name ?? componentName(name), props, tag.firstChild);
      if (!role || role === own?.entry.role) continue;
      const { classes, unresolved } = this.componentClasses(definition, props, site);
      if (!definition) unresolved.unshift(`${tag.tag}: ${symbol.kind === "unknown" ? symbol.detail : "not a known definition"}`);
      const rootTag = definition?.recipe?.tag ?? null;
      this.addLook({ file, ...at, role, source: "component", tag: tag.tag, definition, classes, rootTag, unresolved, recipe: this.recipeFor(role, definition, rootTag, classes, props, tag.text, []) });
    }
  }

  async collectLooks(): Promise<void> {
    for (const module of this.sortedModules()) {
      if (module.lang === "css") continue;
      await this.noteImports(module);
      const astro = this.astro.get(module.file);
      if (astro) await this.astroLooks(module.file, astro);
      else await this.reactLooks(module);
    }
  }

  /* ---------------------------------------------------------------- stories */

  /**
   * Storybook stories as authored states of their components, read statically (stories.ts):
   * each drawable story becomes a look of its meta's component, resolved and styled exactly like
   * a JSX site of it, with simple provider decorators as its recipe's wrappers. Every story not
   * drawn is listed with why; a file that fails is listed in `failed`, and the scan goes on.
   */
  async storyLooks(): Promise<void> {
    const { root, exclude } = this.target;
    let config: Awaited<ReturnType<typeof storyConfig>>;
    let files: Awaited<ReturnType<typeof findStoryFiles>>;
    try {
      config = await storyConfig(root);
      files = await findStoryFiles(root, config, exclude);
    } catch (error: unknown) {
      this.stories = { files: 0, read: 0, drawn: 0, skipped: [], notes: [`story files could not be listed (${error instanceof Error ? error.message : String(error)}); no stories were read`] };
      return;
    }
    if (files.length === 0 && config.main === null) return;
    const stories: StoriesRead = { files: files.length, read: 0, drawn: 0, skipped: [], notes: [...config.notes] };
    for (const { file, specifier } of files) {
      try {
        const module = await parseModule(file, await readFile(join(root, file), "utf8"));
        if (!module) continue;
        if (module.parseErrors > 0) {
          const error = module.root.root().find({ rule: { kind: "ERROR" } });
          this.failed.push({ file, reason: `${module.parseErrors} parse error node(s); its stories were not read` });
          stories.skipped.push({ file, line: error ? position(error).line : 1, name: "every story in it", reason: "the file did not parse; fix its syntax and run again" });
          continue;
        }
        const csf = readCsf(module, specifier);
        for (const story of csf.stories) {
          stories.read++;
          try {
            const reason = story.skip ?? (await this.storyLook(module, csf, story, stories.notes));
            if (reason) stories.skipped.push({ file, line: story.line, name: story.name, reason });
            else stories.drawn++;
          } catch (error: unknown) {
            stories.skipped.push({ file, line: story.line, name: story.name, reason: `could not be drawn (${error instanceof Error ? error.message : String(error)})` });
          }
        }
      } catch (error: unknown) {
        this.failed.push({ file, reason: error instanceof Error ? error.message : String(error) });
        stories.skipped.push({ file, line: 1, name: "every story in it", reason: "the file could not be read" });
      }
    }
    stories.skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    this.stories = stories;
  }

  /** One story as a look of its component; the reason when it cannot be one. */
  private async storyLook(module: ModuleInfo, csf: CsfFile, story: CsfStory, notes: string[]): Promise<string | null> {
    const tag = csf.component!;
    const { symbol } = await resolveTag(this.graph, module, tag);
    if (symbol.kind === "external") return `${symbol.name} comes from package ${packageOf(symbol.module)}, not this project`;
    if (symbol.kind !== "symbol") return `${tag} could not be traced to its file (${symbol.kind === "unknown" ? symbol.detail : "a namespace object"})`;
    const definition = this.definitions.get(`${symbol.file}#${symbol.name}`) ?? null;
    if (definition?.entry.kind !== "react") return `${tag} in ${symbol.file} is not a component the inventory found (an exported component that renders JSX)`;
    const role = roleOfComponent(definition.entry.name, story.props, null);
    if (!role) return `${definition.entry.name} is not an element the inventory groups (buttons, inputs, cards, badges, dialogs, tabs)`;
    const site = story.className ?? { certain: [], conditional: [], dynamic: [], calls: [], passthrough: false };
    const { classes, unresolved } = this.componentClasses(definition, story.props, site);
    const wrappers: InventoryRecipeWrapper[] = [];
    for (const decorator of story.decorators) {
      const skipped = "reason" in decorator ? decorator.reason : await this.decoratorWrappers(module, decorator.chain, wrappers);
      const note = skipped && `${csf.file}: decorator at line ${decorator.line} skipped: ${skipped}; its stories are drawn without it`;
      if (note && !notes.includes(note)) notes.push(note);
    }
    const rootTag = definition.recipe?.tag ?? null;
    const recipe = this.recipeFor(role, definition, rootTag, classes, story.props, story.label, wrappers);
    this.addLook({ file: csf.file, line: story.line, column: story.column, role, source: "component", tag, definition, classes, rootTag, unresolved: [...story.unresolved, ...unresolved], recipe, story: { title: csf.title, name: story.name, id: story.id } });
    return null;
  }

  /** A decorator's tags as recipe wrappers, added only when every one is a component of this project; else why not. */
  private async decoratorWrappers(module: ModuleInfo, chain: ReadonlyArray<{ tag: string; props: Record<string, PropValue> }>, into: InventoryRecipeWrapper[]): Promise<string | null> {
    const found: InventoryRecipeWrapper[] = [];
    for (const { tag, props } of chain) {
      if (/^[a-z]/.test(tag)) return `a <${tag}> wrapper is layout, not a provider; only providers defined in this project are applied`;
      const { symbol } = await resolveTag(this.graph, module, tag);
      if (symbol.kind === "external") return `${symbol.name.split(".").at(-1)} comes from package ${packageOf(symbol.module)}; only providers defined in this project are applied`;
      const definition = symbol.kind === "symbol" ? this.definitions.get(`${symbol.file}#${symbol.name}`) : undefined;
      if (definition?.entry.kind !== "react") return `${tag} is not a component this project exports`;
      found.push({ file: definition.entry.file, export: exportOf(definition), props: recipeProps(props) });
    }
    into.push(...found);
    return null;
  }
}

/** The first element a JSX element wraps (`<Button asChild><a …>`). */
function firstChildTag(opening: SgNode): string | null {
  const element = opening.parent();
  if (element?.kind() !== "jsx_element") return null;
  for (const child of element.children()) {
    if (child.kind() === "jsx_self_closing_element") return child.field("name")?.text() ?? null;
    if (child.kind() === "jsx_element") return child.find({ rule: { kind: "jsx_opening_element" } })?.field("name")?.text() ?? null;
  }
  return null;
}

export interface CollectOptions {
  /** Record each role-bearing definition's root as a look too (`youiyoux check --diff` compares new components before anything renders them). */
  readonly definitionRoots?: boolean;
}

/** One project read through every stage: definitions, kits, primitives and looks. */
export async function readProject(target: InventoryTarget, options: CollectOptions = {}): Promise<ProjectPass> {
  const pass = new ProjectPass(target, options);
  await pass.read();
  pass.classKits();
  await pass.reactDefinitions();
  await pass.astroDefinitions();
  await pass.collectLooks();
  await pass.storyLooks();
  return pass;
}

export async function collectProject(target: InventoryTarget, options: CollectOptions = {}): Promise<ProjectInventory> {
  const pass = await readProject(target, options);
  const git = await gitState(target.root);
  const definitions = [...pass.definitions.values()].map((d) => d.entry).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  const primitives = [...pass.primitives].map(([pkg, p]) => ({ package: pkg, project: target.id, exports: [...p.exports].sort(), count: p.count, sites: p.sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column) })).sort((a, b) => a.package.localeCompare(b.package));
  const looks = pass.looks.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { id: target.id, target, commit: git.commit, failed: pass.failed.sort((a, b) => a.file.localeCompare(b.file)), warnings: pass.theme.warnings, definitions, kits: pass.kits.sort((a, b) => a.id.localeCompare(b.id)), primitives, looks, kitImports: pass.kitImports, stories: pass.stories };
}
