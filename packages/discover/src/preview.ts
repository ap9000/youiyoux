/**
 * A Discover preview's files: the one candidate a person opened, ready to bundle. Its registry
 * source comes from candidateSource (cache-first: fetched on the first open, never before, and
 * never for a candidate nobody opened), and is written under `<cache>/preview/<key>/` at the
 * paths the registry gives, each checked first: an absolute path, a `..` segment or a symlink
 * anywhere on the way is refused, so a registry cannot make us write outside that directory.
 *
 * Registry items import their siblings as `@/registry/<style>/ui/<name>`. Each such import is
 * pointed at a local copy: the project's own component of that name when it exports everything
 * the import asks for (so the preview is built with what the project already has), else that
 * part's own registry source, fetched the same way, at most MAX_FETCHED_PARTS per preview; a
 * part past the cap or missing from the index is listed as not fetched. Nothing here runs the
 * fetched code: it is only written, read and rewritten as text.
 */
import { lstat, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { sha256, writeFileAtomic } from "@youiyoux/core";
import type { PoliteOptions } from "./http.ts";
import { candidateSource, findListing, type CandidateSource } from "./on-demand.ts";
import { importedPackages, packageName } from "./sources.ts";

export const PREVIEW_DIR = "preview";
/** Registry parts fetched for one preview besides the item itself. */
export const MAX_FETCHED_PARTS = 3;

/** One of the project's own components, by its registry name (`dialog`). */
export interface ProjectPart {
  /** Absolute path. */
  readonly file: string;
  /** Project-relative, for a reader. */
  readonly display: string;
  readonly exports: readonly string[];
}

export interface PreviewOptions extends PoliteOptions {
  /** The project's own component for a registry name, or null when it has none. */
  readonly projectPart?: (name: string) => ProjectPart | null;
  readonly maxParts?: number;
}

/** How one `@/registry/…` part was resolved. */
export interface PreviewPart {
  readonly name: string;
  readonly from: "project" | "fetched" | "not-fetched";
  /** A sentence for a reader. */
  readonly detail: string;
  /** The project's own file it was pointed at (absolute), when `from` is "project": the bundle may import exactly this file. */
  readonly file?: string;
}

export interface PreparedPreview {
  readonly id: string;
  readonly ref: string;
  /** The directory's name under preview/: a digest of the item's URL. */
  readonly key: string;
  readonly dir: string;
  /** The item's main file, relative to `dir`. */
  readonly main: string;
  readonly exports: readonly string[];
  /** Every file written, relative to `dir`. */
  readonly files: readonly string[];
  readonly parts: readonly PreviewPart[];
  /** Bare packages the written files import (react and react-dom aside). */
  readonly packages: readonly string[];
  /** What the item declares. */
  readonly declared: readonly string[];
  /** What its code imports without declaring. */
  readonly implicit: readonly string[];
  readonly cssVars: CandidateSource["cssVars"] | null;
  /** The item's source text, for reading its classes (theme fit). */
  readonly sources: readonly string[];
}

/**
 * A registry file's path, normalised and relative; null when it is absolute, climbs out with
 * `..`, is empty or holds a control character.
 */
export function safeRelative(path: string): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 300 || /[\u0000-\u001f]/.test(path)) return null;
  const slashed = path.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-z]:/i.test(slashed)) return null;
  const parts = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return posix.join(...parts);
}

/** Refuse when anything on the way from `base` to `base/rel` is a symlink (the base included). */
async function assertNoLinks(base: string, rel: string): Promise<void> {
  let at = base;
  for (const part of ["", ...rel.split("/")]) {
    at = part ? join(at, part) : at;
    const info = await lstat(at).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`refused: ${rel} leads through a symlink in the preview cache`);
  }
}

