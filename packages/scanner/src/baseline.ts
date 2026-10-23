/**
 * Existing-violation baselines. A baseline accepts the debt a project already has,
 * so a check fails only on what is new or worse:
 *
 * - a finding is matched by rule + file + flagged text (not line), so moving code is not new;
 * - more occurrences than recorded are new (lines recorded at baseline time pick which ones);
 * - an occurrence recorded as a warning that is now an error is a regression;
 * - fewer occurrences than recorded are fixed, and `ratchetBaseline` drops them, so
 *   fixed debt cannot silently come back.
 */
import type { Baseline, BaselineEntry, CheckIdentity, Violation } from "@youiyoux/core";
import { byPosition } from "./parse.ts";

export const BASELINE_FILE = "youi.baseline.json";

export interface BaselineComparison {
  /** Findings beyond the baseline: these fail a check when they are errors. */
  readonly new: readonly Violation[];
  /** Recorded as warnings, errors now (a rule was tightened): these fail too. */
  readonly regressed: readonly Violation[];
  /** Accepted existing debt, still present. */
  readonly known: readonly Violation[];
  /** Recorded occurrences that are gone, with how many disappeared. */
  readonly fixed: ReadonlyArray<BaselineEntry & { readonly gone: number }>;
}

const keyOf = (v: Pick<Violation, "rule" | "file" | "text">): string => `${v.rule}\0${v.file}\0${v.text}`;

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Occurrences on recorded lines first: those are the accepted ones, any extra ones are new. */
function recordedFirst(group: readonly Violation[], entry: BaselineEntry): Violation[] {
  const lines = new Set(entry.lines);
  return [...group].sort((a, b) => Number(!lines.has(a.line)) - Number(!lines.has(b.line)) || byPosition(a, b));
}

function entriesOf(violations: readonly Violation[]): BaselineEntry[] {
  return [...groupBy(violations, keyOf).values()]
    .map((group) => {
      const first = group[0]!;
      const severity = group.some((v) => v.severity === "error") ? "error" : "warn";
      return { rule: first.rule, file: first.file, text: first.text, severity, count: group.length, lines: group.map((v) => v.line).sort((a, b) => a - b) } satisfies BaselineEntry;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.text.localeCompare(b.text));
}

function totalsOf(entries: readonly BaselineEntry[]): Baseline["totals"] {
  const sum = (severity: BaselineEntry["severity"]): number => entries.filter((e) => e.severity === severity).reduce((n, e) => n + e.count, 0);
  return { errors: sum("error"), warnings: sum("warn") };
}

export function createBaseline(project: string, identity: CheckIdentity, violations: readonly Violation[], now: Date = new Date()): Baseline {
  const entries = entriesOf(violations);
  return { schema: "youi.baseline/v1", project, recordedAt: now.toISOString(), identity, totals: totalsOf(entries), entries };
}

/**
 * Compare findings with a baseline. With `scope` (the files a focused check looked at),
 * entries for other files are neither matched nor reported as fixed.
 */
export function compareToBaseline(baseline: Baseline, violations: readonly Violation[], scope?: ReadonlySet<string>): BaselineComparison {
  const recorded = new Map(baseline.entries.filter((e) => !scope || scope.has(e.file)).map((e) => [keyOf(e), e]));
  const fresh: Violation[] = [];
  const regressed: Violation[] = [];
  const known: Violation[] = [];
  const current = groupBy(violations, keyOf);
  for (const [key, group] of current) {
    const entry = recorded.get(key);
    if (!entry) {
      fresh.push(...group);
      continue;
    }
    for (const [index, violation] of recordedFirst(group, entry).entries()) {
      if (index >= entry.count) fresh.push(violation);
      else if (entry.severity === "warn" && violation.severity === "error") regressed.push(violation);
      else known.push(violation);
    }
  }
  const fixed = [...recorded].flatMap(([key, entry]) => {
    const gone = entry.count - Math.min(entry.count, current.get(key)?.length ?? 0);
    return gone > 0 ? [{ ...entry, gone }] : [];
  });
  return { new: fresh.sort(byPosition), regressed: regressed.sort(byPosition), known: known.sort(byPosition), fixed };
}

/**
 * Tighten a baseline to what is still present: fixed occurrences are dropped and
 * nothing new is added (accepting new debt is a separate, deliberate rewrite).
 */
export function ratchetBaseline(baseline: Baseline, violations: readonly Violation[], identity: CheckIdentity, now: Date = new Date()): Baseline {
  const current = groupBy(violations, keyOf);
  const entries = baseline.entries.flatMap((entry) => {
    const kept = recordedFirst(current.get(keyOf(entry)) ?? [], entry).slice(0, entry.count);
    return kept.length === 0 ? [] : [{ ...entry, count: kept.length, lines: kept.map((v) => v.line).sort((a, b) => a - b) }];
  });
  return { ...baseline, recordedAt: now.toISOString(), identity, totals: totalsOf(entries), entries };
}
