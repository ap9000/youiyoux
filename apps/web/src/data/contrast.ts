/** WCAG 2.x contrast for resolved CSS colours (hex and rgb() forms, as the token build emits them). */

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

/** Contrast of `foreground` on `background`; translucent colours are composited first. */
export function contrastRatio(foreground: string, background: string): number | null {
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  if (!bg || !fg) return null;
  const base = bg.a < 1 ? composite(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
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
