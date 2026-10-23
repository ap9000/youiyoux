/**
 * CSS colour strings ⇄ DTCG 2025.10 colour values: sRGB (hex, rgb(), hsl()) and OKLCH, which
 * Tailwind v4 and shadcn/ui write. An OKLCH colour keeps its own components, so it is written back
 * exactly as it was, with a `hex` fallback; comparisons and contrast use its sRGB value.
 */

export interface DtcgColor {
  readonly colorSpace: "srgb" | "oklch";
  /** sRGB: r, g, b from 0 to 1; OKLCH: lightness 0–1, chroma, hue in degrees. */
  readonly components: readonly [number, number, number];
  readonly alpha?: number;
  readonly hex?: string;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;
const HSL = /^hsla?\(\s*([^)]*)\)$/i;
const OKLCH = /^oklch\(\s*([^)]*)\)$/i;

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function channelToHex(unit: number): string {
  return Math.round(Math.min(1, Math.max(0, unit)) * 255).toString(16).padStart(2, "0");
}

function fromHex(hex: string): DtcgColor {
  let digits = hex.slice(1).toLowerCase();
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
  const channel = (i: number): number => parseInt(digits.slice(i, i + 2), 16) / 255;
  const rgb: [number, number, number] = [round(channel(0)), round(channel(2)), round(channel(4))];
  const hex6 = `#${digits.slice(0, 6)}`;
  return digits.length === 8 ? { colorSpace: "srgb", components: rgb, alpha: round(channel(6), 3), hex: hex6 } : { colorSpace: "srgb", components: rgb, hex: hex6 };
}

function parseChannel(raw: string): number | null {
  const value = raw.trim();
  if (value.endsWith("%")) {
    const pct = Number(value.slice(0, -1));
    return Number.isFinite(pct) ? pct / 100 : null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number / 255 : null;
}

function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const value = raw.trim();
  const number = value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(number) ? number : null;
}

function fromRgb(body: string): DtcgColor | null {
  const [channels, slashAlpha] = body.split("/");
  const parts = (channels ?? "").includes(",") ? (channels ?? "").split(",") : (channels ?? "").trim().split(/\s+/);
  const commaAlpha = parts.length === 4 ? parts.pop() : undefined;
  if (parts.length !== 3) return null;
  const rgb = parts.map(parseChannel);
  const alpha = parseAlpha(slashAlpha ?? commaAlpha);
  if (rgb.some((c) => c === null) || alpha === null) return null;
  const components = rgb.map((c) => round(c as number)) as [number, number, number];
  const hex = `#${components.map(channelToHex).join("")}`;
  return alpha < 1 ? { colorSpace: "srgb", components, alpha: round(alpha, 3), hex } : { colorSpace: "srgb", components, hex };
}

/** Channels and the alpha after a slash (`h s l / a`), or the legacy comma form with a fourth alpha. */
function channelsOf(body: string): { parts: string[]; alpha: string | undefined } {
  const [channels, slashAlpha] = body.split("/");
  const parts = (channels ?? "").includes(",") ? (channels ?? "").split(",").map((p) => p.trim()) : (channels ?? "").trim().split(/\s+/);
  const commaAlpha = parts.length === 4 ? parts.pop() : undefined;
  return { parts, alpha: slashAlpha ?? commaAlpha };
}

