/**
 * Discover thumbnails: each candidate photographed in a project's theme, light and dark, by
 * `youiyoux discover previews` (capture-discover-thumbs.ts), so the Discover page can show a
 * gallery without drawing anything live. They live in the Discover cache, never in a snapshot:
 *
 *   <cache>/thumbs/<project>/index.json             which candidate each picture is, and of what
 *   <cache>/thumbs/<project>/<key>.<scheme>.webp    the pictures, named by content
 *
 * A picture records the listing's provenance digest when it was taken; once the listing changes
 * (the registry published a new version) the picture is stale and is neither served nor kept on
 * the next capture. A candidate that could not be drawn on its own is recorded with the reason,
 * so the next capture does not try it again until it changes (or `--retry`).
 *
 * The hub's servers answer, for this machine only,
 *
 *   GET /__youi/discover-thumbs[?project=<id>]                  the project's current pictures
 *   GET /__youi/discover-thumbs/<project>/<key>.<scheme>.webp   one picture, immutable
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import { loadPackage } from "./packages.ts";
import { isHubHost, NOT_THIS_HOST, send } from "./query-server.ts";
import { readTryIndex } from "./try-server.ts";

export const THUMBS_PATH = "/__youi/discover-thumbs";
const THUMBS_DIR = "thumbs";
const THUMBS_INDEX = "index.json";
const THUMBS_SCHEMA = "youiyoux.discover-thumbs/v1";
export const THUMB_SCHEMES = ["light", "dark"] as const;

/** A project id as try.json names it; anything else never reaches a path. */
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const PICTURE = /^([0-9a-f]{16})\.(light|dark)\.webp$/;

interface Thumb {
  /** The listing's provenance digest when the picture was taken. */
  readonly sha: string;
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}

interface ThumbFailure {
  readonly sha: string;
  /** Why it could not be drawn on its own, in a sentence. */
  readonly reason: string;
  readonly at: string;
}

export interface ThumbIndex {
  readonly schema: typeof THUMBS_SCHEMA;
  readonly project: string;
  readonly items: Readonly<Record<string, Thumb>>;
  readonly failed: Readonly<Record<string, ThumbFailure>>;
}

/** What the hub is answered: the pictures still current, by candidate id. */
export interface ThumbAnswer {
  readonly project: string;
  readonly items: Readonly<Record<string, { readonly light: string; readonly dark: string; readonly width: number; readonly height: number; readonly capturedAt: string }>>;
  readonly failed: Readonly<Record<string, string>>;
}

const safeProject = (project: string): string | null => (PROJECT.test(project) && project !== "." && project !== ".." ? project : null);

export function thumbsDir(cache: string, project: string): string {
  const safe = safeProject(project);
  if (!safe) throw new Error(`refused: "${project.slice(0, 60)}" is not a project id`);
  return join(resolve(cache), THUMBS_DIR, safe);
}

export const emptyIndex = (project: string): ThumbIndex => ({ schema: THUMBS_SCHEMA, project, items: {}, failed: {} });

export function readThumbIndex(cache: string, project: string): ThumbIndex {
  const file = join(thumbsDir(cache, project), THUMBS_INDEX);
  if (!existsSync(file)) return emptyIndex(project);
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ThumbIndex>;
    if (value.schema !== THUMBS_SCHEMA) return emptyIndex(project);
    return { schema: THUMBS_SCHEMA, project, items: { ...value.items }, failed: { ...value.failed } };
  } catch {
    return emptyIndex(project);
  }
}

export async function writeThumbIndex(cache: string, index: ThumbIndex): Promise<void> {
  await writeFileAtomic(join(thumbsDir(cache, index.project), THUMBS_INDEX), `${JSON.stringify(index, null, 1)}\n`);
}

/** Whether a candidate needs a capture: no current picture and no current failure, or `force`. */
export function needsCapture(index: ThumbIndex, id: string, sha: string, force = false): boolean {
  return force || (index.items[id]?.sha !== sha && index.failed[id]?.sha !== sha);
}

/** The pictures a candidate's listings still match: `current` is each candidate's provenance digest now. */
export function currentThumbs(index: ThumbIndex, current: ReadonlyMap<string, string>, url: (file: string) => string): ThumbAnswer {
  const items: Record<string, ThumbAnswer["items"][string]> = {};
  for (const [id, thumb] of Object.entries(index.items)) {
    if (current.get(id) !== thumb.sha || !/^[0-9a-f]{16}$/.test(thumb.key)) continue;
    items[id] = { light: url(`${thumb.key}.light.webp`), dark: url(`${thumb.key}.dark.webp`), width: thumb.width, height: thumb.height, capturedAt: thumb.capturedAt };
  }
  const failed: Record<string, string> = {};
  for (const [id, failure] of Object.entries(index.failed)) if (current.get(id) === failure.sha && !items[id]) failed[id] = failure.reason;
  return { project: index.project, items, failed };
}