/** Every name a module exports, read from its text (`export function X`, `export { A, B as C }`, `export default`). */
export function exportNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  for (const match of source.matchAll(/\bexport\s+(?!type\b)\{([^}]*)\}(?!\s*from)/g)) {
    for (const item of match[1]!.split(",")) {
      const words = item.trim().split(/\s+/).filter((w) => w !== "type");
      const name = words.length >= 3 && words[1] === "as" ? words[2] : words[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !/^type\s/.test(item.trim())) names.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(source)) names.add("default");
  return [...names];
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;

/** The names an import of `spec` asks for in `source` (`import { A, B as C } from spec`); `*` for a namespace import. */
export function importedNames(source: string, spec: string): string[] {
  const names: string[] = [];
  const escaped = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const match of source.matchAll(new RegExp(`\\bimport\\s+(?:type\\s+)?((?:[\\w$]+\\s*,?\\s*)?(?:\\{[^}]*\\}|\\*\\s*as\\s+[\\w$]+)?)\\s*from\\s*["']${escaped}["']`, "g"))) {
    const clause = match[1]!;
    if (/\*\s+as\s+/.test(clause)) names.push("*");
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const item of braces[1]!.split(",")) {
      const words = item.trim().split(/\s+/).filter((w) => w && w !== "type");
      if (words[0]) names.push(words[0]);
    }
    const head = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+\w+/, "").replace(/,/g, " ").trim();
    if (head && head !== "type") names.push("default");
  }
  return names;
}

/** `@/registry/new-york-v4/ui/dialog` → `dialog`. */
const partName = (spec: string): string => spec.split("/").at(-1)!.replace(/\.(?:tsx?|jsx?)$/, "");

