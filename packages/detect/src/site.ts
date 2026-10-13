/**
 * Website detection with Playwright and the headless-shell Chromium for the pinned playwright-core,
 * downloaded on the first website run, never by project setup (`YOUI_CHROMIUM` uses another).
 * Each URL is loaded, optionally its menus, dialogs and tabs are opened to expose portals
 * (`expose`), every fingerprint is read in one evaluate per state, and one element screenshot
 * is saved per detected element type. The report covers only the pages crawled, and says so.
 */
import { spawn as spawnChild } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright-core";
import type { DetectFont, DetectPage, DetectReport } from "@youiyoux/core";
import { COLLECT_SOURCE, collectSpec, MARKER, TRIGGERS_SOURCE, type CollectedFacts } from "./collect.ts";
import { buildReport } from "./report.ts";
import type { ElementHit, Signal } from "./score.ts";
import { siteSignals, type PageFacts } from "./site-signals.ts";

/** The one line printed before the headless shell is downloaded. */
export const DOWNLOAD_NOTICE = "youi detect: downloading Chromium headless shell (~100 MB, once)";
export const SCREENSHOT_DIR = "screenshots";
const TRIGGER_ATTR = "data-youi-trigger";

export class BrowserMissingError extends Error {
  override name = "BrowserMissingError";
}

export interface SiteOptions {
  /** The report's directory: screenshots go to `<out>/screenshots/`. */
  readonly out: string;
  /** Open menus, dialogs and tabs to expose portals. */
  readonly expose?: boolean;
  /** A Chromium to use instead of the installed headless shell. */
  readonly executablePath?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly timeoutMs?: number;
  /** At most this many triggers are opened per page. */
  readonly maxTriggers?: number;
  readonly now?: Date;
}

/** What the browser is for, in launchBrowser's messages: `no Chromium for <what>`, `<command>: downloading…`. */
export interface BrowserPurpose {
  readonly what: string;
  readonly command: string;
}

export const WEBSITE_DETECTION: BrowserPurpose = { what: "website detection", command: "youi detect" };

/** What launchBrowser does to the outside world, replaceable in tests. */
export interface LaunchDeps {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>;
  /** Run a command to completion; resolves with its exit code. */
  readonly spawn?: (command: string, args: readonly string[]) => Promise<number>;
  readonly log?: (line: string) => void;
  /** Default: website detection, whose messages stay as they were. */
  readonly purpose?: BrowserPurpose;
  /** false: a missing headless shell is an error that says how to install it, never a download (tests). */
  readonly download?: boolean;
}

