/**
 * Classes → one resolved shape. Plain CSS rules for the classes apply first, then Tailwind
 * utilities in class order (a CVA base, then its variants, then the call site's className), each
 * resolved with the project's theme. Breakpoint and state variants, and pseudo-class or media
 * rules, are recorded on the look and never applied: a family is decided by the resting shape.
 */
import { SHAPE_DIMENSIONS, type InventoryShape, type ShapeDimension } from "@youiyoux/core";
import { splitTopLevel, type CssDeclaration, type CssRule } from "@youiyoux/tokens";
import { PILL, round, type Stylesheet, type Theme } from "./theme.ts";

type Prop = "height" | "minHeight" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "radius" | "fontSize" | "lineHeight" | "fontWeight" | "border";

/** Elements a browser styles itself; without Tailwind's preflight their padding and radius are unknown. */
const FORM_CONTROLS = new Set(["button", "input", "select", "textarea"]);
const BREAKPOINT = /^(?:sm|md|lg|xl|2xl|xs|3xl|max-(?:sm|md|lg|xl|2xl)|min-\[.*\]|max-\[.*\]|@.*|portrait|landscape|print)$/;

export interface ResolvedStyle {
  readonly shape: InventoryShape;
  readonly derived: ShapeDimension[];
  readonly unresolved: string[];
  readonly responsive: string[];
  readonly states: string[];
}

/** Collects declarations in order; a later one wins. `null` is "set, but not statically known". */
export class StyleAccumulator {
  private readonly values = new Map<Prop, number | null>();
  /** Line heights given as a multiplier of the font size. */
  private lineHeightFactor: number | null = null;
  /** A Tailwind text-* size brings its own line height, unless a leading-* says otherwise. */
  private textLineHeight: number | null = null;
  readonly unresolved: string[] = [];
  readonly responsive: string[] = [];
  readonly states: string[] = [];
  private preflight: boolean;
  private readonly tag: string | null;

  constructor(tag: string | null, preflight: boolean) {
    this.tag = tag;
    this.preflight = preflight;
  }

  /** Whether any declaration applied at all; an element nothing styles has no known padding or radius. */
  private touched = false;

  set(prop: Prop, value: number | null): void {
    this.touched = true;
    this.values.set(prop, value);
    if (prop === "lineHeight") this.lineHeightFactor = null;
  }

  setLineHeightFactor(factor: number): void {
    this.touched = true;
    this.values.delete("lineHeight");
    this.lineHeightFactor = factor;
  }

  setTextLineHeight(px: number | null): void {
    this.textLineHeight = px;
  }

  /** A Tailwind utility applied: the project's preflight reset is in effect for this element. */
  usedTailwind(): void {
    this.preflight = true;
  }

  /** The font size so far, for em lengths. */
  fontSizeNow(): number | null {
    return this.values.get("fontSize") ?? null;
  }

  private known(prop: Prop): number | null | undefined {
    return this.values.has(prop) ? this.values.get(prop)! : undefined;
  }

