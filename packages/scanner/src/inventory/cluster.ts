/**
 * Grouping looks by shape. Two shapes are compatible only when every dimension is within
 * tolerance (and a dimension one of them does not know matches only another unknown). When both
 * heights are fixed (set, not derived from padding and line height), vertical padding does not
 * change the look and is not compared: a 32px button with 6px or 0 vertical padding is one shape.
 * Complete-link agglomerative clustering merges two groups only when *every* pair across them
 * is compatible, so a family's diameter never exceeds the tolerance. Single-link (merge when
 * *any* pair is) chains a 28px…38px ladder of 2px steps into one family; it is kept here only
 * so tests can show the difference.
 */
import { SHAPE_DIMENSIONS, type InventoryShape, type ShapeDimension } from "@youiyoux/core";

export interface Tolerance {
  readonly height: number;
  readonly padding: number;
  readonly radius: number;
  readonly fontSize: number;
  readonly fontWeight: number;
}

export const DEFAULT_TOLERANCE: Tolerance = { height: 2, padding: 2, radius: 2, fontSize: 1, fontWeight: 100 };

/** A shape to cluster; `fixedHeight` when its height was set, not derived from padding and line height. */
export type ClusterShape = InventoryShape & { readonly fixedHeight?: boolean };

/** A look's shape for clustering. */
export function clusterShapeOf(look: { readonly shape: InventoryShape; readonly derived: readonly ShapeDimension[] }): ClusterShape {
  return { ...look.shape, fixedHeight: look.shape.height !== null && !look.derived.includes("height") };
}

const LIMIT: Readonly<Record<ShapeDimension, keyof Tolerance>> = { height: "height", paddingX: "padding", paddingY: "padding", radius: "radius", fontSize: "fontSize", fontWeight: "fontWeight" };

/** How far apart two shapes are, in tolerances: ≤ 1 is compatible; Infinity when one knows a dimension the other does not. */
export function shapeDistance(a: ClusterShape, b: ClusterShape, tolerance: Tolerance = DEFAULT_TOLERANCE): number {
  let worst = 0;
  const fixed = a.fixedHeight === true && b.fixedHeight === true;
  for (const dimension of SHAPE_DIMENSIONS) {
    if (fixed && dimension === "paddingY") continue;
    const x = a[dimension];
    const y = b[dimension];
    if (x === null && y === null) continue;
    if (x === null || y === null) return Infinity;
    const limit = tolerance[LIMIT[dimension]];
    const d = Math.abs(x - y);
    worst = Math.max(worst, limit === 0 ? (d === 0 ? 0 : Infinity) : d / limit);
  }
  return worst;
}

export function compatible(a: ClusterShape, b: ClusterShape, tolerance: Tolerance = DEFAULT_TOLERANCE): boolean {
  return shapeDistance(a, b, tolerance) <= 1 + 1e-9;
}

/** A stable order for shapes: by each dimension, unknown first, then derived heights before fixed ones. */
export function compareShapes(a: ClusterShape, b: ClusterShape): number {
  for (const dimension of SHAPE_DIMENSIONS) {
    const x = a[dimension] ?? -1;
    const y = b[dimension] ?? -1;
    if (x !== y) return x - y;
  }
  return Number(a.fixedHeight === true) - Number(b.fixedHeight === true);
}

export type Linkage = "complete" | "single";

/**
 * Agglomerative clustering of `items` (already deduplicated by shape and sorted, so the result
 * is deterministic): repeatedly merge the closest two groups whose linkage distance is within
 * tolerance. Returns groups of item indexes, each sorted, ordered by their first index.
 */
export function clusterShapes(shapes: readonly ClusterShape[], linkage: Linkage = "complete", tolerance: Tolerance = DEFAULT_TOLERANCE): number[][] {
  const n = shapes.length;
  const distance: number[][] = shapes.map((a) => shapes.map((b) => shapeDistance(a, b, tolerance)));
  const groups: Array<number[] | null> = shapes.map((_, i) => [i]);
  // Linkage distance between live groups, updated in place (Lance–Williams).
  const link = distance.map((row) => [...row]);
  for (;;) {
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i++) {
      if (!groups[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!groups[j]) continue;
        const d = link[i]![j]!;
        if (d <= 1 + 1e-9 && d < bestDistance) {
          best = [i, j];
          bestDistance = d;
        }
      }
    }
    if (!best) break;
    const [i, j] = best;
    groups[i] = [...groups[i]!, ...groups[j]!].sort((a, b) => a - b);
    groups[j] = null;
    for (let k = 0; k < n; k++) {
      if (!groups[k] || k === i) continue;
      const merged = linkage === "complete" ? Math.max(link[i]![k]!, link[j]![k]!) : Math.min(link[i]![k]!, link[j]![k]!);
      link[i]![k] = merged;
      link[k]![i] = merged;
    }
  }
  const result = groups.filter((g): g is number[] => g !== null);
  if (linkage === "complete") {
    // The invariant every family keeps: no two members further apart than the tolerance.
    for (const group of result) {
      for (const a of group) for (const b of group) if (!compatible(shapes[a]!, shapes[b]!, tolerance)) throw new Error(`clustering invariant broken: shapes ${a} and ${b} share a family but differ beyond tolerance`);
    }
  }
  return result.sort((a, b) => a[0]! - b[0]!);
}
