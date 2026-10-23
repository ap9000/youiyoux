/**
 * Where a project's design system comes from: its config's `source` (a folder, an installed
 * package, or a git repository), unless the person has linked the project to a checkout of their
 * own (`youiyoux link`), which lives outside the repo and is never committed.
 *
 * A git source is fetched into a cache (one tree per commit, never written after it is made) and
 * used offline from then on: at the commit the product's lockfile records, else at the commit the
 * ref last resolved to. `youiyoux sync` resolves the ref again (`refresh`), the way an update
 * moves a lockfile; every other command keeps to what is recorded.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expandGitSource, readTextOrNull, writeFileAtomic, type ProjectConfig } from "@youiyoux/core";

const run = promisify(execFile);
const LOCK_FILE = "youi.lock.json";
const COMMIT = /^[0-9a-f]{40}$/;

export interface DesignSourceOptions {
  /** Resolve a git ref again, fetching first (youiyoux sync); otherwise what is recorded is used. */
  readonly refresh?: boolean;
  /** The cache for fetched systems; default YOUI_SYSTEMS_CACHE, else $XDG_CACHE_HOME/youiyoux/systems. */
  readonly cacheDir?: string;
}

export interface DesignLocation {
  readonly root: string;
  /** The commit a git source is at; null for a folder or a package. */
  readonly commit: string | null;
}

export const systemsCacheDir = (): string => process.env.YOUI_SYSTEMS_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "youiyoux/systems");

/**
 * The design repo a config's `source` names: a `path` beside the config file; a `package` installed
 * for the product (its node_modules, then each parent's, as Node finds packages; a workspace link
 * is followed to the package's own folder); or a `git` repository at `ref`.
 */
export async function designRootOf(source: ProjectConfig["source"], configFile: string, productRoot: string, options: DesignSourceOptions = {}): Promise<string> {
  return (await locateDesign(source, configFile, productRoot, options)).root;
}

export async function locateDesign(source: ProjectConfig["source"], configFile: string, productRoot: string, options: DesignSourceOptions = {}): Promise<DesignLocation> {
  if ("path" in source) return { root: resolve(dirname(configFile), source.path), commit: null };
  if ("package" in source) {
    for (let dir = resolve(productRoot); ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", ...source.package.split("/"));
      if (await isDirectory(candidate)) return { root: await realpath(candidate), commit: null };
      if (dirname(dir) === dir) break;
    }
    throw new Error(`the design system package ${source.package} is not installed for ${productRoot} (config ${configFile}): add it as a dependency and install, or set source.path to its checkout`);
  }
  return gitCheckout(source.git, source.ref, { ...options, locked: await lockedCommit(productRoot) });
}

