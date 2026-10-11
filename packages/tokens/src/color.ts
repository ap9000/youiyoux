/** CSS colour strings ⇄ DTCG 2025.10 colour values (sRGB only). */

export interface DtcgColor {
  readonly colorSpace: "srgb";
  readonly components: readonly [number, number, number];
  readonly alpha?: number;
  readonly hex?: string;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;

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

/** Parse a literal CSS colour (hex or rgb/rgba). Returns null for anything else (names, var(), color-mix()). */
export function parseCssColor(input: string): DtcgColor | null {
  const value = input.trim();
  if (HEX.test(value)) return fromHex(value);
  const rgb = RGB.exec(value);
  return rgb ? fromRgb(rgb[1] ?? "") : null;
}

export function toHex(color: DtcgColor): string {
  return color.hex ?? `#${color.components.map(channelToHex).join("")}`;
}

/** Shortest faithful CSS form: hex when opaque, `rgb(r g b / a)` when translucent. */
export function formatCssColor(color: DtcgColor): string {
  const alpha = color.alpha ?? 1;
  if (alpha >= 1) return toHex(color);
  const [r, g, b] = color.components.map((c) => Math.round(c * 255));
  const a = String(round(alpha, 3)).replace(/^0\./, ".");
  return `rgb(${r} ${g} ${b} / ${a})`;
}

/** Equal to 8-bit precision per channel and to 1/1000 in alpha. */
export function sameColor(a: DtcgColor, b: DtcgColor): boolean {
  const channels = a.components.every((c, i) => Math.round(c * 255) === Math.round((b.components[i] ?? -1) * 255));
  return channels && Math.abs((a.alpha ?? 1) - (b.alpha ?? 1)) < 0.001;
}
