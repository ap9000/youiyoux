/**
 * A deliberately small CSS reader: enough to lift custom properties out of
 * rule blocks (including blocks nested in @media) and to parse the token value
 * shapes Signal uses. It is not a general CSS parser.
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

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function parseDeclarations(css: string, start: number, body: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  const pattern = /(--?[A-Za-z0-9_-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?:;|$)/g;
  for (const match of body.matchAll(pattern)) {
    declarations.push({ property: match[1]!, value: match[2]!.trim(), line: lineAt(css, start + (match.index ?? 0)) });
  }
  return declarations;
}

/** Every rule with its own (non-nested) declarations, in source order. */
export function readRules(source: string): CssRule[] {
  const css = blankComments(source);
  const rules: CssRule[] = [];
  const stack: Array<{ prelude: string; bodyStart: number; childText: string[] }> = [];
  let segmentStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      const prelude = css.slice(segmentStart, i).split(";").pop()!.trim();
      stack.at(-1)?.childText.push(css.slice(segmentStart, i));
      stack.push({ prelude, bodyStart: i + 1, childText: [] });
      segmentStart = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (!frame) continue;
      frame.childText.push(css.slice(segmentStart, i));
      const own = css.slice(frame.bodyStart, i);
      // Remove nested blocks from this rule's own text before reading declarations.
      let flat = own;
      for (let previous = ""; previous !== flat; ) {
        previous = flat;
        flat = flat.replace(/[^{};]*\{[^{}]*\}/g, (block) => block.replace(/[^\n]/g, " "));
      }
      const declarations = parseDeclarations(css, frame.bodyStart, flat);
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
