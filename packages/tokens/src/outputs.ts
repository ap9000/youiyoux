/** Non-CSS-variable outputs rendered from resolved tokens: Tailwind v4 @theme, TS, React Native. */
import type { ComponentContract, OutputConfig } from "@youiyoux/core";
import type { ResolvedToken } from "./build.ts";
import { cssValue, springCurve, tokenVariables, variableSuffixes, type Dimension, type FocusRing, type Spring, type Typography } from "./values.ts";

const NAMESPACE: Record<string, string> = { color: "color", radius: "radius", space: "spacing", font: "font", shadow: "shadow", easing: "ease" };

/** Tailwind theme variable names (without `--`) for a token, with the CSS each one should read. */
function tailwindEntries(token: ResolvedToken, prefix: string): Array<[string, string]> {
  const [group, ...rest] = token.id.split(".");
  const name = rest.join("-");
  const ref = `var(--${prefix}-${token.cssName})`;
  if (token.type === "typography") {
    const sub = (s: string): string => `var(--${prefix}-${token.cssName}-${s})`;
    const t = token.light as Typography;
    return [
      [`text-${name}`, sub("font-size")],
      [`text-${name}--line-height`, sub("line-height")],
      [`text-${name}--font-weight`, sub("font-weight")],
      ...(t.letterSpacing ? ([[`text-${name}--letter-spacing`, sub("letter-spacing")]] as Array<[string, string]>) : []),
    ];
  }
  const namespace = NAMESPACE[group ?? ""];
  if (namespace && name) return [[`${namespace}-${name}`, ref]];
  // Motion and focus tokens live in any group: their type says which Tailwind names they get.
  const named = rest.filter((segment) => !/^(?:durations?|easings?)$/.test(segment)).join("-") || name;
  switch (token.type) {
    case "duration":
      return named ? [[`transition-duration-${named}`, ref]] : [];
    case "cubicBezier":
      return named ? [[`ease-${named}`, ref]] : [];
    case "spring":
      // `ease-spring-snappy duration-spring-snappy`: the spring's curve and its settle time.
      return named ? [[`ease-${named}`, ref], [`transition-duration-${named}`, `var(--${prefix}-${token.cssName}-duration)`]] : [];
    case "focusRing":
      // The ring's colour for outline-/ring- utilities; the ring itself is var(--<prefix>-<name>) (an outline shorthand).
      return [[`color-${token.id.replace(/\./g, "-")}`, `var(--${prefix}-${token.cssName}-color)`]];
    default:
      return [];
  }
}

export interface ThemeEntry {
  /** The CSS the theme variable reads. */
  readonly css: string;
  /** The token behind it, when there is one. */
  readonly token?: string;
}

const SIZES = ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];
/**
 * Names Tailwind v4 already gives a meaning. Emitting them silently changes existing classes:
 * `--spacing-2xl` would turn `max-w-2xl` (a container width) into a 24px gap, and
 * `--ease-out` would retime every `ease-out` transition. Only an explicit map entry may.
 */
const TAILWIND_RESERVED = new Set([
  ...SIZES.flatMap((size) => [`spacing-${size}`, `radius-${size}`, `text-${size}`, `shadow-${size}`]),
  "radius-full", "text-base", "shadow-inner", "ease-in", "ease-out", "ease-in-out", "ease-linear", "font-sans", "font-serif", "font-mono",
]);

export function isReservedTailwindKey(key: string): boolean {
  return TAILWIND_RESERVED.has(key.replace(/--.*$/, ""));
}

/** Tailwind theme variables (without `--`) for a project: token names that do not collide with Tailwind's own, plus the project's map (which wins). */
export function tailwindTheme(tokens: readonly ResolvedToken[], output: OutputConfig): Map<string, ThemeEntry> {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const entries = new Map<string, ThemeEntry>();
  if (output.tailwind.includeAll) {
    for (const token of tokens) {
      for (const [key, css] of tailwindEntries(token, output.cssVarPrefix)) if (!isReservedTailwindKey(key)) entries.set(key, { css, token: token.id });
    }
  }
  for (const [key, target] of Object.entries(output.tailwind.map)) {
    const token = byId.get(target);
    entries.set(key, token ? { css: `var(--${output.cssVarPrefix}-${token.cssName})`, token: token.id } : { css: target });
  }
  return entries;
}

export function renderTailwind(tokens: readonly ResolvedToken[], output: OutputConfig, header: string): string {
  const entries = tailwindTheme(tokens, output);
  const lines = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `  --${key}: ${value.css};`);
  return `${header}\n/* Tailwind v4 theme: utilities read the design-language CSS variables, so light and dark follow tokens.css. */\n@theme inline {\n${lines.join("\n")}\n}\n`;
}

function tsLiteral(map: Record<string, unknown>): string {
  const body = Object.entries(map)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
  return `{\n${body}\n}`;
}