/** playwright-core's own CLI, beside the package.json of the copy this package resolves. */
export function playwrightCli(): string {
  return join(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
}

/** The installer's output goes to stderr, so `youi detect --json` keeps a clean stdout. */
function spawnToStderr(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const isMissing = (error: unknown): boolean => /Executable doesn't exist|ENOENT|install/i.test(error instanceof Error ? error.message : String(error));

/**
 * Launch headless Chromium. Without an executablePath, a missing headless shell is downloaded
 * once (`playwright-core install chromium-headless-shell`, run by this Node) and launch is retried once.
 */
export async function launchBrowser(executablePath?: string, deps: LaunchDeps = {}): Promise<Browser> {
  const launch = deps.launch ?? ((options: LaunchOptions) => chromium.launch(options));
  const options: LaunchOptions = { headless: true, ...(executablePath ? { executablePath } : {}) };
  const { what, command } = deps.purpose ?? WEBSITE_DETECTION;
  try {
    return await launch(options);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    if (executablePath) throw new BrowserMissingError(`no Chromium for ${what} at ${executablePath} (YOUI_CHROMIUM): point it at a Chromium, or unset it to use the headless shell ${command} downloads`);
    if (deps.download === false) throw new BrowserMissingError(`no Chromium for ${what}: the headless shell is not installed; run node ${playwrightCli()} install chromium-headless-shell, or set YOUI_CHROMIUM to a Chromium`);
  }
  (deps.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(`${command}: downloading Chromium headless shell (~100 MB, once)`);
  const code = await (deps.spawn ?? spawnToStderr)(process.execPath, [playwrightCli(), "install", "chromium-headless-shell"]).catch(() => 1);
  try {
    return await launch(options);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    throw new BrowserMissingError(`no Chromium for ${what}: downloading the headless shell failed${code ? ` (installer exit code ${code})` : ""}; check the network and run ${command} again, or set YOUI_CHROMIUM to a Chromium`);
  }
}

/** Two reads of the same page (before and after opening a trigger): the larger count of everything, every variable. */
function mergeFacts(a: PageFacts, b: PageFacts): PageFacts {
  const maxTally = (x: PageFacts["classes"], y: PageFacts["classes"]) =>
    Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].map((k) => {
      const [p, q] = [x[k], y[k]];
      return [k, { count: Math.max(p?.count ?? 0, q?.count ?? 0), samples: [...new Set([...(p?.samples ?? []), ...(q?.samples ?? [])])].slice(0, 5) }];
    }));
  const maxCount = (x: Readonly<Record<string, number>>, y: Readonly<Record<string, number>>) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].map((k) => [k, Math.max(x[k] ?? 0, y[k] ?? 0)]));
  return {
    url: a.url,
    title: a.title,
    classes: maxTally(a.classes, b.classes),
    rootVars: [...new Set([...a.rootVars, ...b.rootVars])].sort(),
    ids: maxTally(a.ids, b.ids),
    dataSlots: maxCount(a.dataSlots, b.dataSlots),
    styleTags: maxCount(a.styleTags, b.styleTags),
    tailwind: b.tailwind.total > a.tailwind.total ? b.tailwind : a.tailwind,
    fonts: a.fonts,
    elements: a.elements.map((e, i) => ({ ...e, count: Math.max(e.count, b.elements[i]?.count ?? 0) })),
  };
}

interface PageRun {
  readonly page: DetectPage;
  readonly facts: PageFacts | null;
  /** `library:type` → screenshot path relative to the report. */
  readonly shots: Map<string, string>;
}

async function crawl(page: Page, url: string, n: number, options: SiteOptions): Promise<PageRun> {
  const spec = collectSpec();
  const shots = new Map<string, string>();
  const timeout = options.timeoutMs ?? 30_000;
  const read = async (): Promise<PageFacts> => {
    const raw = (await page.evaluate(`(${COLLECT_SOURCE})(${JSON.stringify(spec)})`)) as CollectedFacts;
    for (const [i, rule] of spec.elements.entries()) {
      const key = `${rule.library}:${rule.type}`;
      if (!raw.elements[i]?.marked || shots.has(key)) continue;
      const file = `${SCREENSHOT_DIR}/p${n}-${rule.library}-${rule.type}.png`;
      try {
        await page.locator(`[${MARKER}${i}]`).first().screenshot({ path: join(options.out, file), timeout: 5_000, animations: "disabled" });
        shots.set(key, file);
      } catch {
        // An element that moved or detached between the read and the shot keeps its verdict, without a picture.
      }
    }
    return { url, title: raw.title, classes: raw.classes, rootVars: raw.rootVars, ids: raw.ids, dataSlots: raw.dataSlots, styleTags: raw.styleTags, tailwind: raw.tailwind, fonts: raw.fonts, elements: spec.elements.map((rule, i) => ({ ...rule, count: raw.elements[i]?.count ?? 0 })) };
  };
  try {
    const response = await page.goto(url, { waitUntil: "load", timeout });
    if (response && response.status() >= 400) return { page: { url, status: "failed", error: `HTTP ${response.status()}`, exposed: 0 }, facts: null, shots };
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    let facts = await read();
    let exposed = 0;
    if (options.expose) {
      const loaded = page.url();
      const triggers = (await page.evaluate(`(${TRIGGERS_SOURCE})(${JSON.stringify({ attr: TRIGGER_ATTR, limit: options.maxTriggers ?? 8 })})`)) as string[];
      for (const [i] of triggers.entries()) {
        try {
          await page.locator(`[${TRIGGER_ATTR}="${i}"]`).first().click({ timeout: 2_000 });
          await page.waitForTimeout(300);
          facts = mergeFacts(facts, await read());
          exposed++;
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
          if (page.url() !== loaded) await page.goto(loaded, { waitUntil: "load", timeout });
        } catch {
          // A trigger that cannot be clicked (covered, removed) is skipped.
        }
      }
    }
    return { page: { url, status: "ok", title: facts.title, exposed }, facts, shots };
  } catch (error: unknown) {
    return { page: { url, status: "failed", error: error instanceof Error ? error.message.split("\n")[0]! : String(error), exposed: 0 }, facts: null, shots };
  }
}

