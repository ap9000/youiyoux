/**
 * Repo detection: package.json files and the lockfile say what is declared; components.json
 * (or, without one, a components/ui folder of shadcn-named files) says shadcn/ui; the code's
 * actual imports (read with the TypeScript parser) say what is used, and imports of the local
 * ui kit count through any tsconfig/jsconfig alias, relative path or barrel.
 * A UI package that is declared but never imported is reported apart, in `unused`, and is
 * never counted towards a verdict.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { findFiles, type DetectElementType, type DetectFont, type DetectUnused } from "@youiyoux/core";
import { EXPORT_TYPES, libraryOfPackage, SHADCN_FILE_TYPES, SHADCN_SLOTS } from "./fingerprints.ts";
import { RepoPaths } from "./paths.ts";
import type { ElementHit, Signal } from "./score.ts";

const SOURCE_GLOB = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];
const SKIP = ["**/*.d.ts", "**/build/**", "**/.next/**", "**/out/**", "**/coverage/**", "**/.turbo/**", "**/storybook-static/**"];
const MAX_FILE_BYTES = 1_000_000;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export interface RepoScan {
  readonly name: string;
  readonly signals: Signal[];
  readonly hits: ElementHit[];
  readonly unused: DetectUnused[];
  readonly fonts: DetectFont[];
  readonly notes: string[];
  readonly coverage: string;
}

interface Declared {
  readonly version: string;
  readonly declaredIn: string;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`; relative, absolute and node: specifiers → null. */
