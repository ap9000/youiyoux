/**
 * The hub's performance budgets and live measurements of them. Samples are kept
 * in memory, shown on Home, and readable from devtools as `window.__youiyoux`.
 */
import { useSyncExternalStore } from "react";

export const BUDGETS = { searchMs: 50, navigationMs: 100, initialKbGzip: 150 } as const;

export type Metric = "search" | "navigation";

const MAX_SAMPLES = 100;

let samples: Readonly<Record<Metric, readonly number[]>> = { search: [], navigation: [] };
let pending: { readonly target: string; readonly start: number } | null = null;
const listeners = new Set<() => void>();

export function record(metric: Metric, ms: number): void {
  samples = { ...samples, [metric]: [...samples[metric].slice(-(MAX_SAMPLES - 1)), ms] };
  listeners.forEach((listener) => listener());
}

/** Call just before navigating to `target`; the sample is recorded when that path has painted. */
export function markNavigation(target: string): void {
  pending = { target, start: performance.now() };
}

/**
 * Call when a route has committed at `path`. Only the navigation that was marked for this
 * path is recorded (a mark for a navigation that never happened is dropped by the next one).
 */
export function settleNavigation(path: string): void {
  if (!pending || pending.target !== path) return;
  const { start } = pending;
  pending = null;
  requestAnimationFrame(() => record("navigation", performance.now() - start));
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

export function useSamples(): Readonly<Record<Metric, readonly number[]>> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => samples,
  );
}

(globalThis as { __youiyoux?: unknown }).__youiyoux = { budgets: BUDGETS, samples: () => samples };
