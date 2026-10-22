/**
 * `youiyoux discover previews`: photograph Discover candidates in a project's theme, light and
 * dark, for the hub's gallery. discover-thumbs.ts says where the pictures go and when one is stale.
 *
 *   youiyoux ui --project <dir>                       # a hub on your project, in one terminal
 *   youiyoux discover previews [--port 5173] [--registry @shadcn] [--role dialog] [--limit 40] [--force]
 *
 * For each candidate it opens the hub's capture page (/discover/specimen), which asks the hub's
 * server for the candidate exactly as opening it in the drawer does: only that item's source is
 * fetched and bundled, and it runs only in the page's sandboxed frame. The browser is headless
 * Chromium, and any request it makes to anything but this machine is aborted and counted. Each
 * stage is photographed at twice the pixels and kept as WebP.
 *
 * Pictures still current (the listing unchanged since) are kept and not taken again; a candidate
 * that could not be drawn on its own is recorded with why, and not tried again until it changes.
 * `--force` takes every one again. The index is written after each candidate, so stopping part
 * way keeps what was done.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchBrowser } from "../../../packages/detect/src/index.ts";
import { discoverCacheDir, loadIndex } from "../../../packages/discover/src/index.ts";
import { needsCapture, prunePictures, readThumbIndex, selectCandidates, THUMB_SCHEMES, THUMBS_PATH, thumbsDir, writeThumbIndex, type ThumbIndex } from "./discover-thumbs.ts";

/** A page of the browser launchBrowser starts (its playwright-core, not the hub's own copy). */
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>;

/** The preview's own limit (60 s) and the frame's draw limit (15 s), with room to spare. */
const DRAW_TIMEOUT_MS = 90_000;
const SETTLE_MS = 300;
/** Cut inside the stage's rounded border, so a picture is only the drawing on its paper. */
const INSET = 8;
const WEBP_QUALITY = 0.86;
/** A picture with fewer pixels than this share away from its background colour shows nothing. */
const BLANK_SHARE = 0.002;
const SCALE = 2;

async function writeBytes(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

/**
 * A PNG photographed by Chromium, re-encoded as WebP by Chromium's own canvas, and whether it is
 * blank: all but a sliver of its pixels the colour of its corner (a chart with no width, say).
 */
async function webp(page: Page, png: Buffer): Promise<{ bytes: Buffer; blank: boolean }> {
  const { url, share } = await page.evaluate(
    async ({ data, quality }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let away = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i]! - pixels[0]!) + Math.abs(pixels[i + 1]! - pixels[1]!) + Math.abs(pixels[i + 2]! - pixels[2]!) > 24) away++;
      return { url: canvas.toDataURL("image/webp", quality), share: away / (pixels.length / 4) };
    },
    { data: png.toString("base64"), quality: WEBP_QUALITY },
  );
  if (!url.startsWith("data:image/webp;base64,")) throw new Error("this Chromium cannot encode WebP");
  return { bytes: Buffer.from(url.slice("data:image/webp;base64,".length), "base64"), blank: share < BLANK_SHARE };
}

type Outcome = { status: "drawn"; light: Buffer; dark: Buffer; width: number; height: number } | { status: "failed"; reason: string };