function relativeSpec(fromFile: string, toFile: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile).replace(/\.(?:tsx?|jsx?)$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The item's main file: its first ui or component file, else its first script. */
function mainFile(files: readonly string[], types: ReadonlyMap<string, string | undefined>): string | null {
  return files.find((f) => /registry:(?:ui|component|hook|block)/.test(types.get(f) ?? "") && /\.(?:tsx|jsx|ts|js)$/.test(f)) ?? files.find((f) => /\.(?:tsx|jsx)$/.test(f)) ?? files.find((f) => /\.(?:ts|js)$/.test(f)) ?? null;
}

/**
 * Write one opened candidate's source (and the registry parts it imports) under the preview
 * cache, with `@/registry/…` imports pointed at the local copies. Throws a plain sentence when
 * the item cannot be previewed (not a registry item, no code, an unsafe path).
 */
export async function preparePreview(cacheDir: string, id: string, options: PreviewOptions = {}): Promise<PreparedPreview> {
  const { entry } = await findListing(cacheDir, id);
  if (entry.source.kind !== "shadcn-registry" || !entry.source.ref) throw new Error(`${entry.name} is an npm package, not a registry item: there is no single source file to draw, so it is listed without a preview`);
  const ref = entry.source.ref;
  const registry = ref.slice(0, ref.indexOf("/"));
  const source = await candidateSource(cacheDir, id, options);
  const key = sha256(source.url).slice(0, 16);
  const root = join(cacheDir, PREVIEW_DIR);
  const dir = join(root, key);
  await assertNoLinks(cacheDir, `${PREVIEW_DIR}/${key}`);
  await rm(dir, { recursive: true, force: true });

  const texts = new Map<string, string>();
  const types = new Map<string, string | undefined>();
  const add = (files: CandidateSource["files"], under: string): string[] => {
    const written: string[] = [];
    for (const file of files) {
      if (typeof file.content !== "string") continue;
      const rel = safeRelative(file.path);
      if (rel === null) throw new Error(`refused: the registry gave a file path that leaves the preview directory (${String(file.path).slice(0, 80)})`);
      const at = under ? posix.join(under, rel) : rel;
      texts.set(at, file.content);
      types.set(at, file.type);
      written.push(at);
    }
    return written;
  };
  const own = add(source.files, "");
  const main = mainFile(own, types);
  if (!main) throw new Error(`${ref} has no component code to draw (its registry entry lists no script files)`);

  const parts: PreviewPart[] = [];
  const resolved = new Map<string, string>();
  const max = options.maxParts ?? MAX_FETCHED_PARTS;
  let fetched = 0;
  /** What the fetched parts declare: their packages are the install's too. */
  const partDeps: string[] = [];
  const queue = [...own];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = texts.get(file)!;
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[3]!;
      if (!spec.startsWith("@/registry/") || resolved.has(spec)) continue;
      const local = [...texts.keys()].find((f) => f.replace(/\.(?:tsx?|jsx?)$/, "") === spec.slice(2) || f.replace(/\/index\.(?:tsx?|jsx?)$/, "") === spec.slice(2));
      if (local) {
        resolved.set(spec, local);
        continue;
      }
      const name = partName(spec);
      const wanted = [...new Set([...texts.values()].flatMap((t) => importedNames(t, spec)))];
      const mine = options.projectPart?.(name) ?? null;
      const lacking = mine ? wanted.filter((n) => n !== "*" && !mine.exports.includes(n)) : [];
      if (mine && lacking.length === 0) {
        resolved.set(spec, mine.file);
        parts.push({ name, from: "project", detail: `${name}: your ${mine.display}`, file: mine.file });
        continue;
      }
      const why = mine ? `your ${mine.display} has no ${lacking.join(", ")}` : "your project has none";
      if (fetched >= max) {
        resolved.set(spec, spec);
        parts.push({ name, from: "not-fetched", detail: `${name}: not fetched (${why}; at most ${max} parts are fetched for one preview)` });
        continue;
      }
      const partRef = `${registry}/${name}`;
      try {
        const part = await candidateSource(cacheDir, partRef, options);
        fetched++;
        partDeps.push(...(part.dependencies ?? []));
        const written = add(part.files, `parts/${name}`);
        const partMain = mainFile(written, types);
        if (!partMain) throw new Error("it has no script files");
        resolved.set(spec, partMain);
        queue.push(...written);
        parts.push({ name, from: "fetched", detail: `${name}: the registry's own ${partRef}, fetched (${why})` });
      } catch (error: unknown) {
        resolved.set(spec, spec);
        parts.push({ name, from: "not-fetched", detail: `${name}: could not be fetched (${error instanceof Error ? error.message.split("\n")[0] : String(error)}; ${why})` });
      }
    }
  }

  const rewritten = new Map<string, string>();
  for (const [file, text] of texts) {
    rewritten.set(file, text.replace(SPECIFIER, (all, lead: string, quote: string, spec: string) => {
      const target = resolved.get(spec);
      if (!target || target === spec) return all;
      // A project file by its absolute path; a local copy relative to the importer.
      const next = target.startsWith("/") || /^[a-z]:[\\/]/i.test(target) ? target : relativeSpec(file, target);
      return `${lead}${quote}${next}${quote}`;
    }));
  }
  for (const [file, text] of rewritten) {
    await assertNoLinks(dir, file);
    await writeFileAtomic(join(dir, file), text);
  }

  const packages = [...new Set([...rewritten.values()].flatMap((t) => importedPackages(t)))].filter((p) => !p.startsWith("/")).sort();
  const declared = [...new Set([...(source.dependencies ?? entry.install?.npm ?? []), ...partDeps].map(packageName))].sort();
  const sources = [...rewritten.entries()].filter(([f]) => /\.(?:tsx|jsx|ts|js)$/.test(f)).map(([, t]) => t);
  return {
    id: entry.id,
    ref,
    key,
    dir,
    main,
    exports: exportNames(rewritten.get(main)!),
    files: [...rewritten.keys()],
    parts,
    packages,
    declared,
    implicit: packages.filter((p) => !declared.includes(p)),
    cssVars: source.cssVars ?? null,
    sources,
  };
}