  finish(): ResolvedStyle {
    const derived: ShapeDimension[] = [];
    // Unset padding and radius are 0 (CSS initial values, or Tailwind's preflight on form controls).
    const zero = this.touched && (this.preflight || !FORM_CONTROLS.has(this.tag ?? "")) ? 0 : null;
    const axis = (a: Prop, b: Prop): number | null => {
      const x = this.known(a);
      const y = this.known(b);
      if (x === null || y === null) return null;
      if (x === undefined && y === undefined) return zero;
      if (x === undefined || y === undefined) return x ?? y ?? null;
      return (x + y) / 2;
    };
    const fontSize = this.known("fontSize") ?? null;
    const explicitLine = this.known("lineHeight");
    const lineHeight = explicitLine !== undefined ? explicitLine : this.lineHeightFactor !== null ? (fontSize === null ? null : this.lineHeightFactor * fontSize) : this.textLineHeight;
    const explicit = this.known("height") !== undefined ? this.known("height")! : this.known("minHeight");
    let height = explicit ?? null;
    if (explicit === undefined) {
      // No height given: padding + line height + border, when all of them are known.
      const top = this.known("paddingTop") === undefined ? zero : this.known("paddingTop")!;
      const bottom = this.known("paddingBottom") === undefined ? zero : this.known("paddingBottom")!;
      const border = this.known("border") ?? 0;
      if (top !== null && bottom !== null && lineHeight !== null) {
        height = top + bottom + lineHeight + 2 * border;
        derived.push("height");
      }
    }
    const radius = this.known("radius") === undefined ? zero : this.known("radius")!;
    // A pill is a pill whatever number spells it: 9999px, 999px, or half the height.
    const radiusValue = radius !== null && (radius >= 999 || (height !== null && height > 0 && radius * 2 >= height)) ? PILL : radius;
    const shape = {
      height: height === null ? null : round(height),
      paddingX: axis("paddingLeft", "paddingRight"),
      paddingY: axis("paddingTop", "paddingBottom"),
      radius: radiusValue,
      fontSize,
      fontWeight: this.known("fontWeight") ?? null,
    } satisfies InventoryShape;
    return { shape, derived, unresolved: [...new Set(this.unresolved)], responsive: [...new Set(this.responsive)], states: [...new Set(this.states)] };
  }
}

export function hasShape(shape: InventoryShape): boolean {
  return SHAPE_DIMENSIONS.some((d) => shape[d] !== null);
}

/* ---------------------------------------------------------------- Tailwind */

/** Split `md:hover:h-8` into variants and the utility, ignoring colons inside brackets. */
function variantsOf(name: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      parts.push(name.slice(start, i));
      start = i + 1;
    }
  }
  return { variants: parts, utility: name.slice(start) };
}

function arbitrary(value: string): string | null {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).replace(/_/g, " ").replace(/^length:/, "");
  if (value.startsWith("(") && value.endsWith(")")) return `var(${value.slice(1, -1).replace(/^length:/, "")})`;
  return null;
}

/** A spacing step (`8`, `2.5`, `px`, `[30px]`, `(--x)`, or a named `--spacing-*`) in px; undefined when not a length at all. */
function spacing(value: string, theme: Theme): number | null | undefined {
  if (/^\d+(?:\.\d+)?$/.test(value)) return theme.length(`calc(var(--spacing) * ${value})`);
  if (value === "px") return 1;
  if (value === "0") return 0;
  const raw = arbitrary(value);
  if (raw !== null) return theme.length(raw);
  const named = theme.variable(`--spacing-${value}`);
  if (named !== undefined) return theme.length(named);
  return undefined;
}

const RELATIVE = /^(?:auto|full|screen|svh|lvh|dvh|min|max|fit|lh)$/;

