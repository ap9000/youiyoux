/** Specimen tiles for a family, a side of a near-duplicate, or a family's wall tile, from loaded chunks. */
import type { Scheme } from "../../app/theme.tsx";
import type { InventorySource } from "../../data/inventory-source.ts";
import type { InventoryChunk, InventoryFamily } from "../../data/types.ts";
import type { Tile } from "./Specimens.tsx";

const cssFor = (source: InventorySource, project: string, scheme: Scheme): string | null => {
  const file = source.index.projects.find((p) => p.id === project)?.specimenCss?.[scheme];
  return file ? source.cssUrl(file) : null;
};

/**
 * A family's looks as tiles: one per distinct specimen in each project (looks drawn the same
 * share one, with their count), and one per shape for looks nothing draws. Each Storybook story
 * is a tile of its own, labeled with its title and name, after the uses. `keep`, when given,
 * keeps only the looks it accepts by project and kit (one side of a near-duplicate, one library).
 */
export function familyTiles(family: InventoryFamily, chunks: readonly InventoryChunk[], source: InventorySource, scheme: Scheme, keep?: (project: string, kit: string | null) => boolean): Tile[] {
  const tiles: Tile[] = [];
  for (const chunk of chunks) {
    if (chunk.role !== family.role) continue;
    const css = cssFor(source, chunk.project, scheme);
    const groups = new Map<string, Tile & { count: number }>();
    const stories: Tile[] = [];
    for (const look of chunk.looks) {
      if (look.family !== family.id || (keep && !keep(chunk.project, look.kit))) continue;
      const specimen = look.specimen ? (chunk.specimens[look.specimen] ?? null) : null;
      const drawn = { project: chunk.project, specimen, css: specimen ? css : null, shape: look.shape, count: 1, place: `${look.file}:${look.line}`, specimenId: specimen ? look.specimen : null };
      if (look.story) {
        stories.push({ ...drawn, key: `${chunk.project}:story:${look.id}`, story: look.story });
        continue;
      }
      const key = `${chunk.project}:${specimen && css ? `s:${look.specimen}` : `shape:${Object.values(look.shape).join("/")}`}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { ...drawn, key });
    }
    tiles.push(...groups.values(), ...stories);
  }
  return tiles;
}

const drawn = (tile: Tile): boolean => tile.specimen !== null && tile.css !== null;

/**
 * The tiles that can stand for a set, in the order to try them: its drawn specimens, most used
 * first, then its most used shape (the family's shape when it has none). A specimen can draw
 * nothing at the desk width (shown only on a phone), so LeadTile moves on to the next.
 */
export function leadTiles(tiles: readonly Tile[], family: InventoryFamily, key: string): Tile[] {
  // A use stands for the family before any story does.
  const byUse = [...tiles].sort((a, b) => Number(Boolean(a.story)) - Number(Boolean(b.story)) || b.count - a.count);
  const shape = byUse.find((t) => !drawn(t)) ?? { project: family.projects[0] ?? "", specimen: null, css: null, shape: family.shape, count: family.looks, place: "" };
  return [...byUse.filter(drawn), shape].map((tile) => ({ ...tile, key }));
}
