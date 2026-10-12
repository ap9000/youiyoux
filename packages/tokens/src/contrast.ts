/** WCAG 2.x contrast for resolved CSS colours (hex and rgb() forms, as the token build emits them), and the colour pairs a system must pass. Browser-safe: the hub imports it as `@youiyoux/tokens/contrast`. */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1. */
  readonly a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;

function parseHex(digits: string): Rgba {
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
  const channel = (i: number): number => parseInt(full.slice(i, i + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) / 255 : 1 };
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const value = raw.trim();
  const alpha = value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
}

function parseRgb(body: string): Rgba | null {
  const [channels = "", slashAlpha] = body.split("/");
  const parts = channels.includes(",") ? channels.split(",").map((p) => p.trim()) : channels.trim().split(/\s+/);
  const commaAlpha = parts.length === 4 ? parts.pop() : undefined;
  if (parts.length !== 3) return null;
  const values = parts.map((p) => (p.endsWith("%") ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p)));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const [r = 0, g = 0, b = 0] = values;
  return { r, g, b, a: parseAlpha(slashAlpha ?? commaAlpha) };
}

export function parseColor(css: string): Rgba | null {
  const value = css.trim();
  if (HEX.test(value)) return parseHex(value.slice(1));
  const rgb = RGB.exec(value);
  return rgb ? parseRgb(rgb[1] ?? "") : null;
}

