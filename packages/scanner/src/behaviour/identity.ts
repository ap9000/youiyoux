/**
 * Which popup a result is about, across fresh loads of a screen: route, pattern, component and
 * accessible name. File, line and DOM path are display only, so moving code doesn't break a match.
 * Several targets sharing all four are told apart by an ordinal (their order on the page) for
 * display, but never matched by it: order is a guess (rows reorder), so they are ambiguous, and a
 * probe says so instead of clicking one of them.
 */
import { pageText, type BehaviourPattern } from "@youiyoux/core";

export interface TargetKey {
  readonly route: string;
  readonly pattern: BehaviourPattern;
  readonly component: string | null;
  readonly accessibleName: string;
}

export const keyOf = (t: TargetKey): string => JSON.stringify([t.route, t.pattern, t.component, t.accessibleName]);

/** Each target with its ordinal among those sharing its key (only when there are several), and whether it is ambiguous. */
export function withOrdinals<T extends TargetKey>(targets: readonly T[]): Array<T & { readonly ordinal?: number; readonly ambiguous: boolean }> {
  const groups = new Map<string, number>();
  for (const t of targets) groups.set(keyOf(t), (groups.get(keyOf(t)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return targets.map((t) => {
    const key = keyOf(t);
    if ((groups.get(key) ?? 0) < 2) return { ...t, ambiguous: false };
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ...t, ordinal, ambiguous: true };
  });
}

export type Match = { readonly state: "found"; readonly index: number } | { readonly state: "missing" } | { readonly state: "ambiguous"; readonly count: number };

/** The one target on a fresh load with this key; none, or several, is never a match. */
export function matchTarget(wanted: TargetKey, found: readonly TargetKey[]): Match {
  const key = keyOf(wanted);
  const hits = found.flatMap((t, index) => (keyOf(t) === key ? [index] : []));
  if (hits.length === 1) return { state: "found", index: hits[0]! };
  return hits.length === 0 ? { state: "missing" } : { state: "ambiguous", count: hits.length };
}

const NOUN: Record<BehaviourPattern, string> = { "menu-button": "menus", "combobox-listbox": "comboboxes", "modal-dialog": "dialog buttons", popover: "popover buttons" };

/** The words for several targets sharing a name. */
export function ambiguousWords(t: TargetKey, count: number): { why: string; fix: string } {
  return {
    why: `several ${NOUN[t.pattern]} are called ${pageText(t.accessibleName)} here (${count}); probes never pick one by its place on the page`,
    fix: "Next: name them apart (an aria-label that says which row or item each one is for), or declare a contract binding for the component.",
  };
}
