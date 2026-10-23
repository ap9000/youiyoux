/**
 * The project's own components as an agent needs them before it writes UI: for each
 * definition, the import line, its props (its `<Name>Props` type, the first parameter's type
 * or destructuring, and CVA variants), the packages its module imports and every place it is
 * rendered (file:line:column, routes and the real JSX). It reuses the inventory's pass
 * (collect.ts): the same parse, binding resolution and route attribution, no design system.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import type { ResolvedSymbol } from "../graph.ts";
import type { InventoryDefinition, InventoryPrimitive, PropValue } from "@youiyoux/core";
import { byPosition, escapeRegExp, unquote, type ModuleInfo } from "../parse.ts";
import { propsOf, resolveTag } from "../usage.ts";
import { packageOf, pathAliases, readProject, type ProjectPass } from "./collect.ts";
import { classValueOf, jsxClassAttribute, parseExpression } from "./classes.ts";
import { loadInventoryTarget, readJson, type TargetGlobs } from "./target.ts";

/** Lines of a site's JSX kept as its snippet. */
const SNIPPET_LINES = 6;

export interface ComponentProp {
  readonly name: string;
  /** Legal values, from a CVA table or a union of string literals. */
  readonly values?: readonly string[];
}

export interface ComponentSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly routes: readonly string[];
  /** Literal props passed here (`variant="primary"`). */
  readonly props: Readonly<Record<string, string | number | boolean>>;
  /** The element as written, at most SNIPPET_LINES lines (then its opening tag, then cut). */
  readonly snippet: string;
}

export interface ComponentFacts {
  readonly definition: InventoryDefinition;
  /** The export it is imported by: a name, or `default`. */
  readonly export: string;
  /** `@/components/alert` through a tsconfig alias, else the root-relative path without extension. */
  readonly specifier: string;
  readonly aliased: boolean;
  readonly importLine: string;
  /** null when no props could be read statically. */
  readonly props: readonly ComponentProp[] | null;
  /** npm packages its module imports (`@radix-ui/react-dialog`). */
  readonly packages: readonly string[];
  /** `data-slot` names its module sets (shadcn stamps its own). */
  readonly slots: readonly string[];
  readonly sites: readonly ComponentSite[];
  /** Packages referenced by this declaration, rather than its sibling components. */
  readonly ownPackages: readonly string[];
  readonly ownSlots: readonly string[];
  /** Public functions and hooks exported beside the component, with actual call sites. */
  /** `from`: the package to import it from, when the module wraps that package rather than exporting the function. */
  readonly calls: readonly { name: string; from?: string; sites: readonly ComponentSite[] }[];
}

export interface ProjectComponents {
  readonly id: string;
  readonly root: string;
  readonly components: readonly ComponentFacts[];
  readonly primitives: readonly InventoryPrimitive[];
  /** package.json dependencies and devDependencies. */
  readonly dependencies: readonly string[];
  /** shadcn's ui folder from components.json (`aliases.ui`, resolved to a root-relative directory), else null. */
  readonly shadcnUi: string | null;
  /** Where most of the project's components live, for a new one. */
  readonly componentsDir: string | null;
}

const named = (node: SgNode): SgNode[] => node.children().filter((c) => c.isNamed() && c.kind() !== "comment");

/** The function a declaration defines: itself, an arrow or function value, or the one inside forwardRef()/memo(). */
function functionOf(declaration: SgNode): SgNode | null {
  if (declaration.kind() === "function_declaration") return declaration;
  const value = declaration.field("value");
  if (!value) return null;
  if (value.kind() === "arrow_function" || value.kind() === "function_expression") return value;
  if (value.kind() === "call_expression") return value.field("arguments")?.find({ rule: { any: [{ kind: "arrow_function" }, { kind: "function_expression" }] } }) ?? null;
  return null;
}