/** `top` painted over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number): number => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast of `foreground` on `background`; translucent colours are composited first, a translucent background over `surface` (white by default). */
export function contrastRatio(foreground: string, background: string, surface = "#ffffff"): number | null {
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  if (!bg || !fg) return null;
  const under = parseColor(surface);
  const opaque = under && under.a >= 1 ? under : { r: 255, g: 255, b: 255, a: 1 };
  const base = bg.a < 1 ? composite(bg, opaque) : bg;
  const top = fg.a < 1 ? composite(fg, base) : fg;
  const [hi, lo] = [relativeLuminance(top), relativeLuminance(base)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastGrade = "AAA" | "AA" | "AA large" | "Fail";

export const AAA_TEXT = 7;
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

export function grade(ratio: number): ContrastGrade {
  if (ratio >= AAA_TEXT) return "AAA";
  if (ratio >= AA_TEXT) return "AA";
  if (ratio >= AA_LARGE) return "AA large";
  return "Fail";
}

/* ---------------------------------------------------------------- colour pairs */

/** A colour token as the pair finder reads it: resolved CSS per scheme. */
export interface ContrastToken {
  /** DTCG path, e.g. `color.muted`. */
  readonly path: string;
  readonly type: string;
  readonly light: string;
  readonly dark: string;
}

/** A contract's colour bindings: role → token path, at rest and per interaction state. */
export interface ContrastContract {
  readonly id: string;
  readonly name: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly states?: Readonly<Partial<Record<string, Readonly<Record<string, string>>>>>;
}

/** A focus ring as the pair finder reads it: the colour token it draws with and how far out it sits. */
export interface ContrastRing {
  /** Path of the colour entry (`focus.ring.color`). */
  readonly color: string;
  /** Offset in px; at 0 or less the ring is drawn over the element's own fill. null when unknown (then it is checked against fills too). */
  readonly offset: number | null;
}

/** A typography token, for large text: its size in px and its weight (null when unknown). */
export interface ContrastText {
  readonly path: string;
  readonly size: number | null;
  readonly weight: number | null;
}

/** WCAG large text: 18pt (24px) and up, or 14pt (18.66px) and up when bold. */
export function isLargeText(text: Pick<ContrastText, "size" | "weight">): boolean {
  if (text.size === null) return false;
  return text.size >= 24 || (text.size >= 18.66 && (text.weight ?? 400) >= 700);
}

const WEIGHT_NAMES: Readonly<Record<string, number>> = { thin: 100, hairline: 100, "extra-light": 200, "ultra-light": 200, light: 300, normal: 400, regular: 400, book: 400, medium: 500, "semi-bold": 600, "demi-bold": 600, bold: 700, "extra-bold": 800, "ultra-bold": 800, black: 900, heavy: 900, "extra-black": 950, "ultra-black": 950 };

/** A resolved typography value (DTCG) as large-text input: size in px (rem × 16) and numeric weight. */
export function contrastText(path: string, value: unknown): ContrastText {
  const t = (value ?? {}) as { fontSize?: { value?: unknown; unit?: unknown }; fontWeight?: unknown };
  const size = typeof t.fontSize?.value === "number" ? t.fontSize.value * (t.fontSize.unit === "rem" ? 16 : 1) : null;
  const weight = typeof t.fontWeight === "number" ? t.fontWeight : typeof t.fontWeight === "string" ? (WEIGHT_NAMES[t.fontWeight] ?? null) : null;
  return { path, size, weight };
}

/** A resolved focus ring value (DTCG) as its offset in px, or null when it cannot be read. */
export function ringOffset(value: unknown): number | null {
  const offset = (value as { offset?: { value?: unknown; unit?: unknown } } | null)?.offset;
  return typeof offset?.value === "number" ? offset.value * (offset.unit === "rem" ? 16 : 1) : null;
}

/** text: body text (4.5:1); large: large text (3:1); ui: focus rings and other UI parts against what they sit on (3:1). */
export type PairKind = "text" | "large" | "ui";

export interface ContrastPair {
  /** Stable key: foreground, background and where the pair comes from. */
  readonly key: string;
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly kind: PairKind;
  /**
   * naming: `on-x` on `x`, `x` on `x-soft`; surface: text-like colours on surfaces; large: a heading,
   * display or title colour on surfaces, linked to large typography by name; contract: a contract's
   * fg/bg roles (large when every typography it binds is large); focus: a focus ring on a surface,
   * or on a component's fill when the ring is drawn over it.
   */
  readonly source: "naming" | "surface" | "large" | "contract" | "focus";
  /** The contract (and state) a contract pair comes from. */
  readonly contract?: string;
  readonly state?: string;
}

export const REQUIRED: Readonly<Record<PairKind, number>> = { text: AA_TEXT, large: AA_LARGE, ui: AA_LARGE };

/** Surfaces, in the order systems name them; the first ones present are the system's surfaces. */
const SURFACES = ["paper", "ground", "raised"];
const FALLBACK_SURFACES = ["surface", "canvas", "background", "card"];
/** Text colours a surface must carry: the first ink-like token, then muted. */
const TEXT_ON_SURFACE = [["ink", "foreground", "text"], ["muted"]];
const TEXT_LIKE = /(?:^|-)(?:ink|text|foreground|fg|muted|subtle|faint)(?:-|$)|^ink-\d$/;
/** Names that mark large text, on a colour and on the typography it is set in. */
const LARGE_WORDS = ["heading", "display", "title"] as const;
const largeWord = (name: string): string | undefined => LARGE_WORDS.find((word) => name.split(/[-.]/).includes(word));

function colors(tokens: readonly ContrastToken[]): Map<string, ContrastToken> {
  return new Map(tokens.filter((t) => t.type === "color").map((t) => [t.path, t]));
}

function surfacesOf(byPath: ReadonlyMap<string, ContrastToken>): ContrastToken[] {
  const named = (names: readonly string[]): ContrastToken[] => names.map((n) => byPath.get(`color.${n}`)).filter((t): t is ContrastToken => t !== undefined);
  const surfaces = named(SURFACES);
  return surfaces.length > 0 ? surfaces : named(FALLBACK_SURFACES);
}

const pairKey = (fg: string, bg: string, source: string, extra = ""): string => `${source}:${fg}|${bg}${extra ? `|${extra}` : ""}`;

/**
 * Which pairs matter for one colour: `on-x` sits on `x`; `x-soft` carries `x` text; a surface
 * carries ink and muted; anything else is read as text on the system's surfaces.
 */
export function pairsFor(tokens: readonly ContrastToken[], path: string): ContrastPair[] {
  const byPath = colors(tokens);
  const token = byPath.get(path);
  if (!token) return [];
  const color = (name: string): ContrastToken | undefined => byPath.get(`color.${name}`);
  const name = path.slice("color.".length);
  const backgrounds = surfacesOf(byPath);
  const base = name.startsWith("on-") ? color(name.slice(3)) : name.endsWith("-soft") ? color(name.slice(0, -"-soft".length)) : undefined;
  if (base && name.startsWith("on-")) return [{ key: pairKey(path, base.path, "naming"), label: `${path} on ${base.path}`, foreground: path, background: base.path, kind: "text", source: "naming" }];
  if (base) return [{ key: pairKey(base.path, path, "naming"), label: `${base.path} text on ${path}`, foreground: base.path, background: path, kind: "text", source: "naming" }];
  if (backgrounds.some((b) => b.path === path)) {
    return TEXT_ON_SURFACE.flatMap((names) => {
      const fg = names.map(color).find(Boolean);
      return fg ? [{ key: pairKey(fg.path, path, "surface"), label: `${fg.path} on ${path}`, foreground: fg.path, background: path, kind: "text" as const, source: "surface" as const }] : [];
    });
  }
  return backgrounds.map((bg) => ({ key: pairKey(path, bg.path, "surface"), label: `${path} as text on ${bg.path}`, foreground: path, background: bg.path, kind: "text" as const, source: "surface" as const }));
}

const tokenPath = (id: string): string => id.replace(/^youi:[a-z][a-z0-9-]*\/token\//, "");

export interface SystemPairsOptions {
  /** Focus ring token → the colour it draws with and its offset (a bare colour path is read as an unknown offset). */
  readonly focusRings?: ReadonlyMap<string, string | ContrastRing>;
  /** Typography tokens, to find large text (3:1 instead of 4.5:1). */
  readonly typography?: readonly ContrastText[];
}

/**
 * Every pair a system's colours must pass: the naming pairs, text-like colours on each surface,
 * heading, display and title colours on each surface as large text when large typography carries
 * the same name, focus-ring colours on each surface, and each contract's `fg.x` on `bg.x` at rest
 * and in every state that changes either (as large text when every typography the contract binds
 * is large). A focus ring drawn over its element (offset 0 or less, or unknown) is also checked
 * against each fill of the contracts it can focus: their `bg` roles at rest and in every state.
 * A third argument that is a Map is read as `focusRings`.
 */
export function systemPairs(tokens: readonly ContrastToken[], contracts: readonly ContrastContract[] = [], options: SystemPairsOptions | ReadonlyMap<string, string | ContrastRing> = {}): ContrastPair[] {
  const { focusRings = new Map(), typography = [] } = options instanceof Map ? { focusRings: options } : (options as SystemPairsOptions);
  const rings = new Map([...focusRings].map(([ring, value]) => [ring, typeof value === "string" ? { color: value, offset: null } : value]));
  const byPath = colors(tokens);
  const surfaces = surfacesOf(byPath);
  const textByPath = new Map(typography.map((t) => [t.path, t]));
  const largeNames = new Set<string>(typography.filter(isLargeText).flatMap((t) => LARGE_WORDS.filter((word) => t.path.split(/[-.]/).includes(word))));
  const pairs = new Map<string, ContrastPair>();
  const add = (pair: ContrastPair): void => {
    if (byPath.has(pair.foreground) && byPath.has(pair.background) && pair.foreground !== pair.background && !pairs.has(pair.key)) pairs.set(pair.key, pair);
  };
  for (const token of byPath.values()) {
    const name = token.path.slice(token.path.indexOf(".") + 1);
    // Only real naming pairs: a `-soft` with no base colour is not text on a surface.
    if (name.startsWith("on-") || name.endsWith("-soft")) pairsFor(tokens, token.path).filter((p) => p.source === "naming").forEach(add);
    const word = largeWord(name);
    if (word && largeNames.has(word)) {
      for (const bg of surfaces) add({ key: pairKey(token.path, bg.path, "large"), label: `${token.path} as large text on ${bg.path}`, foreground: token.path, background: bg.path, kind: "large", source: "large" });
    } else if (TEXT_LIKE.test(name)) {
      for (const bg of surfaces) add({ key: pairKey(token.path, bg.path, "surface"), label: `${token.path} on ${bg.path}`, foreground: token.path, background: bg.path, kind: "text", source: "surface" });
    }
  }
  for (const [ring, { color }] of rings) {
    for (const bg of surfaces) add({ key: pairKey(color, bg.path, "focus", ring), label: `${ring} (${color}) on ${bg.path}`, foreground: color, background: bg.path, kind: "ui", source: "focus" });
  }
  for (const contract of contracts) {
    const bound = [...Object.values(contract.tokens), ...Object.values(contract.states ?? {}).flatMap((roles) => Object.values(roles ?? {}))].map(tokenPath);
    const texts = bound.map((path) => textByPath.get(path)).filter((t): t is ContrastText => t !== undefined);
    const kind: PairKind = texts.length > 0 && texts.every(isLargeText) ? "large" : "text";
    const variants = new Set(Object.keys(contract.tokens).filter((role) => /^(?:fg|bg)(?:\.|$)/.test(role)).map((role) => role.replace(/^(?:fg|bg)\.?/, "")));
    for (const variant of variants) {
      const role = (part: "fg" | "bg"): string => (variant ? `${part}.${variant}` : part);
      const rest = { fg: contract.tokens[role("fg")], bg: contract.tokens[role("bg")] };
      const label = (state?: string): string => `${contract.name}${variant ? ` ${variant}` : ""}${state ? ` (${state})` : ""}: ${kind === "large" ? "large text" : "text"} on fill`;
      if (rest.fg && rest.bg) add({ key: pairKey(tokenPath(rest.fg), tokenPath(rest.bg), "contract", `${contract.id}:${variant}`), label: label(), foreground: tokenPath(rest.fg), background: tokenPath(rest.bg), kind, source: "contract", contract: contract.id });
      for (const [state, bindings] of Object.entries(contract.states ?? {})) {
        const fg = bindings?.[role("fg")] ?? rest.fg;
        const bg = bindings?.[role("bg")] ?? rest.bg;
        if (!fg || !bg || (fg === rest.fg && bg === rest.bg)) continue;
        add({ key: pairKey(tokenPath(fg), tokenPath(bg), "contract", `${contract.id}:${variant}:${state}`), label: label(state), foreground: tokenPath(fg), background: tokenPath(bg), kind, source: "contract", contract: contract.id, state });
      }
    }
    // Focus rings over this contract's fills: the rings it binds, else every ring the system has.
    const own = bound.filter((path) => rings.has(path));
    const fills: Array<{ role: string; path: string; state?: string }> = [
      ...Object.entries(contract.tokens).filter(([role]) => /^bg(?:\.|$)/.test(role)).map(([role, id]) => ({ role, path: tokenPath(id) })),
      ...Object.entries(contract.states ?? {}).flatMap(([state, roles]) => Object.entries(roles ?? {}).filter(([role]) => /^bg(?:\.|$)/.test(role)).map(([role, id]) => ({ role, path: tokenPath(id), state }))),
    ];
    for (const ring of own.length > 0 ? [...new Set(own)] : [...rings.keys()]) {
      const { color, offset } = rings.get(ring)!;
      if (offset !== null && offset > 0) continue;
      for (const fill of fills) {
        add({ key: pairKey(color, fill.path, "focus", `${ring}:${contract.id}:${fill.role}${fill.state ? `:${fill.state}` : ""}`), label: `${ring} (${color}) on ${contract.name} ${fill.role}${fill.state ? ` (${fill.state})` : ""}`, foreground: color, background: fill.path, kind: "ui", source: "focus", contract: contract.id, ...(fill.state ? { state: fill.state } : {}) });
      }
    }
  }
  return [...pairs.values()];
}

export interface ContrastFinding {
  readonly pair: ContrastPair;
  readonly scheme: "light" | "dark";
  readonly foreground: string;
  readonly background: string;
  /** null when either colour could not be read (a var() or a colour space contrast.ts does not parse). */
  readonly ratio: number | null;
  readonly grade: ContrastGrade | null;
  readonly required: number;
  /** A colour that cannot be read cannot be shown to pass: it fails, with `unreadable` saying which. */
  readonly passes: boolean;
  /** Why the pair could not be graded: "could not read colour color.x (light: var(--y))". */
  readonly unreadable?: string;
}

/** Grade every pair in both schemes against WCAG AA for its kind. */
export function gradePairs(pairs: readonly ContrastPair[], tokens: readonly ContrastToken[]): ContrastFinding[] {
  const byPath = colors(tokens);
  // A translucent fill sits on the system's first surface in that scheme, not on white.
  const surface = surfacesOf(byPath)[0];
  return pairs.flatMap((pair) =>
    (["light", "dark"] as const).map((scheme) => {
      const foreground = byPath.get(pair.foreground)?.[scheme] ?? "";
      const background = byPath.get(pair.background)?.[scheme] ?? "";
      const ratio = contrastRatio(foreground, background, surface?.[scheme]);
      const required = REQUIRED[pair.kind];
      const unread = [[pair.foreground, foreground], [pair.background, background]].filter(([, css]) => parseColor(css!) === null).map(([path, css]) => `${path} (${scheme}: ${css || "no value"})`);
      return {
        pair,
        scheme,
        foreground,
        background,
        ratio,
        grade: ratio === null ? null : grade(ratio),
        required,
        passes: ratio !== null && ratio >= required,
        ...(ratio === null ? { unreadable: `could not read colour ${unread.join(" and ") || `${pair.foreground} or ${pair.background}`}` } : {}),
      };
    }),
  );
}
