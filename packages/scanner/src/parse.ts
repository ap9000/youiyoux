/**
 * One ast-grep pass per file, reduced to the facts the scanner needs:
 * imports, exports, local declarations, JSX elements and string fragments.
 * The SgRoot is kept so rule checks and codemods can reuse the parse.
 */
import { Lang, parseAsync, type SgNode, type SgRoot } from "@ast-grep/napi";

export interface ImportBinding {
  /** Local name in this file. */
  readonly local: string;
  /** Exported name in the source module: a name, "default", or "*" for a namespace import. */
  readonly imported: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export type ExportEntry =
  /** Declared in this file (function, const, class) or `export { local as name }`. */
  | { readonly kind: "local"; readonly name: string; readonly local: string }
  /** `export { a as b } from "./x"` */
  | { readonly kind: "reexport"; readonly name: string; readonly imported: string; readonly specifier: string };

export interface JsxElement {
  readonly node: SgNode;
  /** Tag text: `Button`, `ui.Button`, `button`. */
  readonly tag: string;
  readonly line: number;
  readonly column: number;
}

export interface ModuleInfo {
  readonly file: string;
  readonly lang: "tsx" | "ts" | "css";
  readonly source: string;
  readonly root: SgRoot;
  readonly imports: readonly ImportBinding[];
  /** Static imports and re-exports that can run, including side-effect imports; no type-only edges. */
  readonly runtimeSpecifiers: readonly string[];
  /** Literal import(), require() and CSS @import dependencies. */
  readonly dynamicSpecifiers: readonly string[];
  readonly exports: readonly ExportEntry[];
  /** `export * from "…"` specifiers, in order. */
  readonly starExports: readonly string[];
  /** Top-level names declared in this file. */
  readonly declarations: ReadonlySet<string>;
  readonly jsx: readonly JsxElement[];
  readonly parseErrors: number;
  /**
   * Text read from `root` back to the source's own text. Identity unless the parse needed a
   * stand-in (see `parseSource`); code that writes `root.commitEdits(…)` to disk or shows node text
   * goes through it.
   */
  readonly restore: (text: string) => string;
}

export function langOf(file: string): ModuleInfo["lang"] | null {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return "tsx";
  if (/\.(?:c|m)?[jt]s$/.test(file)) return "ts";
  if (file.endsWith(".css")) return "css";
  return null;
}

const LANG = { tsx: Lang.Tsx, ts: Lang.TypeScript, css: Lang.Css } as const;

export function unquote(text: string): string {
  return text.length >= 2 && /^["'`]/.test(text) ? text.slice(1, -1) : text;
}

/** Sort order for anything at a place in a file: file, then line, then column. */
export const byPosition = <T extends { file: string; line: number; column: number }>(a: T, b: T): number => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;

/** `text` as a literal inside a regular expression. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isTypeOnly(statement: SgNode): boolean {
  return /^import\s+type\b/.test(statement.text());
}

function importsOf(root: SgNode, restore: (text: string) => string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const source = statement.field("source");
    if (!source) continue;
    const specifier = unquote(source.text());
    const typeOnly = isTypeOnly(statement);
    const clause = statement.find({ rule: { kind: "import_clause" } });
    if (!clause) continue;
    for (const child of clause.children()) {
      if (child.kind() === "identifier") bindings.push({ local: restore(child.text()), imported: "default", specifier, typeOnly });
      if (child.kind() === "namespace_import") {
        const name = child.find({ rule: { kind: "identifier" } });
        if (name) bindings.push({ local: restore(name.text()), imported: "*", specifier, typeOnly });
      }
      if (child.kind() === "named_imports") {
        for (const spec of child.findAll({ rule: { kind: "import_specifier" } })) {
          const name = spec.field("name")?.text();
          if (!name) continue;
          const alias = spec.field("alias")?.text();
          bindings.push({ local: restore(unquote(alias ?? name)), imported: restore(unquote(name)), specifier, typeOnly: typeOnly || /^type\s/.test(spec.text()) });
        }
      }
    }
  }
  return bindings;
}

function runtimeSpecifiersOf(root: SgNode): string[] {
  const specifiers = new Set<string>();
  for (const statement of root.children()) {
    if (statement.kind() !== "import_statement" && statement.kind() !== "export_statement") continue;
    const source = statement.field("source");
    if (!source || /^(?:import|export)\s+type\b/.test(statement.text())) continue;
    const bindings = statement.findAll({ rule: { any: [{ kind: "import_specifier" }, { kind: "export_specifier" }] } });
    const clause = statement.find({ rule: { kind: "import_clause" } });
    const hasDefault = clause?.children().some((c) => c.kind() === "identifier");
    if (!hasDefault && bindings.length > 0 && bindings.every((b) => /^type\s/.test(b.text()))) continue;
    specifiers.add(unquote(source.text()));
  }
  return [...specifiers];
}

function dynamicSpecifiersOf(root: SgNode): string[] {
  const specifiers = new Set<string>();
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = call.field("function")?.text();
    if (callee !== "import" && callee !== "require") continue;
    const args = call.field("arguments")?.children().filter((node) => node.isNamed() && node.kind() !== "comment") ?? [];
    if ((callee === "import" || args.length === 1) && args[0]?.kind() === "string") specifiers.add(unquote(args[0].text()));
  }
  return [...specifiers];
}

function cssSpecifiersOf(source: string): string[] {
  const specifiers = new Set<string>();
  // Consume comments and ordinary strings too, so text resembling an @import
  // inside either one cannot create a dependency.
  const imports = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@import\s+(?:["']([^"']+)["']|url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\))/gi;
  for (const match of source.matchAll(imports)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    // CSS filenames are relative even without "./"; package imports stay external.
    specifiers.add(/^[^./@~#][^:]*\.css$/.test(specifier) ? `./${specifier}` : specifier);
  }
  return [...specifiers];
}

function declaredNames(node: SgNode, restore: (text: string) => string): string[] {
  const kind = node.kind();
  if (["function_declaration", "class_declaration", "generator_function_declaration", "type_alias_declaration", "interface_declaration", "enum_declaration"].includes(String(kind))) {
    const name = node.field("name")?.text();
    return name ? [restore(name)] : [];
  }
  if (kind === "lexical_declaration" || kind === "variable_declaration") {
    return node
      .findAll({ rule: { kind: "variable_declarator" } })
      .filter((d) => d.parent()?.id() === node.id())
      .map((d) => d.field("name"))
      .filter((n): n is SgNode => n !== null && n.kind() === "identifier")
      .map((n) => restore(n.text()));
  }
  return [];
}

function exportsOf(root: SgNode, restore: (text: string) => string): { exports: ExportEntry[]; starExports: string[] } {
  const exports: ExportEntry[] = [];
  const starExports: string[] = [];
  for (const statement of root.children().filter((c) => c.kind() === "export_statement")) {
    const source = statement.field("source");
    const declaration = statement.field("declaration");
    if (/^export\s+default\b/.test(statement.text())) {
      // `export default function X` exports X as "default"; the name stays local to the module.
      const value = statement.field("value") ?? declaration;
      const named = value ? declaredNames(value, restore)[0] : undefined;
      exports.push({ kind: "local", name: "default", local: value?.kind() === "identifier" ? restore(value.text()) : named ?? "default" });
      continue;
    }
    if (declaration) {
      for (const name of declaredNames(declaration, restore)) exports.push({ kind: "local", name, local: name });
      continue;
    }
    const clause = statement.find({ rule: { kind: "export_clause" } });
    if (!clause) {
      const namespace = statement.find({ rule: { kind: "namespace_export" } });
      const name = namespace?.children().find((c) => c.isNamed());
      if (source && name) exports.push({ kind: "reexport", name: restore(unquote(name.text())), imported: "*", specifier: unquote(source.text()) });
      if (source && /^export\s+(?:type\s+)?\*\s+from/.test(statement.text())) starExports.push(unquote(source.text()));
      continue;
    }
    for (const spec of clause.findAll({ rule: { kind: "export_specifier" } })) {
      const found = spec.field("name")?.text();
      if (!found) continue;
      const name = restore(found);
      const alias = restore(spec.field("alias")?.text() ?? found);
      exports.push(source ? { kind: "reexport", name: unquote(alias), imported: unquote(name), specifier: unquote(source.text()) } : { kind: "local", name: unquote(alias), local: unquote(name) });
    }
  }
  return { exports, starExports };
}

function topLevelDeclarations(root: SgNode, restore: (text: string) => string): Set<string> {
  const names = new Set<string>();
  for (const child of root.children()) {
    const target = child.kind() === "export_statement" ? child.field("declaration") : child;
    if (target) for (const name of declaredNames(target, restore)) names.add(name);
  }
  return names;
}

function jsxOf(root: SgNode, restore: (text: string) => string): JsxElement[] {
  return root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }] } }).flatMap((node) => {
    const name = node.field("name");
    if (!name) return [];
    const start = node.range().start;
    return [{ node, tag: restore(name.text()), line: start.line + 1, column: start.column + 1 }];
  });
}

const errorsOf = (root: SgRoot): number => root.root().findAll({ rule: { kind: "ERROR" } }).length;

/** A real `using` declaration: `using x =` / `await using x =`, the binding on the same line. */
const USING_DECLARATION = /^[ \t]+(?!(?:in|of|instanceof|as|satisfies)\b)[\p{ID_Start}$_\\]/u;

/** Private-use characters absent from `source`, so a stand-in made of them can be mapped back exactly. */
function unusedPrivateChars(source: string, count: number): string[] | null {
  const chars: string[] = [];
  for (let code = 0xe000; code <= 0xf8ff && chars.length < count; code++) {
    const char = String.fromCharCode(code);
    if (!source.includes(char)) chars.push(char);
  }
  return chars.length === count ? chars : null;
}

/** Inside JSX children: an ERROR (or a run of them) whose first non-ERROR ancestor is a JSX element. */
function inJsxError(node: SgNode): boolean {
  let parent = node.parent();
  if (parent?.kind() !== "ERROR") return false;
  while (parent?.kind() === "ERROR") parent = parent.parent();
  return parent?.kind() === "jsx_element";
}

/**
 * One round of stand-ins on `text` from its tree: each bare `&` the grammar choked on in JSX text,
 * and each `using` keyword token that is not a `using` declaration (an ordinary name). Same length,
 * so every line, column and index is unchanged.
 */
function withStandIns(top: SgNode, text: string, stand: { amp: string; using: string }): string {
  const spans: Array<{ start: number; end: number; with: string }> = [];
  for (const node of top.findAll({ rule: { regex: "^(?:&|using)$" } })) {
    const { start, end } = node.range();
    if (node.kind() === "&" && inJsxError(node)) spans.push({ start: start.index, end: end.index, with: stand.amp });
    if (node.kind() === "using" && !USING_DECLARATION.test(text.slice(end.index))) spans.push({ start: start.index, end: end.index, with: stand.using });
  }
  let out = text;
  for (const span of spans.sort((a, b) => b.start - a.start)) out = out.slice(0, span.start) + span.with + out.slice(span.end);
  return out;
}

/**
 * Parse `source`, working around syntax tsc accepts that the bundled tree-sitter grammar rejects:
 * a bare `&` in JSX text (`<Tab>Contract & tokens</Tab>`; the grammar reads only `&name;`), and
 * `using` as an ordinary name (`const [using, setUsing] = useState()`; the grammar takes it for a
 * `using` declaration, and the error can swallow the whole file). Each is swapped for same-length
 * private-use text absent from the source, and the swap is kept only when it leaves fewer errors;
 * `restore` maps text read from the tree back to the source exactly.
 */
async function parseSource(lang: "tsx" | "ts", source: string): Promise<{ root: SgRoot; parseErrors: number; restore: (text: string) => string }> {
  const root = await parseAsync(LANG[lang], source);
  let best = { root, parseErrors: errorsOf(root), restore: (text: string) => text };
  const chars = best.parseErrors > 0 ? unusedPrivateChars(source, 2) : null;
  if (!chars) return best;
  const stand = { amp: chars[0]!, using: `${chars[1]}sing` };
  const restore = (text: string) => text.replaceAll(stand.amp, "&").replaceAll(stand.using, "using");
  let text = source;
  // A swap can let the grammar recover enough to expose the next one, so repeat while it helps.
  for (let round = 0; round < 4 && best.parseErrors > 0; round++) {
    const next = withStandIns(best.root.root(), text, stand);
    if (next === text) break;
    const reparsed = await parseAsync(LANG[lang], next);
    const errors = errorsOf(reparsed);
    if (errors >= best.parseErrors) break;
    text = next;
    best = { root: reparsed, parseErrors: errors, restore };
  }
  return best;
}

export async function parseModule(file: string, source: string): Promise<ModuleInfo | null> {
  const lang = langOf(file);
  if (!lang) return null;
  if (lang === "css") {
    const root = await parseAsync(LANG.css, source);
    // Stylesheets are read by youi's custom-property reader (tokens/css.ts); tree-sitter-css
    // rejects Tailwind at-rules (@theme, @custom-variant), so its errors say nothing here.
    return { file, lang, source, root, imports: [], runtimeSpecifiers: [], dynamicSpecifiers: cssSpecifiersOf(source), exports: [], starExports: [], declarations: new Set(), jsx: [], parseErrors: 0, restore: (text) => text };
  }
  const { root, parseErrors, restore } = await parseSource(lang, source);
  const top = root.root();
  const { exports, starExports } = exportsOf(top, restore);
  return {
    file,
    lang,
    source,
    root,
    imports: importsOf(top, restore),
    runtimeSpecifiers: runtimeSpecifiersOf(top),
    dynamicSpecifiers: dynamicSpecifiersOf(top),
    exports,
    starExports,
    declarations: topLevelDeclarations(top, restore),
    jsx: lang === "tsx" ? jsxOf(top, restore) : [],
    parseErrors,
    restore,
  };
}

/**
 * Why a file with parse errors was only partly read: where the parser could not read it, that
 * `lost` (e.g. "UI sites there were not read") is unknown rather than zero, and what to do.
 * Null when the file parsed.
 */
export function parseProblem(module: ModuleInfo, lost: string): string | null {
  if (module.parseErrors === 0) return null;
  const spans: Array<[number, number]> = [];
  for (const node of module.root.root().findAll({ rule: { kind: "ERROR" } }).map((n) => n.range()).sort((a, b) => a.start.index - b.start.index)) {
    const [start, end] = [node.start.line + 1, node.end.line + 1];
    const last = spans.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  const lines = module.source.replace(/\n$/, "").split("\n").length;
  const covered = spans.reduce((n, [start, end]) => n + end - start + 1, 0);
  const span = ([start, end]: [number, number]) => (start === end ? `${start}` : `${start}-${end}`);
  const where =
    covered >= lines * 0.9 ? "most of the file" : `line${spans.length > 1 || spans[0]![0] !== spans[0]![1] ? "s" : ""} ${spans.slice(0, 3).map(span).join(", ")}${spans.length > 3 ? ` and ${spans.length - 3} more places` : ""}`;
  return `the parser could not read ${where}, so ${lost}. Next: fix the syntax there; if TypeScript accepts it, youiyoux's parser does not support that syntax yet: report it, and write it another way meanwhile`;
}

/** Count of tree-sitter ERROR nodes, after the same workarounds as parseModule: the "no parse errors" invariant. */
export async function countParseErrors(file: string, source: string): Promise<number> {
  const lang = langOf(file);
  if (!lang) return 0;
  if (lang === "css") return errorsOf(await parseAsync(LANG.css, source));
  return (await parseSource(lang, source)).parseErrors;
}
