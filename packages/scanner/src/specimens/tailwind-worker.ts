/**
 * One Tailwind v4 entry compiled the way `@tailwindcss/vite` does it, in a worker so css.ts can
 * stop it after a timeout: `@tailwindcss/node` compile, candidates from the oxide Scanner over
 * its sources, then optimize, all from the project's own installed packages. Fenced to the
 * project root (contain.ts): an `@import` that leaves the root becomes an empty sheet, an
 * `@plugin`/`@config` that does fails the compile, an `@source` outside it is not scanned,
 * symlinks that leave it are skipped, and a stylesheet read from outside anyway fails the build.
 * Posts one message: { css, dependencies, warnings } or { error, … }.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { inPackage, packageName, packageUnderRoot, within } from "./contain.ts";

interface Input {
  readonly root: string;
  readonly from: string;
  readonly node: string;
  readonly oxide: string;
  /** Project-relative symlinks that leave the root. */
  readonly exclude: readonly string[];
  /** Directories outside the root scanned for class names too (a Discover preview's files). */
  readonly extraSources?: readonly string[];
}
type Source = { base: string; pattern: string; negated: boolean };
interface TailwindNode {
  compile(css: string, options: { base: string; from?: string; onDependency: (path: string) => void; shouldRewriteUrls?: boolean; customCssResolver?: Resolver; customJsResolver?: Resolver }): Promise<{ root: "none" | { base: string; pattern: string } | null; sources: Source[]; build(candidates: string[]): string }>;
  optimize(css: string, options?: { file?: string; minify?: boolean }): { code: string };
}
type Resolver = (id: string, base: string) => Promise<string | false | undefined>;

const { root, from, node: nodePath, oxide: oxidePath, exclude, extraSources = [] } = workerData as Input;
const require = createRequire(import.meta.url);
const warnings: string[] = [];
const dependencies: string[] = [];
const escaped: string[] = [];

/** Why Tailwind may not load `id` from `base`, or null when it may (Tailwind's own resolver then finds it). */
function refusal(id: string, base: string): string | null {
  // An installed package loading its own files or its dependencies.
  if (inPackage(base) && !within(root, base)) return null;
  const name = packageName(id);
  if (name) return packageUnderRoot(root, id) ? null : `"${id}" is not a package in the project's node_modules`;
  const target = isAbsolute(id) ? id : resolve(base, id);
  return within(root, target) || within(root, `${target}.css`) ? null : `"${id}" is outside the project root`;
}

const cssResolver: Resolver = async (id, base) => {
  const reason = refusal(id, base);
  if (reason === null) return undefined;
  warnings.push(`refused @import ${reason}`);
  return devNull;
};
const jsResolver: Resolver = async (id, base) => {
  const reason = refusal(id, base);
  if (reason === null) return undefined;
  throw new Error(`refused @plugin/@config ${reason}`);
};

const insideSource = (source: { base: string; pattern: string }): boolean => within(root, source.base) && !source.pattern.split("/").includes("..");

async function run(): Promise<{ css: string } | { error: string }> {
  const tailwind = require(nodePath) as TailwindNode;
  const oxide = require(oxidePath) as { Scanner: new (options: { sources: Source[] }) => { scan(): string[] } };
  const css = readFileSync(from, "utf8");
  const compiler = await tailwind.compile(css, {
    base: dirname(from),
    from,
    shouldRewriteUrls: true,
    customCssResolver: cssResolver,
    customJsResolver: jsResolver,
    onDependency: (path) => {
      if (path === devNull) return;
      dependencies.push(path);
      if (!within(root, path) && !inPackage(path)) escaped.push(path);
    },
  });
  if (escaped.length > 0) return { error: `read ${escaped.length} file(s) outside the project root: refused` };
  // As @tailwindcss/vite does: the project root unless the sheet names its own source root.
  const declared = (compiler.root === "none" ? [] : compiler.root === null ? [{ base: root, pattern: "**/*", negated: false }] : [{ ...compiler.root, negated: false }]).concat(compiler.sources);
  const sources = declared.filter((source) => {
    if (source.negated || insideSource(source)) return true;
    warnings.push(`refused @source "${relative(root, source.base)}/${source.pattern}": outside the project root, not scanned`);
    return false;
  });
  for (const link of exclude) sources.push({ base: root, pattern: link, negated: true }, { base: root, pattern: `${link}/**`, negated: true });
  // Scanned for class names only, as the caller asked: their files are never imported.
  for (const base of extraSources) sources.push({ base, pattern: "**/*", negated: false });
  const candidates = new oxide.Scanner({ sources }).scan();
  return { css: tailwind.optimize(compiler.build(candidates), { file: from, minify: false }).code };
}

run().then(
  (result) => parentPort!.postMessage({ ...result, dependencies, warnings }),
  (error: unknown) => parentPort!.postMessage({ error: String((error as Error)?.message ?? error).split("\n")[0], dependencies, warnings }),
);
