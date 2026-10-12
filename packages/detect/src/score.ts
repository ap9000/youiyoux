/**
 * The scorer: signals in, verdicts out, with no I/O. A detector (repo or website) turns what it
 * read into signals, each naming a library, a kind of evidence and how much it decides; this
 * turns them into one verdict per library and one per element type.
 *
 *   strong   2 points: decides a verdict by itself (medium; two kinds make it high)
 *   weak     1 point: alone it gives only a low-confidence verdict
 *   support  ½ point, and only for a library something strong or weak already found
 */
import type { DetectConfidence, DetectElement, DetectElementType, DetectEvidence, DetectLibrary } from "@youiyoux/core";
import { LIBRARY_BY_ID } from "./fingerprints.ts";

export type EvidenceKind = DetectEvidence["kind"];

export interface Signal {
  readonly library: string;
  readonly kind: EvidenceKind;
  readonly strength: DetectEvidence["strength"];
  readonly detail: string;
  readonly count: number;
  readonly where?: readonly string[];
  readonly samples?: readonly string[];
}

/** An element of a known type matched on a page or imported in a repo. */
export interface ElementHit {
  readonly library: string;
  readonly type: DetectElementType;
  readonly kind: EvidenceKind;
  readonly detail: string;
  readonly count: number;
  readonly where?: readonly string[];
  readonly screenshot?: string;
  readonly page?: string;
}

const POINTS = { strong: 2, weak: 1, support: 0.5 } as const;
const HIGH = 3.5;
const MEDIUM = 2;
const MAX_SAMPLES = 5;
const MAX_WHERE = 10;
const RANK: Record<DetectConfidence, number> = { high: 3, medium: 2, low: 1 };

const union = (a: readonly string[], b: readonly string[] = [], max: number): string[] => [...new Set([...a, ...b])].slice(0, max);

/** One evidence item per library, kind, strength and detail, with counts summed and places merged. */
function mergeEvidence(signals: readonly Signal[]): Map<string, DetectEvidence[]> {
  const byLibrary = new Map<string, Map<string, DetectEvidence>>();
  for (const s of signals) {
    const items = byLibrary.get(s.library) ?? new Map<string, DetectEvidence>();
    byLibrary.set(s.library, items);
    const key = `${s.kind}\u0000${s.strength}\u0000${s.detail}`;
    const prev = items.get(key);
    items.set(key, {
      kind: s.kind,
      strength: s.strength,
      detail: s.detail,
      count: (prev?.count ?? 0) + Math.max(1, s.count),
      where: union(prev?.where ?? [], s.where, MAX_WHERE),
      samples: union(prev?.samples ?? [], s.samples, MAX_SAMPLES),
    });
  }
  return new Map([...byLibrary].map(([library, items]) => [library, [...items.values()]]));
}

/** Points count each kind of evidence once, at its strongest. */
function pointsOf(evidence: readonly DetectEvidence[]): { decided: number; support: number } {
  const best = new Map<EvidenceKind, number>();
  for (const e of evidence) best.set(e.kind, Math.max(best.get(e.kind) ?? 0, POINTS[e.strength]));
  let decided = 0;
  let support = 0;
  for (const [kind, points] of best) {
    const strengths = evidence.filter((e) => e.kind === kind).map((e) => e.strength);
    if (strengths.every((s) => s === "support")) support += points;
    else decided += points;
  }
  return { decided, support };
}

export function confidenceOf(points: number): DetectConfidence {
  return points >= HIGH ? "high" : points >= MEDIUM ? "medium" : "low";
}

const layerOf = (id: string): number => LIBRARY_BY_ID.get(id)?.layer ?? 0;
const nameOf = (id: string): string => LIBRARY_BY_ID.get(id)?.name ?? id;
const ORDER: Record<DetectEvidence["strength"], number> = { strong: 0, weak: 1, support: 2 };

/**
 * One verdict per library that strong or weak evidence found; support alone never makes one.
 * Ordered by confidence, then the higher layer (a kit explains the primitives it is built
 * on), then points.
 */
export function scoreLibraries(signals: readonly Signal[], pagesOf: (library: string) => readonly string[] = () => []): DetectLibrary[] {
  const verdicts: Array<DetectLibrary & { points: number }> = [];
  for (const [id, evidence] of mergeEvidence(signals)) {
    const { decided, support } = pointsOf(evidence);
    if (decided === 0) continue;
    const points = decided + support;
    const sorted = [...evidence].sort((a, b) => ORDER[a.strength] - ORDER[b.strength] || b.count - a.count);
    verdicts.push({ id, name: nameOf(id), confidence: confidenceOf(points), score: Math.round(Math.min(1, points / 5) * 100) / 100, evidence: sorted, pages: [...pagesOf(id)], points });
  }
  verdicts.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || layerOf(b.id) - layerOf(a.id) || b.points - a.points || a.name.localeCompare(b.name));
  return verdicts.map(({ points: _points, ...verdict }) => verdict);
}

/**
 * One verdict per element type, from libraries that have a verdict. When several match the
 * same type (shadcn's dialog is a Radix dialog), the higher layer wins, then the library
 * ranked first; the others are listed in `also`.
 */
export function scoreElements(hits: readonly ElementHit[], libraries: readonly DetectLibrary[]): DetectElement[] {
  const rank = new Map(libraries.map((l, i) => [l.id, i]));
  const merged = new Map<string, ElementHit & { where: string[] }>();
  for (const hit of hits) {
    if (!rank.has(hit.library)) continue;
    const key = `${hit.type}\u0000${hit.library}`;
    const prev = merged.get(key);
    merged.set(key, {
      ...hit,
      count: (prev?.count ?? 0) + hit.count,
      where: union(prev?.where ?? [], hit.where, MAX_WHERE),
      ...(prev?.screenshot ? { screenshot: prev.screenshot, page: prev.page } : {}),
      detail: prev?.detail ?? hit.detail,
    });
  }
  const byType = new Map<DetectElementType, Array<ElementHit & { where: string[] }>>();
  for (const hit of merged.values()) byType.set(hit.type, [...(byType.get(hit.type) ?? []), hit]);
  const elements: DetectElement[] = [];
  for (const [type, candidates] of byType) {
    candidates.sort((a, b) => layerOf(b.library) - layerOf(a.library) || rank.get(a.library)! - rank.get(b.library)! || b.count - a.count);
    const best = candidates[0]!;
    const library = libraries[rank.get(best.library)!]!;
    elements.push({
      type,
      library: best.library,
      confidence: library.confidence,
      count: best.count,
      evidence: [{ kind: best.kind, strength: "strong", detail: best.detail, count: best.count, where: best.where, samples: [] }],
      also: candidates.slice(1).map((c) => c.library),
      ...(best.screenshot ? { screenshot: best.screenshot } : {}),
      ...(best.page ? { page: best.page } : {}),
    });
  }
  return elements.sort((a, b) => rank.get(a.library)! - rank.get(b.library)! || a.type.localeCompare(b.type));
}