/** `hsl(210 40% 98%)` as sRGB, to 8-bit precision. */
function fromHsl(body: string): DtcgColor | null {
  const { parts, alpha: rawAlpha } = channelsOf(body);
  if (parts.length !== 3 || !parts[1]!.endsWith("%") || !parts[2]!.endsWith("%")) return null;
  const hue = Number(parts[0]!.replace(/deg$/, ""));
  const [s, l] = [Number(parts[1]!.slice(0, -1)) / 100, Number(parts[2]!.slice(0, -1)) / 100];
  const alpha = parseAlpha(rawAlpha);
  if (![hue, s, l].every(Number.isFinite) || alpha === null) return null;
  const f = (n: number): number => {
    const k = (n + (((hue % 360) + 360) % 360) / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const components = [f(0), f(8), f(4)].map((c) => round(c)) as [number, number, number];
  const hex = `#${components.map(channelToHex).join("")}`;
  return alpha < 1 ? { colorSpace: "srgb", components, alpha: round(alpha, 3), hex } : { colorSpace: "srgb", components, hex };
}

/** `oklch(0.623 0.214 259.8 / 50%)`, kept in OKLCH. */
function fromOklch(body: string): DtcgColor | null {
  const { parts, alpha: rawAlpha } = channelsOf(body);
  if (parts.length !== 3) return null;
  const [lRaw, cRaw, hRaw] = parts as [string, string, string];
  const lightness = lRaw.endsWith("%") ? Number(lRaw.slice(0, -1)) / 100 : Number(lRaw);
  const chroma = cRaw.endsWith("%") ? (Number(cRaw.slice(0, -1)) / 100) * 0.4 : Number(cRaw);
  const hue = hRaw === "none" ? 0 : Number(hRaw.replace(/deg$/, ""));
  const alpha = parseAlpha(rawAlpha);
  if (![lightness, chroma, hue].every(Number.isFinite) || alpha === null) return null;
  const components: [number, number, number] = [round(lightness, 6), round(chroma, 6), round(hue, 6)];
  const color: DtcgColor = { colorSpace: "oklch", components, ...(alpha < 1 ? { alpha: round(alpha, 3) } : {}) };
  return { ...color, hex: `#${srgbOf(color).map(channelToHex).join("")}` };
}

/** sRGB components (0–1, clipped to the gamut) of any colour this module reads. */
export function srgbOf(color: DtcgColor): [number, number, number] {
  if (color.colorSpace !== "oklch") return [...color.components];
  const [l, c, h] = color.components;
  const [a, b] = [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
  const [lm, mm, sm] = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((v) => v ** 3) as [number, number, number];
  const linear = [4.0767416621 * lm - 3.3077115913 * mm + 0.2309699292 * sm, -1.2684380046 * lm + 2.6097574011 * mm - 0.3413193965 * sm, -0.0041960863 * lm - 0.7034186147 * mm + 1.707614701 * sm];
  return linear.map((v) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))) as [number, number, number];
}

/** Parse a literal CSS colour (hex, rgb(), hsl() or oklch()). Returns null for anything else (names, var(), color-mix(), a bare `210 40% 98%`). */
export function parseCssColor(input: string): DtcgColor | null {
  const value = input.trim();
  if (HEX.test(value)) return fromHex(value);
  const rgb = RGB.exec(value);
  if (rgb) return fromRgb(rgb[1] ?? "");
  const hsl = HSL.exec(value);
  if (hsl) return fromHsl(hsl[1] ?? "");
  const oklch = OKLCH.exec(value);
  return oklch ? fromOklch(oklch[1] ?? "") : null;
}

export function toHex(color: DtcgColor): string {
  // The schema checks the fallback; anything else is never written, the components are.
  return color.hex !== undefined && /^#[0-9a-f]{6}$/i.test(color.hex) ? color.hex : `#${srgbOf(color).map(channelToHex).join("")}`;
}

const alphaText = (alpha: number): string => String(round(alpha, 3)).replace(/^0\./, ".");

/** Shortest faithful CSS form: OKLCH as `oklch(l c h)`; sRGB as hex when opaque, `rgb(r g b / a)` when translucent. */
export function formatCssColor(color: DtcgColor): string {
  const alpha = color.alpha ?? 1;
  if (color.colorSpace === "oklch") return `oklch(${color.components.join(" ")}${alpha < 1 ? ` / ${alphaText(alpha)}` : ""})`;
  if (alpha >= 1) return toHex(color);
  const [r, g, b] = color.components.map((c) => Math.round(c * 255));
  return `rgb(${r} ${g} ${b} / ${alphaText(alpha)})`;
}

/** Equal to 8-bit sRGB precision per channel and to 1/1000 in alpha, whatever space each is written in. */
export function sameColor(a: DtcgColor, b: DtcgColor): boolean {
  const [x, y] = [srgbOf(a), srgbOf(b)];
  const channels = x.every((c, i) => Math.round(c * 255) === Math.round(y[i]! * 255));
  return channels && Math.abs((a.alpha ?? 1) - (b.alpha ?? 1)) < 0.001;
}