/** String literal members of a union type (`"info" | "warning"`). */
function literalValues(type: SgNode | null): string[] | undefined {
  if (!type) return undefined;
  const literals = type.findAll({ rule: { kind: "literal_type" } }).map((l) => l.text());
  const strings = literals.filter((l) => /^["'`]/.test(l)).map(unquote);
  return strings.length > 1 && strings.length === literals.length ? strings : undefined;
}

/** Property signatures of a type node, not those nested inside another property's type. */
function signatures(type: SgNode): ComponentProp[] {
  return type.findAll({ rule: { kind: "property_signature" } }).flatMap((signature) => {
    for (let node = signature.parent(); node && node.id() !== type.id(); node = node.parent()) if (node.kind() === "property_signature") return [];
    const name = signature.field("name");
    if (!name) return [];
    const values = literalValues(signature.field("type"));
    return [{ name: unquote(name.text()), ...(values ? { values } : {}) }];
  });
}

/** Local interfaces and type aliases by name. */
function localTypes(module: ModuleInfo): Map<string, SgNode> {
  const types = new Map<string, SgNode>();
  for (const node of module.root.root().findAll({ rule: { any: [{ kind: "interface_declaration" }, { kind: "type_alias_declaration" }] } })) {
    const name = node.field("name")?.text();
    const body = node.kind() === "interface_declaration" ? node.field("body") : node.field("value");
    if (name && body) types.set(name, body);
  }
  return types;
}

function destructured(pattern: SgNode | null): string[] {
  if (pattern?.kind() !== "object_pattern") return [];
  return named(pattern).flatMap((child) => {
    if (child.kind() === "shorthand_property_identifier_pattern") return [child.text()];
    if (child.kind() === "object_assignment_pattern") return [child.field("left")?.text() ?? named(child)[0]?.text() ?? ""];
    if (child.kind() === "pair_pattern") return [unquote(child.field("key")?.text() ?? "")];
    return [];
  }).filter(Boolean);
}

/** A component's props: its `<Name>Props` type, its first parameter's type and destructuring, and CVA variants. */
export function propsOfDeclaration(module: ModuleInfo, declaration: SgNode | null, name: string, variants: Readonly<Record<string, readonly string[]>>): ComponentProp[] | null {
  const types = localTypes(module);
  const found = new Map<string, ComponentProp>();
  const add = (props: readonly ComponentProp[]): void => {
    for (const prop of props) if (!found.has(prop.name) && !/^(?:ref|key)$/.test(prop.name)) found.set(prop.name, prop);
  };
  const fn = declaration ? functionOf(declaration) : null;
  const parameter = fn ? (fn.field("parameters") ? named(fn.field("parameters")!)[0] : fn.field("parameter")) : undefined;
  const annotation = parameter?.field("type") ?? null;
  if (annotation) {
    add(signatures(annotation));
    for (const id of annotation.findAll({ rule: { kind: "type_identifier" } })) {
      const body = types.get(id.text());
      if (body) add(signatures(body));
    }
  }
  const own = types.get(`${name}Props`);
  if (own) add(signatures(own));
  add(destructured(parameter?.field("pattern") ?? null).map((n) => ({ name: n })));
  for (const [key, values] of Object.entries(variants)) found.set(key, { name: key, values: [...values] });
  return found.size > 0 ? [...found.values()] : null;
}

/** The top-level declaration a module exports under `local`. */
function declarationOf(module: ModuleInfo, local: string): SgNode | null {
  for (const child of module.root.root().children()) {
    const target = child.kind() === "export_statement" ? child.field("declaration") : child;
    if (!target) continue;
    if (target.kind() === "function_declaration" && target.field("name")?.text() === local) return target;
    if (target.kind() === "lexical_declaration") {
      const declarator = target.findAll({ rule: { kind: "variable_declarator" } }).find((d) => d.parent()?.id() === target.id() && d.field("name")?.text() === local);
      if (declarator) return declarator;
    }
  }
  return null;
}

/** The import specifier for a project file: through a tsconfig `paths` alias when one covers it, else root-relative. */
export function specifierFor(file: string, aliases: ReadonlyArray<readonly [string, string]>): { specifier: string; aliased: boolean } {
  const bare = file.replace(/\.(tsx|ts|jsx|js|mjs|astro)$/, "").replace(/\/index$/, "");
  const path = file.endsWith(".astro") ? file : bare;
  for (const [prefix, target] of [...aliases].sort((a, b) => b[1].length - a[1].length)) {
    const dir = posix.normalize(target).replace(/^\.\/?/, "").replace(/\/$/, "");
    if (dir === "") return { specifier: `${prefix}${path}`, aliased: true };
    if (path.startsWith(`${dir}/`)) return { specifier: `${prefix}${path.slice(dir.length + 1)}`, aliased: true };
  }
  return { specifier: path, aliased: false };
}

function snippetOf(node: SgNode, column: number): string {
  const element = node.kind() === "jsx_opening_element" ? (node.parent() ?? node) : node;
  const lines = element.text().split("\n");
  if (lines.length <= SNIPPET_LINES) return dedent(lines, column - 1);
  const opening = node.text().split("\n");
  return dedent(opening.length < SNIPPET_LINES ? [...opening, "…"] : [...opening.slice(0, SNIPPET_LINES - 1), "…"], column - 1);
}

/** Continuation lines lose the indent the element itself had in the file. */
function dedent(lines: readonly string[], indent: number): string {
  return [lines[0]!, ...lines.slice(1).map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)![0].length)))].join("\n");
}

