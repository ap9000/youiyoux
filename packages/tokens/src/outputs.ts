/** Non-CSS-variable outputs rendered from resolved tokens: Tailwind v4 @theme, TS, React Native. */
import type { OutputConfig } from "@youiyoux/core";
import { formatCssColor, type DtcgColor } from "./color.ts";
import type { ResolvedToken } from "./build.ts";

interface Dimension {
  value: number;
  unit: string;
}

interface ShadowLayer {
  color: DtcgColor;
  offsetX: Dimension;
  offsetY: Dimension;
  blur: Dimension;
  spread: Dimension;
  inset?: boolean;
}

interface Typography {
  fontFamily: string[] | string;
  fontSize: Dimension;
  fontWeight: number;
  lineHeight: number | Dimension;
  letterSpacing?: Dimension;
}

const dim = (d: Dimension): string => `${d.value}${d.unit}`;
const quoteFamily = (f: string): string => (/^[a-z-]+$/i.test(f) && !/\s/.test(f) ? f : `"${f}"`);

/** A token value as CSS text (used for TS output and literal theme entries). */
export function cssValue(type: string, value: unknown): string {
  switch (type) {
    case "color":
      return formatCssColor(value as DtcgColor);
    case "dimension":
      return dim(value as Dimension);
    case "fontFamily":
      return (Array.isArray(value) ? value : [String(value)]).map(quoteFamily).join(", ");
    case "cubicBezier":
      return `cubic-bezier(${(value as number[]).join(", ")})`;
    case "shadow":
      return (Array.isArray(value) ? (value as ShadowLayer[]) : [value as ShadowLayer])
        .map((l) => `${l.inset ? "inset " : ""}${dim(l.offsetX)} ${dim(l.offsetY)} ${dim(l.blur)} ${dim(l.spread)} ${formatCssColor(l.color)}`)
        .join(", ");
    case "typography": {
      const t = value as Typography;
      const lh = typeof t.lineHeight === "number" ? t.lineHeight : dim(t.lineHeight);
      return `${t.fontWeight} ${dim(t.fontSize)}/${lh} ${cssValue("fontFamily", t.fontFamily)}`;
    }
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

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
  return namespace && name ? [[`${namespace}-${name}`, ref]] : [];
}

export interface ThemeEntry {
  /** The CSS the theme variable reads. */
  readonly css: string;
  /** The token behind it, when there is one. */
  readonly token?: string;
}

/** Tailwind theme variables (without `--`) for a project: every token's name plus the project's map, map wins. */
export function tailwindTheme(tokens: readonly ResolvedToken[], output: OutputConfig): Map<string, ThemeEntry> {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const entries = new Map<string, ThemeEntry>();
  if (output.tailwind.includeAll) {
    for (const token of tokens) for (const [key, css] of tailwindEntries(token, output.cssVarPrefix)) entries.set(key, { css, token: token.id });
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
      const t = value as Typography;
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
    default:
      return cssValue(type, value);
  }
}

/** React Native: numbers for dimensions (px), first family only, `boxShadow` strings (RN ≥ 0.76). */
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
