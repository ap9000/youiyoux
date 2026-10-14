/**
 * A project's real CSS for its specimens, built the way its own pages get it. The stylesheets a
 * page loads, in page order (findStylesheets): an explicit `specimens.css` list in
 * youi.project.json (or in a config kept outside the product) when there is one; else the sheets
 * its server or source code reads and inlines (`readFileSync`, `readFile`, `new URL(…,
 * import.meta.url)`, `?raw` and `?inline` imports: tokens a server puts in a `<style>` come
 * first), then the `<link rel="stylesheet">`s of its index.html, other HTML and server templates
 * (a link to a Tailwind CLI output maps back to the entry the CLI builds), then what its layouts
 * and components import. A Tailwind entry nothing links, imports or reads is built only when the
 * page loads no other Tailwind entry; otherwise it is skipped, and the stylesheet list says so.
 * Each Tailwind v4 entry is compiled with the project's own installed Tailwind (`@tailwindcss/node`
 * compile, candidates from the oxide Scanner over its sources, then optimize, as
 * `@tailwindcss/vite` does) in a worker that is stopped after a timeout; fonts it loads from
 * absolute `/fonts/…` paths are inlined as data URIs; and there is one copy per colour scheme with
 * `prefers-color-scheme` fixed to true or false.
 *
 * Everything is read; nothing is written. Every file read is inside the project root, and every
 * package loaded is in the root's own node_modules (contain.ts): anything else is refused with a
 * warning.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { SpecimenStats } from "./cache.ts";
import { displayPath, escapingLinks, inPackage, packageName, packageUnderRoot, realOf, relativeInside, within } from "./contain.ts";

export type Scheme = "light" | "dark";
export const SCHEMES: readonly Scheme[] = ["light", "dark"];

/** A stylesheet the build used: project-relative, how the page gets it, and how it was built. */
export interface SheetSource {
  readonly sheet: string;
  readonly via: string;
  /** tailwind: compiled with the project's Tailwind; plain: inlined as written (Tailwind directives dropped). */
  readonly as?: "tailwind" | "plain";
}

export interface ProjectCss {
  /** null when the project has no stylesheet a page loads. */
  readonly light: string | null;
  readonly dark: string | null;
  readonly warnings: string[];
  /** Project-relative stylesheets, in the order they were concatenated. */
  readonly sheets: string[];
  /** The same, with how the page gets each and how it was built. */
  readonly sources: SheetSource[];
  /** Tailwind entries nothing links, imports or reads, left out because the page loads another. */
  readonly skipped: string[];
  /** How Tailwind was handled: compiled with the project's own version, or why not. */
  readonly tailwind: string;
}

export interface CssOptions {
  readonly tsconfig?: string;
  /** youi.project.json `specimens.css`: exactly these sheets, in this order. */
  readonly override?: readonly string[] | null;
  /** Where the override comes from, for a reader: youi.project.json, or a config kept outside the product. */
  readonly overrideFrom?: string;
  /** HTML and server templates (index.html first), project-relative. */
  readonly templates?: readonly string[];
  /** How long one Tailwind compile and scan may take. */
  readonly tailwindTimeoutMs?: number;
  /**
   * Directories outside the root whose files Tailwind also scans for classes (a Discover
   * preview's fetched files), so the project's sheet has the rules those classes need. Only
   * scanned for class names: nothing in them is imported or run.
   */
  readonly extraSources?: readonly string[];
  /** Stops the build early (its Tailwind workers are terminated): a Discover preview past its limit. */
  readonly signal?: AbortSignal;
}

export const TAILWIND_TIMEOUT_MS = 30_000;

