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
 * share one, with their count), and one per shape for looks nothing draws. `keep`, when given,
 * keeps only the looks it accepts by project and kit (one side of a near-duplicate, one library).
 */
export function familyTiles(family: InventoryFamily, chunks: readonly InventoryChunk[], source: InventorySource, scheme: Scheme, keep?: (project: string, kit: string | null) => boolean): Tile[] {
  const tiles: Tile[] = [];
  for (const chunk of chunks) {
    if (chunk.role !== family.role) continue;
    const css = cssFor(source, chunk.project, scheme);
    const groups = new Map<string, Tile & { count: number }>();
    for (const look of chunk.looks) {
      if (look.family !== family.id || (keep && !keep(chunk.project, look.kit))) continue;
      const specimen = look.specimen ? (chunk.specimens[look.specimen] ?? null) : null;
      const key = `${chunk.project}:${specimen && css ? `s:${look.specimen}` : `shape:${Object.values(look.shape).join("/")}`}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { key, project: chunk.project, specimen, css: specimen ? css : null, shape: look.shape, count: 1, place: `${look.file}:${look.line}` });
    }
    tiles.push(...groups.values());
  }
  return tiles;
}

/** The one tile that stands for a set: the most used drawn specimen, else the most used shape; the family's shape when nothing is loaded. */
export function leadTile(tiles: readonly Tile[], family: InventoryFamily, key: string): Tile {
  const best = [...tiles].sort((a, b) => Number(b.specimen !== null && b.css !== null) - Number(a.specimen !== null && a.css !== null) || b.count - a.count)[0];
  return best ? { ...best, key } : { key, project: family.projects[0] ?? "", specimen: null, css: null, shape: family.shape, count: family.looks, place: "" };
}
