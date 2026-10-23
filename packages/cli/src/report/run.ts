/**
 * `youiyoux report [path]`, and what `npx youiyoux` runs by default: scan a repo with no setup and
 * write three files beside it (or to --out): youiyoux-report.html, youiyoux-card.png and
 * youiyoux-summary.md. Nothing else is written into the repo: no index, no inventory file, no
 * config; rendered looks come from the specimen cache outside it. It prints five plain-English
 * summary lines, the three paths and what to do next.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import type { SpecimenCache } from "@youiyoux/scanner";
import { drawCard } from "./card.ts";
import { placesByKind, renderHtml } from "./html.ts";
import { addLooks, chromiumStatus, downloadChromium, DOWNLOAD_SIZE, looksOff } from "./looks.ts";
import { renderMarkdown } from "./markdown.ts";
import { buildReportModel, NPX, type ReportModel } from "./model.ts";
import { Redactor } from "./safe.ts";

const REPORT_FILE = "youiyoux-report.html";
const CARD_FILE = "youiyoux-card.png";
const SUMMARY_FILE = "youiyoux-summary.md";

export interface ReportOptions {
  /** The repo (default: the current directory). */
  readonly path?: string;
  /** Where the three files go (default: the repo). */
  readonly out?: string;
  /** Draw the looks, downloading the headless shell first if it is missing (asked, or --yes). */
  readonly render?: boolean;
  readonly yes?: boolean;
  /** Keep the line of code at each place. */
  readonly includeCode?: boolean;
  readonly json?: boolean;
}

/** The outside world, replaceable in tests: questions, the download, the environment, output. */
export interface ReportIo {
  readonly interactive?: boolean;
  readonly ask?: (question: string) => Promise<boolean>;
  readonly download?: () => Promise<boolean>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cache?: SpecimenCache;
  readonly print?: (text: string) => void;
  readonly error?: (text: string) => void;
}

interface ReportResult {
  readonly code: number;
  readonly files: { readonly report: string; readonly card: string; readonly summary: string } | null;
  readonly model: ReportModel | null;
}

/** Ask on the terminal; anything but yes is no. */
async function askTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function writeBinaryAtomic(file: string, bytes: Buffer): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, file);
}

const shown = (file: string): string => {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
};

export async function runReport(options: ReportOptions = {}, io: ReportIo = {}): Promise<ReportResult> {
  const print = io.print ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const error = io.error ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const env = io.env ?? process.env;
  const root = resolve(options.path ?? process.cwd());
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    error(`✖ ${options.path ?? root} is not a directory: run ${NPX} in a repo, or pass its path (${NPX} path/to/repo)`);
    return { code: 2, files: null, model: null };
  }

  // Rendering: on when a Chromium is already here; --render may download one, never silently.
  let chromium = chromiumStatus(env);
  let renderNote: string | null = null;
  if (options.render && !chromium.available) {
    const interactive = io.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY));
    let allowed = options.yes === true;
    if (!allowed && !interactive) {
      error(`✖ --render needs the headless Chromium (${DOWNLOAD_SIZE}, downloaded once), and this shell cannot ask first. Run ${NPX} --render --yes to allow the download, or ${NPX} without --render for the report without rendered looks. Nothing was written.`);
      return { code: 2, files: null, model: null };
    }
    if (!allowed) allowed = await (io.ask ?? askTerminal)(`Download the headless Chromium (${DOWNLOAD_SIZE}, once) to draw the most-used components?`);
    if (allowed) {
      error(`youiyoux: downloading the headless Chromium (${DOWNLOAD_SIZE}, once)`);
      const ok = await (io.download ?? downloadChromium)();
      chromium = chromiumStatus(env);
      if (!ok || !chromium.available) renderNote = `The headless Chromium could not be downloaded, so no looks were drawn; check the network and run ${NPX} --render again, or set YOUI_CHROMIUM to a Chromium.`;
    } else renderNote = `Rendered looks are off: the download was declined. Run ${NPX} --render again and answer yes to draw the most-used components.`;
  }

  const model = await buildReportModel(root, { includeCode: options.includeCode === true });
  const started = performance.now();
  if (chromium.available) await addLooks(model, root, { ...(env.YOUI_CHROMIUM ? { executablePath: env.YOUI_CHROMIUM } : {}), ...(io.cache ? { cache: io.cache } : {}), log: error });
  else if (renderNote) model.render = { state: "off", note: renderNote };
  else looksOff(model);
  model.durationMs += Math.round(performance.now() - started);

  const redactor = await Redactor.forRepo(root, { includeCode: options.includeCode === true, env });
  const clean = redactor.model(model);
  const outDir = resolve(options.out ?? root);
  await mkdir(outDir, { recursive: true });
  const files = { report: join(outDir, REPORT_FILE), card: join(outDir, CARD_FILE), summary: join(outDir, SUMMARY_FILE) };
  const t = clean.totals;
  const card = {
    repo: redactor.scrub(clean.repo),
    parts: placesByKind(clean),
    footer: redactor.scrub(t.libraries.length > 0 ? `UI libraries: ${t.libraries.join(", ")}` : "No UI library found"),
  };
  const html = redactor.scrub(renderHtml(clean));
  const markdown = redactor.scrub(renderMarkdown(clean, REPORT_FILE));
  await writeFileAtomic(files.report, html);
  await writeBinaryAtomic(files.card, drawCard(card));
  await writeFileAtomic(files.summary, markdown);

  if (options.json) {
    print(JSON.stringify({ ...clean, projects: clean.projects.map((p) => ({ ...p, rendered: p.rendered.map(({ light: _l, dark: _d, ...r }) => r) })), files }, null, 2));
    return { code: 0, files, model: clean };
  }
  // The longest label ("Summary") and two spaces.
  const width = 9;
  const looks = clean.render.state === "off" && !renderNote ? `; to add rendered looks, run ${NPX} --render` : "";
  print([
    ...clean.summary,
    "",
    `${"Report".padEnd(width)}${shown(files.report)}`,
    `${"Card".padEnd(width)}${shown(files.card)}`,
    `${"Summary".padEnd(width)}${shown(files.summary)}`,
    "",
    `Next: open ${shown(files.report)} in a browser and start with its top fix; set up youiyoux for your agent with ${NPX} agents install${looks}.`,
  ].join("\n"));
  return { code: 0, files, model: clean };
}
