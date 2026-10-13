/**
 * Storybook stories, read statically as extra specimens: Storybook is never installed, imported
 * or run. Story files are found from `.storybook/main.*`'s `stories` list (string globs, and
 * `{ directory, files, titlePrefix }` entries), else `**\/*.stories.*`; MDX docs are never read.
 * Each CSF 3 file gives its default-export meta (`title`, `component`, `args`, `decorators`) and
 * its named object stories (`args`, `name`, `render`, `decorators`). Literal args become props, a
 * string `children` the label; anything else is listed as unresolved. A story that cannot be
 * drawn says why in plain words, and nothing here throws on a strange file: collect.ts turns
 * what is read into looks.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { findFiles, type PropValue } from "@youiyoux/core";
import { parseModule, unquote, type ModuleInfo } from "../parse.ts";
import { literalOf, propsOf } from "../usage.ts";
import { classValueOf, type ClassValue } from "./classes.ts";

export const STORY_FILE = /\.stories\.(?:tsx|ts|jsx|js|mjs)$/;
const CONFIG_DIR = ".storybook";
const MAIN = ["main.ts", "main.mts", "main.cts", "main.js", "main.mjs", "main.cjs"];
const PREVIEW = ["preview.tsx", "preview.ts", "preview.jsx", "preview.js", "preview.mjs"];
const DEFAULT_SPECIFIER: StorySpecifier = { glob: "**/*.stories.{tsx,ts,jsx,js,mjs}", base: "", titlePrefix: "" };

/** One entry of `stories`, project-relative. */
export interface StorySpecifier {
  readonly glob: string;
  /** The glob's directory before its first wildcard: auto titles are relative to it. */
  readonly base: string;
  readonly titlePrefix: string;
}

export interface StoryConfig {
  /** `.storybook/main.ts`, when there is one. */
  readonly main: string | null;
  readonly specifiers: readonly StorySpecifier[];
  /** What was not applied, once per project. */
  readonly notes: string[];
}

export interface StoryFile {
  readonly file: string;
  readonly specifier: StorySpecifier;
}

/** A decorator as a chain of wrapper tags around `<Story />`, outermost first; or why it is not one. */
export type CsfDecorator = { readonly line: number; readonly chain: ReadonlyArray<{ readonly tag: string; readonly props: Record<string, PropValue> }> } | { readonly line: number; readonly reason: string };

export interface CsfStory {
  readonly exportName: string;
  /** Its display name: `name`, else the export name in words (`WithIcon` → `With Icon`). */
  readonly name: string;
  /** Storybook's story id (`ui-button--primary`). */
  readonly id: string;
  readonly line: number;
  readonly column: number;
  readonly props: Record<string, PropValue>;
  /** The `className` arg, read as a class expression. */
  readonly className: ClassValue | null;
  readonly label: string | null;
  readonly unresolved: string[];
  /** Meta's then the story's, outermost first. */
  readonly decorators: readonly CsfDecorator[];
  /** Why it is not drawn; null when it can be. */
  readonly skip: string | null;
}

export interface CsfFile {
  readonly file: string;
  readonly title: string;
  /** The tag the meta names as its component (`Button`, `ui.Button`), null when it names none. */
  readonly component: string | null;
  readonly stories: readonly CsfStory[];
}

const GLOB = /[*?{}[\]()!]/;