export function renderTs(tokens: readonly ResolvedToken[], prefix: string, header: string): string {
  const vars = Object.fromEntries(tokens.map((t) => [t.id, `var(--${prefix}-${t.cssName})`]));
  const light = Object.fromEntries(tokens.map((t) => [t.id, cssValue(t.type, t.light)]));
  const dark = Object.fromEntries(tokens.map((t) => [t.id, cssValue(t.type, t.dark)]));
  return [
    header,
    "/** CSS variable for each token: use where a class cannot reach (inline styles, canvas, charts). */",
    `export const cssVar = ${tsLiteral(vars)} as const;`,
    "",
    "export type TokenId = keyof typeof cssVar;",
    "",
    "/** Resolved values per scheme, for non-CSS consumers. Prefer cssVar in the browser so themes switch live. */",
    `export const light: Record<TokenId, string> = ${tsLiteral(light)};`,
    "",
    `export const dark: Record<TokenId, string> = ${tsLiteral(dark)};`,
    "",
  ].join("\n");
}

function nativeValue(type: string, value: unknown): unknown {
  const px = (d: Dimension): number => (d.unit === "rem" ? d.value * 16 : d.value);
  switch (type) {
    case "dimension":
      return px(value as Dimension);
    case "typography": {
      const t = value as Typography & { fontSize: Dimension; lineHeight: number | Dimension; letterSpacing?: Dimension };
      const size = px(t.fontSize);
      const family = Array.isArray(t.fontFamily) ? t.fontFamily[0] : t.fontFamily;
      return {
        fontFamily: family,
        fontSize: size,
        fontWeight: String(t.fontWeight),
        lineHeight: typeof t.lineHeight === "number" ? Math.round(t.lineHeight * size * 100) / 100 : px(t.lineHeight),
        ...(t.letterSpacing ? { letterSpacing: px(t.letterSpacing) } : {}),
      };
    }
    case "shadow":
      return cssValue("shadow", value);
    case "fontFamily":
      return Array.isArray(value) ? value[0] : value;
    case "duration": {
      const d = value as Dimension;
      return d.unit === "s" ? d.value * 1000 : d.value;
    }
    case "spring": {
      // The config Reanimated's withSpring (and most native spring APIs) take, plus its settle time.
      const { stiffness, damping, mass, velocity } = value as Spring;
      return { stiffness, damping, mass, ...(velocity !== undefined ? { velocity } : {}), durationMs: springCurve(value as Spring).durationMs };
    }
    case "focusRing": {
      const f = value as FocusRing;
      return { color: cssValue("color", f.color), width: px(f.width as Dimension), offset: px(f.offset as Dimension), style: f.style };
    }
    default:
      return cssValue(type, value);
  }
}

/** React Native: numbers for dimensions (px) and durations (ms), first family only, `boxShadow` strings (RN ≥ 0.76), spring configs and focus ring parts as objects. */
export function renderNative(tokens: readonly ResolvedToken[], header: string): string {
  const scheme = (pick: (t: ResolvedToken) => unknown): Record<string, unknown> => Object.fromEntries(tokens.map((t) => [t.id, nativeValue(t.type, pick(t))]));
  return [
    header,
    "/** React Native values per scheme: dimensions in px (rem × 16), colours as CSS strings, shadows as boxShadow. */",
    `export const light = ${tsLiteral(scheme((t) => t.light))} as const;`,
    "",
    `export const dark = ${tsLiteral(scheme((t) => t.dark))} as const;`,
    "",
    "export type NativeTokenId = keyof typeof light;",
    "",
  ].join("\n");
}

/**
 * Component state variables: each binding in a contract's `states` becomes
 * `--<prefix>-<component>-<state>-<role>` reading the bound token's variable (and its part
 * variables, for composites), so the owned implementation reads the state from one place and a
 * re-bound state changes no code. Dark follows, because each reads a token variable.
 */
export function stateVariables(contracts: readonly Pick<ComponentContract, "id" | "states">[], tokens: readonly ResolvedToken[], prefix: string): Array<[string, string]> {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const vars: Array<[string, string]> = [];
  for (const contract of contracts) {
    const component = contract.id.split("/").at(-1)!;
    for (const [state, bindings] of Object.entries(contract.states ?? {})) {
      for (const [role, tokenId] of Object.entries(bindings ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const token = byId.get(tokenId.replace(/^youi:[a-z][a-z0-9-]*\/token\//, ""));
        if (!token) continue;
        for (const suffix of variableSuffixes(token.type)) vars.push([`--${prefix}-${component}-${state}-${role.replace(/\./g, "-")}${suffix}`, `var(--${prefix}-${token.cssName}${suffix})`]);
      }
    }
  }
  return vars;
}

/** Declarations for the variables Terrazzo does not emit (the youi types), per scheme: aliases stay var() references. */
export function youiTypeVariables(tokens: readonly ResolvedToken[], prefix: string, scheme: "light" | "dark"): Array<[string, string]> {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const ref = (path: string, suffix = ""): string => `var(--${prefix}-${byId.get(path)?.cssName ?? path.replace(/\./g, "-")}${suffix})`;
  return tokens
    .filter((t) => t.type === "spring" || t.type === "focusRing")
    .flatMap((t) => tokenVariables(t.type, t.source?.[scheme] ?? t[scheme], ref).map(([suffix, css]) => [`--${prefix}-${t.cssName}${suffix}`, css] as [string, string]));
}