const literalProps = (props: Readonly<Record<string, PropValue>>): Record<string, string | number | boolean> => Object.fromEntries(Object.entries(props).flatMap(([name, value]) => ("literal" in value ? [[name, value.literal]] : [])));

/** Every place each definition is rendered, by `${file}#${export}`. */
async function sitesOf(pass: ProjectPass): Promise<Map<string, ComponentSite[]>> {
  const sites = new Map<string, ComponentSite[]>();
  const add = (key: string, site: ComponentSite): void => void sites.set(key, [...(sites.get(key) ?? []), site]);
  for (const module of [...pass.modules.values()].filter((m): m is ModuleInfo => m !== null && m.lang !== "css").sort((a, b) => a.file.localeCompare(b.file))) {
    const astro = pass.astro.get(module.file);
    if (astro) {
      for (const tag of astro.tags) {
        if (!/^[A-Z]/.test(tag.tag)) continue;
        const { symbol } = await resolveTag(pass.graph, astro.module, tag.tag);
        if (symbol.kind !== "symbol" || !pass.definitions.has(`${symbol.file}#${symbol.name}`)) continue;
        add(`${symbol.file}#${symbol.name}`, { file: module.file, line: tag.line, column: tag.column, routes: pass.routes.of(module.file).routes, props: Object.fromEntries(tag.attributes.flatMap((a) => ("literal" in a.value ? [[a.name, a.value.literal]] : []))), snippet: `<${tag.tag}${tag.attributes.map((a) => ("literal" in a.value ? (a.value.literal === true ? ` ${a.name}` : ` ${a.name}="${a.value.literal}"`) : ` ${a.name}={${a.value.expression}}`)).join("")}>` });
      }
      continue;
    }
    for (const element of module.jsx) {
      if (!/^[A-Z]/.test(element.tag)) continue;
      const { symbol } = await resolveTag(pass.graph, module, element.tag);
      if (symbol.kind !== "symbol") continue;
      const key = `${symbol.file}#${symbol.name}`;
      if (!pass.definitions.has(key)) continue;
      add(key, { file: module.file, line: element.line, column: element.column, routes: pass.routes.of(module.file).routes, props: literalProps(propsOf(element.node).props), snippet: snippetOf(element.node, element.column) });
    }
  }
  return sites;
}

