/**
 * Token values as CSS: the one formatter the build, the hub's preview sheet and its live
 * style editor share. Browser-safe (no Terrazzo, no Node), so the hub imports it as
 * `@youiyoux/tokens/values`.
 *
 * A token emits a main variable and, for composites, one per part (`-font-size`,
 * `-offset`, …). Parts written as aliases can be emitted as `var()` references, so a
 * change to the token they read cascades in the browser without rebuilding.
 */
import { formatCssColor, type DtcgColor } from "./color.ts";

/** A token's CSS variable: `--<prefix>-<name>`, or `--<name>` with no prefix (a product whose own variables have none, as shadcn/ui's `--primary`). */
export const cssVariable = (prefix: string, name: string): string => (prefix ? `--${prefix}-${name}` : `--${name}`);

export interface Dimension {
  readonly value: number;
  readonly unit: string;
}

export interface ShadowLayer {
  readonly color: DtcgColor | string;
  readonly offsetX: Dimension | string;
  readonly offsetY: Dimension | string;
  readonly blur: Dimension | string;
  readonly spread: Dimension | string;
  readonly inset?: boolean;
}

export interface Typography {
  readonly fontFamily: string[] | string;
  readonly fontSize: Dimension | string;
  readonly fontWeight: number | string;
  readonly lineHeight: number | Dimension | string;
  readonly letterSpacing?: Dimension | string;
}

export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
  readonly velocity?: number;
}

export interface FocusRing {
  readonly color: DtcgColor | string;
  readonly width: Dimension | string;
  readonly offset: Dimension | string;
  readonly style: string;
}

/** A token path read by an alias (`{color.brand}` → `color.brand`), or null. */
export function aliasTarget(value: unknown): string | null {
  return typeof value === "string" ? (/^\{([^{}]+)\}$/.exec(value)?.[1] ?? null) : null;
}

/**
 * How an alias is written: by default it must already be resolved; with `ref`, as `var(--…)`.
 * `suffix` names the part variable being written when a whole composite is an alias.
 */
export type AliasRef = (path: string, suffix?: string) => string;

const isAlias = (value: unknown): value is string => aliasTarget(value) !== null;

function part<T>(value: T | string, format: (v: T) => string, ref: AliasRef | undefined): string {
  if (isAlias(value)) {
    if (!ref) throw new Error(`unresolved alias ${value}`);
    return ref(aliasTarget(value)!);
  }
  return format(value as T);
}

/** A dimension or a duration: its number and unit. */
const dim = (d: Dimension): string => `${d.value}${d.unit}`;
/** A line height: a unitless number, or a dimension. */
const lineHeight = (v: number | Dimension): string => (typeof v === "number" ? String(v) : dim(v));
/**
 * A CSS string literal. Quotes and backslashes are escaped, and control characters and angle
 * brackets written as hex escapes, so no text can close the string and start a declaration.
 */