export function siteCoverage(pages: readonly DetectPage[], expose: boolean): string {
  const ok = pages.filter((p) => p.status === "ok");
  const failed = pages.length - ok.length;
  const opened = ok.reduce((sum, p) => sum + p.exposed, 0);
  return [
    `Coverage is per page crawled: ${ok.length} of ${pages.length} page${pages.length === 1 ? "" : "s"} loaded${failed ? ` (${failed} failed)` : ""}: ${ok.map((p) => p.url).join(", ") || "none"}.`,
    "Libraries used only on other pages, behind a sign-in, or in UI that never rendered are not seen; pass more URLs to cover more.",
    expose ? `${opened} menu, dialog and tab trigger${opened === 1 ? "" : "s"} were opened to expose portals.` : "Menus and dialogs rendered into portals only when opened are not seen; pass --expose to open them.",
  ].join(" ");
}

/** Detect the libraries behind one or more pages. Each URL is a page crawled; nothing else on the site is. */
export async function siteReport(urls: readonly string[], options: SiteOptions): Promise<DetectReport> {
  if (urls.length === 0) throw new Error("youi detect needs at least one URL");
  for (const url of urls) if (!/^https?:\/\//.test(url)) throw new Error(`${url} is not an http(s) URL`);
  await rm(join(options.out, SCREENSHOT_DIR), { recursive: true, force: true });
  await mkdir(join(options.out, SCREENSHOT_DIR), { recursive: true });
  const browser = await launchBrowser(options.executablePath);
  const runs: PageRun[] = [];
  try {
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
    for (const [i, url] of urls.entries()) {
      const page = await context.newPage();
      runs.push(await crawl(page, url, i + 1, options));
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const signals: Signal[] = [];
  const hits: ElementHit[] = [];
  const notes: string[] = [];
  const fonts = new Map<string, Set<string>>();
  for (const run of runs) {
    if (!run.facts) continue;
    const found = siteSignals(run.facts);
    signals.push(...found.signals);
    notes.push(...found.notes);
    hits.push(...found.hits.map((hit) => {
      const shot = run.shots.get(`${hit.library}:${hit.type}`);
      return shot ? { ...hit, screenshot: shot } : hit;
    }));
    for (const font of run.facts.fonts) fonts.set(font.family, new Set([...(fonts.get(font.family) ?? []), ...font.usedBy]));
  }
  const pages = runs.map((r) => r.page);
  const hosts = [...new Set(urls.map((u) => new URL(u).host))];
  const report = buildReport({
    kind: "site",
    inputs: urls,
    name: hosts.join(" + "),
    pages,
    coverage: siteCoverage(pages, Boolean(options.expose)),
    signals,
    hits,
    fonts: [...fonts].map(([family, usedBy]): DetectFont => ({ family, usedBy: [...usedBy] })),
    notes,
    ...(options.now ? { now: options.now } : {}),
  });
  // One screenshot per element type: drop the pictures of matches that lost to another library.
  const kept = new Set(report.elements.flatMap((e) => (e.screenshot ? [e.screenshot.split("/").at(-1)!] : [])));
  for (const name of await readdir(join(options.out, SCREENSHOT_DIR))) if (!kept.has(name)) await rm(join(options.out, SCREENSHOT_DIR, name), { force: true });
  return report;
}
