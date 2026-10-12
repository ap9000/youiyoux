/**
 * Where a repo's own imports point: relative paths, and the path aliases its nearest
 * tsconfig.json or jsconfig.json declares (`compilerOptions.paths` and `baseUrl`, following
 * `extends`, comments allowed: TypeScript reads the config). So `~/ui/button`, `@lib/ui/card`
 * and `../ui/dialog` all land on a file in the repo, whatever the alias is called.
 */
import { existsSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import ts from "typescript";

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

interface Aliases {
  /** The absolute directory `paths` targets are relative to: baseUrl, else the config that declares `paths`. */
  readonly base: string;
  readonly paths: ReadonlyArray<readonly [string, readonly string[]]>;
  readonly baseUrl: string | null;
}

/** Only the compiler options are wanted: never list the project's files. */
const CONFIG_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: (path) => ts.sys.fileExists(path),
  readFile: (path) => ts.sys.readFile(path),
};

function readAliases(file: string): Aliases | null {
  const { config, error } = ts.readConfigFile(file, (path) => ts.sys.readFile(path));
  if (error || !config) return null;
  const options = ts.parseJsonConfigFileContent(config, CONFIG_HOST, dirname(file), undefined, file).options;
  const baseUrl = options.baseUrl ?? null;
  // pathsBasePath is where TypeScript itself resolves `paths` from when there is no baseUrl.
  const base = baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? dirname(file);
  return { base, paths: Object.entries(options.paths ?? {}), baseUrl };
}

/** TypeScript's rule: an exact pattern wins, then the `*` pattern with the longest prefix. */
function matchAlias(paths: Aliases["paths"], specifier: string): { targets: readonly string[]; star: string } | null {
  let best: { targets: readonly string[]; star: string; prefix: number } | null = null;
  for (const [pattern, targets] of paths) {
    if (pattern === specifier) return { targets, star: "" };
    const at = pattern.indexOf("*");
    if (at < 0) continue;
    const [prefix, suffix] = [pattern.slice(0, at), pattern.slice(at + 1)];
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix) && (!best || prefix.length > best.prefix)) {
      best = { targets, star: specifier.slice(prefix.length, specifier.length - suffix.length), prefix: prefix.length };
    }
  }
  return best;
}

export class RepoPaths {
  private readonly configs = new Map<string, Aliases | null>();
  private readonly nearest = new Map<string, string | null>();

  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The repo-relative path (as written, no extension added) an import points to; null for a package or outside the repo. */
  resolve(specifier: string, fromFile: string): string | null {
    if (/^\.\.?(\/|$)/.test(specifier)) return this.inRepo(join(this.root, posix.dirname(fromFile), specifier));
    const aliases = this.aliasesFor(posix.dirname(fromFile));
    if (!aliases) return null;
    const match = matchAlias(aliases.paths, specifier);
    if (match) {
      const candidates = match.targets.map((target) => this.inRepo(join(aliases.base, target.replace("*", match.star))));
      return candidates.find((path) => path !== null && this.exists(path)) ?? candidates[0] ?? null;
    }
    if (aliases.baseUrl) {
      const path = this.inRepo(join(aliases.baseUrl, specifier));
      if (path && this.exists(path)) return path;
    }
    return null;
  }

  /** A file or directory at `path`, with or without a source extension or index file. */
  exists(path: string): boolean {
    const abs = join(this.root, path);
    return existsSync(abs) || EXTENSIONS.some((ext) => existsSync(`${abs}${ext}`) || existsSync(join(abs, `index${ext}`)));
  }

  private inRepo(abs: string): string | null {
    const path = relative(this.root, abs).split(sep).join("/");
    return path.startsWith("..") ? null : path;
  }

  /** The aliases of the config nearest to a repo directory. */
  private aliasesFor(dir: string): Aliases | null {
    const file = this.configPath(dir);
    if (!file) return null;
    if (!this.configs.has(file)) this.configs.set(file, readAliases(join(this.root, file)));
    return this.configs.get(file) ?? null;
  }

  /** The nearest tsconfig.json or jsconfig.json, walking up to the repo root. */
  private configPath(dir: string): string | null {
    const known = this.nearest.get(dir);
    if (known !== undefined) return known;
    const own = CONFIG_NAMES.map((name) => posix.join(dir, name)).find((file) => existsSync(join(this.root, file)));
    const found = own ?? (dir === "." ? null : this.configPath(posix.dirname(dir)));
    this.nearest.set(dir, found);
    return found;
  }
}