export function packageOf(specifier: string): string | null {
  if (/^(\.|\/|node:|[a-z]+:\/\/)/.test(specifier) || specifier.startsWith("@/") || specifier.startsWith("~/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0]!;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every UI-relevant package declared in any package.json, with the file that declares it. */
async function declaredPackages(root: string, manifests: readonly string[]): Promise<Map<string, Declared>> {
  const declared = new Map<string, Declared>();
  for (const file of manifests) {
    const json = await readJson(join(root, file));
    for (const field of DEP_FIELDS) {
      const deps = json?.[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, version] of Object.entries(deps as Record<string, unknown>)) if (!declared.has(name)) declared.set(name, { version: String(version), declaredIn: file });
    }
  }
  return declared;
}

/** Resolved versions from whichever lockfile the repo has. */
async function lockedVersions(root: string): Promise<{ file: string | null; versions: Map<string, string> }> {
  const versions = new Map<string, string>();
  const pnpm = join(root, "pnpm-lock.yaml");
  if (existsSync(pnpm)) {
    const lock = parseYaml(await readFile(pnpm, "utf8")) as { importers?: Record<string, Record<string, Record<string, { version?: string }>>> } | null;
    for (const importer of Object.values(lock?.importers ?? {})) {
      for (const field of DEP_FIELDS) for (const [name, entry] of Object.entries(importer[field] ?? {})) if (entry?.version && !versions.has(name)) versions.set(name, String(entry.version).split("(")[0]!);
    }
    return { file: "pnpm-lock.yaml", versions };
  }
  const npm = await readJson(join(root, "package-lock.json"));
  if (npm) {
    for (const [path, entry] of Object.entries((npm.packages ?? {}) as Record<string, { version?: string }>)) {
      const at = path.lastIndexOf("node_modules/");
      if (at >= 0 && entry.version) versions.set(path.slice(at + "node_modules/".length), entry.version);
    }
    return { file: "package-lock.json", versions };
  }
  const yarn = join(root, "yarn.lock");
  if (existsSync(yarn)) {
    let current: string[] = [];
    for (const line of (await readFile(yarn, "utf8")).split("\n")) {
      if (/^\S/.test(line) && line.endsWith(":")) current = line.slice(0, -1).split(",").map((s) => s.trim().replace(/^"|"$/g, "").replace(/@(?:npm:)?[^@]*$/, ""));
      const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line)?.[1];
      if (version) for (const name of current) if (!versions.has(name)) versions.set(name, version);
    }
    return { file: "yarn.lock", versions };
  }
  return { file: null, versions };
}

interface ShadcnConfig {
  readonly file: string;
  readonly style: string;
  /** The ui alias (`@/components/ui`) and the directories it most likely maps to. */
  readonly alias: string | null;
  readonly dirs: readonly string[];
}

async function shadcnConfig(root: string): Promise<ShadcnConfig | null> {
  const [file] = await findFiles(root, ["components.json", "**/components.json"], SKIP);
  if (!file) return null;
  const json = await readJson(join(root, file));
  const aliases = (json?.aliases ?? {}) as Record<string, unknown>;
  const isShadcn = typeof json?.$schema === "string" ? json.$schema.includes("ui.shadcn.com") : typeof json?.style === "string" && typeof aliases.components === "string";
  if (!isShadcn) return null;
  const alias = typeof aliases.ui === "string" ? aliases.ui : typeof aliases.components === "string" ? `${aliases.components}/ui` : null;
  const base = posix.dirname(file) === "." ? "" : `${posix.dirname(file)}/`;
  const bare = alias?.replace(/^[@~]\//, "") ?? "components/ui";
  return { file, style: typeof json?.style === "string" ? json.style : "default", alias, dirs: [`${base}src/${bare}`, `${base}${bare}`] };
}

interface ShadcnKit {
  /** The kit's directories; an import of a file in one, of the directory or of its index counts as shadcn. */
  readonly dirs: readonly string[];
  /** How the evidence names the kit: components.json's ui alias, else its directory. */
  readonly label: string;
  /** Without components.json: the kit directory and its shadcn-named files, for the coverage text. */
  readonly found: string | null;
}

const KIT_DIR = /(^|\/)components\/ui$/;
const SOURCE_EXTENSION = /\.(?:[mc]?[jt]sx?)$/;
const SHADCN_SLOT_ATTR = /data-slot=["'{`]*([\w-]+)/g;

/**
 * The local ui kit. With components.json, its ui alias (through the repo's own path aliases) and
 * the usual places. Without one, a `components/ui` folder holding at least two shadcn-named files
 * (button, tabs, dialog…) whose source uses `cva(` or shadcn/ui's own data-slot names.
 */
async function shadcnKit(root: string, shadcn: ShadcnConfig | null, files: readonly string[], paths: RepoPaths): Promise<ShadcnKit | null> {
  if (shadcn) {
    const aliased = shadcn.alias ? paths.resolve(shadcn.alias, shadcn.file) : null;
    const existing = [...new Set([aliased, ...shadcn.dirs].filter((dir): dir is string => dir !== null && existsSync(join(root, dir))))];
    return { dirs: [...new Set([...existing, ...shadcn.dirs])], label: shadcn.alias ?? existing[0] ?? shadcn.dirs[0]!, found: null };
  }
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = posix.dirname(file);
    const stem = posix.basename(file).replace(SOURCE_EXTENSION, "");
    if (KIT_DIR.test(dir) && SHADCN_FILE_TYPES[stem]) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  const dirs: string[] = [];
  const named: string[] = [];
  for (const [dir, candidates] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const kitFiles: string[] = [];
    for (const file of candidates) {
      if ((await stat(join(root, file))).size > MAX_FILE_BYTES) continue;
      const text = await readFile(join(root, file), "utf8");
      if (text.includes("cva(") || [...text.matchAll(SHADCN_SLOT_ATTR)].some((m) => SHADCN_SLOTS.has(m[1]!))) kitFiles.push(posix.basename(file).replace(SOURCE_EXTENSION, ""));
    }
    if (kitFiles.length < 2) continue;
    dirs.push(dir);
    named.push(`${dir} (${[...new Set(kitFiles)].sort().join(", ")})`);
  }
  return dirs.length === 0 ? null : { dirs, label: dirs[0]!, found: `ui kit at ${named.join("; ")}` };
}

export interface ImportSite {
  readonly specifier: string;
  /** Imported names (`default` for a default import, `*` for a namespace). */
  readonly names: readonly string[];
  readonly file: string;
  readonly line: number;
}

/** Runtime imports (static, re-exports, import(), require()) and string data-slot attributes in one file. */
function readSource(file: string, text: string): { imports: ImportSite[]; slots: Map<string, number> } {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const imports: ImportSite[] = [];
  const slots = new Map<string, number>();
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        const names: string[] = [];
        if (clause?.name) names.push("default");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
        // `import { type A } from "x"` brings nothing in at runtime.
        if (!(clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && names.length === 0)) imports.push({ specifier: node.moduleSpecifier.text, names, file, line: lineOf(node) });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      const names = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text) : ["*"];
      imports.push({ specifier: node.moduleSpecifier.text, names, file, line: lineOf(node) });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) imports.push({ specifier: (node.arguments[0] as ts.StringLiteral).text, names: ["*"], file, line: lineOf(node) });
    } else if (ts.isJsxAttribute(node) && node.name.getText(source) === "data-slot" && node.initializer && ts.isStringLiteral(node.initializer)) {
      slots.set(node.initializer.text, (slots.get(node.initializer.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, slots };
}

/** The element type an import brings in: a named export (`Button`), a deep path (`@mui/material/Button`) or a one-element package. */
export function elementTypes(site: ImportSite, pkg: string, packageElements: Readonly<Record<string, DetectElementType>> | undefined): DetectElementType[] {
  const types = new Set<DetectElementType>();
  const fromPackage = packageElements?.[pkg];
  if (fromPackage) types.add(fromPackage);
  for (const name of site.names) if (EXPORT_TYPES[name]) types.add(EXPORT_TYPES[name]);
  const deep = site.specifier.slice(pkg.length + 1).split("/").at(-1);
  if (deep && EXPORT_TYPES[deep] && site.names.includes("default")) types.add(EXPORT_TYPES[deep]);
  return [...types];
}

/** Fonts a repo loads by package: next/font/google's named imports and @fontsource packages. */
function fontsOf(imports: readonly ImportSite[]): DetectFont[] {
  const fonts = new Map<string, Set<string>>();
  const add = (family: string, by: string): void => void fonts.set(family, (fonts.get(family) ?? new Set()).add(by));
  for (const site of imports) {
    if (site.specifier === "next/font/google") for (const name of site.names) if (/^[A-Z]/.test(name)) add(name.replace(/_/g, " "), `${site.file}:${site.line}`);
    const fontsource = /^@fontsource(?:-variable)?\/([a-z0-9-]+)/.exec(site.specifier)?.[1];
    if (fontsource) add(fontsource.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), site.specifier);
    if (/^geist\/font\//.test(site.specifier)) for (const name of site.names) if (/^Geist/.test(name)) add(name.replace(/([a-z])([A-Z])/g, "$1 $2"), site.specifier);
  }
  return [...fonts].map(([family, by]) => ({ family, usedBy: [...by].slice(0, 5) }));
}

export async function detectRepo(rootInput: string): Promise<RepoScan> {
  const root = resolve(rootInput);
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`${rootInput} is not a directory`);
  const manifests = await findFiles(root, ["package.json", "**/package.json"], SKIP);
  if (manifests.length === 0) throw new Error(`${root} has no package.json: youiyoux detect reads a JavaScript repo's package.json, lockfile, components.json and imports`);
  const rootManifest = await readJson(join(root, manifests.includes("package.json") ? "package.json" : manifests[0]!));
  const name = typeof rootManifest?.name === "string" && rootManifest.name ? rootManifest.name : basename(root);
  const declared = await declaredPackages(root, manifests);
  const lock = await lockedVersions(root);
  const shadcn = await shadcnConfig(root);

  const files = await findFiles(root, SOURCE_GLOB, SKIP);
  const imports: ImportSite[] = [];
  const slots = new Map<string, { count: number; where: string[] }>();
  let read = 0;
  for (const file of files) {
    const size = (await stat(join(root, file))).size;
    if (size > MAX_FILE_BYTES) continue;
    const found = readSource(file, await readFile(join(root, file), "utf8"));
    read++;
    imports.push(...found.imports);
    for (const [slot, count] of found.slots) {
      const prev = slots.get(slot) ?? { count: 0, where: [] };
      slots.set(slot, { count: prev.count + count, where: [...prev.where, file] });
    }
  }

  const signals: Signal[] = [];
  const hits: ElementHit[] = [];
  const at = (site: ImportSite): string => `${site.file}:${site.line}`;

  // Imports of library packages: the only thing that counts a package as used.
  const usedPackages = new Map<string, ImportSite[]>();
  for (const site of imports) {
    const pkg = packageOf(site.specifier);
    if (pkg && libraryOfPackage(pkg)) usedPackages.set(pkg, [...(usedPackages.get(pkg) ?? []), site]);
  }
  for (const [pkg, sites] of usedPackages) {
    const lib = libraryOfPackage(pkg)!;
    signals.push({ library: lib.id, kind: "import", strength: "strong", detail: `imports from ${pkg}`, count: sites.length, where: sites.map(at), samples: [...new Set(sites.map((s) => s.specifier))] });
    const dep = declared.get(pkg);
    if (dep) signals.push({ library: lib.id, kind: "package", strength: "weak", detail: `${pkg}@${dep.version} declared`, count: 1, where: [dep.declaredIn] });
    const locked = lock.versions.get(pkg);
    if (locked && lock.file) signals.push({ library: lib.id, kind: "lockfile", strength: "support", detail: `${lock.file} resolves ${pkg} ${locked}`, count: 1, where: [lock.file] });
    for (const site of sites) for (const type of elementTypes(site, pkg, lib.packageElements)) hits.push({ library: lib.id, type, kind: "import", detail: `${site.names.filter((n) => n !== "*" && n !== "default").join(", ") || site.specifier} from ${site.specifier}`, count: 1, where: [at(site)] });
  }

  // Declared, never imported: reported apart, never a verdict.
  const unused: DetectUnused[] = [];
  for (const [pkg, dep] of declared) {
    const lib = libraryOfPackage(pkg);
    if (lib && !usedPackages.has(pkg)) unused.push({ package: pkg, version: dep.version, declaredIn: dep.declaredIn, library: lib.id });
  }

  // shadcn/ui: components.json, its own data-slot names in the code, and imports of its ui kit.
  const notes: string[] = [];
  const paths = new RepoPaths(root);
  const kit = await shadcnKit(root, shadcn, files, paths);
  if (shadcn) signals.push({ library: "shadcn", kind: "components-json", strength: "strong", detail: `${shadcn.file} (style ${shadcn.style}${shadcn.alias ? `, ui at ${shadcn.alias}` : ""})`, count: 1, where: [shadcn.file] });
  if (kit?.found) notes.push(`no components.json; ${kit.found} counts as a shadcn/ui kit: its files use cva or shadcn/ui data-slot names`);
  if (kit) {
    const inKit = (path: string): boolean => kit.dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
    for (const site of imports) {
      // The kit's own imports (a barrel's re-exports, one component using another) are not the app's.
      if (inKit(posix.dirname(site.file))) continue;
      // Without a config alias for it, components.json's own alias still names the kit.
      const resolved = paths.resolve(site.specifier, site.file) ?? (shadcn?.alias && site.specifier.startsWith(`${shadcn.alias}/`) ? `${kit.dirs[0]}/${site.specifier.slice(shadcn.alias.length + 1)}` : null);
      // ESM specifiers name the emitted file: `./ui/button.js` is `ui/button.tsx`.
      const path = resolved?.replace(SOURCE_EXTENSION, "");
      const target = path === undefined ? undefined : kit.dirs.map((dir) => posix.relative(dir, path)).find((rel) => !rel.startsWith("..") && !rel.includes("/"));
      if (target === undefined) continue;
      signals.push({ library: "shadcn", kind: "import", strength: "strong", detail: `imports from the ${kit.label} components`, count: 1, where: [at(site)], samples: [site.specifier] });
      if (target === "" || target === "index") {
        // A barrel: the imported names say which elements came in.
        const names = site.names.filter((n) => n !== "*" && n !== "default");
        for (const type of new Set(names.flatMap((n) => EXPORT_TYPES[n] ?? []))) hits.push({ library: "shadcn", type, kind: "import", detail: `${names.join(", ")} from ${site.specifier}`, count: 1, where: [at(site)] });
      } else {
        const type = SHADCN_FILE_TYPES[target];
        if (type) hits.push({ library: "shadcn", type, kind: "import", detail: `${site.specifier}`, count: 1, where: [at(site)] });
      }
    }
  }
  const own = [...slots].filter(([slot]) => SHADCN_SLOTS.has(slot));
  const foreign = [...slots].filter(([slot]) => !SHADCN_SLOTS.has(slot));
  if (own.length > 0) {
    const count = own.reduce((sum, [, s]) => sum + s.count, 0);
    signals.push({ library: "shadcn", kind: "data-slot", strength: own.length >= 2 ? "strong" : "weak", detail: "shadcn/ui data-slot names in the code", count, where: [...new Set(own.flatMap(([, s]) => s.where))], samples: own.map(([slot]) => slot) });
  }
  if (foreign.length > 0) notes.push(`data-slot values that are not shadcn/ui's were not counted: ${foreign.map(([slot, s]) => `${slot} (${s.count})`).join(", ")}`);
  if (unused.length > 0) notes.push(`${unused.length} UI package${unused.length === 1 ? " is" : "s are"} declared but never imported: listed under unused, not counted`);

  const coverage = `Repo ${name}: ${manifests.length} package.json file${manifests.length === 1 ? "" : "s"}, ${lock.file ?? "no lockfile"}, ${shadcn ? shadcn.file : kit?.found ? `no components.json (${kit.found})` : "no components.json"}, and the imports of ${read} source file${read === 1 ? "" : "s"}. A package counts only when the code imports it; declared but never imported packages are listed apart. Code loaded at runtime from elsewhere (a CDN, another repo) is not seen.`;
  return { name, signals, hits, unused, fonts: fontsOf(imports), notes, coverage };
}

