/**
 * The share card: a 1200×630 PNG (the Open Graph size) with the repo's name and the headline
 * numbers, drawn pixel by pixel with the bitmap font (font.ts) and compressed with node:zlib, so
 * it needs no browser, no font files and no network. The PNG carries no text chunks: the only
 * text is drawn, and it has been through the redactor (safe.ts) first.
 */
import { deflateSync } from "node:zlib";
import { DESCENDERS, GLYPH_WIDTH, GLYPHS, plainAscii } from "./font.ts";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

type Rgb = readonly [number, number, number];

const INK = { background: [11, 16, 32], tile: [22, 30, 54], accent: [124, 156, 255], text: [232, 236, 248], muted: [147, 160, 191], warn: [251, 191, 36], ok: [74, 222, 128] } satisfies Record<string, Rgb>;

export interface CardInput {
  readonly repo: string;
  readonly stats: ReadonlyArray<{ readonly value: number; readonly label: readonly string[]; readonly tone?: "warn" | "ok" }>;
  /** One line under the tiles: the UI libraries found. */
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
  canvas.rect(0, 0, CARD_WIDTH, 10, INK.accent);
  canvas.text(margin, 64, "YOUIYOUX REPORT", 4, INK.accent);
  const name = fit(input.repo, inner, 10, 5);
  canvas.text(margin, 64 + 7 * 4 + 32, name.text, name.scale, INK.text);

  const gap = 16;
  const tiles = input.stats.slice(0, 4);
  const tileWidth = Math.floor((inner - gap * (tiles.length - 1)) / Math.max(1, tiles.length));
  const top = 290;
  const tileHeight = 220;
  tiles.forEach((stat, i) => {
    const x = margin + i * (tileWidth + gap);
    canvas.rect(x, top, tileWidth, tileHeight, INK.tile, 18);
    const value = fit(String(stat.value), tileWidth - 48, 12, 6);
    const tone = stat.tone === "warn" ? INK.warn : stat.tone === "ok" ? INK.ok : INK.text;
    canvas.text(x + 24, top + 28, value.text, value.scale, tone);
    stat.label.slice(0, 2).forEach((line, n) => {
      const label = fit(line, tileWidth - 48, 3, 2);
      canvas.text(x + 24, top + 28 + 7 * 12 + 26 + n * 30, label.text, label.scale, INK.muted);
    });
  });

  const credit = "npx youiyoux";
  const creditWidth = textWidth(credit, 3);
  canvas.text(CARD_WIDTH - margin - creditWidth, 560, credit, 3, INK.accent);
  const footer = fit(input.footer, inner - creditWidth - 40, 3, 2);
  canvas.text(margin, 560 + (footer.scale === 3 ? 0 : 4), footer.text, footer.scale, INK.muted);
  return encodePng(CARD_WIDTH, CARD_HEIGHT, canvas.pixels);
}
