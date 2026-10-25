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
 * part past the cap or missing from the index is listed as not fetched. Registries outside
 * shadcn's own name their parts their own ways, and those are followed too: a file is found where
 * it is installed (its `target`) as well as where its registry keeps it; a part the item declares
 * by URL (on its own site only), as `@registry/name` (its own registry only) or by a bare name
 * (shadcn's) is fetched when an import needs it, by name or, failing that, by what it installs;
 * an undeclared one is its own registry's of that name, else shadcn's. Nothing here runs the
 * fetched code: it is only written, read and rewritten as text.
 *
 * A component is drawn from its registry's own demo when it has one (findDemo): the demo is what
 * its authors wrote to show it working, with the props, data and neighbours it needs. Demos are
 * not listings; they are found by the names registries give them (`<name>-demo` on shadcn, Magic
 * UI and Aceternity, or `<name>-demo-1`; `p-<name>-1` on coss), and one is used only when it builds
 * on the component.
 */
import { lstat, readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { sha256, writeFileAtomic } from "@youiyoux/core";
import type { PoliteOptions } from "./http.ts";
import { candidateSource, findListing, registryItemAt, registryItemSource, type CandidateSource } from "./on-demand.ts";
import { importedPackages, packageName } from "./sources.ts";

export const PREVIEW_DIR = "preview";
/** Registry parts fetched for one preview besides the item itself. */
export const MAX_FETCHED_PARTS = 3;
/** The same for a block: a page is built from many parts (a sidebar, a card, a separator…). */
export const MAX_BLOCK_PARTS = 24;
/** The same for a component drawn from its demo: a demo shows it among a few others (a card with a label and an input). */
export const MAX_DEMO_PARTS = 8;
/** Where what was learnt about each component's demo is kept: its name, or that it has none. */
export const DEMOS_DIR = "demos";
/** A component found to have no demo is asked about again after this long. */
export const DEMO_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** Whether it is a block (a page, a chart card): drawn full width at a page's size rather than shrink-wrapped as a component. */
  readonly page: boolean;
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
  /** The registry's own demo it is drawn from (`@magicui/animated-beam-demo`), or null when it has none. */
  readonly demo: string | null;
}

/** The names registries give a component's demo, in the order they are tried. */
export function demoNames(name: string): string[] {
  return [`${name}-demo`, `${name}-demo-1`, `p-${name}-1`];
}

/** Whether a registry item builds on the component `name`: it lists it among its registry dependencies, or imports it. */
export function buildsOn(source: Pick<CandidateSource, "files" | "registryDependencies">, name: string): boolean {
  const last = (spec: string): string => (spec.split(/[?#]/)[0] ?? "").replace(/\/+$/, "").split("/").at(-1)!.replace(/\.json$/, "");
  if ((source.registryDependencies ?? []).some((dep) => last(dep) === name)) return true;
  return source.files.some((file) => typeof file.content === "string" && [...file.content.matchAll(SPECIFIER)].some((m) => m[3]!.startsWith("@/") && last(m[3]!) === name));
}

/**
 * The registry's own demo of the component `registry/name`, fetched (cache-first) by the names
 * demos are given, and kept only when it builds on the component. What was learnt is recorded
 * under demos/, a demo or that there is none, so a second open asks nothing; "none" is asked
 * again after DEMO_RECHECK_MS. A registry that cannot be reached is not recorded.
 */
export async function findDemo(cacheDir: string, registry: string, name: string, options: PoliteOptions = {}): Promise<{ name: string; source: CandidateSource } | null> {
  const record = join(cacheDir, DEMOS_DIR, `${sha256(`${registry}/${name}`).slice(0, 32)}.json`);
  const now = (options.now?.() ?? new Date()).getTime();
  const known = JSON.parse(await readFile(record, "utf8").catch(() => "null")) as { demo: string | null; checkedAt: string } | null;
  const fresh = known !== null && (known.demo !== null || now - Date.parse(known.checkedAt) < DEMO_RECHECK_MS);
  for (const candidate of fresh ? (known?.demo ? [known.demo] : []) : demoNames(name)) {
    let source: CandidateSource | "missing";
    try {
      source = await registryItemSource(cacheDir, registry, candidate, options);
    } catch {
      // Not reached, or not a registry item: drawn without a demo this time, and asked again next time.
      return null;
    }
    if (source === "missing" || !buildsOn(source, name)) continue;
    await assertNoLinks(cacheDir, `${DEMOS_DIR}/${record.slice(record.lastIndexOf("/") + 1)}`);
    if (known?.demo !== candidate) await writeFileAtomic(record, `${JSON.stringify({ demo: candidate, checkedAt: new Date(now).toISOString() })}\n`);
    return { name: candidate, source };
  }
  if (!fresh) {
    await assertNoLinks(cacheDir, `${DEMOS_DIR}/${record.slice(record.lastIndexOf("/") + 1)}`);
    await writeFileAtomic(record, `${JSON.stringify({ demo: null, checkedAt: new Date(now).toISOString() })}\n`);
  }
  return null;
}

/** A demo's own file to draw: the one named after it, else its first file that is not the component's. */
function demoMain(files: readonly string[], demo: string, component: readonly string[]): string | null {
  const base = (f: string): string => posix.basename(f).replace(/\.(?:tsx?|jsx?)$/, "");
  const code = files.filter((f) => /\.(?:tsx|jsx)$/.test(f));
  return code.find((f) => base(f) === demo) ?? code.find((f) => !component.includes(f)) ?? null;
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
/** shadcn's own path for one of its components (`@/components/ui/button`), which items of other registries import without declaring it. */
const SHADCN_UI = /^@\/components\/ui\/[a-z0-9][a-z0-9-]*$/;
/** A registry's own copy of shadcn's utils (`@/registry/default/lib/utils`): it stands for `cn`. */
const REGISTRY_UTILS = /^@\/registry\/.*\/lib\/utils$/;

function relativeSpec(fromFile: string, toFile: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile).replace(/\.(?:tsx?|jsx?)$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Script extensions an import may leave off, or write as `.js` for a `.ts` file (TypeScript's ESM style). */
const SCRIPT = /\.(?:tsx?|jsx?|mjs|cjs)$/;
/** shadcn's target aliases (`@ui/spinner.tsx`, `@components/blocks/x.tsx`), as the paths `@/` imports name. */
const TARGET_ALIASES: ReadonlyArray<readonly [string, string]> = [["@ui/", "components/ui/"], ["@components/", "components/"], ["@lib/", "lib/"], ["@hooks/", "hooks/"], ["~/", ""], ["@/", ""]];

/**
 * The module paths a written file answers to, without extension: where the registry keeps it
 * (`registry/pagination`) and where it is installed (`components/shadcn-space/blocks/x`, its
 * `target`), each with a leading `src/` and a trailing `/index` taken off too. An `@/x/y` import
 * names `x/y`; nothing here is written, so a target only needs to be a safe relative path.
 */
function modulePaths(path: string, target: string | undefined): string[] {
  const keys: string[] = [];
  const from = (value: string | null): void => {
    if (!value) return;
    const bare = value.replace(SCRIPT, "");
    for (const key of [bare, bare.replace(/\/index$/, "")]) for (const k of [key, key.replace(/^src\//, "")]) if (k && !keys.includes(k)) keys.push(k);
  };
  from(path);
  from(installedAt(target));
  return keys;
}

/** Whether two registry URLs are one site's: the same host, `www.` or not (`atelier-ui.com` names its parts without it). */
function sameSite(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  const host = (url: string): string => new URL(url).host.toLowerCase().replace(/^www\./, "");
  return host(a) === host(b);
}

/** A listing that is a demo itself (`@spaceui/demo-p-popover-01`, `button-demo`): drawn with a demo's parts. */
const DEMO_NAME = /(?:^|-)demo(?:-|$)/;

/** How many registry parts one preview may fetch: a block's page most, a demo (drawn from one, or one itself) more than a lone component. */
export function partLimit(kind: string, name: string, drawnFromDemo: boolean): number {
  return kind === "pattern" ? MAX_BLOCK_PARTS : drawnFromDemo || DEMO_NAME.test(name) ? MAX_DEMO_PARTS : MAX_FETCHED_PARTS;
}

/** Where a file is installed (its `target`, aliases spelled out), when that is a safe relative path. */
function installedAt(target: string | undefined): string | null {
  if (typeof target !== "string") return null;
  const alias = TARGET_ALIASES.find(([lead]) => target.startsWith(lead));
  return safeRelative(alias ? `${alias[1]}${target.slice(alias[0].length)}` : target);
}

/** A declared part's own name: `@hairline/number-roll`, `https://x.dev/r/number-roll.json?as=dependency` and `number-roll` are all `number-roll`. */
function depName(dep: string): string {
  const path = /^https:\/\//.test(dep) ? (URL.canParse(dep) ? new URL(dep).pathname : dep) : dep;
  return path.split("/").at(-1)!.replace(/\.json$/, "");
}

/** The item's main file: its first ui or component file, else its first script. */
function mainFile(files: readonly string[], types: ReadonlyMap<string, string | undefined>): string | null {
  // A block's page puts its parts together (a sidebar inside its provider), so it is what to draw.
  return files.find((f) => types.get(f) === "registry:page" && /\.(?:tsx|jsx)$/.test(f)) ?? files.find((f) => /registry:(?:ui|component|hook|block)/.test(types.get(f) ?? "") && /\.(?:tsx|jsx|ts|js)$/.test(f)) ?? files.find((f) => /\.(?:tsx|jsx)$/.test(f)) ?? files.find((f) => /\.(?:ts|js)$/.test(f)) ?? null;
}

/**
 * Write one opened candidate's source (and the registry parts it imports) under the preview
 * cache, with `@/registry/…` imports pointed at the local copies: a part the project has is its
 * own, else the registry's, and `@/components/ui/<name>` (imported undeclared) is shadcn's; a
 * registry's own `lib/utils` becomes `cn`, which the bundler supplies. Throws a plain sentence when
 * the item cannot be previewed (not a registry item, no code, an unsafe path).
 */
export async function preparePreview(cacheDir: string, id: string, options: PreviewOptions = {}): Promise<PreparedPreview> {
  const { entry } = await findListing(cacheDir, id);
  if (entry.source.kind !== "shadcn-registry" || !entry.source.ref) throw new Error(`${entry.name} is an npm package, not a registry item: there is no single source file to draw, so it is listed without a preview`);
  const ref = entry.source.ref;
  const registry = ref.slice(0, ref.indexOf("/"));
  const source = await candidateSource(cacheDir, id, options);
  // A component is drawn from its registry's own demo when there is one; a block is a page already.
  const demo = entry.kind === "pattern" ? null : await findDemo(cacheDir, registry, ref.slice(registry.length + 1), options);
  const key = sha256(demo ? `${source.url}\n${demo.source.url}` : source.url).slice(0, 16);
  const root = join(cacheDir, PREVIEW_DIR);
  const dir = join(root, key);
  await assertNoLinks(cacheDir, `${PREVIEW_DIR}/${key}`);
  await rm(dir, { recursive: true, force: true });

  const texts = new Map<string, string>();
  const types = new Map<string, string | undefined>();
  /** Each module path a written file answers to (modulePaths); the first file to claim one keeps it. */
  const modules = new Map<string, string>();
  /** The URL of the item each written file came from: a part it names by URL must be on that host. */
  const urlOf = new Map<string, string>();
  /** Where each written file is installed, when its registry says: its relative imports are written from there. */
  const installed = new Map<string, string>();
  const add = (files: CandidateSource["files"], under: string, url: string): string[] => {
    const written: string[] = [];
    for (const file of files) {
      if (typeof file.content !== "string") continue;
      const rel = safeRelative(file.path);
      if (rel === null) throw new Error(`refused: the registry gave a file path that leaves the preview directory (${String(file.path).slice(0, 80)})`);
      const at = under ? posix.join(under, rel) : rel;
      // A part's file already written from elsewhere (a shared helper): the first copy stands.
      if (texts.has(at)) continue;
      texts.set(at, file.content);
      types.set(at, file.type);
      urlOf.set(at, url);
      const target = installedAt(file.target);
      if (target) installed.set(at, target);
      for (const key of modulePaths(at, file.target)) if (!modules.has(key)) modules.set(key, at);
      for (const key of modulePaths(rel, file.target)) if (!modules.has(key)) modules.set(key, at);
      written.push(at);
    }
    return written;
  };
  const own = add(source.files, "", source.url);
  // The demo's files beside the component's, so its imports of the component resolve to this copy.
  const shown = demo ? add(demo.source.files, "", demo.source.url).filter((f) => !own.includes(f)) : [];
  const main = demo ? demoMain([...shown, ...own], demo.name, own) : mainFile(own, types);
  if (!main) throw new Error(`${ref} has no component code to draw (its registry entry lists no script files)`);

  const parts: PreviewPart[] = [];
  const resolved = new Map<string, string>();
  /** A relative import that resolves somewhere other than beside its importer, by `<importer>\0<spec>`. */
  const relative = new Map<string, string>();
  const max = options.maxParts ?? partLimit(entry.kind, entry.name, demo !== null);
  let fetched = 0;
  /** What the fetched parts declare: their packages are the install's too. */
  const partDeps: string[] = [];
  const queue = [...own, ...shown];
  /** The registry each part's files came from: a shadcn part's own `@/registry/…` imports are shadcn's. */
  const registryOf = new Map<string, string>();
  /** Every part the item and what it fetched declare (`@reg/name`, a URL, or a bare name, which is shadcn's). */
  const declaredParts: string[] = [...(source.registryDependencies ?? []), ...(demo?.source.registryDependencies ?? [])];
  const asked = new Set<string>();
  /** A part not fetched, said once however many files import it. */
  const notFetched = (name: string, detail: string): void => {
    if (!parts.some((p) => p.name === name && p.from === "not-fetched")) parts.push({ name, from: "not-fetched", detail });
  };
  const moduleOf = (path: string): string | undefined => modules.get(path.replace(SCRIPT, "")) ?? modules.get(path.replace(SCRIPT, "").replace(/\/index$/, ""));

  /**
   * Fetch one declared part, as the item names it, and write its files where the registry keeps
   * them (a relative import between parts then resolves as written), or under `under` for a
   * sibling the item imports by its registry path (kept apart from the item's own files). Only its own registry's
   * parts (by name, or by URL on the host it came from) and shadcn's (a bare name). Null when it is
   * not one of those, past the limit, or cannot be had.
   */
  const fetchDeclared = async (dep: string, from: string, fromUrl: string, why: string, under = ""): Promise<string[] | null> => {
    if (asked.has(dep)) return null;
    asked.add(dep);
    const name = depName(dep);
    let partRef: string;
    let load: () => Promise<CandidateSource | "missing">;
    if (/^https:\/\//.test(dep)) {
      if (!sameSite(dep, fromUrl)) return null;
      partRef = `${from}/${name}`;
      load = () => registryItemAt(cacheDir, dep, name, options);
    } else if (dep.startsWith("@")) {
      if (dep.slice(0, dep.indexOf("/")) !== from) return null;
      partRef = dep;
      load = () => registryItemSource(cacheDir, from, name, options);
    } else {
      partRef = `@shadcn/${name}`;
      load = () => registryItemSource(cacheDir, "@shadcn", name, options);
    }
    if (fetched >= max) {
      notFetched(name, `${name}: not fetched (${why}; at most ${max} parts are fetched for one preview)`);
      return null;
    }
    try {
      const part = await load();
      if (part === "missing") throw new Error(`${partRef} is not in its registry`);
      fetched++;
      partDeps.push(...(part.dependencies ?? []));
      declaredParts.push(...(part.registryDependencies ?? []));
      const written = add(part.files, under, part.url);
      const partRegistry = partRef.slice(0, partRef.indexOf("/"));
      for (const at of written) registryOf.set(at, partRegistry);
      queue.push(...written);
      parts.push({ name, from: "fetched", detail: `${name}: the registry's own ${partRef}, fetched (${why})` });
      return written;
    } catch (error: unknown) {
      notFetched(name, `${name}: could not be fetched (${error instanceof Error ? error.message.split("\n")[0] : String(error)}; ${why})`);
      return null;
    }
  };

  /**
   * A module an import names that no written file answers to yet: the declared part of that name,
   * else (an import named for a file, not its part: `@/lib/motion-tokens` in `@nusaiba/foundation`)
   * each declared part of the same registry in turn until one brings it. The file it is, or null.
   */
  const findDeclared = async (path: string, file: string, why: string): Promise<string | null> => {
    const from = registryOf.get(file) ?? registry;
    const fromUrl = urlOf.get(file) ?? source.url;
    const name = path.replace(SCRIPT, "").replace(/\/index$/, "").split("/").at(-1)!;
    for (const dep of declaredParts.filter((d) => depName(d) === name)) {
      await fetchDeclared(dep, from, fromUrl, why);
      const found = moduleOf(path);
      if (found) return found;
    }
    for (const dep of declaredParts.filter((d) => !asked.has(d) && (d.startsWith(`${from}/`) || (/^https:\/\//.test(d) && sameSite(d, fromUrl))))) {
      await fetchDeclared(dep, from, fromUrl, why);
      const found = moduleOf(path);
      if (found) return found;
    }
    return null;
  };

  while (queue.length > 0) {
    const file = queue.shift()!;
    const from = registryOf.get(file) ?? registry;
    const text = texts.get(file)!;
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[3]!;
      // A relative import: beside its importer when written so, else wherever that module was written.
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const path = posix.normalize(posix.join(posix.dirname(file), spec));
        if (path.startsWith("..") || relative.has(`${file}\0${spec}`)) continue;
        const beside = [...texts.keys()].some((f) => f.replace(SCRIPT, "") === path.replace(SCRIPT, "") || f.replace(SCRIPT, "") === `${path.replace(SCRIPT, "")}/index`);
        if (beside) continue;
        // Written from where the file is installed (`components/wxcn/`), not where its registry keeps it.
        const target = installed.get(file);
        const fromTarget = target ? posix.normalize(posix.join(posix.dirname(target), spec)) : null;
        const found = moduleOf(path) ?? (fromTarget && !fromTarget.startsWith("..") ? moduleOf(fromTarget) : undefined) ?? (await findDeclared(path, file, "it is imported beside the item"));
        if (found && found.replace(SCRIPT, "") !== path.replace(SCRIPT, "")) relative.set(`${file}\0${spec}`, found);
        continue;
      }
      if (!spec.startsWith("@/") || resolved.has(spec)) continue;
      // The bundler supplies cn: the project's own, else shadcn's.
      if (REGISTRY_UTILS.test(spec)) {
        resolved.set(spec, "cn");
        continue;
      }
      const shadcnUi = SHADCN_UI.test(spec);
      const sibling = spec.startsWith("@/registry/");
      // Written already: the item's own file, or a part's, where it is kept or installed.
      const local = moduleOf(spec.slice(2));
      if (local) {
        resolved.set(spec, local);
        continue;
      }
      if (!sibling && !shadcnUi) {
        // Any other `@/` module (`@/lib/utils`, `@/hooks/use-x`) is the project's, unless the item declares a part that brings it.
        if (/^@\/lib\/utils(?:\.[jt]sx?)?$/.test(spec)) continue;
        const found = await findDeclared(spec.slice(2), file, "your project has none");
        if (found) resolved.set(spec, found);
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
      // A part the item declares by name (by URL, `@reg/name`, or bare for shadcn's), where its registry keeps it.
      const named = declaredParts.find((d) => depName(d) === name && !asked.has(d));
      if (named) {
        const written = await fetchDeclared(named, from, urlOf.get(file) ?? source.url, why, `parts/${name}`);
        const found = written ? (moduleOf(spec.slice(2)) ?? mainFile(written, types)) : null;
        if (found) {
          resolved.set(spec, found);
          continue;
        }
      }
      // A part of its own registry that brings it under another name (`primitives-popover` installs `components/ui/popover`).
      const brought = await findDeclared(spec.slice(2), file, why);
      if (brought) {
        resolved.set(spec, brought);
        continue;
      }
      if (fetched >= max) {
        resolved.set(spec, spec);
        notFetched(name, `${name}: not fetched (${why}; at most ${max} parts are fetched for one preview)`);
        continue;
      }
      // Undeclared: its own registry's part of that name, else shadcn's (`@/components/ui/<name>` is shadcn's first).
      const tries = shadcnUi || from === "@shadcn" ? ["@shadcn"] : [from, "@shadcn"];
      let done = false;
      let last = "";
      for (const reg of tries) {
        const partRef = `${reg}/${name}`;
        try {
          const part = await registryItemSource(cacheDir, reg, name, options);
          if (part === "missing") throw new Error(`${partRef} is not in its registry`);
          fetched++;
          partDeps.push(...(part.dependencies ?? []));
          declaredParts.push(...(part.registryDependencies ?? []));
          const written = add(part.files, `parts/${name}`, part.url);
          const partMain = mainFile(written, types);
          if (!partMain) throw new Error("it has no script files");
          resolved.set(spec, partMain);
          for (const at of written) registryOf.set(at, reg);
          queue.push(...written);
          parts.push({ name, from: "fetched", detail: `${name}: the registry's own ${partRef}, fetched (${why})` });
          done = true;
          break;
        } catch (error: unknown) {
          last = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        }
      }
      if (!done) {
        resolved.set(spec, spec);
        notFetched(name, `${name}: could not be fetched (${last}; ${why})`);
      }
    }
  }

  const rewritten = new Map<string, string>();
  for (const [file, text] of texts) {
    rewritten.set(file, text.replace(SPECIFIER, (all, lead: string, quote: string, spec: string) => {
      const target = resolved.get(spec) ?? relative.get(`${file}\0${spec}`);
      if (!target || target === spec) return all;
      if (target === "cn") return `${lead}${quote}cn${quote}`;
      // A project file by its absolute path; a local copy relative to the importer.
      const next = target.startsWith("/") || /^[a-z]:[\\/]/i.test(target) ? target : relativeSpec(file, target);
      return `${lead}${quote}${next}${quote}`;
    }));
  }
  for (const [file, text] of rewritten) {
    await assertNoLinks(dir, file);
    await writeFileAtomic(join(dir, file), text);
  }

  const packages = [...new Set([...rewritten.values()].flatMap((t) => importedPackages(t)))].sort();
  const declared = [...new Set([...(source.dependencies ?? entry.install?.npm ?? []), ...(demo?.source.dependencies ?? []), ...partDeps].map(packageName))].sort();
  const sources = [...rewritten.entries()].filter(([f]) => /\.(?:tsx|jsx|ts|js)$/.test(f)).map(([, t]) => t);
  return {
    id: entry.id,
    ref,
    key,
    dir,
    main,
    page: entry.kind === "pattern",
    exports: exportNames(rewritten.get(main)!),
    files: [...rewritten.keys()],
    parts,
    packages,
    declared,
    implicit: packages.filter((p) => !declared.includes(p)),
    cssVars: source.cssVars ?? null,
    sources,
    demo: demo ? `${registry}/${demo.name}` : null,
  };
}
