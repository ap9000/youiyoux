/**
 * Where specimens are kept between hub snapshots: outside every scanned repo, under
 * `$XDG_CACHE_HOME/youiyoux/specimens` (`~/.cache/…` when unset; `YOUI_SPECIMEN_CACHE` or an
 * explicit directory overrides it). An entry is keyed by the project's commit and the content
 * of every input, so a hit means the same CSS and HTML, and skips Tailwind and esbuild.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageUnderRoot, within } from "./contain.ts";

/** Bump when what a specimen entry holds changes, so old entries are never read. */
export const SPECIMEN_FORMAT = "youiyoux.specimens/5";

/** Counts, for proving a cache hit compiles nothing. */
export interface SpecimenStats {
  tailwindCompiles: number;
  bundles: number;
  hits: number;
  misses: number;
}

export const newStats = (): SpecimenStats => ({ tailwindCompiles: 0, bundles: 0, hits: 0, misses: 0 });

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.YOUI_SPECIMEN_CACHE) return env.YOUI_SPECIMEN_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "youiyoux", "specimens");
}

/** Versions of the packages that decide the output, as the root's node_modules has them. */
export function versions(root: string): Record<string, string | null> {
  return Object.fromEntries(
    ["tailwindcss", "react", "react-dom"].map((name) => {
      const dir = packageUnderRoot(root, name);
      try {
        if (!dir) return [name, null];
        return [name, (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version];
      } catch {
        return [name, null];
      }
    }),
  );
}

/** Files besides the inventoried sources that change the output. */
const EXTRA_INPUTS = ["package.json", "tsconfig.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];
const FONT_DIRS = ["public/fonts", "static/fonts"];

/** The cache key: commit, format, resolved versions, the recipes asked for, and every input's content (only files inside the root). */
export function specimenKey(root: string, commit: string | null, files: readonly string[], recipes: unknown): string {
  const hash = createHash("sha256");
  hash.update(`${SPECIMEN_FORMAT}\0${commit ?? "no-commit"}\0${JSON.stringify(versions(root))}\0${JSON.stringify(recipes)}\0`);
  const fonts = FONT_DIRS.flatMap((dir) => {
    try {
      return readdirSync(join(root, dir)).map((f) => `${dir}/${f}`);
    } catch {
      return [];
    }
  });
  for (const file of [...new Set([...files, ...EXTRA_INPUTS, ...fonts])].sort()) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile() || !within(root, path)) continue;
    hash.update(`${file}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

export class SpecimenCache {
  readonly dir: string;

  constructor(dir: string = defaultCacheDir()) {
    this.dir = dir;
  }

  entryDir(project: string, key: string): string {
    return join(this.dir, `${project.replace(/[^a-z0-9-]+/gi, "-")}-${key}`);
  }

  read<T>(project: string, key: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.entryDir(project, key), "entry.json"), "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** Written to a temporary name and renamed, so a reader never sees half an entry. */
  write(project: string, key: string, value: unknown): void {
    const dir = this.entryDir(project, key);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "entry.json");
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value));
    renameSync(`${file}.${process.pid}.tmp`, file);
  }

  /** A scratch directory for one build (the bundle esbuild makes is evaluated from here). */
  scratch(project: string, key: string): string {
    const dir = join(this.entryDir(project, key), "build");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
