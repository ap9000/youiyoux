/**
 * "Try it" on the hub's own server: what may be bundled, and the endpoint that bundles it.
 *
 * snapshot.ts writes `<snapshot>/try.json` (beside public/, never in it, so it is never copied into
 * a build; and denied to the dev server's file serving by tryIndexDeny, so only this handler reads
 * it, from disk): per project its root, relative to the snapshot directory, and its
 * tsconfig; per component specimen the look to bundle and its siblings (same file, role and
 * wrapper chain, in line order, at most six: a tab trigger and the triggers beside it).
 *
 * The dev and preview servers (vite.config.ts) answer `GET /__youi/try?project=<id>&specimen=<id>`
 * with `{ script }` (the bundle's URL, `/__youi/try/<hash>.js`, served immutable) or `{ error }`
 * (a plain sentence). The request names ids only, never a path: an id that try.json does not
 * list is a 404. The scanner (bundleForBrowser: the specimen root fence, esbuild's time limit) is
 * loaded on the first request, and a bundle is reused while every file it read is unchanged. Its
 * cache (BrowserBundleCache) runs two builds at once, queues a few more and answers the rest 503
 * (busy), and keeps a bounded number of bundles, by count, size and age.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TRY_PATH = "/__youi/try";
export const TRY_INDEX = "try.json";

/** Vite 8's default `server.fs.deny`, which a config that sets the option replaces, so it is kept here. */
const VITE_DENY = [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**"];

/**
 * `server.fs.deny` for a hub whose snapshot is `snapshot`: Vite's defaults and the snapshot's
 * try.json. The dev server serves any file under its root (apps/web, where the committed snapshot
 * and `youi ui`'s .hub live) and, through /@fs/, the workspace; a denied file is refused on every
 * route (root, /@fs/, an alias, `?import` or `?raw`), case-insensitively. Glob characters in the
 * path are escaped.
 */
export function tryIndexDeny(snapshot: string): string[] {
  return [...VITE_DENY, join(snapshot, TRY_INDEX).replace(/\\/g, "/").replace(/[*?[\]{}()!+@]/g, "\\$&")];
}

/** A recipe as the inventory holds it: a component and the wrappers around it. */
interface Recipe {
  readonly kind: string;
  readonly file: string;
  readonly export: string;
  readonly props: Record<string, unknown>;
  readonly label: string | null;
  readonly wrappers: ReadonlyArray<{ readonly file: string; readonly export: string; readonly props: Record<string, unknown> }>;
  readonly tag: string;
  readonly classes: readonly string[];
}

export interface TryLook {
  readonly recipe: Recipe;
  readonly label: string | null;
  readonly icon: boolean;
}

export interface TryProject {
  /** Relative to the snapshot directory. */
  readonly root: string;
  readonly tsconfig: string;
  /** Specimen id → the look to bundle, and its siblings (the look among them) when it has any. */
  readonly specimens: Record<string, { readonly look: TryLook; readonly siblings: readonly TryLook[] }>;
}

export interface TryIndex {
  readonly schema: "youiyoux.try/v1";
  readonly projects: Record<string, TryProject>;
}

const MAX_SIBLINGS = 6;

/** An inventory look, as much of it as try.json needs. */
interface Look {
  readonly id: string;
  readonly role: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly recipe: Recipe | null;
}

/**
 * One project's Try it entries: each component specimen once (its first look), with the looks
 * that share its file, role and wrapper chain when it has wrappers (a TabsTrigger inside its Tabs
 * and TabsList), in line order, at most six around it.
 */
export function tryProject(rootFromSnapshot: string, tsconfig: string, looks: readonly Look[], lookSpecimen: Readonly<Record<string, string>>, kinds: Readonly<Record<string, { kind: string }>>, lookOf: (recipe: Recipe, role: string) => TryLook): TryProject {
  const specimens: Record<string, { look: TryLook; siblings: TryLook[] }> = {};
  const ordered = [...looks].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  for (const look of ordered) {
    const id = lookSpecimen[look.id];
    if (!id || specimens[id] || kinds[id]?.kind !== "component" || look.recipe?.kind !== "component") continue;
    const chain = JSON.stringify(look.recipe.wrappers);
    const around = look.recipe.wrappers.length === 0 ? [] : ordered.filter((l) => l.file === look.file && l.role === look.role && l.recipe?.kind === "component" && JSON.stringify(l.recipe.wrappers) === chain);
    const at = around.indexOf(look);
    const start = Math.max(0, Math.min(at - Math.floor(MAX_SIBLINGS / 2), around.length - MAX_SIBLINGS));
    const siblings = around.length > 1 ? around.slice(start, start + MAX_SIBLINGS).map((l) => lookOf(l.recipe!, l.role)) : [];
    specimens[id] = { look: lookOf(look.recipe, look.role), siblings };
  }
  return { root: rootFromSnapshot, tsconfig, specimens };
}

/** What bundleForBrowser and its cache look like to the server (typed here, so the hub never compiles the scanner). */
type Built = { hash: string; code: string } | { error: string; busy?: true };
interface Scanner {
  bundleForBrowser(root: string, tsconfig: string, job: TryLook, siblings: readonly TryLook[]): Promise<Built>;
  BrowserBundleCache: new () => { get(key: string, build: () => Promise<Built>): Promise<Built>; code(hash: string): string | null };
}

const SCANNER = resolve(import.meta.dirname, "../../../packages/scanner/src/index.ts");

/** The try.json of a snapshot, re-read when it changes; null when there is none. */
function reader(snapshot: string): () => TryIndex | null {
  const file = join(snapshot, TRY_INDEX);
  let cached: { mtime: number; index: TryIndex | null } | null = null;
  return () => {
    if (!existsSync(file)) return null;
    const mtime = statSync(file).mtimeMs;
    if (cached?.mtime !== mtime) {
      try {
        cached = { mtime, index: JSON.parse(readFileSync(file, "utf8")) as TryIndex };
      } catch {
        cached = { mtime, index: null };
      }
    }
    return cached.index;
  };
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

/**
 * The Try it endpoint for a snapshot directory, as connect middleware under the hub's `base`:
 * `next()` for any other URL. `load` is how the scanner is loaded (a test passes its own).
 */
export function tryMiddleware(snapshot: string, base = "/", load: () => Promise<Scanner> = () => import(pathToFileURL(SCANNER).href) as Promise<Scanner>) {
  const index = reader(snapshot);
  let scanner: Promise<{ module: Scanner; cache: InstanceType<Scanner["BrowserBundleCache"]> }> | null = null;
  const loaded = () => (scanner ??= load().then((module) => ({ module, cache: new module.BrowserBundleCache() })));
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL((req.url ?? "/").replace(base, "/"), "http://hub.local");
    if (!url.pathname.startsWith(TRY_PATH) || req.method !== "GET") return next();
    try {
      const script = /^\/__youi\/try\/([0-9a-f]{16})\.js$/.exec(url.pathname);
      if (script) {
        const code = scanner ? (await scanner).cache.code(script[1]!) : null;
        if (code === null) return send(res, 404, { error: "no such bundle" });
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(code);
        return;
      }
      if (url.pathname !== TRY_PATH) return send(res, 404, { error: "not found" });
      const project = url.searchParams.get("project") ?? "";
      const specimen = url.searchParams.get("specimen") ?? "";
      const entry = Object.hasOwn(index()?.projects ?? {}, project) ? index()!.projects[project]! : null;
      const look = entry && Object.hasOwn(entry.specimens, specimen) ? entry.specimens[specimen]! : null;
      if (!entry || !look) return send(res, 404, { error: "This look cannot be tried here: the hub has no record of it." });
      const root = resolve(snapshot, entry.root);
      const { module, cache } = await loaded();
      const result = await cache.get(`${project}\0${specimen}\0${root}`, () => module.bundleForBrowser(root, entry.tsconfig, look.look, look.siblings));
      if ("error" in result) return send(res, "busy" in result ? 503 : 422, { error: result.error });
      send(res, 200, { script: `${base}${TRY_PATH.slice(1)}/${result.hash}.js` });
    } catch (error: unknown) {
      send(res, 500, { error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  };
}