/** Apply one Tailwind class; returns false when it is not a shape utility (colour, layout…). */
export function applyUtility(style: StyleAccumulator, name: string, theme: Theme): boolean {
  const { variants, utility: raw } = variantsOf(name.replace(/^!|!$/g, ""));
  const utility = raw.replace(/^!|!$/g, "");
  if (variants.length > 0) {
    // Recorded, never applied: the resting shape decides the family.
    (variants.some((v) => BREAKPOINT.test(v)) ? style.responsive : style.states).push(name);
    return true;
  }
  const unresolved = (): boolean => {
    style.unresolved.push(name);
    return true;
  };
  let match: RegExpExecArray | null;
  if ((match = /^(h|min-h|size)-(.+)$/.exec(utility))) {
    const [, kind, value] = match as unknown as [string, string, string];
    if (RELATIVE.test(value) || /^\d+\/\d+$/.test(value)) return unresolved();
    const px = spacing(value, theme);
    if (px === undefined) return false;
    style.usedTailwind();
    style.set(kind === "min-h" ? "minHeight" : "height", px);
    if (px === null) style.unresolved.push(name);
    return true;
  }
  if ((match = /^p([xytrblse]?)-(.+)$/.exec(utility))) {
    const [, side, value] = match as unknown as [string, string, string];
    const px = spacing(value, theme);
    if (px === undefined) return false;
    style.usedTailwind();
    const sides: Record<string, Prop[]> = { "": ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"], x: ["paddingLeft", "paddingRight"], y: ["paddingTop", "paddingBottom"], t: ["paddingTop"], b: ["paddingBottom"], r: ["paddingRight"], l: ["paddingLeft"], s: ["paddingLeft"], e: ["paddingRight"] };
    for (const prop of sides[side]!) style.set(prop, px);
    if (px === null) style.unresolved.push(name);
    return true;
  }
  if ((match = /^rounded(?:-(.+))?$/.exec(utility))) {
    const value = match[1] ?? "DEFAULT";
    if (/^(?:[trblse]|tl|tr|bl|br|ss|se|es|ee)(?:-|$)/.test(value)) return unresolved();
    style.usedTailwind();
    const raw = arbitrary(value);
    const themed = theme.variable(`--radius-${value}`);
    const px = raw !== null ? theme.length(raw) : themed !== undefined ? theme.length(themed) : null;
    style.set("radius", px);
    if (px === null) style.unresolved.push(name);
    return true;
  }
  if ((match = /^text-(.+)$/.exec(utility))) {
    const [size, leading] = splitTopLevel(match[1]!, "/");
    const raw = size ? arbitrary(size) : null;
    const themed = size ? theme.variable(`--text-${size}`) : undefined;
    if (raw === null && themed === undefined) return false;
    if (raw !== null && /^(?:#|rgb|hsl|oklch|color:|var\(--colou?r)/.test(raw)) return false;
    const px = raw !== null ? theme.length(raw) : theme.length(themed!);
    if (raw !== null && px === null && !raw.startsWith("var(")) return false;
    style.usedTailwind();
    style.set("fontSize", px);
    const ownLeading = themed !== undefined ? theme.variable(`--text-${size}--line-height`) : undefined;
    style.setTextLineHeight(ownLeading !== undefined && px !== null ? theme.lineHeight(ownLeading, px) : null);
    if (leading !== undefined) applyLeading(style, leading, theme);
    if (px === null) style.unresolved.push(name);
    return true;
  }
  if ((match = /^font-(.+)$/.exec(utility))) {
    const value = match[1]!;
    const raw = arbitrary(value);
    const themed = theme.variable(`--font-weight-${value}`);
    if (raw === null && themed === undefined) return false;
    const weight = theme.number(raw ?? themed!);
    if (raw !== null && weight === null) return false;
    style.usedTailwind();
    style.set("fontWeight", weight);
    return true;
  }
  if ((match = /^leading-(.+)$/.exec(utility))) {
    style.usedTailwind();
    if (!applyLeading(style, match[1]!, theme)) style.unresolved.push(name);
    return true;
  }
  if ((match = /^border(?:-(\d+|\[[^\]]+\]))?$/.exec(utility))) {
    style.usedTailwind();
    const value = match[1];
    style.set("border", value === undefined ? 1 : /^\d+$/.test(value) ? Number(value) : theme.length(arbitrary(value)!));
    return true;
  }
  return false;
}

function applyLeading(style: StyleAccumulator, value: string, theme: Theme): boolean {
  const named = theme.variable(`--leading-${value}`);
  if (named !== undefined) {
    const factor = theme.number(named);
    if (factor !== null) style.setLineHeightFactor(factor);
    else style.set("lineHeight", theme.length(named));
    return true;
  }
  const px = spacing(value, theme);
  if (px === undefined) return false;
  style.set("lineHeight", px);
  return px !== null;
}

/* --------------------------------------------------------------- CSS rules */

interface ClassRule {
  readonly classes: readonly string[];
  /** Pseudo-classes, attribute selectors or an outer @media/@container: recorded, not applied. */
  readonly condition: { readonly kind: "state" | "responsive"; readonly label: string } | null;
  readonly declarations: readonly CssDeclaration[];
  readonly order: number;
}

/** Class rules from a project's stylesheets: only single-compound selectors made of classes (`.a.b:hover`). */
export class ClassRules {
  /** Rules by each class they name, so a look only looks at rules that could match it. */
  private readonly byClass = new Map<string, ClassRule[]>();
  private order = 0;

  add(rules: readonly CssRule[]): void {
    for (const rule of rules) {
      const outer = rule.preludes.slice(0, -1).filter((p) => !p.startsWith("@layer"));
      if (outer.some((p) => !p.startsWith("@"))) continue; // nested selectors: not read
      const media = outer.find((p) => /^@(?:media|container|supports)/.test(p));
      for (const selector of splitTopLevel(rule.preludes.at(-1) ?? "", ",")) {
        const compound = /^((?:\.[\w-]+)+)((?::{1,2}[\w-]+(?:\([^)]*\))?|\[[^\]]*\])*)$/.exec(selector.replace(/^[a-z]+(?=\.)/, "").trim());
        if (!compound) continue;
        const classes = compound[1]!.slice(1).split(".");
        const pseudo = compound[2] ?? "";
        const condition = media ? { kind: "responsive" as const, label: `${media} ${selector.trim()}` } : pseudo ? { kind: "state" as const, label: selector.trim() } : null;
        const entry = { classes, condition, declarations: rule.declarations, order: this.order++ };
        for (const name of classes) this.byClass.set(name, [...(this.byClass.get(name) ?? []), entry]);
      }
    }
  }

  addSheet(sheet: Stylesheet): void {
    this.add(sheet.rules);
  }

  apply(style: StyleAccumulator, classes: readonly string[], theme: Theme): void {
    const present = new Set(classes);
    const candidates = new Set([...present].flatMap((c) => this.byClass.get(c) ?? []));
    const matching = [...candidates].filter((r) => r.classes.every((c) => present.has(c))).sort((a, b) => a.classes.length - b.classes.length || a.order - b.order);
    for (const rule of matching) {
      if (rule.condition) {
        (rule.condition.kind === "state" ? style.states : style.responsive).push(rule.condition.label);
        continue;
      }
      // The font size first (font-size or the font shorthand): em and unitless line heights depend
      // on it. Then every declaration in source order, so a later font-weight still beats `font`.
      const selector = `.${rule.classes.join(".")}`;
      const sizing = rule.declarations.filter((d) => d.property === "font-size" || d.property === "font");
      for (const declaration of [...sizing, ...rule.declarations]) applyDeclaration(style, declaration, theme, selector);
    }
  }
}

