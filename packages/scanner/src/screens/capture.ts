/**
 * `youiyoux screens capture`: a project's screens photographed, light and dark, with where each
 * component sits on them (locate.ts), for the hub's Screens page.
 *
 * Reads `<dir>/screens.json` (`youiyoux.screens/v1`: each route and the address that shows it)
 * and writes beside it, for each route:
 *
 *   <slug>.<scheme>.webp         the whole page at twice its pixels
 *   <slug>.<scheme>.thumb.webp   half size, for thumbnails
 *   <slug>.places.json           every component on the light page: its box, and the file and
 *                                line that rendered it (`youiyoux.places/v1`)
 *
 * The app is the one at `base`, run in development so React keeps the stacks that name each
 * line: point it at a seeded demo or a scratch copy, never at someone's working instance. The
 * pictures and places are the project's data: they stay in its `.youi/screens`.
 */
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { writeFileAtomic } from "@youiyoux/core";
import { locateInPage, mapNotes, MAX_PLACES, resolvePlaces, whyNoLines, type Place } from "./locate.ts";

export const SCREENS_SCHEMA = "youiyoux.screens/v1";
export const PLACES_SCHEMA = "youiyoux.places/v1";
const SCHEMES = ["light", "dark"] as const;
/** Pictures are taken at twice the page's pixels: a box in CSS pixels is this many times larger on one. */
export const PICTURE_SCALE = 2;
const THUMB_SCALE = 0.5;
/** After load, for fonts, data and animations to settle. */
const SETTLE_MS = 1200;
const NAVIGATION_TIMEOUT_MS = 30_000;
/** A page longer than this many viewports is photographed to that length. */
const MAX_VIEWPORTS = 6;
const WEBP_QUALITY = 0.9;

export interface ScreensSpec {
  readonly schema: typeof SCREENS_SCHEMA;
  readonly project: string;
  readonly source: string;
  readonly capturedAt: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly screens: ReadonlyArray<{ readonly route: string; readonly path: string; readonly note?: string }>;
  /** Where the app ran at the last capture (`http://localhost:3000`). */
  readonly base?: string;
}

export interface PlacesFile {
  readonly schema: typeof PLACES_SCHEMA;
  readonly route: string;
  readonly path: string;
  readonly viewport: ScreensSpec["viewport"];
  /** The page's size in CSS pixels: what the boxes are measured against. */
  readonly size: { readonly width: number; readonly height: number };
  /** React development stacks were there, so places have lines. */
  readonly dev: boolean;
  readonly capped: boolean;
  readonly places: readonly Place[];
}

/** A route as a file name: `/flows/[id]` → `flows-id`, the app shell `*` → `app-shell` (as the hub names them). */
export function screenSlug(route: string): string {
  if (route === "*") return "app-shell";
  if (route === "?") return "unrouted";
  return route.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

export function readScreensSpec(dir: string): ScreensSpec {
  const file = join(dir, "screens.json");
  let value: Partial<ScreensSpec>;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as Partial<ScreensSpec>;
  } catch (error: unknown) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const valid = value.schema === SCREENS_SCHEMA && typeof value.project === "string" && typeof value.source === "string" && typeof value.viewport?.width === "number" && typeof value.viewport.height === "number" && Array.isArray(value.screens) && value.screens.every((s) => typeof s?.route === "string" && typeof s.path === "string");
  if (!valid) throw new Error(`${file} is not a ${SCREENS_SCHEMA} document: it needs project, source, viewport { width, height } and screens [{ route, path }]`);
  // A path is on the app's own address: `/settings`, never `https://…`, `//host/…` or a backslash a browser reads as a slash.
  const elsewhere = value.screens!.find((s) => !/^\/(?![/\\])/.test(s.path) || s.path.includes("\\"));
  if (elsewhere) throw new Error(`${file}: the path of ${elsewhere.route} (${elsewhere.path}) must start with a single / on the app's own address; capture opens nothing elsewhere`);
  const slugs = new Map<string, string>();
  for (const { route } of value.screens!) {
    const slug = screenSlug(route);
    if (slugs.has(slug)) throw new Error(`${file}: routes ${slugs.get(slug)} and ${route} would share the file name ${slug}`);
    slugs.set(slug, route);
  }
  return value as ScreensSpec;
}