/** Open one candidate's capture page and photograph both stages, or say why it could not be drawn. */
async function photograph(page: Page, hub: string, id: string, project: string): Promise<Outcome> {
  await page.goto(`${hub}/discover/specimen?id=${encodeURIComponent(id)}&project=${encodeURIComponent(project)}`);
  const settled = page.locator(`[data-capture="${id}"][data-capture-state="ready"] [data-capture-stage] iframe[data-placed], [data-capture-state="failed"]`).first();
  try {
    await settled.waitFor({ timeout: DRAW_TIMEOUT_MS });
    await page.waitForFunction(() => document.querySelector('[data-capture-state="failed"]') || document.querySelectorAll("[data-capture-stage] iframe[data-placed]").length === 2, undefined, { timeout: DRAW_TIMEOUT_MS });
  } catch {
    return { status: "failed", reason: `It did not draw within ${DRAW_TIMEOUT_MS / 1000}s` };
  }
  await page.waitForTimeout(SETTLE_MS);
  const failed = page.locator('[data-capture-state="failed"]');
  if (await failed.count()) return { status: "failed", reason: ((await failed.first().getAttribute("data-capture-reason")) ?? "It could not be drawn").replace(/\.$/, "") };
  const shots: Partial<Record<(typeof THUMB_SCHEMES)[number], Buffer>> = {};
  let size = { width: 0, height: 0 };
  for (const scheme of THUMB_SCHEMES) {
    const box = await page.locator(`[data-capture-stage="${scheme}"]`).boundingBox();
    if (!box) return { status: "failed", reason: "Its stage was not on the page" };
    const clip = { x: box.x + INSET, y: box.y + INSET, width: box.width - 2 * INSET, height: box.height - 2 * INSET };
    const shot = await webp(page, await page.screenshot({ clip }));
    if (shot.blank) return { status: "failed", reason: "It draws nothing visible on its own (it may need data, a size or a parent)" };
    shots[scheme] = shot.bytes;
    size = { width: Math.round(clip.width * SCALE), height: Math.round(clip.height * SCALE) };
  }
  return { status: "drawn", light: shots.light!, dark: shots.dark!, ...size };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { hub: { type: "string" }, registry: { type: "string" }, role: { type: "string" }, limit: { type: "string" }, force: { type: "boolean", default: false }, cache: { type: "string" } } });
  const hub = (values.hub ?? "http://localhost:5173").replace(/\/+$/, "");
  const cache = resolve(discoverCacheDir(values.cache));
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("--limit takes a whole number above 0");

  // The hub names the project it draws in; without one there is no theme to photograph in.
  const answer = await fetch(`${hub}${THUMBS_PATH}`).then(
    async (res) => ({ ok: res.ok, body: (await res.json().catch(() => null)) as { project?: string; error?: string } | null }),
    () => null,
  );
  if (!answer) {
    process.stderr.write(`✖ no hub answers at ${hub}: start one on your project with \`youiyoux ui --project <dir>\` (it says its port), then run this again\n`);
    return 1;
  }
  if (!answer.ok || !answer.body?.project) {
    process.stderr.write(`✖ ${answer.body?.error ?? `the hub at ${hub} cannot serve Discover previews`}\n`);
    return 1;
  }
  const project = answer.body.project;

  const listings = selectCandidates((await loadIndex(cache)).entries, { registry: values.registry ?? null, role: values.role ?? null, limit });
  let index: ThumbIndex = readThumbIndex(cache, project);
  const todo = listings.filter((e) => needsCapture(index, e.id, e.provenance.sha256, values.force));
  process.stdout.write(`Photographing ${todo.length} of ${listings.length} candidates in ${project}'s theme (${listings.length - todo.length} already current)\n`);

  const dir = thumbsDir(cache, project);
  await mkdir(dir, { recursive: true });
  const offsite: string[] = [];
  // YOUI_CHROMIUM, else the headless shell, downloaded once if it is missing (as youiyoux detect does).
  const browser = await launchBrowser(process.env.YOUI_CHROMIUM, { purpose: { what: "Discover previews", command: "youiyoux discover previews" } });
  let drawn = 0;
  let failed = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: SCALE, reducedMotion: "reduce" });
    const host = new URL(hub).host;
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.host === host || url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return route.continue();
      offsite.push(url.href);
      return route.abort();
    });
    const page = await context.newPage();
    for (const entry of todo) {
      const sha = entry.provenance.sha256;
      const outcome = await photograph(page, hub, entry.id, project);
      const items = { ...index.items };
      const failures = { ...index.failed };
      const at = new Date().toISOString();
      if (outcome.status === "drawn") {
        const key = createHash("sha256").update(outcome.light).update(outcome.dark).digest("hex").slice(0, 16);
        await writeBytes(join(dir, `${key}.light.webp`), outcome.light);
        await writeBytes(join(dir, `${key}.dark.webp`), outcome.dark);
        items[entry.id] = { sha, key, width: outcome.width, height: outcome.height, capturedAt: at };
        delete failures[entry.id];
        drawn++;
        process.stdout.write(`  ✓ ${entry.source.ref}\n`);
      } else {
        delete items[entry.id];
        failures[entry.id] = { sha, reason: outcome.reason, at };
        failed++;
        process.stdout.write(`  – ${entry.source.ref}: ${outcome.reason}\n`);
      }
      index = { ...index, items, failed: failures };
      await writeThumbIndex(cache, index);
    }
  } finally {
    await browser.close();
  }

  // Pictures of listings that changed or left the index are no longer anyone's.
  const current = new Map((await loadIndex(cache)).entries.map((e) => [e.id, e.provenance?.sha256]));
  index = { ...index, items: Object.fromEntries(Object.entries(index.items).filter(([id, t]) => current.get(id) === t.sha)), failed: Object.fromEntries(Object.entries(index.failed).filter(([id, f]) => current.get(id) === f.sha)) };
  await writeThumbIndex(cache, index);
  const pruned = await prunePictures(cache, index);

  process.stdout.write(`${drawn} photographed, ${failed} could not be drawn on their own${pruned ? `, ${pruned} old pictures removed` : ""} → ${dir}\n`);
  if (offsite.length) process.stdout.write(`${offsite.length} requests to other hosts were blocked (${[...new Set(offsite.map((u) => new URL(u).host))].slice(0, 5).join(", ")})\n`);
  process.stdout.write(`Next: open ${hub}/discover?view=gallery\n`);
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`✖ ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