/** The design commit the product's lockfile records, if it has one. */
async function lockedCommit(productRoot: string): Promise<string | null> {
  try {
    const commit = (JSON.parse((await readTextOrNull(join(productRoot, LOCK_FILE))) ?? "{}") as { sourceCommit?: unknown }).sourceCommit;
    return typeof commit === "string" && COMMIT.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * A git repository's tree at a commit, from the cache, fetching only when that commit (or, with no
 * commit recorded, the ref) is not there yet. Only https, ssh and file transports run, and git
 * never prompts: a repository that needs a password fails with git's own message.
 */
export async function gitCheckout(url: string, ref: string, options: DesignSourceOptions & { locked?: string | null } = {}): Promise<DesignLocation> {
  const remote = expandGitSource(url);
  const base = join(options.cacheDir ?? systemsCacheDir(), createHash("sha256").update(remote).digest("hex").slice(0, 16));
  const bare = join(base, "repo.git");
  const refs = join(base, "refs.json");
  const recorded = options.refresh ? null : COMMIT.test(ref) ? ref : (options.locked ?? (await readRefs(refs))[ref] ?? null);
  if (recorded !== null && (await isDirectory(join(base, recorded)))) return { root: join(base, recorded), commit: recorded };

  if (recorded === null || !(await hasCommit(bare, recorded))) await fetchAll(bare, remote);
  let commit = recorded;
  if (commit === null) {
    commit = await revParse(bare, ref);
    if (commit === null) throw new Error(`${url} has no branch, tag or commit "${ref}"`);
    await writeFileAtomic(refs, `${JSON.stringify({ ...(await readRefs(refs)), [ref]: commit }, null, 2)}\n`);
  } else if (!(await hasCommit(bare, commit))) {
    throw new Error(`${url} has no commit ${commit}, which youi.lock.json records: run youiyoux sync to resolve "${ref}" again`);
  }
  const tree = join(base, commit);
  if (!(await isDirectory(tree))) await extract(bare, commit, tree);
  return { root: tree, commit };
}

const GIT_ENV = { ...process.env, GIT_ALLOW_PROTOCOL: "https:ssh:file", GIT_TERMINAL_PROMPT: "0" };
const git = (args: readonly string[]) => run("git", args as string[], { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });

async function fetchAll(bare: string, remote: string): Promise<void> {
  if (!(await isDirectory(bare))) {
    await mkdir(dirname(bare), { recursive: true });
    await git(["init", "--quiet", "--bare", bare]);
  }
  try {
    await git(["--git-dir", bare, "fetch", "--quiet", "--force", "--prune", "--tags", "--", remote, "+refs/heads/*:refs/heads/*"]);
  } catch (error: unknown) {
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n").pop() ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`could not fetch the design system from ${remote}: ${detail}`);
  }
}

async function revParse(bare: string, ref: string): Promise<string | null> {
  for (const name of [`refs/tags/${ref}`, `refs/heads/${ref}`, ref]) {
    const commit = await git(["--git-dir", bare, "rev-parse", "--verify", "--quiet", `${name}^{commit}`]).then((r) => r.stdout.trim(), () => "");
    if (COMMIT.test(commit)) return commit;
  }
  return null;
}

const hasCommit = (bare: string, commit: string): Promise<boolean> => git(["--git-dir", bare, "cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);

/** The commit's files into `tree`, made beside it and renamed, so a reader never sees half of it. */
async function extract(bare: string, commit: string, tree: string): Promise<void> {
  const temp = await mkdtemp(`${tree}.`);
  try {
    await git(["--git-dir", bare, "archive", "--format=tar", "-o", join(temp, ".tree.tar"), commit]);
    await run("tar", ["-xf", join(temp, ".tree.tar"), "-C", temp]);
    await rm(join(temp, ".tree.tar"));
    await rename(temp, tree).catch(async (error: unknown) => {
      // Another run made it first: theirs is the same commit.
      if (!(await isDirectory(tree))) throw error;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function readRefs(file: string): Promise<Record<string, string>> {
  try {
    const refs = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(refs).filter((e): e is [string, string] => typeof e[1] === "string" && COMMIT.test(e[1])));
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------------- links */

/** Where links are kept: YOUI_LINKS, else $XDG_CONFIG_HOME/youiyoux/links.json; per person, never in a repo. */
export const linksFile = (): string => process.env.YOUI_LINKS || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "youiyoux/links.json");

async function readLinks(): Promise<Record<string, string>> {
  try {
    const links = JSON.parse(await readFile(linksFile(), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(links).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

const productKey = async (productRoot: string): Promise<string> => realpath(productRoot).catch(() => resolve(productRoot));

/** The checkout this person linked the product to, or null. */
export async function linkedDesign(productRoot: string): Promise<string | null> {
  return (await readLinks())[await productKey(productRoot)] ?? null;
}

/** Link the product to a design checkout (null: unlink), for this person only. */
export async function setLink(productRoot: string, design: string | null): Promise<void> {
  const links = await readLinks();
  const key = await productKey(productRoot);
  if (design === null) delete links[key];
  else links[key] = resolve(design);
  await writeFileAtomic(linksFile(), `${JSON.stringify(links, null, 2)}\n`);
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}
