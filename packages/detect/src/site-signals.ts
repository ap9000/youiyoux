/**
 * What one page showed (PageFacts, read in the browser by collect.ts) → signals and element
 * hits for the scorer. Pure, so the false-positive rules are tested on hand-built facts.
 */
import type { DetectElementType } from "@youiyoux/core";
import { LIBRARIES, RADIX_SCALE, SHADCN_SLOTS, SUPPORT, TAILWIND_DENSITY, TAILWIND_MIN_TOKENS } from "./fingerprints.ts";
import type { ElementHit, EvidenceKind, Signal } from "./score.ts";

export interface Tally {
  readonly count: number;
  readonly samples: readonly string[];
}

export interface PageFacts {
  readonly url: string;
  readonly title: string;
  /** Class tokens matching a library's class pattern, by library id. */
  readonly classes: Readonly<Record<string, Tally>>;
  /** Custom properties declared on :root (or html). */
  readonly rootVars: readonly string[];
  /** Elements whose id starts with a known prefix, by prefix. */
  readonly ids: Readonly<Record<string, Tally>>;
  /** Every data-slot value on the page and how often. */
  readonly dataSlots: Readonly<Record<string, number>>;
  /** Style tags carrying a known attribute (`data-styled`), by attribute. */
  readonly styleTags: Readonly<Record<string, number>>;
  readonly tailwind: { readonly utility: number; readonly total: number };
  readonly fonts: ReadonlyArray<{ readonly family: string; readonly usedBy: readonly string[] }>;
  readonly elements: ReadonlyArray<{ readonly library: string; readonly type: DetectElementType; readonly selector: string; readonly count: number }>;
}

/** Fewer matches than this makes a class or slot marker weak: one stray class is not a library. */
const MIN_STRONG = 3;

/** Complete 12-step Radix Colors scales among the :root variables. */
export function radixScales(vars: readonly string[]): string[] {
  const steps = new Map<string, Set<number>>();
  for (const name of vars) {
    const match = RADIX_SCALE.exec(name);
    if (!match) continue;
    const key = `${match[1]}${match[2] ? "-a" : ""}`;
    const set = steps.get(key) ?? new Set<number>();
    set.add(Number(match[3]));
    steps.set(key, set);
  }
  return [...steps].filter(([, set]) => Array.from({ length: 12 }, (_, i) => i + 1).every((step) => set.has(step))).map(([name]) => name);
}

function kindOfSelector(selector: string): EvidenceKind {
  if (selector.includes("data-slot")) return "data-slot";
  if (selector.includes("[id^=")) return "id-prefix";
  return "class-prefix";
}

export interface PageSignals {
  readonly signals: Signal[];
  readonly hits: ElementHit[];
  readonly notes: string[];
}

export function siteSignals(facts: PageFacts): PageSignals {
  const where = [facts.url];
  const signals: Signal[] = [];
  const notes: string[] = [];
  for (const lib of LIBRARIES) {
    const classes = facts.classes[lib.id];
    if (lib.classPattern && classes && classes.count > 0) {
      signals.push({ library: lib.id, kind: "class-prefix", strength: classes.count >= MIN_STRONG ? lib.classPattern.strength : "weak", detail: lib.classPattern.label, count: classes.count, where, samples: classes.samples });
    }
    for (const { prefix, strength } of lib.cssVarPrefixes ?? []) {
      const vars = facts.rootVars.filter((v) => v.startsWith(prefix));
      if (vars.length > 0) signals.push({ library: lib.id, kind: "css-var", strength, detail: `${prefix}* custom properties on :root`, count: vars.length, where, samples: vars.slice(0, 5) });
    }
    for (const prefix of lib.idPrefixes ?? []) {
      const ids = facts.ids[prefix];
      if (ids && ids.count > 0) signals.push({ library: lib.id, kind: "id-prefix", strength: "strong", detail: `ids starting ${prefix}`, count: ids.count, where, samples: ids.samples });
    }
    for (const attr of lib.styleTags ?? []) {
      const count = facts.styleTags[attr] ?? 0;
      if (count > 0) signals.push({ library: lib.id, kind: "style-tag", strength: "strong", detail: `<style ${attr}> injected styles`, count, where });
    }
  }

  // shadcn's own slot names only; any other data-slot is noted and never counted.
  const slots = Object.entries(facts.dataSlots);
  const own = slots.filter(([name]) => SHADCN_SLOTS.has(name));
  const foreign = slots.filter(([name]) => !SHADCN_SLOTS.has(name));
  const ownCount = own.reduce((sum, [, n]) => sum + n, 0);
  if (own.length > 0) {
    const strong = own.length >= 2 && ownCount >= MIN_STRONG;
    signals.push({ library: "shadcn", kind: "data-slot", strength: strong ? "strong" : "weak", detail: "shadcn/ui data-slot names", count: ownCount, where, samples: own.map(([name]) => name).slice(0, 5) });
  }
  if (foreign.length > 0) notes.push(`${facts.url}: data-slot values that are not shadcn/ui's were not counted: ${foreign.map(([name, n]) => `${name} (${n})`).join(", ")}`);

  // Support only: the scorer drops a library whose evidence is all support.
  const scales = radixScales(facts.rootVars);
  if (scales.length > 0) for (const library of SUPPORT["radix-colors"]) signals.push({ library, kind: "radix-colors", strength: "support", detail: `Radix Colors 12-step scales on :root`, count: scales.length, where, samples: scales.slice(0, 5) });
  const { utility, total } = facts.tailwind;
  if (total >= TAILWIND_MIN_TOKENS && utility / total >= TAILWIND_DENSITY) {
    for (const library of SUPPORT.tailwind) signals.push({ library, kind: "tailwind", strength: "support", detail: `Tailwind utility density ${Math.round((utility / total) * 100)}% of class tokens`, count: utility, where });
  }

  const hits: ElementHit[] = facts.elements.filter((e) => e.count > 0).map((e) => ({ library: e.library, type: e.type, kind: kindOfSelector(e.selector), detail: e.selector, count: e.count, where, page: facts.url }));
  return { signals, hits, notes };
}