/** Class sites use the same certain-class parser as inventory. */
async function classSites(pass: ProjectPass, block: string): Promise<ComponentSite[]> {
  const sites: ComponentSite[] = [];
  for (const module of pass.modules.values()) {
    if (!module || module.lang === "css") continue;
    const routes = pass.routes.of(module.file).routes;
    const astro = pass.astro.get(module.file);
    if (astro) {
      const source = await readFile(join(pass.target.root, module.file), "utf8");
      for (const tag of astro.tags) {
        const classes: string[] = [];
        for (const a of tag.attributes.filter((a) => ["class", "className", "class:list"].includes(a.name))) {
          if ("literal" in a.value) classes.push(...String(a.value.literal).split(/\s+/));
          else classes.push(...classValueOf(await parseExpression(a.value.expression)).certain);
        }
        if (classes.includes(block)) {
          const offset = source.split("\n").slice(0, tag.line - 1).join("\n").length + (tag.line > 1 ? 1 : 0) + tag.column - 1;
          // The element as written, up to its closing tag (or SNIPPET_LINES lines), not the markup after it.
          const lines = source.slice(offset).split("\n").slice(0, SNIPPET_LINES);
          const closing = lines.findIndex((l) => l.includes(`</${tag.tag}>`));
          const selfClosing = /^<[^>]*\/>/.test(lines[0] ?? "");
          sites.push({ file: module.file, line: tag.line, column: tag.column, routes, props: {}, snippet: dedent(selfClosing ? [lines[0]!.slice(0, lines[0]!.indexOf("/>") + 2)] : closing >= 0 ? [...lines.slice(0, closing), lines[closing]!.slice(0, lines[closing]!.indexOf(`</${tag.tag}>`) + tag.tag.length + 3)] : lines, tag.column - 1) });
        }
      }
    } else for (const element of module.jsx) {
      if (classValueOf(jsxClassAttribute(element.node)).certain.includes(block)) sites.push({ file: module.file, line: element.line, column: element.column, routes, props: literalProps(propsOf(element.node).props), snippet: snippetOf(element.node, element.column) });
    }
  }
  return sites.sort(byPosition);
}

/** Packages whose functions are never a component's call API: the framework and class helpers. */
const NOT_CALL_APIS = /^(?:react|react-dom|preact|vue|solid-js|astro|next|clsx|classnames|class-variance-authority|tailwind-merge|lucide-react|@heroicons\/react|@radix-ui\/react-icons|react-icons|@phosphor-icons\/react|@tabler\/icons-react)$/;

/** What a binding or export finally names: a project declaration or a package export. */
function identityOf(symbol: ResolvedSymbol): string | null {
  if (symbol.kind === "symbol") return `${symbol.file}#${symbol.name}`;
  if (symbol.kind === "external") return `npm:${symbol.module}#${symbol.name}`;
  return null;
}

interface CallIndex {
  readonly bindings: ReadonlyArray<{ module: ModuleInfo; imported: string; local: string; identity: string | null; namespace: string | null }>;
  readonly calls: ReadonlyMap<string, ReadonlyArray<{ node: SgNode; callee: string }>>;
}

/** Every module's import bindings, resolved once, and its call expressions. */
async function callIndex(pass: ProjectPass): Promise<CallIndex> {
  const bindings: Array<CallIndex["bindings"][number]> = [];
  const calls = new Map<string, Array<{ node: SgNode; callee: string }>>();
  for (const module of [...pass.modules.values()].filter((m): m is ModuleInfo => m !== null && m.lang !== "css").sort((a, b) => a.file.localeCompare(b.file))) {
    for (const binding of module.imports) {
      if (binding.typeOnly) continue;
      const resolved = await pass.graph.resolveLocal(module, binding.local);
      bindings.push({ module, imported: binding.imported, local: binding.local, identity: identityOf(resolved), namespace: resolved.kind === "namespace" ? resolved.file : null });
    }
    calls.set(module.file, module.root.root().findAll({ rule: { kind: "call_expression" } }).map((node) => ({ node, callee: node.field("function")?.text() ?? "" })));
  }
  return { bindings, calls };
}

