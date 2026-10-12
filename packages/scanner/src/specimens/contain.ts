/**
 * What a specimen build may read and run: files whose real path is inside the project root,
 * and bare packages whose entry is in the root's own node_modules (with whatever those packages
 * load in turn). Every reader in css.ts and render.ts asks here first; a refused path is a
 * warning and a fallback, never a crash. Real paths on both sides and a separator-aware prefix,
 * so a symlink that leaves the root, `..`, an absolute path, or a sibling directory that only
 * shares the root's name as a prefix (`/x/console-evil` beside `/x/console`) are all outside.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/** A path's real path; for a path that does not exist, its nearest existing parent's, plus the rest. */
export function realOf(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realOf(parent), basename(absolute));
  }
}

/** True when `path` (resolved through every symlink) is `root` or inside it. */
export function within(root: string, path: string): boolean {
  const base = realOf(root);
  const real = realOf(path);
  return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** `react-dom/server` → `react-dom`, `@radix-ui/react-tabs/x` → `@radix-ui/react-tabs`; null for a relative, absolute or URL specifier. */
export function packageName(specifier: string): string | null {
  if (/^(?:\.|\/|[a-z][a-z0-9+.-]*:|#)/i.test(specifier) || isAbsolute(specifier)) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : null;
}

/** The package's directory when its entry sits in `<root>/node_modules` (a symlink into a store counts); else null. */
export function packageUnderRoot(root: string, specifier: string): string | null {
  const name = packageName(specifier);
  if (!name) return null;
  const entry = join(root, "node_modules", ...name.split("/"));
  try {
    lstatSync(entry);
  } catch {
    return null;
  }
  // pnpm links the entry into its store, outside the root: the entry is what the project installed.
  return realOf(entry);
}

export const isBarePackageUnderRoot = (root: string, specifier: string): boolean => packageUnderRoot(root, specifier) !== null;

/** True for a path inside some installed package (a node_modules directory), wherever its store is. */
export const inPackage = (path: string): boolean => realOf(path).split(sep).includes("node_modules");

/**
 * A project-relative path as written in a recipe, a config or a link: refused when absolute, when
 * it climbs out with `..` once normalised, or when its real path leaves the root. Returns the
 * normalised relative path, or the reason it was refused.
 */
export function relativeInside(root: string, path: string): { ok: string } | { refused: string } {
  if (isAbsolute(path) || /^[a-z]:[\\/]/i.test(path)) return { refused: `${path} is an absolute path` };
  const normal = posix.normalize(path.split("\\").join("/"));
  if (normal === ".." || normal.startsWith("../")) return { refused: `${path} is outside the project root` };
  if (!within(root, join(root, normal))) return { refused: `${path} leads outside the project root (a symlink)` };
  return { ok: normal.replace(/^\.\//, "") };
}

/**
 * Files under the root (not node_modules or .git) that are symlinks whose target leaves the root.
 * Scanners that walk the tree themselves (Tailwind's oxide) are told to skip them.
 */
export function escapingLinks(root: string, limit = 20_000): string[] {
  const out: string[] = [];
  const stack = [""];
  let seen = 0;
  while (stack.length > 0 && seen < limit) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (!within(root, join(root, rel))) out.push(rel);
      } else if (entry.isDirectory()) stack.push(rel);
    }
  }
  return out.sort();
}

/** A project-relative display path for a file inside the root; for a package file, its place under node_modules. */
export function displayPath(root: string, path: string): string {
  const rel = relative(realOf(root), realOf(path)).split(sep).join("/");
  if (!rel.startsWith("../")) return rel;
  const parts = path.split(sep);
  const at = parts.lastIndexOf("node_modules");
  return at >= 0 ? `node_modules/${parts.slice(at + 1).join("/")}` : rel;
}