export interface CaptureOptions {
  /** Where the app runs, in development (`http://localhost:3000`). */
  readonly base: string;
  /** The product's root, so absolute source paths become project-relative. */
  readonly root?: string;
  readonly browser: Browser;
  /** A signed-in session (Playwright's storage state file), for an app behind a sign-in. */
  readonly storageState?: string;
  /** Only these routes (after a change, the screen it touched); the rest keep their pictures. */
  readonly routes?: readonly string[];
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface ScreenCapture {
  readonly route: string;
  readonly path: string;
  /** Components placed, and how many of them have a line. */
  readonly placed: number;
  readonly lined: number;
  readonly error: string | null;
}

export interface CaptureReport {
  readonly dir: string;
  readonly project: string;
  readonly screens: readonly ScreenCapture[];
  /** No screen had React's development stacks: the app is a production build. */
  readonly production: boolean;
  /** No screen had React at all. */
  readonly noReact: boolean;
  /** A development build whose components got no lines at all: why, and what to do; else null. */
  readonly noLines: string | null;
}

async function writeBytes(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

/** A PNG as WebP at `scale`, encoded by the browser's own canvas, on a blank page of its own (the app's CSP never applies). */
async function encode(page: Page, png: Buffer, scale: number): Promise<Buffer> {
  const url = await page.evaluate(
    async ({ data, scale, quality }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d")!;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", quality);
    },
    { data: png.toString("base64"), scale, quality: WEBP_QUALITY },
  );
  if (!url.startsWith("data:image/webp;base64,")) throw new Error("this Chromium cannot encode WebP");
  return Buffer.from(url.slice("data:image/webp;base64,".length), "base64");
}

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.replace(/\.$/, "");

/** Photograph every route of `dir`'s screens.json and place its components. */
export async function captureScreens(dir: string, options: CaptureOptions): Promise<CaptureReport> {
  const spec = readScreensSpec(dir);
  const unknown = (options.routes ?? []).filter((route) => !spec.screens.some((s) => s.route === route));
  if (unknown.length) throw new Error(`${join(dir, "screens.json")} has no route ${unknown.join(", ")}: it lists ${spec.screens.map((s) => s.route).join(", ")}`);
  const chosen = options.routes?.length ? spec.screens.filter((s) => options.routes!.includes(s.route)) : spec.screens;
  const log = options.log ?? (() => undefined);
  const { width, height } = spec.viewport;
  const results = new Map<string, { placed: number; lined: number; error: string | null }>();
  let dev = false;
  let react = false;
  const notes = mapNotes();
  for (const scheme of SCHEMES) {
    const context = await options.browser.newContext({ viewport: { width, height }, deviceScaleFactor: PICTURE_SCALE, colorScheme: scheme, reducedMotion: "reduce", ...(options.storageState ? { storageState: options.storageState } : {}) });
    try {
      const page = await context.newPage();
      const encoder = await context.newPage();
      for (const screen of chosen) {
        const slug = screenSlug(screen.route);
        if (results.get(screen.route)?.error) continue;
        try {
          const target = new URL(screen.path, options.base).href;
          if (new URL(target).origin !== new URL(options.base).origin) throw new Error(`${screen.path} is not on ${new URL(options.base).origin}`);
          await page.goto(target, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
          await page.evaluate(() => document.fonts?.ready.then(() => undefined));
          await page.waitForTimeout(SETTLE_MS);
          let located = scheme === "light" ? await page.evaluate(locateInPage, MAX_PLACES) : null;
          // No React yet: a dev server still optimising reloads the page, or the app mounts late. Look once more.
          if (located && !located.react) {
            await page.waitForLoadState("load");
            await page.waitForTimeout(SETTLE_MS * 2);
            located = await page.evaluate(locateInPage, MAX_PLACES);
          }
          const pageHeight = located?.size.height ?? (await page.evaluate(() => document.documentElement.scrollHeight));
          const clip = { x: 0, y: 0, width, height: Math.min(Math.max(pageHeight, height), height * MAX_VIEWPORTS) };
          const png = await page.screenshot({ fullPage: true, clip });
          await writeBytes(join(dir, `${slug}.${scheme}.webp`), await encode(encoder, png, 1));
          await writeBytes(join(dir, `${slug}.${scheme}.thumb.webp`), await encode(encoder, png, THUMB_SCALE / PICTURE_SCALE));
          if (located) {
            react ||= located.react;
            dev ||= located.dev;
            const places = await resolvePlaces(located.places, async (url) => {
              const response = await fetch(url).catch(() => null);
              return response?.ok ? response.text() : null;
            }, options.root ?? null, notes);
            const file: PlacesFile = { schema: PLACES_SCHEMA, route: screen.route, path: screen.path, viewport: spec.viewport, size: { width, height: clip.height }, dev: located.dev, capped: located.capped, places: places.filter((p) => p.box.y < clip.height) };
            await writeFileAtomic(join(dir, `${slug}.places.json`), `${JSON.stringify(file)}\n`);
            results.set(screen.route, { placed: file.places.length, lined: file.places.filter((p) => p.line !== null).length, error: null });
          }
          log(`${screen.route} (${scheme}) → ${slug}.${scheme}.webp${located ? `, ${results.get(screen.route)!.placed} components placed` : ""}`);
        } catch (error: unknown) {
          results.set(screen.route, { placed: 0, lined: 0, error: `${sentence(error)} (${screen.path})` });
          log(`${screen.route} (${scheme}): ${sentence(error)}`);
        }
      }
    } finally {
      await context.close();
    }
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  // capturedAt is the whole set's; a capture of some routes leaves it (each picture's own time is its file's).
  // base is where the app last ran, so one route can be captured again without asking (screens_capture).
  if (chosen === spec.screens) await writeFileAtomic(join(dir, "screens.json"), `${JSON.stringify({ ...spec, capturedAt: now, base: options.base }, null, 2)}\n`);
  else if (spec.base !== options.base) await writeFileAtomic(join(dir, "screens.json"), `${JSON.stringify({ ...spec, base: options.base }, null, 2)}\n`);
  const screens = chosen.map((s) => ({ route: s.route, path: s.path, ...(results.get(s.route) ?? { placed: 0, lined: 0, error: "not captured" }) }));
  const placed = screens.reduce((n, s) => n + s.placed, 0);
  const lined = screens.reduce((n, s) => n + s.lined, 0);
  // Unknown is never zero: places with no line in a development build are explained, not left as a 0.
  const noLines = dev && placed > 0 && lined === 0 ? (whyNoLines(notes) ?? "the source maps name no file of this product: its components may all come from a library") : null;
  return { dir, project: spec.project, screens, production: react && !dev, noReact: !react && screens.some((s) => !s.error), noLines };
}

/** The capture in a few lines, with what to do next. */
export function captureText(report: CaptureReport): string {
  const ok = report.screens.filter((s) => !s.error);
  const lines = [`${ok.length} of ${report.screens.length} screens of ${report.project} captured → ${report.dir}`];
  for (const s of report.screens) lines.push(s.error ? `  ✖ ${s.route}: ${s.error}` : `  ✓ ${s.route}: ${s.placed} components placed, ${s.lined} with their line`);
  if (report.noReact) lines.push("No React on these pages, so nothing is placed: the pictures are kept without places.");
  else if (report.production) lines.push("These pages are a production build: components are placed but have no lines. Run the app in development (vite, next dev) and capture again.");
  else if (report.noLines) lines.push(`Components are placed but none has its line: ${report.noLines}.`);
  lines.push(ok.length ? "Next: youiyoux ui --project <dir> shows them on the Screens page, each component selectable." : "Next: start the app, check --base, and capture again.");
  return lines.join("\n");
}
