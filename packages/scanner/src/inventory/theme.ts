/**
 * A project's own theme, so `rounded-md` means what it means there (8px in one product, 6px in
 * Tailwind's defaults). Values come from, last wins: Tailwind's defaults, a statically read
 * `tailwind.config.*` (never executed), then `@theme` and `:root` variables in the project's CSS.
 * Lengths resolve through var() and calc() to px.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";
import { readRules, splitTopLevel, type CssRule } from "@youiyoux/tokens";
import { unquote } from "../parse.ts";

const ROOT_FONT_SIZE = 16;
/** Pill radii (9999px, 999px, or anything at least half the height) are all this. */
export const PILL = 9999;

const TEXT_SCALE: Record<string, [string, string]> = {
  xs: ["0.75rem", "1rem"],
  sm: ["0.875rem", "1.25rem"],
  base: ["1rem", "1.5rem"],
  lg: ["1.125rem", "1.75rem"],
  xl: ["1.25rem", "1.75rem"],
  "2xl": ["1.5rem", "2rem"],
  "3xl": ["1.875rem", "2.25rem"],
  "4xl": ["2.25rem", "2.5rem"],
  "5xl": ["3rem", "1"],
  "6xl": ["3.75rem", "1"],
};
const WEIGHTS: Record<string, string> = { thin: "100", extralight: "200", light: "300", normal: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800", black: "900" };
const LEADING: Record<string, string> = { none: "1", tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625", loose: "2" };
const RADIUS_V4: Record<string, string> = { none: "0", xs: "0.125rem", sm: "0.25rem", DEFAULT: "0.25rem", md: "0.375rem", lg: "0.5rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.5rem", "4xl": "2rem", full: "9999px" };
const RADIUS_V3: Record<string, string> = { ...RADIUS_V4, sm: "0.125rem" };

/** Tailwind's default theme as v4 variables (v3's radius scale differs at `sm`). */
function defaults(version: 3 | 4): Map<string, string> {
  const vars = new Map<string, string>([["--spacing", "0.25rem"]]);
  for (const [key, [size, leading]] of Object.entries(TEXT_SCALE)) {
    vars.set(`--text-${key}`, size);
    vars.set(`--text-${key}--line-height`, leading);
  }
  for (const [key, value] of Object.entries(WEIGHTS)) vars.set(`--font-weight-${key}`, value);
  for (const [key, value] of Object.entries(LEADING)) vars.set(`--leading-${key}`, value);
  for (const [key, value] of Object.entries(version === 4 ? RADIUS_V4 : RADIUS_V3)) vars.set(`--radius-${key}`, value);
  return vars;
}

/* ------------------------------------------------------------------ lengths */

type Quantity = { value: number; unit: "px" | "" };

/** Replace var(--x, fallback) with values, innermost first; null when one is undefined without a fallback. */
export function substituteVars(text: string, lookup: (name: string) => string | undefined, depth = 0): string | null {
  if (depth > 12) return null;
  const at = text.lastIndexOf("var(");
  if (at < 0) return text;
  let level = 0;
  let end = -1;
  for (let i = at + 3; i < text.length; i++) {
    if (text[i] === "(") level++;
    else if (text[i] === ")" && --level === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const [name, ...rest] = splitTopLevel(text.slice(at + 4, end), ",");
  const fallback = rest.length > 0 ? rest.join(",") : undefined;
  const found = name ? lookup(name.trim()) : undefined;
  const value = found !== undefined ? substituteVars(found, lookup, depth + 1) : fallback;
  if (value === null || value === undefined) return null;
  return substituteVars(`${text.slice(0, at)}${value}${text.slice(end + 1)}`, lookup, depth + 1);
}

/** A small calc() evaluator over px, rem, em and unitless numbers. */
function evaluate(text: string, fontSize: number | null): Quantity | null {
  const tokens = text.match(/-?\d*\.?\d+(?:px|rem|em|%)?|calc\(|[()+\-*/]|[a-z-]+\(|\S+/g) ?? [];
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const factor = (): Quantity | null => {
    const token = tokens[index++];
    if (token === undefined) return null;
    if (token === "(" || token === "calc(") {
      const inner = expression();
      if (tokens[index++] !== ")") return null;
      return inner;
    }
    const match = /^(-?\d*\.?\d+)(px|rem|em|%)?$/.exec(token);
    if (!match) return null;
    const n = Number(match[1]);
    if (match[2] === "px") return { value: n, unit: "px" };
    if (match[2] === "rem") return { value: n * ROOT_FONT_SIZE, unit: "px" };
    if (match[2] === "em") return fontSize === null ? null : { value: n * fontSize, unit: "px" };
    if (match[2] === "%") return null;
    return { value: n, unit: "" };
  };
  const term = (): Quantity | null => {
    let left = factor();
    while (left && (peek() === "*" || peek() === "/")) {
      const op = tokens[index++];
      const right = factor();
      if (!right) return null;
      if (op === "*") {
        if (left.unit === "px" && right.unit === "px") return null;
        left = { value: left.value * right.value, unit: left.unit || right.unit };
      } else {
        if (right.unit === "px" || right.value === 0) return null;
        left = { value: left.value / right.value, unit: left.unit };
      }
    }
    return left;
  };
  const expression = (): Quantity | null => {
    let left = term();
    while (left && (peek() === "+" || peek() === "-")) {
      const op = tokens[index++];
      const right = term();
      if (!right || (right.unit !== left.unit && right.value !== 0 && left.value !== 0)) return null;
      left = { value: op === "+" ? left.value + right.value : left.value - right.value, unit: left.unit || right.unit };
    }
    return left;
  };
  const result = expression();
  return result && index === tokens.length ? result : null;
}

export const round = (n: number): number => Math.round(n * 100) / 100;

/* -------------------------------------------------------------- the theme */

export class Theme {
  readonly tailwind: 3 | 4 | null;
  readonly warnings: string[];
  /** Project declarations only: excludes implicit Tailwind defaults. */
  readonly declared: ReadonlyMap<string, string>;
  private readonly vars: Map<string, string>;

  constructor(vars: Map<string, string>, tailwind: 3 | 4 | null, warnings: string[], declared: ReadonlyMap<string, string> = new Map()) {
    this.vars = vars;
    this.declared = declared;
    this.tailwind = tailwind;
    this.warnings = warnings;
  }

  variable(name: string): string | undefined {
    return this.vars.get(name);
  }

  /** A CSS length in px; `fontSize` resolves em. null when it cannot be resolved statically. */
  length(text: string, fontSize: number | null = null): number | null {
    const substituted = substituteVars(text.trim(), (name) => this.vars.get(name));
    if (substituted === null) return null;
    const result = evaluate(substituted.trim(), fontSize);
    if (!result) return null;
    // A unitless 0 is a length; any other unitless number is not.
    if (result.unit === "" && result.value !== 0) return null;
    return round(result.value);
  }

  /** A number with no unit (font-weight, a line-height multiplier). */
  number(text: string): number | null {
    const substituted = substituteVars(text.trim(), (name) => this.vars.get(name));
    if (substituted === null) return null;
    const result = evaluate(substituted.trim(), null);
    return result && result.unit === "" ? result.value : null;
  }

  /** A line height in px: a length, or a multiplier of the font size. */
  lineHeight(text: string, fontSize: number | null): number | null {
    const multiplier = this.number(text);
    if (multiplier !== null) return fontSize === null ? null : round(multiplier * fontSize);
    return this.length(text, fontSize);
  }
}

/* ------------------------------------------------------- tailwind.config.* */

const CONFIG_FILES = ["tailwind.config.ts", "tailwind.config.mts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];
/** Tailwind v3 theme keys → v4 variable namespaces. */
const NAMESPACES: Record<string, string> = { borderRadius: "radius", spacing: "spacing", fontSize: "text", fontWeight: "font-weight", lineHeight: "leading" };

function keyText(node: SgNode | null): string | null {
  if (!node) return null;
  const kind = node.kind();
  if (kind === "property_identifier" || kind === "identifier") return node.text();
  if (kind === "string" || kind === "number") return unquote(node.text());
  return null;
}

function literal(node: SgNode | null): string | null {
  if (!node) return null;
  if (node.kind() === "string") return unquote(node.text());
  if (node.kind() === "number") return `${node.text()}px`;
  if (node.kind() === "template_string" && !node.text().includes("${")) return unquote(node.text());
  return null;
}

function pairsOf(object: SgNode): Array<{ key: string | null; value: SgNode | null; node: SgNode }> {
  return object.children().filter((c) => c.kind() === "pair" || c.kind() === "spread_element" || c.kind() === "method_definition" || c.kind() === "shorthand_property_identifier").map((node) => ({ key: node.kind() === "pair" ? keyText(node.field("key")) : null, value: node.kind() === "pair" ? node.field("value") : null, node }));
}

/** Read `theme` and `theme.extend` from a Tailwind config without running it. */
async function readTailwindConfig(root: string): Promise<{ file: string | null; vars: Map<string, string>; warnings: string[] }> {
  const vars = new Map<string, string>();
  const warnings: string[] = [];
  for (const name of CONFIG_FILES) {
    const source = await readFile(join(root, name), "utf8").catch(() => null);
    if (source === null) continue;
    const top = (await parseAsync(Lang.TypeScript, source)).root();
    const theme = top.findAll({ rule: { kind: "pair" } }).find((p) => keyText(p.field("key")) === "theme" && p.field("value")?.kind() === "object");
    if (!theme) {
      if (/\btheme\s*:/.test(source)) warnings.push(`${name}: its theme is not an object literal, so Tailwind's defaults are used`);
      return { file: name, vars, warnings };
    }
    const scopes = [theme.field("value")!];
    const extend = pairsOf(theme.field("value")!).find((p) => p.key === "extend")?.value;
    if (extend?.kind() === "object") scopes.push(extend);
    for (const scope of scopes) {
      for (const pair of pairsOf(scope)) {
        if (pair.key === "extend") continue;
        const namespace = pair.key ? NAMESPACES[pair.key] : undefined;
        if (!pair.key) warnings.push(`${name}:${pair.node.range().start.line + 1}: ${pair.node.text().slice(0, 40)} cannot be read statically`);
        if (!namespace) continue;
        if (pair.value?.kind() !== "object") {
          warnings.push(`${name}:${pair.node.range().start.line + 1}: theme.${pair.key} is not an object literal; its values are not read`);
          continue;
        }
        for (const entry of pairsOf(pair.value)) {
          const line = entry.node.range().start.line + 1;
          if (!entry.key) {
            warnings.push(`${name}:${line}: ${entry.node.text().slice(0, 40)} in theme.${pair.key} cannot be read statically`);
            continue;
          }
          let value = literal(entry.value);
          if (namespace === "text" && entry.value?.kind() === "array") {
            const [size, second] = entry.value.children().filter((c) => c.isNamed());
            value = literal(size ?? null);
            const leading = second?.kind() === "object" ? pairsOf(second).find((p) => p.key === "lineHeight")?.value ?? null : (second ?? null);
            const leadingValue = leading?.kind() === "number" ? leading.text() : literal(leading);
            if (leadingValue) vars.set(`--text-${entry.key}--line-height`, leadingValue);
          }
          if ((namespace === "font-weight" || namespace === "leading") && entry.value?.kind() === "number") value = entry.value.text();
          if (value === null) warnings.push(`${name}:${line}: theme.${pair.key}.${entry.key} is not a literal value`);
          else vars.set(`--${namespace}-${entry.key}`, value);
        }
      }
    }
    return { file: name, vars, warnings };
  }
  return { file: null, vars, warnings };
}

/* -------------------------------------------------------------- CSS input */

export interface Stylesheet {
  readonly file: string;
  readonly source: string;
  readonly rules: readonly CssRule[];
}

export async function readStylesheet(file: string, source: string): Promise<Stylesheet> {
  return { file, source, rules: readRules(source) };
}

const THEME_SCOPES = new Set([":root", "html", ":host", "@theme", "@theme inline", "@theme static", "@theme inline static"]);

/** The theme for one project: its CSS variables and Tailwind setup over Tailwind's defaults. */
export async function buildTheme(root: string, sheets: readonly Stylesheet[], usesTailwindPackage: boolean): Promise<Theme> {
  const config = await readTailwindConfig(root);
  const v4 = sheets.some((s) => /@import\s+["']tailwindcss|@theme\b/.test(s.source));
  const v3 = config.file !== null || sheets.some((s) => /@tailwind\s+(base|components|utilities)/.test(s.source));
  const version = v4 ? 4 : v3 || usesTailwindPackage ? 3 : null;
  const vars = version ? defaults(version) : new Map<string, string>();
  const declared = new Map(config.vars);
  for (const [name, value] of config.vars) vars.set(name, value);
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      // Only top-level theme scopes: a dark-mode or media override is a different context.
      if (rule.preludes.length !== 1 || !THEME_SCOPES.has(rule.preludes[0]!.replace(/\s+/g, " "))) continue;
      for (const declaration of rule.declarations) if (declaration.property.startsWith("--")) {
        vars.set(declaration.property, declaration.value);
        declared.set(declaration.property, declaration.value);
      }
    }
  }
  return new Theme(vars, version, config.warnings, declared);
}