/** Pictures no entry of the index names any more (a candidate recaptured, or gone stale). */
export async function prunePictures(cache: string, index: ThumbIndex): Promise<number> {
  const dir = thumbsDir(cache, index.project);
  const keep = new Set(Object.values(index.items).map((t) => t.key));
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const match = PICTURE.exec(name);
    if (!match || keep.has(match[1]!)) continue;
    await rm(join(dir, name), { force: true });
    removed++;
  }
  return removed;
}

export interface Selection {
  readonly registry: string | null;
  readonly role: string | null;
  readonly limit: number | null;
}

/** The listings to photograph: registry items (an npm package has no drawing), official first as Discover lists them. */
export function selectCandidates<T extends { id: string; source: { kind?: string | null; ref?: string | null }; categories?: readonly string[]; provenance?: { sha256?: string } | null }>(entries: readonly T[], selection: Selection): Array<T & { provenance: { sha256: string } }> {
  const chosen = entries.filter((e): e is T & { provenance: { sha256: string } } => {
    if (e.source.kind !== "shadcn-registry" || !e.source.ref || typeof e.provenance?.sha256 !== "string") return false;
    if (selection.registry && !e.source.ref.startsWith(`${selection.registry}/`)) return false;
    return !selection.role || (e.categories ?? []).includes(selection.role) || e.source.ref.endsWith(`/${selection.role}`);
  });
  return selection.limit === null ? chosen : chosen.slice(0, selection.limit);
}

/* ------------------------------------------------------------------ the server */

export interface ThumbsOptions {
  /** The Discover cache directory (default: as the CLI). */
  readonly cache?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Each listing's provenance digest in the Discover cache's index, by id. */
function listingDigests(cache: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const name of ["index.json", "index-all.json"]) {
    const file = join(cache, name);
    if (!existsSync(file)) continue;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as { entries?: Array<{ id?: unknown; provenance?: { sha256?: unknown } }> };
      for (const entry of value.entries ?? []) if (typeof entry.id === "string" && typeof entry.provenance?.sha256 === "string") digests.set(entry.id, entry.provenance.sha256);
    } catch {
      // An unreadable index has no current listings: nothing is served as current.
    }
  }
  return digests;
}

/** The thumbnail endpoints for a snapshot directory, as connect middleware under the hub's `base`. */
export function discoverThumbsMiddleware(snapshot: string, base = "/", options: ThumbsOptions = {}, cacheDir: () => Promise<string> = async () => (await loadPackage<typeof import("../../../packages/discover/src/index.ts")>("discover")).discoverCacheDir(undefined, options.env ?? process.env)) {
  const projects = (): string[] => Object.keys(readTryIndex(snapshot)?.projects ?? {});
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL((req.url ?? "/").replace(base, "/"), "http://hub.local");
    if (!url.pathname.startsWith(THUMBS_PATH) || req.method !== "GET") return next();
    if (!isHubHost(req.headers.host)) return send(res, 403, { error: `Thumbnails answer this machine only (${NOT_THIS_HOST}).` });
    const cache = resolve(options.cache ?? (await cacheDir()));
    const picture = /^\/__youi\/discover-thumbs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (picture) {
      const project = safeProject(decodeURIComponent(picture[1]!));
      if (!project || !PICTURE.test(picture[2]!)) return send(res, 400, { error: "not a thumbnail" });
      const file = join(thumbsDir(cache, project), picture[2]!);
      if (!existsSync(file)) return send(res, 404, { error: "no such thumbnail" });
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.end(readFileSync(file));
      return;
    }
    if (url.pathname !== THUMBS_PATH) return send(res, 404, { error: "not found" });
    const known = projects();
    const wanted = url.searchParams.get("project");
    const project = wanted ? (known.includes(wanted) ? wanted : null) : (known[0] ?? null);
    if (!project || !safeProject(project)) return send(res, 404, { error: wanted ? `The hub has no project "${wanted.slice(0, 60)}".` : "The hub has no project: open it with youiyoux ui --project." });
    const index = readThumbIndex(cache, project);
    send(res, 200, currentThumbs(index, listingDigests(cache), (file) => `${base}${THUMBS_PATH.slice(1)}/${encodeURIComponent(project)}/${file}`));
  };
}
