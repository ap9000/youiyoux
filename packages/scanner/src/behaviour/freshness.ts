/**
 * What a behaviour result is made against (docs/plans/behaviour-rules.md, "Results and rule
 * execution"): the rule and its options, the youiyoux version, the probed origin, screens.json's
 * behaviour config with the route's screen path, the viewport, and the app's source fingerprint.
 * Computed now, both when a probe stores a result and when `youiyoux check` reads one back; a stored
 * result is fresh only when every part it carries equals what is computed now. Nothing in the
 * stored file can say it is fresh.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { BehaviourConsent, findFiles, sha256, stableStringify, type Freshness, type RuleSpec } from "@youiyoux/core";
import type { ContractBinding } from "./in-page.ts";
import type { Project } from "../project.ts";
import type { ScreensSpec } from "../screens/capture.ts";
import { behaviourConsent } from "./guards.ts";

/** Lockfiles, looked for from the project's root up to its repository's top. */
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"];
/** Folders never part of the app's source: installed packages, build output, caches, youiyoux's own. */
const NOT_SOURCE = new Set(["node_modules", ".git", ".youi", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".output", "coverage", ".cache", ".parcel-cache", ".vite"]);
/** A walk without git stops here, and says so in the digest. */
const MAX_WALKED = 20_000;
/** An npm package name, before it is part of a path. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const run = promisify(execFile);
const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** The folders from `root` up to its repository's top (the folder holding .git), or to the filesystem's root. */
async function upToRepoTop(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (let dir = root; ; dir = dirname(dir)) {
    dirs.push(dir);
    if ((await exists(join(dir, ".git"))) || dirname(dir) === dir) return dirs;
  }
}

const notSource = (path: string): boolean => path.split("/").some((segment) => NOT_SOURCE.has(segment));

/**
 * Every source-like file under `root`: in a git repository what git lists (tracked, and untracked
 * that isn't ignored), else a bounded walk; installed packages, build output and caches left out.
 * `incomplete` (git failing in a repository, the walk's cap reached, a folder that can't be read)
 * means the list isn't the whole app, so nothing can be shown fresh against it.
 */
async function sourceFiles(root: string, inRepo: boolean, maxWalked: number): Promise<{ files: string[]; incomplete: string | null }> {
  if (inRepo) {
    try {
      const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
      return { files: [...new Set(stdout.split("\0").filter((f) => f && !notSource(f)))], incomplete: null };
    } catch (error: unknown) {
      return { files: [], incomplete: `git couldn't list the app's files (${(error instanceof Error ? error.message : String(error)).split("\n")[0]})` };
    }
  }
  const files: string[] = [];
  let incomplete: string | null = null;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      incomplete ??= `the folder ${prefix || "."} couldn't be read`;
      return;
    }
    for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      if (incomplete) return;
      if (NOT_SOURCE.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (files.push(path) > maxWalked) incomplete = `the app has more than ${maxWalked} files outside git; add it to git or list what it reads under behaviour.inputs`;
    }
  };
  await walk(root, "");
  return { files, incomplete };
}

/** A file's content digest; a link's target text (the target, if in the project, is listed itself); a file that can't be read makes the fingerprint incomplete. */
async function contentOf(path: string, problems: string[], name: string): Promise<string> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return `link:${sha256(await readlink(path))}`;
    if (!stat.isFile()) return "not-a-file";
    return sha256(await readFile(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    problems.push(`${name} couldn't be read`);
    return "unreadable";
  }
}

/** A behaviour.inputs file's content, through a link only when its real path stays inside the project's real root. */
async function inputContentOf(root: string, file: string, problems: string[]): Promise<string> {
  try {
    const real = await realpath(join(root, file));
    const inside = relative(await realpath(root), real);
    if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
      problems.push(`behaviour.inputs names ${file}, which leads outside the project`);
      return "outside";
    }
    return sha256(await readFile(real));
  } catch {
    problems.push(`behaviour.inputs names ${file}, which couldn't be read`);
    return "unreadable";
  }
}