export function cssString(text: string): string {
  return `"${text.replace(/["\\]/g, "\\$&").replace(/[\u0000-\u001f\u007f<>]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

/** Text safe inside a CSS comment: nothing can end it (`*\/`) and it stays on one line. */
export function cssComment(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\*\//g, "*\\/");
}

/** One font family name the token schema accepts: core's FONT_FAMILY_NAME, kept here for the browser (core loads zod). */
export const FAMILY_NAME = /^[\p{L}\p{M}\p{N} -]*[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} -]*$/u;

/** A family name as CSS: a keyword-like name as it is, anything else as an escaped string (a second guard behind the token schema). */
export const quoteFamily = (f: string): string => (/^[a-z-]+$/i.test(f) ? f : cssString(f));
const family = (value: string[] | string): string => (Array.isArray(value) ? value : [String(value)]).map(quoteFamily).join(", ");
const bezier = (value: readonly number[]): string => `cubic-bezier(${value.join(", ")})`;
const LINE_STYLES = new Set(["solid", "dashed", "dotted", "double", "groove", "ridge", "outset", "inset"]);
/** A line style the schema allows, else solid: the text of a style never reaches CSS as it is. A dash array is drawn dashed. */
const lineStyle = (value: unknown): string => (typeof value === "string" && LINE_STYLES.has(value) ? value : "solid");
const stroke = (value: unknown): string => (typeof value === "string" ? lineStyle(value) : "dashed");

/* ------------------------------------------------------------------- springs */

/** Damping that just avoids overshoot for this stiffness and mass. */
export function criticalDamping(spring: Pick<Spring, "stiffness" | "mass">): number {
  return 2 * Math.sqrt(spring.stiffness * spring.mass);
}

const STEP = 1 / 1000;
const MAX_SECONDS = 10;
const REST = 0.001;

/**
 * A spring released from 0 towards 1, simulated until it rests (within 0.1% and nearly
 * still) or 10 s pass. Returns its settle time and `samples` evenly spaced positions.
 */
export function springCurve(spring: Spring, samples = 48): { durationMs: number; points: number[]; settles: boolean } {
  const { stiffness: k, damping: c, mass: m } = spring;
  let x = 0;
  let v = spring.velocity ?? 0;
  const trace: number[] = [0];
  let settledAt = -1;
  for (let i = 1; i <= MAX_SECONDS / STEP; i++) {
    // Semi-implicit Euler: stable for stiff springs at a 1 ms step.
    v += ((-k * (x - 1) - c * v) / m) * STEP;
    x += v * STEP;
    trace.push(x);
    const resting = Math.abs(x - 1) < REST && Math.abs(v) < REST * 10;
    if (resting && settledAt < 0) settledAt = i;
    else if (!resting) settledAt = -1;
    if (settledAt > 0 && i - settledAt > 30) break;
  }
  const end = settledAt > 0 ? settledAt : trace.length - 1;
  const points = Array.from({ length: samples + 1 }, (_, i) => (i === samples ? 1 : round(trace[Math.round((i / samples) * end)]!, 4)));
  return { durationMs: Math.max(1, Math.round(end * STEP * 1000)), points, settles: settledAt > 0 };
}

/** The spring as a CSS `linear()` easing; pair it with its settle duration. */
export function springEasing(spring: Spring, samples = 48): string {
  return `linear(${springCurve(spring, samples).points.join(", ")})`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/* ---------------------------------------------------------------- formatting */

/** A token value as CSS text. Alias parts must be resolved unless `ref` says how to write them. */
export function cssValue(type: string, value: unknown, ref?: AliasRef): string {
  if (isAlias(value)) return part(value, String, ref);
  switch (type) {
    case "color":
      return formatCssColor(value as DtcgColor);
    case "dimension":
      return dim(value as Dimension);
    case "duration":
      return dim(value as Dimension);
    case "fontFamily":
      return family(value as string[] | string);
    case "cubicBezier":
      return bezier(value as number[]);
    case "shadow":
      return (Array.isArray(value) ? (value as ShadowLayer[]) : [value as ShadowLayer])
        .map((l) => `${l.inset ? "inset " : ""}${[l.offsetX, l.offsetY, l.blur, l.spread].map((d) => part(d, dim, ref)).join(" ")} ${part(l.color, formatCssColor, ref)}`)
        .join(", ");
    case "typography": {
      const t = value as Typography;
      return `${part(t.fontWeight, String, ref)} ${part(t.fontSize, dim, ref)}/${part(t.lineHeight, lineHeight, ref)} ${part(t.fontFamily, family, ref)}`;
    }
    case "border": {
      const b = value as { color: DtcgColor | string; width: Dimension | string; style: unknown };
      return `${part(b.width, dim, ref)} ${part(b.style, stroke, ref)} ${part(b.color, formatCssColor, ref)}`;
    }
    case "strokeStyle":
      return stroke(value);
    case "transition": {
      const t = value as { duration: Dimension | string; delay: Dimension | string; timingFunction: number[] | string };
      return `${part(t.duration, dim, ref)} ${part(t.delay, dim, ref)} ${part(t.timingFunction, bezier, ref)}`;
    }
    case "spring":
      return springEasing(value as Spring);
    case "focusRing": {
      const f = value as FocusRing;
      return `${part(f.width, dim, ref)} ${part(f.style, lineStyle, ref)} ${part(f.color, formatCssColor, ref)}`;
    }
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/** The parts a composite token emits as their own variables, with how to format each. */
const PARTS: Readonly<Record<string, ReadonlyArray<readonly [suffix: string, key: string, type: string]>>> = {
  typography: [
    ["-font-family", "fontFamily", "fontFamily"],
    ["-font-size", "fontSize", "dimension"],
    ["-font-weight", "fontWeight", "fontWeight"],
    ["-line-height", "lineHeight", "lineHeight"],
    ["-letter-spacing", "letterSpacing", "dimension"],
  ],
  focusRing: [
    ["-color", "color", "color"],
    ["-width", "width", "dimension"],
    ["-offset", "offset", "dimension"],
    ["-style", "style", "strokeStyle"],
  ],
};

/** Every variable suffix a token of `type` emits ("" is the main variable), whatever its value. */
export function variableSuffixes(type: string): string[] {
  if (type === "spring") return ["", "-duration", "-stiffness", "-damping", "-mass"];
  return ["", ...(PARTS[type] ?? []).map(([suffix]) => suffix)];
}

/**
 * The variables one token emits: `[suffix, css]`, the main one first. Parts that are aliases
 * become `ref` (a `var()`), so they follow the token they read; without `ref` they must be resolved.
 */
export function tokenVariables(type: string, value: unknown, ref?: AliasRef): Array<[string, string]> {
  const target = aliasTarget(value);
  if (target && ref) return variableSuffixes(type).map((suffix) => [suffix, ref(target, suffix)] as [string, string]);
  if (type === "spring") {
    const spring = value as Spring;
    const curve = springCurve(spring);
    return [
      ["", `linear(${curve.points.join(", ")})`],
      ["-duration", `${curve.durationMs}ms`],
      ["-stiffness", String(spring.stiffness)],
      ["-damping", String(spring.damping)],
      ["-mass", String(spring.mass)],
    ];
  }
  const vars: Array<[string, string]> = [["", cssValue(type, value, ref)]];
  for (const [suffix, key, partType] of PARTS[type] ?? []) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    const css = partType === "lineHeight" ? part(raw as number | Dimension, lineHeight, ref) : partType === "fontWeight" ? part(raw, String, ref) : cssValue(partType, raw, ref);
    vars.push([suffix, css]);
  }
  return vars;
}

/** Replace every alias in a value with the value it reads (deeply), using `lookup`; unknown aliases stay. */
export function resolveAliases(value: unknown, lookup: (path: string) => unknown, seen: ReadonlySet<string> = new Set()): unknown {
  const target = aliasTarget(value);
  if (target) {
    if (seen.has(target)) return value;
    const next = lookup(target);
    return next === undefined ? value : resolveAliases(next, lookup, new Set([...seen, target]));
  }
  if (Array.isArray(value)) return value.map((v) => resolveAliases(v, lookup, seen));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveAliases(v, lookup, seen)]));
  return value;
}