/**
 * Public call APIs of a component module, with their real call sites: its exported functions and
 * hooks (`useNotice`), what it passes on (`export { toast }` beside a Toaster), and the functions
 * the project imports from a package the module wraps (`toast` from sonner beside the Toaster
 * built on it). A call counts through any binding that resolves to the same function: an alias,
 * a namespace, a barrel; `(ok ? toast.success : toast.error)(…)` included.
 */
async function callsOf(pass: ProjectPass, owner: ModuleInfo, index: CallIndex): Promise<Array<{ name: string; from?: string; sites: ComponentSite[] }>> {
  const apis = new Map<string, { identity: string; from?: string }>();
  for (const entry of owner.exports) {
    if (!/^[a-z]/.test(entry.name)) continue;
    if (entry.kind === "local" && !owner.imports.some((i) => !i.typeOnly && i.local === entry.local)) {
      const declaration = declarationOf(owner, entry.local);
      if (!declaration || !functionOf(declaration)) continue;
    }
    const identity = identityOf(await pass.graph.resolveExport(owner.file, entry.name));
    if (identity) apis.set(entry.name, { identity });
  }
  const wrapped = new Set(owner.imports.filter((i) => !i.typeOnly).map((i) => pass.graph.resolveSpecifier(i.specifier, owner.file)).flatMap((r) => (r.kind === "external" && !NOT_CALL_APIS.test(packageOf(r.module)) ? [r.module] : [])));
  for (const binding of index.bindings) {
    if (!binding.identity?.startsWith("npm:") || !/^[a-z]/.test(binding.imported)) continue;
    const [module, name] = [binding.identity.slice(4, binding.identity.lastIndexOf("#")), binding.identity.slice(binding.identity.lastIndexOf("#") + 1)];
    if (wrapped.has(module) && !apis.has(name) && ![...apis.values()].some((a) => a.identity === binding.identity)) apis.set(name, { identity: binding.identity, from: module });
  }
  const result: Array<{ name: string; from?: string; sites: ComponentSite[] }> = [];
  for (const [name, api] of apis) {
    const sites: ComponentSite[] = [];
    for (const binding of index.bindings) {
      if (binding.module.file === owner.file) continue;
      const prefix = binding.identity === api.identity ? binding.local : binding.namespace && identityOf(await pass.graph.resolveExport(binding.namespace, name)) === api.identity ? `${binding.local}.${name}` : null;
      if (!prefix) continue;
      const reference = new RegExp(`(?<![\\w$.])${escapeRegExp(prefix)}(?![\\w$])`);
      for (const { node, callee } of index.calls.get(binding.module.file) ?? []) {
        if (!reference.test(callee)) continue;
        const at = node.range().start;
        sites.push({ file: binding.module.file, line: at.line + 1, column: at.column + 1, routes: pass.routes.of(binding.module.file).routes, props: {}, snippet: snippetOf(node, at.column + 1) });
      }
    }
    result.push({ name, ...(api.from ? { from: api.from } : {}), sites: sites.sort(byPosition) });
  }
  return result;
}