/** Package managers' install state (transitive versions and integrity): pnpm, npm, yarn. */
const INSTALL_STATE = ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.package-lock.json", "node_modules/.yarn-state.yml", ".yarn/install-state.gz"];

/** What is installed for each direct dependency (its package.json's name, version and integrity), nearest node_modules first. */
async function installed(root: string, dirs: readonly string[]): Promise<string[]> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
  }
  const out: string[] = [];
  for (const name of [...names].sort()) {
    if (!PACKAGE_NAME.test(name)) {
      out.push(`dep ${JSON.stringify(name)}:not-a-package-name`);
      continue;
    }
    let found = "not-installed";
    for (const dir of dirs) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, "node_modules", name, "package.json"), "utf8")) as Record<string, unknown>;
        found = sha256(stableStringify({ name: manifest.name ?? null, version: manifest.version ?? null, integrity: manifest._integrity ?? null, resolved: manifest._resolved ?? null }));
        break;
      } catch {
        // Not here: the next folder up.
      }
    }
    out.push(`dep ${name}:${found}`);
  }
  return out;
}

/** The app's fingerprint, or why it can't be trusted (`incomplete`): then no result can be fresh against it. */
export interface AppFingerprint {
  readonly digest: string;
  readonly incomplete: string | null;
}

/**
 * The app's source fingerprint (any change makes every behaviour result stale): the content of
 *
 * - every source-like file under the project's root (in a git repository, git's tracked and
 *   untracked-not-ignored files; else a walk bounded at `maxWalked`, 20000), and every file the
 *   scan covers, wherever its include globs reach;
 * - package.json, every lockfile, and the package managers' install state (pnpm's
 *   node_modules/.modules.yaml and .pnpm/lock.yaml, npm's node_modules/.package-lock.json, yarn's
 *   node_modules/.yarn-state.yml and .yarn/install-state.gz, which record transitive versions and
 *   integrity) from the project's root up to its repository's top;
 * - each direct dependency's installed package.json (name, version, integrity);
 * - the files screens.json's `behaviour.inputs` globs name (say `.env.development`), through a
 *   link only if it stays inside the project: their content is hashed, never stored or printed.
 *
 * Incomplete, with why, when the file list isn't the whole app (git failing in a repository, the
 * walk's cap, a folder or file that can't be read, an input outside the project). Residuals: hand
 * edits inside node_modules and environment variables set outside files aren't tracked.
 */
export async function appFingerprint(project: Pick<Project, "root" | "config">, options: { readonly inputs?: readonly string[]; readonly maxWalked?: number } = {}): Promise<AppFingerprint> {
  const root = project.root;
  const dirs = await upToRepoTop(root);
  const inRepo = await exists(join(dirs.at(-1)!, ".git"));
  const scanned = await findFiles(root, project.config.include, project.config.exclude);
  const { files: source, incomplete } = await sourceFiles(root, inRepo, options.maxWalked ?? MAX_WALKED);
  const problems: string[] = incomplete ? [incomplete] : [];
  const inputs = options.inputs?.length ? await findFiles(root, options.inputs.filter(safeInput), []) : [];
  const files = [...new Set([...source, ...scanned])].sort();
  const perDir = dirs.flatMap((dir, depth) => [...LOCKFILES, ...INSTALL_STATE].map((name) => ({ name: `(${"../".repeat(depth)}${name})`, path: join(dir, name) })));
  const all = [...files.map((f) => ({ name: f, path: join(root, f) })), { name: "(package.json)", path: join(root, "package.json") }, ...perDir];
  const entries: string[] = [];
  // A few at a time: a large project's files aren't all opened at once.
  for (let i = 0; i < all.length; i += 64) entries.push(...(await Promise.all(all.slice(i, i + 64).map(async ({ name, path }) => `${name}:${await contentOf(path, problems, name)}`))));
  for (const file of inputs) entries.push(`(input ${file}):${await inputContentOf(root, file, problems)}`);
  entries.push(...(await installed(root, dirs)));
  return { digest: sha256(entries.join("\n")).slice(0, 32), incomplete: problems.length ? problems.slice(0, 3).join("; ") : null };
}

