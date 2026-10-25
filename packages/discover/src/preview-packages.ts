/**
 * npm packages an opened candidate needs that neither the project nor the hub has (motion, for
 * most of Aceternity and Magic UI; @base-ui/react, for coss), fetched once into the Discover
 * cache's own folder (`preview-packages/`) and kept for the next preview. Nothing is installed in
 * the project.
 *
 * Fetching runs none of a package's code here: install scripts are off (`--ignore-scripts`), and
 * the code runs only in the hub's sandboxed preview frame, bundled like the item's own files. The
 * whole tree is resolved first (`--package-lock-only`) and refused unless every package in it comes
 * from the registry the requested ones come from: a dependency on a git repository, a local path,
 * a link or another host's tarball is never fetched. Then exactly that tree is installed
 * (`npm ci`), never resolved again.
 * Peer dependencies are not fetched (React always comes from the project). The names come from
 * fetched files, so each must be a plain npm name, and a version a plain range or tag: no URL,
 * path, git or file spec, and no Node built-in's name.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";

/** The folder under the Discover cache that holds fetched packages (its node_modules). */
export const PREVIEW_PACKAGES_DIR = "preview-packages";
/** The most packages one preview may fetch. */
export const MAX_PREVIEW_PACKAGES = 8;
const INSTALL_TIMEOUT_MS = 45_000;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** A semver range or a dist-tag: `^12.0.0`, `1.x`, `>=2 <3`, `latest`. Never a `:` or `/`, so never a URL, path or git spec. */
const RANGE = /^[0-9a-z.^~<>=*|+ -]{1,64}$/i;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));

/** Runs npm with `args` in `cwd`: its exit code and what it wrote to stderr. */
export type NpmRunner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<{ code: number; stderr: string }>;

/** A plain npm package name that is not a Node built-in's. */
export function isPackageName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name) && !BUILTINS.has(name);
}

/**
 * What to fetch for `name`: `name@range` when the item declares a plain range for it (`motion@^12`),
 * else `name` (the latest). Null when `name` is not a plain package name.
 */
export function packageSpec(name: string, declared: readonly string[] = []): string | null {
  if (!isPackageName(name)) return null;
  for (const entry of declared) {
    const at = entry.lastIndexOf("@");
    if (at > 0 && entry.slice(0, at) === name) return RANGE.test(entry.slice(at + 1)) ? entry : name;
  }
  return name;
}

const npm: NpmRunner = (args, cwd, signal) =>
  new Promise((done, fail) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: ["ignore", "ignore", "pipe"], ...(signal ? { signal } : {}) });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stderr }));
  });

/**
 * What in a resolved tree (package-lock.json v2/v3) does not come from the registry the requested
 * packages came from: a git, file or link dependency, or a tarball on another host. Empty: none.
 */
export function offRegistry(lock: unknown, requested: readonly string[]): string[] {
  const packages = (lock as { packages?: Record<string, { resolved?: unknown; link?: unknown; inBundle?: unknown }> } | null)?.packages ?? {};
  const hostOf = (resolved: unknown): string | null => {
    if (typeof resolved !== "string") return null;
    try {
      const url = new URL(resolved);
      return url.protocol === "https:" || url.protocol === "http:" ? url.host : null;
    } catch {
      return null;
    }
  };
  const hosts = new Set(requested.map((name) => hostOf(packages[`node_modules/${name}`]?.resolved)).filter((host): host is string => host !== null));
  const refused: string[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || entry.inBundle === true) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const host = hostOf(entry.resolved);
    if (entry.link === true || host === null || !hosts.has(host)) refused.push(`${name} (${typeof entry.resolved === "string" ? entry.resolved.slice(0, 120) : entry.link === true ? "a link" : "no registry source"})`);
  }
  return refused;
}

/** One install at a time per folder: npm does not share a node_modules with itself. */
const installs = new Map<string, Promise<unknown>>();

/**
 * Fetch `names` into `<cache>/preview-packages` (each at the range the item declares in `declared`,
 * else the latest). Resolves to that folder and the specs fetched; throws a sentence when a name
 * is refused, there are too many, or npm fails.
 */
export async function fetchPreviewPackages(cache: string, names: readonly string[], options: { readonly declared?: readonly string[]; readonly run?: NpmRunner; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<{ store: string; fetched: string[] }> {
  const unique = [...new Set(names)];
  if (unique.length > MAX_PREVIEW_PACKAGES) throw new Error(`it needs ${unique.length} packages your project lacks; a preview fetches at most ${MAX_PREVIEW_PACKAGES}`);
  const specs = unique.map((name) => {
    const spec = packageSpec(name, options.declared);
    if (!spec) throw new Error(`refused to fetch ${JSON.stringify(name)}: not a plain npm package name`);
    return spec;
  });
  const store = join(cache, PREVIEW_PACKAGES_DIR);
  const previous = installs.get(store) ?? Promise.resolve();
  const install = previous.catch(() => undefined).then(async () => {
    options.signal?.throwIfAborted();
    await mkdir(store, { recursive: true });
    if (!existsSync(join(store, "package.json"))) await writeFileAtomic(join(store, "package.json"), `${JSON.stringify({ name: "youiyoux-preview-packages", private: true, description: "npm packages fetched for Discover previews by youiyoux; safe to delete" }, null, 2)}\n`);
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? INSTALL_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const flags = ["--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--loglevel=error"];
    const npmRun = async (args: readonly string[]): Promise<void> => {
      let result: { code: number; stderr: string };
      try {
        result = await (options.run ?? npm)(args, store, signal);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("npm is not installed on this machine, so the packages it needs could not be fetched");
        if (signal.aborted && !options.signal?.aborted) throw new Error(`npm took over ${Math.round((options.timeoutMs ?? INSTALL_TIMEOUT_MS) / 1000)}s fetching ${specs.join(", ")} and was stopped`);
        throw error;
      }
      if (result.code !== 0) {
        const why = result.stderr.split("\n").map((line) => line.replace(/^npm (?:error|ERR!)\s*/, "").trim()).find((line) => line && !/^(?:A complete log|code )/.test(line));
        throw new Error(`npm could not fetch ${specs.join(", ")}${why ? ` (${why.slice(0, 200)})` : ""}`);
      }
    };
    // The tree first, nothing downloaded: what it would fetch, and from where.
    const kept = await Promise.all(["package.json", "package-lock.json"].map(async (file) => [file, await readFile(join(store, file), "utf8").catch(() => null)] as const));
    const restore = async (): Promise<void> => {
      for (const [file, text] of kept) {
        if (text === null) await rm(join(store, file), { force: true });
        else await writeFileAtomic(join(store, file), text);
      }
    };
    try {
      await npmRun(["install", "--package-lock-only", "--save-exact", ...flags, ...specs]);
      const lock = JSON.parse(await readFile(join(store, "package-lock.json"), "utf8")) as unknown;
      const refused = offRegistry(lock, unique);
      if (refused.length > 0) throw new Error(`refused to fetch ${specs.join(", ")}: ${refused.length === 1 ? "a package it depends on does" : `${refused.length} packages it depends on do`} not come from the npm registry: ${refused.slice(0, 3).join(", ")}`);
    } catch (error: unknown) {
      await restore();
      throw error;
    }
    // Exactly the tree that was checked: npm ci installs the lockfile as it is, resolving nothing.
    await npmRun(["ci", ...flags]);
    return { store, fetched: specs };
  });
  installs.set(store, install);
  try {
    return await install;
  } finally {
    if (installs.get(store) === install) installs.delete(store);
  }
}