/** A time limit for a reader: `30s`, or `250 ms` when it is not whole seconds. */
export const limitOf = (ms: number): string => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms} ms`);

/** A Tailwind entry: v4's `@import "tailwindcss"` (or its layers), v3's `@tailwind` directives. */
const TAILWIND_ENTRY = /@import\s+(?:url\()?["']tailwindcss(?:\/[\w.-]+)?["']|@tailwind\s+(?:base|components|utilities)\b/;
/** A module's CSS import; `?raw` and `?inline` ones are read as text (SOURCE_READ), not applied. */
const CSS_IMPORT = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+\.css)(?:\?(?!(?:raw|inline)\b)[^"']*)?["']/gm;
/**
 * Code that reads a stylesheet as text, to inline it: a `readFileSync(`/`readFile(` call (fs,
 * fs/promises, fs.promises), `new URL("./x.css", import.meta.url)`, and `?raw`/`?inline` imports.
 */
const SOURCE_READ = /\b(readFileSync|readFile)\s*\(|\bnew\s+URL\s*\(\s*(["'`])([^"'`$]+?\.css)(?:\?[^"'`]*)?\2\s*,\s*import\.meta\.url\s*\)|(?:^\s*import\s+[\w*{}\s,]+\s+from\s*|\bimport\s*\(\s*)["']([^"']+\.css)\?(raw|inline)\b[^"']*["']/gm;
/** An argument resolved from the module's own directory, not the working directory (the project root). */
const FILE_RELATIVE = /__dirname|import\.meta\.(?:dirname|url)|fileURLToPath/;
const STRING = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
const AT_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/g;
const LINK = /<link\b[^>]*>/gi;
/** Files that set up every page: Next.js and Expo layouts, Astro layouts, app entry points. */
const LAYOUT = /(?:^|\/)(?:layouts?\/[^/]+|(?:_?layout|_app|_document|root|main|app|index)\.(?:tsx|jsx|ts|js|mjs))$/i;
const MODULE = /\.(tsx|jsx|ts|js|mjs|cjs|astro)$/;
const FONT_TYPES: Record<string, string> = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf" };
/** Where frameworks serve absolute paths from. */
const PUBLIC_DIRS = ["public", "static"];

/** A sheet as found: its file, where it is shown, and how the page gets it. */
interface Found {
  readonly path: string;
  readonly sheet: string;
  readonly via: string;
}
type Resolved = { path: string } | { refused: string } | null;

function readInside(root: string, rel: string): string | null {
  const inside = relativeInside(root, rel);
  if (!("ok" in inside)) return null;
  try {
    return readFileSync(join(root, inside.ok), "utf8");
  } catch {
    return null;
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * `./x.css` relative to the importer, `@/styles/x.css` with tsconfig paths, `pkg/x.css` from the
 * root's node_modules. Refused: anything that leaves the root, through `..`, an absolute path, an
 * alias or a symlink, and a package the root does not install itself.
 */
function resolveSheet(root: string, from: string, specifier: string, aliases: ReadonlyArray<readonly [string, string]>): Resolved {
  let rel: string | null = null;
  if (specifier.startsWith(".") && !within(root, from)) {
    // Inside an installed package: its own files, wherever its store is.
    const target = resolve(dirname(from), specifier);
    if (!inPackage(target)) return { refused: `"${specifier}" leaves the package ${displayPath(root, from)}` };
    return existsSync(target) ? { path: target } : null;
  }
  if (specifier.startsWith(".")) rel = posix.join(posix.dirname(displayPath(root, from)), specifier);
  else if (specifier.startsWith("/")) return { refused: `"${specifier}" is an absolute path` };
  else {
    for (const [prefix, target] of aliases) if (specifier.startsWith(prefix)) rel = posix.join(target, specifier.slice(prefix.length));
  }
  if (rel !== null) {
    const inside = relativeInside(root, rel);
    if ("refused" in inside) return { refused: `"${specifier}" is outside the project root` };
    return existsSync(join(root, inside.ok)) ? { path: join(root, inside.ok) } : null;
  }
  // A bare package: from the root's own node_modules, or not at all.
  if (!packageUnderRoot(root, specifier)) return packageName(specifier) ? { refused: `"${specifier}" is not a package in the project's node_modules` } : null;
  try {
    return { path: createRequire(join(root, "package.json")).resolve(specifier) };
  } catch {
    return null;
  }
}

/** `paths` aliases from a tsconfig, read leniently; aliases that point outside the root are dropped. */
export function tsconfigAliases(root: string, tsconfig = "tsconfig.json"): Array<[string, string]> {
  const text = readInside(root, tsconfig);
  if (text === null) return [];
  try {
    const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const base = json.compilerOptions?.baseUrl ?? ".";
    return Object.entries(json.compilerOptions?.paths ?? {}).flatMap(([key, [target]]) => {
      if (!target) return [];
      const to = posix.normalize(posix.join(posix.dirname(tsconfig), base, target.replace(/\*$/, "")));
      return "ok" in relativeInside(root, to) ? [[key.replace(/\*$/, ""), to] as [string, string]] : [];
    });
  } catch {
    return [];
  }
}

/**
 * The stylesheets modules import, in page order: every layout's imports first (outer layouts
 * sort first by path), then each other module's, in source order; each sheet once.
 */
function importedSheets(root: string, files: readonly string[], tsconfig: string, warnings: string[]): Found[] {
  const aliases = tsconfigAliases(root, tsconfig);
  const modules = files.filter((f) => MODULE.test(f));
  const ordered = [...modules.filter((f) => LAYOUT.test(f)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)), ...modules.filter((f) => !LAYOUT.test(f)).sort()];
  const found: Found[] = [];
  for (const file of ordered) {
    let source = readInside(root, file);
    if (source === null) continue;
    // An Astro file's imports are in its frontmatter.
    if (file.endsWith(".astro")) source = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
    for (const match of source.matchAll(CSS_IMPORT)) {
      const sheet = resolveSheet(root, join(root, file), match[1]!, aliases);
      if (sheet && "refused" in sheet) warnings.push(`${file}: refused import ${sheet.refused}`);
      else if (sheet && !found.some((f) => f.path === sheet.path)) found.push({ path: sheet.path, sheet: displayPath(root, sheet.path), via: `import in ${file}` });
    }
  }
  return found;
}

/** The first argument of the call whose `(` is just before `from` (or a declaration's value): up to its top-level `,`, `)` or `;`, strings skipped. */
function firstArgument(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    else if ((c === ")" || c === "," || c === ";") && depth === 0) return source.slice(from, i);
  }
  return "";
}

/**
 * The path a read call's argument names, joined from its string literals (`join(root, "src",
 * "x.css")`, a template's text after its last `${…}`); a bare identifier is followed to its
 * `const`. Null unless it ends in `.css`.
 */
function readPath(source: string, argument: string): { path: string; fileRelative: boolean } | null {
  let expression = argument.trim();
  const named = /^[A-Za-z_$][\w$]*$/.test(expression) ? new RegExp(`\\b(?:const|let|var)\\s+${expression.replace(/\$/g, "\\$")}\\s*=\\s*`).exec(source) : null;
  if (named) expression = firstArgument(source, named.index + named[0].length);
  const pieces = [...expression.matchAll(STRING)].map(([, quote, text]) => (quote === "`" && text!.includes("${") ? text!.slice(text!.lastIndexOf("}") + 1).replace(/^\/+/, "") : text!)).filter(Boolean);
  const path = pieces.length > 0 ? posix.join(...pieces).replace(/[?#].*$/, "") : "";
  return path.endsWith(".css") ? { path, fileRelative: FILE_RELATIVE.test(expression) } : null;
}

/**
 * The stylesheets server or source code reads as text to inline them (a server's `<style>` of
 * design tokens, a `?raw` import), in module order then source order. A path is taken from the
 * module's directory when the code says so (`__dirname`, `import.meta.url`, a relative import),
 * else from the working directory, the project root; the other is the fallback. Only files whose
 * real path is inside the root.
 */
function sourceReadSheets(root: string, files: readonly string[], warnings: string[]): Found[] {
  const found: Found[] = [];
  for (const file of files.filter((f) => MODULE.test(f)).sort()) {
    const source = readInside(root, file);
    if (source === null || !/readFile|import\.meta\.url|\.css\?(?:raw|inline)/.test(source)) continue;
    for (const match of source.matchAll(SOURCE_READ)) {
      const [, call, , urlPath, importPath, query] = match;
      const read = call ? readPath(source, firstArgument(source, match.index + match[0].length)) : { path: (urlPath ?? importPath)!, fileRelative: true };
      if (!read) continue;
      const via = call ? `${call} in ${file}` : urlPath ? `new URL in ${file}` : `?${query} import in ${file}`;
      const fromFile = posix.join(posix.dirname(file), read.path);
      const candidates = read.path.startsWith("/") ? [read.path] : read.fileRelative ? [fromFile, read.path] : [read.path, fromFile];
      let refused: string | null = null;
      let sheet: string | null = null;
      for (const candidate of candidates) {
        const inside = relativeInside(root, candidate);
        if ("refused" in inside) refused ??= inside.refused;
        else if (isFile(join(root, inside.ok))) {
          sheet = inside.ok;
          break;
        }
      }
      if (sheet !== null) {
        if (!found.some((f) => realOf(f.path) === realOf(join(root, sheet)))) found.push({ path: join(root, sheet), sheet, via });
      } else if (refused !== null) warnings.push(`${file}: refused ${call ?? (urlPath ? "new URL" : `?${query} import`)} of "${read.path}": ${refused}`);
    }
  }
  return found;
}

/** The stylesheets modules import, in page order, project-relative (see importedSheets). */
export function pageStylesheets(root: string, files: readonly string[], tsconfig = "tsconfig.json", warnings: string[] = []): string[] {
  return importedSheets(root, files, tsconfig, warnings).map((f) => f.sheet);
}

/** Tailwind CLI runs in package.json scripts: output → input (`tailwindcss -i src/app.css -o public/app.css`). */
export function tailwindCliBuilds(root: string): Array<{ script: string; input: string; output: string }> {
  const scripts = readPackage(root).scripts ?? {};
  const builds: Array<{ script: string; input: string; output: string }> = [];
  for (const [script, command] of Object.entries(scripts)) {
    for (const run of command.split(/&&|\|\||[;&|]/)) {
      if (!/(?:^|[\s/])(?:@tailwindcss\/cli|tailwindcss)(?:@[\w.^~-]+)?(?:\s|$)/.test(run)) continue;
      const arg = (short: string, long: string): string | null => new RegExp(`(?:\\s-${short}|\\s--${long})(?:=|\\s+)["']?([^\\s"']+)`).exec(` ${run}`)?.[1] ?? null;
      const input = arg("i", "input");
      const output = arg("o", "output");
      if (input && output) builds.push({ script, input: posix.normalize(input), output: posix.normalize(output) });
    }
  }
  return builds;
}

/** `<link rel="stylesheet" href>`s in a document or a template string, in document order. */
export function stylesheetLinks(source: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of source.matchAll(LINK)) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    // A computed href (`${base}/x.css`, `<%= … %>`, `{{ … }}`) cannot be followed.
    if (value && !/\$\{|<%|\{\{/.test(value)) hrefs.push(value);
  }
  return hrefs;
}

/**
 * The project file a link's href is served from: the entry a Tailwind CLI script builds it from,
 * the source itself at that path (Vite serves `/src/x.css`), a Tailwind entry of the same name,
 * or the file in public/ or static/.
 */
function linkTarget(root: string, file: string, href: string, builds: ReturnType<typeof tailwindCliBuilds>, entries: readonly string[]): Found | { remote: string } | { refused: string } | null {
  if (/^(?:[a-z]+:)?\/\//i.test(href)) return { remote: href };
  if (/^[a-z]+:/i.test(href)) return null;
  const clean = href.replace(/[?#].*$/, "");
  const served = clean.startsWith("/") ? clean.slice(1) : posix.join(posix.dirname(file), clean);
  const inside = relativeInside(root, served);
  if ("refused" in inside) return { refused: `href "${href}" is outside the project root` };
  const path = inside.ok;
  const where = `link ${href} in ${file}`;
  const built = builds.find((b) => [path, ...PUBLIC_DIRS.map((d) => `${d}/${path}`)].includes(b.output.replace(/^\.\//, ""))) ?? builds.find((b) => basename(b.output) === basename(path));
  if (built) {
    const input = relativeInside(root, built.input);
    if ("refused" in input) return { refused: `package.json "${built.script}" builds it from ${built.input}, outside the project root` };
    if (isFile(join(root, input.ok))) return { path: join(root, input.ok), sheet: input.ok, via: `${where}, built by package.json "${built.script}"` };
  }
  if (path.endsWith(".css") && isFile(join(root, path))) return { path: join(root, path), sheet: path, via: where };
  const entry = entries.find((e) => basename(e) === basename(path));
  if (entry) return { path: join(root, entry), sheet: entry, via: `${where}, the Tailwind entry of that name` };
  for (const dir of PUBLIC_DIRS) {
    const publicFile = relativeInside(root, `${dir}/${path}`);
    if ("ok" in publicFile && isFile(join(root, publicFile.ok))) return { path: join(root, publicFile.ok), sheet: publicFile.ok, via: where };
  }
  return null;
}

/** Whether a sheet is a Tailwind entry; unreadable sheets are not. */
const isTailwindEntry = (path: string): boolean => {
  try {
    return TAILWIND_ENTRY.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
};

/**
 * The stylesheets a page loads, in page order, and how it gets each. With an override, exactly
 * that list. Else: sheets server or source code reads and inlines (sourceReadSheets), ahead of
 * the Tailwind output so the tokens it uses are defined; then links in index.html, then other
 * HTML and templates, then template strings in modules; then module imports (importedSheets);
 * then Tailwind entries nothing links or imports, but only when none of those is a Tailwind
 * entry: a page that loads one does not use the others (`skipped`).
 * Remote links are kept as `@import url()`s.
 */
export function findStylesheets(root: string, files: readonly string[], options: CssOptions = {}): { found: Found[]; remote: string[]; warnings: string[]; skipped: string[] } {
  const warnings: string[] = [];
  const found: Found[] = [];
  const remote: string[] = [];
  const skipped: string[] = [];
  const add = (sheet: Found): void => {
    if (!found.some((f) => realOf(f.path) === realOf(sheet.path))) found.push(sheet);
  };
  if (options.override) {
    const from = options.overrideFrom ?? "youi.project.json";
    for (const entry of options.override) {
      const inside = relativeInside(root, entry);
      if ("refused" in inside) warnings.push(`${from} specimens.css: refused ${inside.refused}`);
      else if (!isFile(join(root, inside.ok))) warnings.push(`${from} specimens.css: ${entry} does not exist`);
      else add({ path: join(root, inside.ok), sheet: inside.ok, via: `specimens.css in ${from}` });
    }
    return { found, remote, warnings, skipped };
  }
  for (const sheet of sourceReadSheets(root, files, warnings)) add(sheet);
  const builds = tailwindCliBuilds(root);
  const sheetsInProject = files.filter((f) => f.endsWith(".css"));
  const entries = sheetsInProject.filter((f) => "ok" in relativeInside(root, f) && isTailwindEntry(join(root, f)));
  const templates = [...(options.templates ?? [])].sort((a, b) => Number(b === "index.html") - Number(a === "index.html") || a.split("/").length - b.split("/").length || a.localeCompare(b));
  const modules = files.filter((f) => MODULE.test(f)).sort();
  for (const file of [...templates, ...modules]) {
    const source = readInside(root, file);
    if (source === null || !/<link\b/i.test(source)) continue;
    for (const href of stylesheetLinks(source)) {
      const target = linkTarget(root, file, href, builds, entries);
      if (target === null) warnings.push(`${file}: <link href="${href}">: no file in the project builds or serves it`);
      else if ("refused" in target) warnings.push(`${file}: refused <link> ${target.refused}`);
      else if ("remote" in target) {
        if (!remote.includes(target.remote)) remote.push(target.remote);
      } else add(target);
    }
  }
  for (const sheet of importedSheets(root, files, options.tsconfig ?? "tsconfig.json", warnings)) add(sheet);
  // A Tailwind entry built by its CLI, not imported: unless another sheet @imports it.
  const imported = new Set<string>();
  for (const sheet of sheetsInProject) {
    const source = readInside(root, sheet);
    for (const match of source?.matchAll(AT_IMPORT) ?? []) {
      const target = match[1]!.startsWith(".") ? relativeInside(root, posix.join(posix.dirname(sheet), match[1]!)) : null;
      if (target && "ok" in target) imported.add(target.ok);
    }
  }
  const unreferenced = entries.filter((entry) => !imported.has(entry) && !found.some((f) => realOf(f.path) === realOf(join(root, entry))));
  if (found.some((f) => isTailwindEntry(f.path))) skipped.push(...unreferenced);
  else for (const entry of unreferenced) add({ path: join(root, entry), sheet: entry, via: "a Tailwind entry no module imports" });
  return { found, remote, warnings, skipped };
}

type PackageJson = Record<string, Record<string, string> | undefined>;
function readPackage(root: string): PackageJson {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

const majorOf = (range: string | undefined): number | null => {
  const match = /(\d+)/.exec(range ?? "");
  return match && !/^(?:\*|latest|workspace:|link:|file:)/.test(range ?? "") ? Number(match[1]) : null;
};

/** A package as the project installs it: in its root's node_modules, else through its Tailwind integration there (pnpm keeps those nested). */
function resolveFromProject(root: string, id: string): string | null {
  const bases = [join(root, "package.json")];
  for (const integration of ["@tailwindcss/vite", "@tailwindcss/postcss", "@tailwindcss/cli"]) {
    const dir = packageUnderRoot(root, integration);
    if (dir) bases.push(join(dir, "package.json"));
  }
  for (const [i, base] of bases.entries()) {
    if (i === 0 && !packageUnderRoot(root, id)) continue;
    try {
      return createRequire(base).resolve(id);
    } catch {
      // try the next base
    }
  }
  return null;
}

/**
 * The project's Tailwind: its version, and its compiler's entry points when that is v4, matches
 * what package.json asks for, and is installed in the root's own node_modules.
 */
export function projectTailwind(root: string): { version: string | null; node: string | null; oxide: string | null; note: string } {
  const pkg = readPackage(root);
  const declared = pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss;
  let version: string | null = null;
  const dir = packageUnderRoot(root, "tailwindcss");
  try {
    if (!dir) throw new Error("not installed");
    version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return { version: null, node: null, oxide: null, note: declared ? `tailwindcss ${declared} is declared but not installed in the project's node_modules: run the project's install` : "no Tailwind" };
  }
  const major = Number(version.split(".")[0]);
  const wanted = majorOf(declared);
  if (wanted !== null && wanted !== major) return { version, node: null, oxide: null, note: `package.json asks for tailwindcss ${declared} but ${version} resolves: global stylesheets only` };
  if (major < 4) return { version, node: null, oxide: null, note: `Tailwind ${version} is not v4: global stylesheets only` };
  const node = resolveFromProject(root, "@tailwindcss/node");
  const oxide = resolveFromProject(root, "@tailwindcss/oxide");
  if (!node || !oxide) return { version, node: null, oxide: null, note: `Tailwind ${version} without @tailwindcss/node and @tailwindcss/oxide installed: global stylesheets only` };
  return { version, node, oxide, note: `Tailwind ${version}, the project's own` };
}

/** A plain stylesheet with its `@import`s inlined (a concatenated sheet cannot resolve them); only files inside the root. */
function inlineImports(root: string, file: string, seen: Set<string>, warnings: string[], hoisted: string[]): string {
  if (seen.has(realOf(file))) return "";
  seen.add(realOf(file));
  const css = readFileSync(file, "utf8");
  const shown = displayPath(root, file);
  return css.replace(AT_IMPORT, (statement, specifier: string, media: string) => {
    if (/^(?:https?:)?\/\//.test(specifier)) {
      hoisted.push(statement);
      return "";
    }
    if (TAILWIND_ENTRY.test(statement)) return "";
    const target = resolveSheet(root, file, specifier, []);
    if (target && "refused" in target) {
      warnings.push(`${shown}: refused @import ${target.refused}`);
      return "";
    }
    if (!target) {
      warnings.push(`${shown}: could not inline @import "${specifier}"`);
      return "";
    }
    const inner = inlineImports(root, target.path, seen, warnings, hoisted);
    return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
  });
}

/** `url(/fonts/x.woff2)` → a data URI of the project's public file; other urls stay. Paths that leave public/ are refused. */
export function inlineFonts(root: string, css: string, warnings: string[]): { css: string; fonts: string[] } {
  const fonts: string[] = [];
  const out = css.replace(/url\(\s*(["']?)(\/[^"')]+?\.(?:woff2|woff|ttf|otf))(?:[?#][^"')]*)?\1\s*\)/g, (whole, _quote: string, path: string) => {
    if (path.split("/").includes("..")) {
      warnings.push(`refused font ${path}: it climbs out of the public directory`);
      return whole;
    }
    const served = path.replace(/^\/+/, "");
    let refused = false;
    const file = PUBLIC_DIRS.map((dir) => [join(root, dir), join(root, dir, served)] as const).find(([dir, candidate]) => {
      if (!existsSync(candidate)) return false;
      if (within(root, candidate) && within(dir, candidate)) return true;
      refused = true;
      return false;
    })?.[1];
    if (!file) {
      warnings.push(refused ? `refused font ${path}: a symlink that leads outside the project root` : `font ${path} is not in ${PUBLIC_DIRS.join("/ or ")}/`);
      return whole;
    }
    fonts.push(displayPath(root, file));
    return `url("data:${FONT_TYPES[extname(file).toLowerCase()]};base64,${readFileSync(file).toString("base64")}")`;
  });
  return { css: out, fonts };
}

/**
 * The sheet for one scheme: every `prefers-color-scheme` query fixed to true (its scheme) or
 * false (the other), class- and attribute-based dark themes are set by the frame's `<html>`.
 */
export function forScheme(css: string, scheme: Scheme): string {
  const fixed = css.replace(/\(\s*prefers-color-scheme\s*(?::\s*([a-z-]+)\s*)?\)/gi, (_, value: string | undefined) => (value === undefined || value.toLowerCase() === scheme ? "(min-width: 0px)" : "(not (min-width: 0px))"));
  return `${fixed}\n:root { color-scheme: ${scheme}; }\n`;
}

interface TailwindResult {
  readonly css?: string;
  readonly error?: string;
  readonly dependencies: string[];
  readonly warnings: string[];
}

/** One Tailwind entry compiled, scanned and optimised in a worker (tailwind-worker.ts), stopped after `timeoutMs`. */
export function compileTailwind(input: { root: string; from: string; node: string; oxide: string; exclude: readonly string[]; files?: readonly string[]; extraSources?: readonly string[] }, timeoutMs: number, signal?: AbortSignal): Promise<TailwindResult> {
  return new Promise((done) => {
    if (signal?.aborted) return done({ error: "stopped", dependencies: [], warnings: [] });
    const worker = new Worker(new URL("./tailwind-worker.ts", import.meta.url), { workerData: input, stdout: true, stderr: true });
    let settled = false;
    const finish = (result: TailwindResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      void worker.terminate();
      done(result);
    };
    const stop = (): void => finish({ error: "stopped", dependencies: [], warnings: [] });
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => finish({ error: `timed out after ${limitOf(timeoutMs)}`, dependencies: [], warnings: [] }), timeoutMs);
    worker.once("message", (message: TailwindResult) => finish(message));
    worker.once("error", (error) => finish({ error: error instanceof Error ? error.message : String(error), dependencies: [], warnings: [] }));
    worker.once("exit", (code) => finish({ error: `the Tailwind worker exited with code ${code}`, dependencies: [], warnings: [] }));
  });
}

/** Lines for a reader: which sheets were used, how the page gets them, and how each was built. */
export function describeSources(sources: readonly SheetSource[], tailwindVersion: string | null): string[] {
  return sources.map((s) => (s.as === "tailwind" ? `built: ${s.sheet} (${s.via}, Tailwind ${tailwindVersion ?? "?"})` : `inlined: ${s.sheet} (${s.via})`));
}

/** Lines for a reader: the Tailwind entries left out, and why. */
export function describeSkipped(skipped: readonly string[]): string[] {
  return skipped.map((sheet) => `skipped: ${sheet} (a Tailwind entry nothing links, imports or reads; the page builds another)`);
}

/** Build a project's specimen CSS, light and dark. */
export async function buildProjectCss(root: string, files: readonly string[], stats: SpecimenStats, options: CssOptions = {}): Promise<ProjectCss & { fonts: string[]; tailwindVersion: string | null }> {
  const { found, remote, warnings, skipped } = findStylesheets(root, files, options);
  const sheets = found.map((f) => f.sheet);
  if (found.length === 0) return { light: null, dark: null, warnings: [...warnings, "no stylesheet a page loads: none is read by its code, linked from HTML, imported by a module, or a Tailwind entry"], sheets, sources: [], skipped, tailwind: "not needed", fonts: [], tailwindVersion: null };
  const needsTailwind = found.some((s) => isTailwindEntry(s.path));
  const tailwind = needsTailwind ? projectTailwind(root) : null;
  if (tailwind && !tailwind.node) warnings.push(tailwind.note);
  const pkg = readPackage(root);
  if (!needsTailwind && (pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss)) warnings.push("tailwindcss is a dependency, but no stylesheet a page loads is a Tailwind entry: Tailwind classes are drawn unstyled");
  const exclude = tailwind?.node ? escapingLinks(root) : [];
  for (const link of exclude) warnings.push(`refused ${link}: a symlink that leads outside the project root (not scanned for classes)`);
  const consumed = new Set<string>();
  const hoisted = remote.map((href) => `@import url(${JSON.stringify(href)});`);
  const parts: string[] = [];
  const sources: SheetSource[] = [];
  for (const sheet of found) {
    if (consumed.has(realOf(sheet.path))) continue;
    if (tailwind?.node && tailwind.oxide && isTailwindEntry(sheet.path)) {
      stats.tailwindCompiles++;
      const result = await compileTailwind({ root, from: sheet.path, node: tailwind.node, oxide: tailwind.oxide, exclude, files: files.filter((file) => !file.endsWith(".css") && !("refused" in relativeInside(root, file))), extraSources: options.extraSources ?? [] }, options.tailwindTimeoutMs ?? TAILWIND_TIMEOUT_MS, options.signal);
      warnings.push(...result.warnings.map((w) => `${sheet.sheet}: ${w}`));
      if (result.css !== undefined) {
        for (const dependency of result.dependencies) consumed.add(realOf(dependency));
        parts.push(`/* ${sheet.sheet} (Tailwind ${tailwind.version}) */\n${result.css}`);
        sources.push({ sheet: sheet.sheet, via: sheet.via, as: "tailwind" });
        continue;
      }
      warnings.push(`${sheet.sheet}: Tailwind failed (${result.error}): its global rules only`);
    }
    parts.push(`/* ${sheet.sheet} */\n${inlineImports(root, sheet.path, consumed, warnings, hoisted)}`);
    sources.push({ sheet: sheet.sheet, via: sheet.via, as: "plain" });
  }
  const { css, fonts } = inlineFonts(root, [...new Set(hoisted), ...parts].join("\n"), warnings);
  return { light: forScheme(css, "light"), dark: forScheme(css, "dark"), warnings, sheets, sources, skipped, tailwind: tailwind?.note ?? "not used", fonts, tailwindVersion: tailwind?.version ?? null };
}