/** A `behaviour.inputs` glob stays inside the project: relative, forward slashes, no `..`. */
export const safeInput = (glob: string): boolean => !!glob && !glob.startsWith("/") && !glob.includes("\\") && !/^[A-Za-z]:/.test(glob) && !glob.split("/").includes("..");

/** The contract bindings a probe locates triggers and popups by: every component's a11y.behaviour in the System. */
export const contractBindings = (system: Pick<Project["system"], "components">): ContractBinding[] =>
  system.components.flatMap(({ contract }) => (contract.a11y.behaviour ? [{ component: contract.name, binding: contract.a11y.behaviour }] : []));

/** The digest of the effective contract bindings (sorted by component), part of every result's freshness. */
export const bindingsDigest = (bindings: readonly ContractBinding[]): string => sha256(stableStringify([...bindings].sort((a, b) => a.component.localeCompare(b.component)))).slice(0, 32);

/** A rule's digest: its whole definition (statement, severity, check and options), as loaded. */
export const ruleDigest = (rule: RuleSpec): string => sha256(stableStringify(rule)).slice(0, 32);

/** The digest of screens.json's behaviour config with the route and the path its screen opens. */
export function behaviourConfigDigest(spec: Pick<ScreensSpec, "behaviour" | "screens">, route: string): string {
  const screen = spec.screens.find((s) => s.route === route);
  return sha256(stableStringify({ behaviour: spec.behaviour ?? null, route, path: screen?.path ?? null })).slice(0, 32);
}

/**
 * The routes behaviour rules are held to (the plan's denominator): `behaviour.routes` when set, else
 * every route screens.json lists. `unknown`: routes `behaviour.routes` names that screens.json
 * doesn't list (never probed, so never fresh).
 */
export function behaviourRoutes(spec: Pick<ScreensSpec, "behaviour" | "screens">): { readonly routes: readonly string[]; readonly unknown: readonly string[] } {
  const consent = BehaviourConsent.safeParse(spec.behaviour ?? {});
  const listed = spec.screens.map((s) => s.route);
  const wanted = consent.success && consent.data.routes ? [...new Set(consent.data.routes)] : [...new Set(listed)];
  return { routes: wanted, unknown: wanted.filter((r) => !listed.includes(r)) };
}

/** What a result made now, on `route`, for a rule with `ruleDigest`, would carry. `origin` is null without consent now. */
export interface FreshnessNow {
  readonly tool: string;
  /** bindingsDigest of the contract bindings in the System now. */
  readonly bindings: string;
  readonly origin: string | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly app: string;
}

export function freshnessNow(spec: Pick<ScreensSpec, "base" | "behaviour" | "viewport">, app: string, tool: string, bindings: string): FreshnessNow {
  const consent = behaviourConsent(spec);
  return { tool, bindings, origin: consent.ok ? consent.origin : null, viewport: { width: spec.viewport.width, height: spec.viewport.height }, app };
}

/**
 * Why a stored result (its freshness key, route and viewport) isn't fresh now, in words; empty when
 * every part matches.
 */
export function staleParts(stored: { readonly freshness: Freshness; readonly viewport: { readonly width: number; readonly height: number } }, now: FreshnessNow & { readonly rule: string; readonly config: string }): string[] {
  const parts: string[] = [];
  if (stored.freshness.app !== now.app) parts.push("the code changed");
  if (stored.freshness.rule !== now.rule) parts.push("the rule changed");
  if (stored.freshness.tool !== now.tool) parts.push("youiyoux changed");
  if (stored.freshness.bindings !== now.bindings) parts.push("the components' behaviour bindings changed");
  if (stored.freshness.origin !== now.origin) parts.push(now.origin === null ? "probing isn't switched on now" : "the app's address changed");
  if (stored.freshness.config !== now.config) parts.push("screens.json's behaviour settings or the screen's path changed");
  if (stored.viewport.width !== now.viewport.width || stored.viewport.height !== now.viewport.height) parts.push("the viewport changed");
  return parts;
}