/** Declarations that set a shape dimension: what makes a stylesheet class a kit member. */
export const SHAPE_PROPERTIES = /^(?:height|min-height|padding(?:-.+)?|border-radius|font|font-size|font-weight)$/;

const PADDING_SIDES: Record<string, Prop[]> = {
  "padding-top": ["paddingTop"],
  "padding-bottom": ["paddingBottom"],
  "padding-left": ["paddingLeft"],
  "padding-right": ["paddingRight"],
  "padding-inline-start": ["paddingLeft"],
  "padding-inline-end": ["paddingRight"],
  "padding-block-start": ["paddingTop"],
  "padding-block-end": ["paddingBottom"],
};
const WEIGHT_KEYWORDS: Record<string, number> = { normal: 400, bold: 700 };
/** `font` shorthand tokens before the size that are not a weight: style, variant, stretch. */
const FONT_PREFIX = /^(?:italic|oblique|small-caps|(?:ultra-|extra-|semi-)?(?:condensed|expanded))$/;

/**
 * `font: [style] [variant] [weight] [stretch] size[/line-height] family`: the size, weight and
 * line height. A weight left out is the shorthand's reset, 400; a line height left out is
 * `normal`, which depends on the font and stays unknown. A system font keyword or a var() is
 * not read: size and weight are then unknown, never guessed.
 */