/** `../src/**\/*.stories.@(ts|tsx)` from `.storybook/` → `src/**\/*.stories.{ts,tsx}`; null when it leaves the project. */
function specifierOf(glob: string, titlePrefix: string): StorySpecifier | null {
  const relative = posix.normalize(posix.join(CONFIG_DIR, glob.replace(/^\.\//, "")));
  if (relative.startsWith("../") || posix.isAbsolute(relative)) return null;
  // Storybook's extglob `@(a|b)` as a brace set, which every glob reader takes.
  const normal = relative.replace(/@\(([^()]*)\)/g, (_, alts: string) => `{${alts.split("|").join(",")}}`);
  const segments = normal.split("/");
  const firstGlob = segments.findIndex((s) => GLOB.test(s));
  if (firstGlob === -1) return { glob: `${normal}/**/*.stories.{tsx,ts,jsx,js,mjs}`, base: normal, titlePrefix };
  return { glob: normal, base: segments.slice(0, firstGlob).join("/"), titlePrefix };
}

const valueOf = (node: SgNode | null | undefined): SgNode | null => {
  // `{ … } satisfies Meta`, `{ … } as Meta`, `({ … })`: the expression inside.
  let current = node ?? null;
  while (current && ["satisfies_expression", "as_expression", "parenthesized_expression", "non_null_expression"].includes(String(current.kind()))) current = current.children().find((c) => c.isNamed() && c.kind() !== "comment") ?? null;
  return current;
};

/** An object literal's own properties, in order: pairs, shorthand names, spreads and methods. */
function propertiesOf(object: SgNode): Array<{ key: string | null; value: SgNode | null; node: SgNode }> {
  return object.children().flatMap((c): Array<{ key: string | null; value: SgNode | null; node: SgNode }> => {
    if (c.kind() === "pair") return [{ key: unquote(c.field("key")?.text() ?? ""), value: c.field("value"), node: c }];
    if (c.kind() === "shorthand_property_identifier") return [{ key: c.text(), value: c, node: c }];
    if (c.kind() === "method_definition") return [{ key: c.field("name")?.text() ?? "", value: c, node: c }];
    if (c.kind() === "spread_element") return [{ key: null, value: c.children().find((x) => x.isNamed()) ?? null, node: c }];
    return [];
  });
}

const line = (node: SgNode): number => node.range().start.line + 1;

/** Storybook's `storyNameFromExport`: `WithIcon` → `With Icon`, `primary_large` → `Primary Large`. */
export function storyName(exportName: string): string {
  return exportName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Storybook's id sanitizer: `UI/Button` → `ui-button`. */
const sanitize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

export const storyId = (title: string, exportName: string): string => `${sanitize(title)}--${sanitize(storyName(exportName))}`;

/** Storybook's auto title: the file's path under its specifier's directory, without `.stories.*`, its last part not repeated. */
export function autoTitle(file: string, specifier: StorySpecifier): string {
  const inside = specifier.base && file.startsWith(`${specifier.base}/`) ? file.slice(specifier.base.length + 1) : file;
  const parts = inside.replace(STORY_FILE, "").split("/").filter(Boolean);
  if (parts.length > 1 && parts.at(-1)!.toLowerCase() === parts.at(-2)!.toLowerCase()) parts.pop();
  if (parts.length > 1 && parts.at(-1) === "index") parts.pop();
  return [specifier.titlePrefix, ...parts].filter(Boolean).join("/");
}

async function firstFile(root: string, names: readonly string[]): Promise<{ file: string; source: string } | null> {
  for (const name of names) {
    const file = posix.join(CONFIG_DIR, name);
    const source = await readFile(join(root, file), "utf8").catch(() => null);
    if (source !== null) return { file, source };
  }
  return null;
}

/** Where a project's stories are, from `.storybook/main.*` when it lists them as plain values. */
export async function storyConfig(root: string): Promise<StoryConfig> {
  const notes: string[] = [];
  const main = await firstFile(root, MAIN);
  const preview = await firstFile(root, PREVIEW);
  if (preview && /\bdecorators\s*:/.test(preview.source)) notes.push(`${preview.file} has global decorators; they are not applied, so stories are drawn with this project's components and CSS only`);
  if (!main) return { main: null, specifiers: [DEFAULT_SPECIFIER], notes };
  const module = await parseModule(main.file, main.source).catch(() => null);
  const list = module?.root.root().findAll({ rule: { kind: "pair" } }).find((p) => unquote(p.field("key")?.text() ?? "") === "stories");
  const array = valueOf(list?.field("value"));
  if (array?.kind() !== "array") {
    notes.push(`${main.file} does not list its stories as plain values; looked for **/*.stories.* files instead`);
    return { main: main.file, specifiers: [DEFAULT_SPECIFIER], notes };
  }
  const specifiers: StorySpecifier[] = [];
  for (const entry of array.children().filter((c) => c.isNamed() && c.kind() !== "comment")) {
    let found: StorySpecifier | null = null;
    if (entry.kind() === "string" || (entry.kind() === "template_string" && !entry.text().includes("${"))) {
      const text = unquote(entry.text());
      // MDX docs pages are not stories.
      if (/\.mdx$/.test(text)) continue;
      found = specifierOf(text, "");
    } else if (entry.kind() === "object") {
      const fields = new Map(propertiesOf(entry).flatMap((p) => (p.key && p.value?.kind() === "string" ? [[p.key, unquote(p.value.text())] as const] : [])));
      const directory = fields.get("directory");
      if (directory) found = specifierOf(fields.has("files") ? `${directory.replace(/\/$/, "")}/${fields.get("files")}` : directory, fields.get("titlePrefix") ?? "");
    }
    if (found) specifiers.push(found);
    else notes.push(`${main.file}:${line(entry)}: stories entry ${entry.text().replace(/\s+/g, " ")} was not read (computed, or outside the project)`);
  }
  return { main: main.file, specifiers, notes };
}

/** The story files each specifier finds, once each (the first specifier to find a file titles it); `exclude` still applies. */
export async function findStoryFiles(root: string, config: StoryConfig, exclude: readonly string[]): Promise<StoryFile[]> {
  // Story files are left out of the normal walk so their JSX never counts as uses; here they are the point.
  const skip = exclude.filter((e) => !/\.stories\./.test(e) && !e.includes(CONFIG_DIR));
  const found = new Map<string, StoryFile>();
  for (const specifier of config.specifiers) {
    for (const file of await findFiles(root, [specifier.glob], skip)) if (STORY_FILE.test(file) && !found.has(file)) found.set(file, { file, specifier });
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/* ---------------------------------------------------------------- CSF files */

/** A top-level `const name = value` in the module, by name. */
function declaredValue(module: ModuleInfo, name: string): SgNode | null {
  for (const child of module.root.root().children()) {
    const target = child.kind() === "export_statement" ? child.field("declaration") : child;
    if (target?.kind() !== "lexical_declaration" && target?.kind() !== "variable_declaration") continue;
    for (const declarator of target.children().filter((c) => c.kind() === "variable_declarator")) if (declarator.field("name")?.text() === name) return valueOf(declarator.field("value"));
  }
  return null;
}

/** The default export's object, through `satisfies`, `as` and a named const. */
function metaOf(module: ModuleInfo): SgNode | null {
  for (const child of module.root.root().children()) {
    if (child.kind() !== "export_statement" || !/^export\s+default\b/.test(child.text())) continue;
    const value = valueOf(child.field("value") ?? child.field("declaration"));
    if (value?.kind() === "identifier") return declaredValue(module, value.text());
    return value;
  }
  // `export { meta as default }`.
  const entry = module.exports.find((e) => e.kind === "local" && e.name === "default");
  return entry?.kind === "local" ? declaredValue(module, entry.local) : null;
}

interface Fields {
  args: Map<string, SgNode>;
  name: string | null;
  render: SgNode | null;
  decorators: SgNode[];
  spreads: string[];
}

const emptyFields = (): Fields => ({ args: new Map(), name: null, render: null, decorators: [], spreads: [] });

/** A story or meta object's fields; `...Other` and `args: { ...Other.args }` take another story of this file. */
function fieldsOf(object: SgNode, others: ReadonlyMap<string, Fields>): Fields {
  const fields = emptyFields();
  for (const property of propertiesOf(object)) {
    if (property.key === null) {
      const from = property.value?.kind() === "identifier" ? others.get(property.value.text()) : undefined;
      if (from) {
        for (const [key, value] of from.args) fields.args.set(key, value);
        fields.name = from.name;
        fields.render = from.render;
        fields.decorators.push(...from.decorators);
      } else fields.spreads.push(`...${property.value?.text() ?? "?"}`);
      continue;
    }
    const value = valueOf(property.value);
    if (property.key === "name" && value?.kind() === "string") fields.name = unquote(value.text());
    else if (property.key === "render") fields.render = property.node;
    else if (property.key === "decorators" && value?.kind() === "array") fields.decorators.push(...value.children().filter((c) => c.isNamed() && c.kind() !== "comment"));
    else if (property.key === "args" && value?.kind() === "object") {
      for (const arg of propertiesOf(value)) {
        if (arg.key !== null) {
          fields.args.set(arg.key, arg.value!);
          continue;
        }
        // `args: { ...Primary.args }`
        const source = arg.value?.kind() === "member_expression" && arg.value.field("property")?.text() === "args" ? others.get(arg.value.field("object")?.text() ?? "") : undefined;
        if (source) for (const [key, node] of source.args) fields.args.set(key, node);
        else fields.spreads.push(`args ...${arg.value?.text() ?? "?"}`);
      }
    }
  }
  return fields;
}

/** The tag a decorator's JSX renders, when it is `<Story />` (or the decorator's first parameter, or `{Story()}`). */
function isStory(node: SgNode, param: string): boolean {
  if (node.kind() === "jsx_self_closing_element") return [param, "Story"].includes(node.field("name")?.text() ?? "");
  if (node.kind() === "jsx_expression") return new RegExp(`^\\{\\s*(?:${param}|Story)\\(\\s*\\)\\s*\\}$`).test(node.text());
  return false;
}

/** The JSX a function returns: an expression body, or a block with only a return. */
function returned(fn: SgNode): SgNode | null {
  const body = fn.field("body");
  if (!body) return null;
  if (body.kind() !== "statement_block") return valueOf(body);
  const statements = body.children().filter((c) => c.isNamed() && c.kind() !== "comment");
  return statements.length === 1 && statements[0]!.kind() === "return_statement" ? valueOf(statements[0]!.children().find((c) => c.isNamed())) : null;
}

/** A decorator as wrapper tags around the story, outermost first; anything else says why it is not one. */
export function readDecorator(node: SgNode): CsfDecorator {
  const at = line(node);
  const fn = valueOf(node);
  if (fn?.kind() !== "arrow_function" && fn?.kind() !== "function_expression" && fn?.kind() !== "function") return { line: at, reason: "it is not an inline function, so what it wraps cannot be read" };
  const params = fn.field("parameters") ?? fn.field("parameter");
  const param = (params?.kind() === "identifier" ? params : params?.find({ rule: { kind: "identifier" } }))?.text() ?? "Story";
  let current = returned(fn);
  const chain: Array<{ tag: string; props: Record<string, PropValue> }> = [];
  while (current) {
    // A decorator that returns the story unwrapped adds nothing: an empty chain.
    if (isStory(current, param)) return { line: at, chain };
    if (current.kind() !== "jsx_element") break;
    const open = current.children().find((c) => c.kind() === "jsx_opening_element")!;
    const tag = open.field("name")?.text() ?? "";
    const { props, spread } = propsOf(open);
    if (spread) return { line: at, reason: `<${tag}> spreads props, which cannot be read` };
    const computed = Object.entries(props).find(([, v]) => "dynamic" in v);
    if (computed) return { line: at, reason: `<${tag}>'s ${computed[0]} is computed (${computed[0]}={${(computed[1] as { dynamic: string }).dynamic}}); only literal props are applied` };
    chain.push({ tag, props });
    const children = current.children().filter((c) => !["jsx_opening_element", "jsx_closing_element"].includes(String(c.kind())) && !(c.kind() === "jsx_text" && c.text().trim() === ""));
    if (children.length !== 1) return { line: at, reason: `<${tag}> wraps more than the story` };
    current = children[0]!;
  }
  return { line: at, reason: "it is not a chain of components around <Story />" };
}

/** Story args → props, label and className; what cannot be read is listed. */
function argsOf(args: ReadonlyMap<string, SgNode>): Pick<CsfStory, "props" | "className" | "label" | "unresolved"> {
  const props: Record<string, PropValue> = {};
  const unresolved: string[] = [];
  let label: string | null = null;
  let className: ClassValue | null = null;
  for (const [key, raw] of args) {
    const node = valueOf(raw);
    if (!node) continue;
    // Handlers (`onClick: fn()`) change what happens, not how it looks.
    if (/^on[A-Z]/.test(key)) continue;
    if (key === "className") {
      className = classValueOf(node);
      continue;
    }
    const value = node.kind() === "shorthand_property_identifier" ? { dynamic: node.text() } : literalOf(node);
    if (key === "children") {
      if ("literal" in value && typeof value.literal === "string") label = value.literal;
      else unresolved.push(`args.children: ${node.text().replace(/\s+/g, " ").slice(0, 60)} (not plain text; drawn with its own label)`);
      continue;
    }
    if ("literal" in value) props[key] = value;
    else unresolved.push(`args.${key}: ${value.dynamic}`);
  }
  return { props, className, label, unresolved };
}

/** One CSF file: its meta and every named export as a story, each drawable or skipped with a reason. */
export function readCsf(module: ModuleInfo, specifier: StorySpecifier): CsfFile {
  const meta = metaOf(module);
  const metaFields = meta?.kind() === "object" ? fieldsOf(meta, new Map()) : null;
  const metaProps = meta?.kind() === "object" ? new Map(propertiesOf(meta).flatMap((p) => (p.key ? [[p.key, valueOf(p.value)] as const] : []))) : new Map<string, SgNode | null>();
  const titleNode = metaProps.get("title");
  const title = titleNode?.kind() === "string" ? unquote(titleNode.text()) : autoTitle(module.file, specifier);
  const componentNode = metaProps.get("component");
  const component = componentNode && /^(?:identifier|member_expression)$/.test(String(componentNode.kind())) ? componentNode.text() : null;
  const excluded = new Set((metaProps.get("excludeStories")?.kind() === "array" ? metaProps.get("excludeStories")!.children() : []).filter((c) => c.kind() === "string").map((c) => unquote(c.text())));
  const metaProblem = !meta ? "the file has no default export, so it is not a CSF stories file" : meta.kind() !== "object" ? "its default export is not a meta object" : null;
  const metaDecorators = [...(metaFields?.decorators ?? [])].reverse().map(readDecorator);
  const seen = new Map<string, Fields>();
  const stories: CsfStory[] = [];
  for (const child of module.root.root().children()) {
    if (child.kind() !== "export_statement" || /^export\s+default\b/.test(child.text())) continue;
    const declaration = child.field("declaration");
    const entries: Array<{ name: string; node: SgNode; value: SgNode | null }> = [];
    if (declaration?.kind() === "function_declaration") entries.push({ name: declaration.field("name")?.text() ?? "", node: declaration, value: declaration });
    else if (declaration?.kind() === "lexical_declaration" || declaration?.kind() === "variable_declaration") {
      for (const d of declaration.children().filter((c) => c.kind() === "variable_declarator")) entries.push({ name: d.field("name")?.text() ?? "", node: d, value: valueOf(d.field("value")) });
    }
    for (const { name: exportName, node, value } of entries) {
      if (!exportName || exportName === "__namedExportsOrder" || excluded.has(exportName)) continue;
      const at = { line: line(node), column: node.range().start.column + 1 };
      const base = { exportName, name: storyName(exportName), id: storyId(title, exportName), ...at, props: {}, className: null, label: null, unresolved: [], decorators: [] };
      try {
        if (value?.kind() !== "object") {
          const kind = value?.kind() === "call_expression" && /\.bind$/.test(value.field("function")?.text() ?? "") ? "a CSF 2 Template.bind story" : value && /^(?:arrow_function|function_expression|function|function_declaration)$/.test(String(value.kind())) ? "a CSF 2 function story" : "not a story object";
          stories.push({ ...base, skip: `${kind}; only CSF 3 object stories are read` });
          continue;
        }
        const own = fieldsOf(value, seen);
        seen.set(exportName, own);
        const name = own.name ?? base.name;
        const merged = new Map([...(metaFields?.args ?? []), ...own.args]);
        const read = argsOf(merged);
        const unresolved = [...read.unresolved, ...[...(metaFields?.spreads ?? []), ...own.spreads].map((s) => `${s}: a spread that cannot be read`)];
        const skip = metaProblem ?? (own.render ? "has its own render function; only args stories are drawn" : metaFields?.render ? "the meta has its own render function; only args stories are drawn" : !component ? "meta names no component" : null);
        stories.push({ ...base, name, ...read, unresolved, decorators: [...metaDecorators, ...[...own.decorators].reverse().map(readDecorator)], skip });
      } catch (error: unknown) {
        stories.push({ ...base, skip: `could not be read (${error instanceof Error ? error.message : String(error)})` });
      }
    }
  }
  return { file: module.file, title, component, stories };
}
