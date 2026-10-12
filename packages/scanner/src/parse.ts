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

function isTypeOnly(statement: SgNode): boolean {
  return /^import\s+type\b/.test(statement.text());
}

function importsOf(root: SgNode): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const source = statement.field("source");
    if (!source) continue;
    const specifier = unquote(source.text());
    const typeOnly = isTypeOnly(statement);
    const clause = statement.find({ rule: { kind: "import_clause" } });
    if (!clause) continue;
    for (const child of clause.children()) {
      if (child.kind() === "identifier") bindings.push({ local: child.text(), imported: "default", specifier, typeOnly });
      if (child.kind() === "namespace_import") {
        const name = child.find({ rule: { kind: "identifier" } });
        if (name) bindings.push({ local: name.text(), imported: "*", specifier, typeOnly });
      }
      if (child.kind() === "named_imports") {
        for (const spec of child.findAll({ rule: { kind: "import_specifier" } })) {
          const name = spec.field("name")?.text();
          if (!name) continue;
          const alias = spec.field("alias")?.text();
          bindings.push({ local: alias ?? name, imported: name, specifier, typeOnly: typeOnly || /^type\s/.test(spec.text()) });
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

function declaredNames(node: SgNode): string[] {
  const kind = node.kind();
  if (kind === "function_declaration" || kind === "class_declaration" || kind === "generator_function_declaration") {
    const name = node.field("name")?.text();
    return name ? [name] : [];
  }
  if (kind === "lexical_declaration" || kind === "variable_declaration") {
    return node
      .findAll({ rule: { kind: "variable_declarator" } })
      .filter((d) => d.parent()?.id() === node.id())
      .map((d) => d.field("name"))
      .filter((n): n is SgNode => n !== null && n.kind() === "identifier")
      .map((n) => n.text());
  }
  return [];
}

function exportsOf(root: SgNode): { exports: ExportEntry[]; starExports: string[] } {
  const exports: ExportEntry[] = [];
  const starExports: string[] = [];
  for (const statement of root.children().filter((c) => c.kind() === "export_statement")) {
    const source = statement.field("source");
    const declaration = statement.field("declaration");
    if (/^export\s+default\b/.test(statement.text())) {
      // `export default function X` exports X as "default"; the name stays local to the module.
      const value = statement.field("value") ?? declaration;
      const named = value ? declaredNames(value)[0] : undefined;
      exports.push({ kind: "local", name: "default", local: value?.kind() === "identifier" ? value.text() : named ?? "default" });
      continue;
    }
    if (declaration) {
      for (const name of declaredNames(declaration)) exports.push({ kind: "local", name, local: name });
      continue;
    }
    const clause = statement.find({ rule: { kind: "export_clause" } });
    if (!clause) {
      if (source && /^export\s+(?:type\s+)?\*\s+from/.test(statement.text())) starExports.push(unquote(source.text()));
      continue;
    }
    for (const spec of clause.findAll({ rule: { kind: "export_specifier" } })) {
      const name = spec.field("name")?.text();
      if (!name) continue;
      const alias = spec.field("alias")?.text() ?? name;
      exports.push(source ? { kind: "reexport", name: alias, imported: name, specifier: unquote(source.text()) } : { kind: "local", name: alias, local: name });
    }
  }
  return { exports, starExports };
}

function topLevelDeclarations(root: SgNode): Set<string> {
  const names = new Set<string>();
  for (const child of root.children()) {
    const target = child.kind() === "export_statement" ? child.field("declaration") : child;
    if (target) for (const name of declaredNames(target)) names.add(name);
  }
  return names;
}

function jsxOf(root: SgNode): JsxElement[] {
  return root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }] } }).flatMap((node) => {
    const name = node.field("name");
    if (!name) return [];
    const start = node.range().start;
    return [{ node, tag: name.text(), line: start.line + 1, column: start.column + 1 }];
  });
}

export async function parseModule(file: string, source: string): Promise<ModuleInfo | null> {
  const lang = langOf(file);
  if (!lang) return null;
  const root = await parseAsync(LANG[lang], source);
  const top = root.root();
  if (lang === "css") {
    // Stylesheets are read by youi's custom-property reader (tokens/css.ts); tree-sitter-css
    // rejects Tailwind at-rules (@theme, @custom-variant), so its errors say nothing here.
    const parseErrors = 0;
    return { file, lang, source, root, imports: [], runtimeSpecifiers: [], dynamicSpecifiers: cssSpecifiersOf(source), exports: [], starExports: [], declarations: new Set(), jsx: [], parseErrors };
  }
  const parseErrors = top.findAll({ rule: { kind: "ERROR" } }).length;
  const { exports, starExports } = exportsOf(top);
  return {
    file,
    lang,
    source,
    root,
    imports: importsOf(top),
    runtimeSpecifiers: runtimeSpecifiersOf(top),
    dynamicSpecifiers: dynamicSpecifiersOf(top),
    exports,
    starExports,
    declarations: topLevelDeclarations(top),
    jsx: lang === "tsx" ? jsxOf(top) : [],
    parseErrors,
  };
}

/** Count of tree-sitter ERROR nodes: the "no parse errors" invariant. */
export async function countParseErrors(file: string, source: string): Promise<number> {
  const lang = langOf(file);
  if (!lang) return 0;
  const root = await parseAsync(LANG[lang], source);
  return root.root().findAll({ rule: { kind: "ERROR" } }).length;
}
