/**
 * Proves a hub build is safe to put on a public preview URL: the only design data it serves is
 * the committed demo snapshot, byte for byte. Anything else under data/ or previews/ (another
 * system's catalog, a product's usage map, its preview images) fails the check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The only system a preview may show: the made-up one committed in snapshot/. */
const PREVIEW_SYSTEM = "demo";
/** The build output directories that carry design data (everything else is the hub's own code). */
const DATA_DIRS = ["data", "previews"] as const;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

const same = (a: string, b: string): boolean => readFileSync(a).equals(readFileSync(b));

function manifestProblems(dist: string): string[] {
  const path = join(dist, "data/manifest.json");
  if (!existsSync(path)) return ["data/manifest.json is missing from the build"];
  let manifest: { systems?: Array<{ id?: unknown }> };
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return ["data/manifest.json is not valid JSON"];
  }
  const ids = (manifest.systems ?? []).map((system) => system.id);
  return ids.length === 1 && ids[0] === PREVIEW_SYSTEM ? [] : [`the build shows systems [${ids.join(", ")}]; a preview shows only "${PREVIEW_SYSTEM}"`];
}

/**
 * Problems with `dist` as a preview build of `snapshotPublic` (apps/web/snapshot/public).
 * Empty means every design file in the build is a committed demo file and every demo file shipped.
 */
export function checkPreviewBuild(dist: string, snapshotPublic: string): string[] {
  if (!existsSync(join(dist, "index.html"))) return [`${dist} has no index.html: build the hub first`];
  const problems = manifestProblems(dist);
  for (const built of DATA_DIRS.flatMap((dir) => files(join(dist, dir)))) {
    const path = relative(dist, built);
    const committed = join(snapshotPublic, path);
    if (!existsSync(committed)) problems.push(`${path} is not part of the committed demo snapshot`);
    else if (!same(built, committed)) problems.push(`${path} differs from the committed demo snapshot`);
  }
  for (const committed of files(snapshotPublic)) {
    const path = relative(snapshotPublic, committed);
    if (!existsSync(join(dist, path))) problems.push(`${path} from the demo snapshot is missing from the build`);
  }
  return problems;
}
