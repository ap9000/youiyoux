/**
 * Captures a project's screens for the Screens page, with chrome-devtools-axi:
 *
 *   node scripts/capture-screens.ts --project toolroll --base http://127.0.0.1:48791
 *
 * Reads `fixtures/<project>.screens.json` (route → the address that shows it) and writes
 * `fixtures/<project>.screens/<slug>.<scheme>.webp` (2x, the screen page) and
 * `<slug>.<scheme>.thumb.webp` (half size, thumbnails), light and dark. `pnpm data`
 * then content-hashes them into the snapshot.
 *
 * Point it at a seeded demo or a scratch copy, never at someone's working instance:
 * these pictures are committed with the project's usage map. Sign in first in the same
 * CHROME_DEVTOOLS_AXI_SESSION (default `youiyoux-capture`); the session keeps the cookie.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { screenSlug } from "../src/data/screens.ts";

const APP = resolve(import.meta.dirname, "..");
const SETTLE_MS = 1200;
const FULL_SCALE = 2;
const THUMB_SCALE = 0.5;
const SCHEMES = ["light", "dark"] as const;

interface ScreensFile {
  schema: "youiyoux.screens/v1";
  project: string;
  viewport: { width: number; height: number };
  screens: Array<{ route: string; path: string }>;
}

function readScreens(project: string): ScreensFile {
  const file = join(APP, "fixtures", `${project}.screens.json`);
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ScreensFile>;
  if (value.schema !== "youiyoux.screens/v1" || !Array.isArray(value.screens) || !value.viewport) throw new Error(`${file} is not a youiyoux.screens/v1 document`);
  return value as ScreensFile;
}

function axi(...args: string[]): string {
  return execFileSync("chrome-devtools-axi", args, { encoding: "utf8", env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: process.env.CHROME_DEVTOOLS_AXI_SESSION ?? "youiyoux-capture" } });
}

function main(): void {
  const { values } = parseArgs({ options: { project: { type: "string" }, base: { type: "string" } } });
  if (!values.project || !values.base) throw new Error("usage: node scripts/capture-screens.ts --project <id> --base <url of a demo or scratch instance>");
  const config = readScreens(values.project);
  const out = join(APP, "fixtures", `${values.project}.screens`);
  mkdirSync(out, { recursive: true });
  const slugs = new Set<string>();
  for (const { route } of config.screens) {
    const slug = screenSlug(route);
    if (slugs.has(slug)) throw new Error(`two routes share the file name ${slug}`);
    slugs.add(slug);
  }
  const { width, height } = config.viewport;
  for (const scheme of SCHEMES) {
    for (const [suffix, scale] of [["", FULL_SCALE], [".thumb", THUMB_SCALE]] as const) {
      axi("emulate", "--viewport", `${width}x${height}x${scale}`, "--color-scheme", scheme);
      for (const screen of config.screens) {
        axi("open", new URL(screen.path, values.base).href);
        axi("wait", String(SETTLE_MS));
        const file = join(out, `${screenSlug(screen.route)}.${scheme}${suffix}.webp`);
        axi("screenshot", file, "--format", "webp");
        process.stdout.write(`${screen.route} (${scheme}${suffix}) → ${file}\n`);
      }
    }
  }
}

main();
