/**
 * The share card: a 1200×630 PNG (the Open Graph size) with the repo's name, the headline's
 * places to fix and the same split bar as the report, in the hub's dark palette, drawn pixel by pixel with the bitmap font (font.ts) and compressed with node:zlib, so
 * it needs no browser, no font files and no network. The PNG carries no text chunks: the only
 * text is drawn, and it has been through the redactor (safe.ts) first.
 */
import { deflateSync } from "node:zlib";
import { DESCENDERS, GLYPH_WIDTH, GLYPHS, plainAscii } from "./font.ts";

export const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

type Rgb = readonly [number, number, number];

/** The hub's dark tokens (apps/web/design/youiyoux.dark.tokens.json): canvas, neutral-soft, accent (and its 55%/25% steps toward surface, as in the report), ink, muted, success. */
const INK = { background: [8, 9, 10], track: [25, 26, 29], accent: [113, 112, 255], accent2: [69, 69, 147], accent3: [40, 40, 76], text: [247, 248, 248], muted: [138, 143, 152], ok: [143, 181, 164] } satisfies Record<string, Rgb>;

interface CardInput {
  readonly repo: string;
  /** Places to fix by kind, as the report's headline counts them. */
  readonly parts: ReadonlyArray<{ readonly label: string; readonly places: number }>;
  /** One line at the bottom: the UI libraries found. */
  readonly footer: string;
}

class Canvas {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number, fill: Rgb) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, fill);
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb, radius = 0): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + w); col++) {
        if (radius > 0) {
          const dx = col < x + radius ? x + radius - col - 0.5 : col >= x + w - radius ? col - (x + w - radius) + 0.5 : 0;
          const dy = row < y + radius ? y + radius - row - 0.5 : row >= y + h - radius ? row - (y + h - radius) + 0.5 : 0;
          if (dx * dx + dy * dy > radius * radius) continue;
        }
        const i = (row * this.width + col) * 3;
        this.pixels[i] = color[0];
        this.pixels[i + 1] = color[1];
        this.pixels[i + 2] = color[2];
      }
    }
  }

  /** Text at a whole-pixel scale; returns its width. */
  text(x: number, y: number, text: string, scale: number, color: Rgb): number {
    let at = x;
    for (const char of plainAscii(text)) {
      const rows = GLYPHS.get(char) ?? GLYPHS.get("?")!;
      const drop = DESCENDERS.has(char) ? 2 : 0;
      rows.forEach((bits, r) => {
        for (let c = 0; c < GLYPH_WIDTH; c++) if (bits & (1 << (GLYPH_WIDTH - 1 - c))) this.rect(at + c * scale, y + (r + drop) * scale, scale, scale, color);
      });
      at += (GLYPH_WIDTH + 1) * scale;
    }
    return at - x - scale;
  }
}

/** The width of `text` at `scale`. */
export const textWidth = (text: string, scale: number): number => Math.max(0, plainAscii(text).length * (GLYPH_WIDTH + 1) * scale - scale);

/** The largest scale (up to `max`) at which `text` fits `width`, shortened with "..." if even `min` does not fit. */
function fit(text: string, width: number, max: number, min: number): { text: string; scale: number } {
  for (let scale = max; scale >= min; scale--) if (textWidth(text, scale) <= width) return { text, scale };
  let cut = plainAscii(text);
  while (cut.length > 1 && textWidth(`${cut}...`, min) > width) cut = cut.slice(0, -1);
  return { text: `${cut}...`, scale: min };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGB PNG: IHDR, one IDAT, IEND, nothing else. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(row * width * 3, (row + 1) * width * 3), row * (width * 3 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())]);
}

export function drawCard(input: CardInput): Buffer {
  const canvas = new Canvas(CARD_WIDTH, CARD_HEIGHT, INK.background);
  const margin = 72;
  const inner = CARD_WIDTH - margin * 2;
  canvas.text(margin, 64, "youiyoux report", 3, INK.muted);
  const name = fit(input.repo, inner, 9, 5);
  canvas.text(margin, 104, name.text, name.scale, INK.text);

  // The headline: the total in ink (sage when clean), then what it counts.
  const total = input.parts.reduce((n, part) => n + part.places, 0);
  const value = fit(String(total), inner / 2, 14, 8);
  const valueWidth = canvas.text(margin, 236, value.text, value.scale, total > 0 ? INK.text : INK.ok);
  const words = total === 0 ? "places to fix: clean" : total === 1 ? "place to fix" : "places to fix";
  canvas.text(margin + valueWidth + 28, 236 + 7 * value.scale - 7 * 4, words, 4, INK.muted);

  // The split bar: one segment per kind, in the accent's steps, on the neutral track.
  const top = 380;
  const steps = [INK.accent, INK.accent2, INK.accent3];
  canvas.rect(margin, top, inner, 20, INK.track, 10);
  if (total > 0) {
    let x = margin;
    const shown = input.parts.filter((part) => part.places > 0);
    const room = inner - 6 * (shown.length - 1);
    input.parts.forEach((part, i) => {
      if (part.places === 0) return;
      const last = part === shown.at(-1);
      const width = last ? margin + inner - x : Math.max(10, Math.round((part.places / total) * room));
      canvas.rect(x, top, width, 20, steps[i] ?? INK.accent3, 10);
      x += width + 6;
    });
  }
  let x = margin;
  input.parts.forEach((part, i) => {
    canvas.rect(x, top + 52, 18, 18, part.places > 0 ? (steps[i] ?? INK.accent3) : INK.track, 4);
    x += 32;
    x += canvas.text(x, top + 52, part.label.split(" ")[0]!, 3, INK.muted) + 16;
    x += canvas.text(x, top + 52, String(part.places), 3, part.places > 0 ? INK.text : INK.ok) + 40;
  });

  const credit = "npx youiyoux";
  const creditWidth = textWidth(credit, 3);
  canvas.text(CARD_WIDTH - margin - creditWidth, 560, credit, 3, INK.accent);
  const footer = fit(input.footer, inner - creditWidth - 40, 3, 2);
  canvas.text(margin, 560 + (footer.scale === 3 ? 0 : 4), footer.text, footer.scale, INK.muted);
  return encodePng(CARD_WIDTH, CARD_HEIGHT, canvas.pixels);
}