/** The project's React and Astro components with their import, props, packages and sites. Class-kit members carry stylesheet paths and class usages. */
export async function collectComponents(dir: string, globs: TargetGlobs = {}): Promise<ProjectComponents> {
  const target = await loadInventoryTarget(dir, globs);
  const pass = await readProject(target);
  const aliases = await pathAliases(target.root, target.tsconfig);
  const sites = await sitesOf(pass);
  const components: ComponentFacts[] = [];
  const moduleCalls = new Map<string, Awaited<ReturnType<typeof callsOf>>>();
  const index = await callIndex(pass);
  for (const [key, definition] of pass.definitions) {
    const entry = definition.entry;

    const module = pass.modules.get(entry.file) ?? null;
    const exported = key.slice(key.lastIndexOf("#") + 1);
    const local = module?.exports.find((e) => e.kind === "local" && e.name === exported);
    const declaration = module && local?.kind === "local" ? declarationOf(module, local.local) : null;
    const { specifier, aliased } = specifierFor(entry.file, aliases);
    const imports = module?.imports.filter((i) => !i.typeOnly) ?? [];
    const packages = [...new Set(imports.map((i) => i.specifier).filter((s) => !s.startsWith(".") && !/^[@~#]\//.test(s) && !aliases.some(([prefix]) => s.startsWith(prefix))).map(packageOf))].sort();
    if (module && entry.kind !== "class" && !moduleCalls.has(module.file)) moduleCalls.set(module.file, await callsOf(pass, module, index));
    const identifiers = new Set(declaration?.findAll({ rule: { kind: "identifier" } }).map((n) => n.text()) ?? []);
    components.push({
      definition: entry,
      export: exported,
      specifier,
      aliased,
      importLine: entry.kind === "class" ? entry.file : exported === "default" ? `import ${entry.name} from "${specifier}";` : `import { ${exported} } from "${specifier}";`,
      props: module && entry.kind === "react" ? propsOfDeclaration(module, declaration, entry.name, entry.variants) : Object.keys(entry.variants).length > 0 ? Object.entries(entry.variants).map(([name, values]) => ({ name, values })) : null,
      packages,
      ownPackages: [...new Set(imports.filter((i) => identifiers.has(i.local)).map((i) => pass.graph.resolveSpecifier(i.specifier, entry.file)).filter((r) => r.kind === "external").map((r) => packageOf(r.module)))].sort(),
      ownSlots: [...new Set([...(declaration?.text() ?? "").matchAll(/data-slot=["']([a-z][a-z0-9-]*)["']/g)].map((m) => m[1]!))],
      calls: moduleCalls.get(entry.file) ?? [],
      slots: [...new Set([...(module?.source ?? "").matchAll(/data-slot=["']([a-z][a-z0-9-]*)["']/g)].map((m) => m[1]!))],
      sites: entry.kind === "class" ? await classSites(pass, entry.name.replace(/^\./, "")) : sites.get(key) ?? [],
    });
  }
  components.sort((a, b) => a.definition.file.localeCompare(b.definition.file) || a.definition.line - b.definition.line);
  const pkg = await readJson(join(target.root, "package.json"));
  const dependencies = [...new Set(["dependencies", "devDependencies"].flatMap((field) => Object.keys((pkg?.[field] ?? {}) as Record<string, string>)))].sort();
  const ui = ((await readJson(join(target.root, "components.json")))?.aliases as Record<string, unknown> | undefined)?.ui;
  const shadcnUi = typeof ui === "string" ? specifierToDir(ui, aliases) : null;
  const dirs = new Map<string, number>();
  for (const c of components) if (c.definition.kind !== "class" && !c.definition.file.startsWith(`${target.routes.strategy === "expo-router" ? target.routes.appDir : "app"}/`)) dirs.set(posix.dirname(c.definition.file), (dirs.get(posix.dirname(c.definition.file)) ?? 0) + 1);
  const componentsDir = [...dirs].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? null;
  const primitives = [...pass.primitives].map(([name, p]) => ({ package: name, project: target.id, exports: [...p.exports].sort(), count: p.count, sites: [...p.sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) })).sort((a, b) => a.package.localeCompare(b.package));
  return { id: target.id, root: target.root, components, primitives, dependencies, shadcnUi, componentsDir };
}

/** `@/components/ui` → `components/ui` through the tsconfig aliases. */
function specifierToDir(specifier: string, aliases: ReadonlyArray<readonly [string, string]>): string {
  for (const [prefix, target] of aliases) {
    if (!specifier.startsWith(prefix)) continue;
    return posix.normalize(posix.join(target, specifier.slice(prefix.length))).replace(/^\.\//, "").replace(/\/$/, "");
  }
  return specifier.replace(/^\.\//, "");
}