function applyFont(style: StyleAccumulator, value: string, length: (text: string) => number | null, theme: Theme, fail: () => void): void {
  const tokens = splitTopLevel(value, " ").filter(Boolean);
  let weight: number | null = 400;
  let i = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (FONT_PREFIX.test(token) || token === "normal") continue;
    if (token in WEIGHT_KEYWORDS) weight = WEIGHT_KEYWORDS[token]!;
    else if (token === "bolder" || token === "lighter") weight = null;
    else if (/^\d+$/.test(token) && Number(token) >= 1 && Number(token) <= 1000) weight = Number(token);
    else break;
  }
  // `14px/20px`, `14px /20px` or `14px / 20px`.
  const rest = tokens.slice(i).join(" ");
  const sized = /^([^\s/]+)\s*(?:\/\s*([^\s]+))?\s+\S/.exec(rest);
  const size = sized ? length(sized[1]!) : null;
  if (size === null) {
    style.set("fontSize", null);
    style.set("fontWeight", null);
    style.set("lineHeight", null);
    return fail();
  }
  style.set("fontSize", size);
  style.set("fontWeight", weight);
  const line = sized![2];
  if (line === undefined || line === "normal") return style.set("lineHeight", null);
  const factor = theme.number(line);
  if (factor !== null) return style.setLineHeightFactor(factor);
  const px = length(line);
  style.set("lineHeight", px);
  if (px === null) fail();
}

function applyDeclaration(style: StyleAccumulator, declaration: CssDeclaration, theme: Theme, selector: string): void {
  const value = declaration.value.replace(/\s*!important\s*$/, "");
  const fail = (): void => void style.unresolved.push(`${selector} { ${declaration.property}: ${value} }`);
  const length = (text: string): number | null => theme.length(text, style.fontSizeNow());
  const set = (prop: Prop, px: number | null): void => {
    style.set(prop, px);
    if (px === null) fail();
  };
  switch (declaration.property) {
    case "height":
      return /^(?:auto|100%|fit-content|max-content|min-content)$/.test(value) ? fail() : set("height", length(value));
    case "min-height":
      return set("minHeight", length(value));
    case "padding": {
      const parts = splitTopLevel(value, " ").map(length);
      const [top, right = top, bottom = top, left = right] = parts;
      if (top === undefined) return fail();
      style.set("paddingTop", top ?? null);
      style.set("paddingRight", right ?? null);
      style.set("paddingBottom", bottom ?? null);
      style.set("paddingLeft", left ?? null);
      if (parts.some((p) => p === null)) fail();
      return;
    }
    case "padding-inline":
    case "padding-block": {
      const [a, b = a] = splitTopLevel(value, " ").map(length);
      const [first, second]: [Prop, Prop] = declaration.property === "padding-inline" ? ["paddingLeft", "paddingRight"] : ["paddingTop", "paddingBottom"];
      style.set(first, a ?? null);
      style.set(second, b ?? null);
      if (a === null || b === null) fail();
      return;
    }
    case "border-radius": {
      const parts = splitTopLevel(value.split("/")[0]!, " ").map(length);
      const all = parts.every((p) => p !== null && p === parts[0]);
      return set("radius", all ? parts[0]! : null);
    }
    case "font-size":
      return set("fontSize", length(value));
    case "font-weight":
      return set("fontWeight", WEIGHT_KEYWORDS[value] ?? theme.number(value));
    case "line-height": {
      const factor = theme.number(value);
      if (factor !== null) return style.setLineHeightFactor(factor);
      return set("lineHeight", length(value));
    }
    case "border":
    case "border-width": {
      if (/^(?:none|0)$/.test(value)) return style.set("border", 0);
      const width = splitTopLevel(value, " ").map((p) => (p === "thin" ? 1 : p === "medium" ? 3 : p === "thick" ? 5 : length(p))).find((p) => p !== null);
      return set("border", width ?? null);
    }
    case "font":
      return applyFont(style, value, length, theme, fail);
    default:
      if (PADDING_SIDES[declaration.property]) for (const prop of PADDING_SIDES[declaration.property]!) set(prop, length(value));
  }
}

/** Resolve a look's classes (in precedence order) for an element whose root tag is `tag`. */
export function resolveClasses(classes: readonly string[], tag: string | null, theme: Theme, rules: ClassRules): ResolvedStyle & { tailwindClasses: number } {
  const style = new StyleAccumulator(tag, false);
  rules.apply(style, classes, theme);
  let tailwindClasses = 0;
  if (theme.tailwind) for (const name of classes) if (applyUtility(style, name, theme)) tailwindClasses++;
  return { ...style.finish(), tailwindClasses };
}
