/**
 * A deliberately small CSS reader: enough to lift custom properties out of
 * rule blocks (including blocks nested in @media) and to parse the token value
 * shapes design tokens use. It is not a general CSS parser.
 */
import { parseCssColor, type DtcgColor } from "./color.ts";

export interface CssDeclaration {
  readonly property: string;
  readonly value: string;
  /** 1-based line of the property name. */
  readonly line: number;
}

export interface CssRule {
  /** Outer-to-inner preludes, e.g. ["@media (prefers-color-scheme: dark)", ":root:not([data-theme=\"light\"])"]. */
  readonly preludes: readonly string[];
  readonly declarations: readonly CssDeclaration[];
}

/** Replace comments with spaces of equal length, keeping newlines so offsets and lines survive. */
export function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Offsets of each line start, for O(log n) offset → line lookups. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function parseDeclarations(starts: readonly number[], start: number, body: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  const pattern = /(--?[A-Za-z0-9_-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?:;|$)/g;
  for (const match of body.matchAll(pattern)) {
    declarations.push({ property: match[1]!, value: match[2]!.trim(), line: lineAt(starts, start + (match.index ?? 0)) });
  }
  return declarations;
}

/** Every rule with its own (non-nested) declarations, in source order. */
export function readRules(source: string): CssRule[] {
  const css = blankComments(source);
  const starts = lineStarts(css);
  const rules: CssRule[] = [];
  // Each open block collects its own declaration text in chunks; a nested block's prelude and
  // body never land in its parent's chunks, so one linear pass is enough.
  const stack: Array<{ prelude: string; chunks: Array<{ start: number; text: string }> }> = [];
  let segmentStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      const segment = css.slice(segmentStart, i);
      const cut = segment.lastIndexOf(";") + 1;
      stack.at(-1)?.chunks.push({ start: segmentStart, text: segment.slice(0, cut) });
      stack.push({ prelude: segment.slice(cut).trim(), chunks: [] });
      segmentStart = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (!frame) continue;
      frame.chunks.push({ start: segmentStart, text: css.slice(segmentStart, i) });
      const declarations = frame.chunks.flatMap((chunk) => parseDeclarations(starts, chunk.start, chunk.text));
      if (declarations.length > 0) rules.push({ preludes: [...stack.map((f) => f.prelude), frame.prelude], declarations });
      segmentStart = i + 1;
    }
  }
  return rules;
}

/** Custom properties declared directly in rules whose innermost prelude equals `selector` (later wins). */
export function customProperties(css: string, selector: string, outer?: string): Map<string, CssDeclaration> {
  const found = new Map<string, CssDeclaration>();
  for (const rule of readRules(css)) {
    if (rule.preludes.at(-1) !== selector) continue;
    if (outer !== undefined && rule.preludes.at(-2) !== outer) continue;
    if (outer === undefined && rule.preludes.length > 1) continue;
    for (const declaration of rule.declarations) {
      if (declaration.property.startsWith("--")) found.set(declaration.property, declaration);
    }
  }
  return found;
}

/** Split on `separator` outside parentheses and quotes. */
export function splitTopLevel(value: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (separator === " " ? /\s/.test(ch ?? "") : ch === separator)) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export interface DtcgDimension {
  readonly value: number;
  readonly unit: "px" | "rem";
}

export function parseDimension(value: string): DtcgDimension | null {
  const match = /^(-?\d*\.?\d+)(px|rem)?$/.exec(value.trim());
  if (!match) return null;
  return { value: Number(match[1]), unit: (match[2] as "px" | "rem" | undefined) ?? "px" };
}

export interface DtcgShadowLayer {
  readonly color: DtcgColor;
  readonly offsetX: DtcgDimension;
  readonly offsetY: DtcgDimension;
  readonly blur: DtcgDimension;
  readonly spread: DtcgDimension;
  readonly inset?: boolean;
}

/** `0 1px 2px rgb(0 0 0 / .06), …` → DTCG shadow layers; null if any layer is not literal. */
export function parseShadow(value: string): DtcgShadowLayer[] | null {
  const layers: DtcgShadowLayer[] = [];
  for (const layer of splitTopLevel(value, ",")) {
    const parts = splitTopLevel(layer, " ");
    const inset = parts.includes("inset");
    const colorPart = parts.find((p) => parseCssColor(p) !== null);
    const lengths = parts.filter((p) => p !== "inset" && p !== colorPart).map(parseDimension);
    if (!colorPart || lengths.length < 2 || lengths.some((l) => l === null)) return null;
    const [offsetX, offsetY, blur = { value: 0, unit: "px" }, spread = { value: 0, unit: "px" }] = lengths as DtcgDimension[];
    layers.push({ color: parseCssColor(colorPart)!, offsetX: offsetX!, offsetY: offsetY!, blur, spread, ...(inset ? { inset } : {}) });
  }
  return layers;
}

export function parseFontFamily(value: string): string[] {
  return splitTopLevel(value, ",").map((f) => f.replace(/^["']|["']$/g, ""));
}

export function parseCubicBezier(value: string): [number, number, number, number] | null {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value.trim());
  const numbers = match?.[1]?.split(",").map((n) => Number(n.trim()));
  return numbers && numbers.length === 4 && numbers.every(Number.isFinite) ? (numbers as [number, number, number, number]) : null;
}
