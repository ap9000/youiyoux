/**
 * Rendered looks in the report: the most-used components of each project drawn the way `youi
 * render` draws them (renderShots: the project's own code and CSS in headless Chromium), light
 * and dark at phone width, embedded as data: URIs. Images come from the specimen cache, outside
 * the repo.
 *
 * Chromium is never downloaded on the way: `chromiumStatus` only looks for YOUI_CHROMIUM or the
 * headless shell of this playwright-core already on disk. Without one the report says how to
 * turn the looks on; `--render` downloads the headless shell, after asking (or with --yes).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { playwrightCli } from "@youiyoux/detect";
import { findStylesheets } from "../../../scanner/src/specimens/css.ts";
import { loadInventoryTarget, renderShots, RenderUnavailableError, type SpecimenCache } from "@youiyoux/scanner";
import { publicLook } from "./filters.ts";
import { NPX, type ReportModel } from "./model.ts";

/** Components drawn per project. */
const LOOKS_PER_PROJECT = 4;
export const DOWNLOAD_SIZE = "~100 MB";
const DEPENDENCIES = "Install the repo's dependencies to see rendered looks";
/** Notes that say a project or component could not be drawn with its own code and CSS (missing dependencies, most often). */
const UNDRAWABLE = /not installed|loads no stylesheet|drawn from (?:its|their) (?:tag and )?classes|did not render|bundle failed|unstyled|stub fallback/i;

interface ChromiumStatus {
  readonly available: boolean;
  /** Where it is, or where the headless shell would go. */
  readonly where: string;
}

/** The playwright-core youiyoux render and youiyoux detect launch: its browsers.json names the headless shell's revision. */
const playwrightDir = (): string => dirname(playwrightCli());

/** Where playwright-core keeps its browsers, as it decides it (PLAYWRIGHT_BROWSERS_PATH, else the per-OS cache). */
function browsersPath(env: Readonly<Record<string, string | undefined>>): string {
  const set = env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === "0") return join(playwrightDir(), ".local-browsers");
  if (set) return set;
  if (process.platform === "darwin") return join(homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "ms-playwright");
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
}

/** Whether a Chromium is here now: YOUI_CHROMIUM, else this playwright-core's installed headless shell. Never downloads. */
export function chromiumStatus(env: Readonly<Record<string, string | undefined>> = process.env): ChromiumStatus {
  if (env.YOUI_CHROMIUM) return { available: existsSync(env.YOUI_CHROMIUM), where: env.YOUI_CHROMIUM };
  try {
    const browsers = JSON.parse(readFileSync(join(playwrightDir(), "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string }> };
    const revision = browsers.browsers.find((b) => b.name === "chromium-headless-shell")?.revision;
    const dir = join(browsersPath(env), `chromium_headless_shell-${revision}`);
    return { available: revision !== undefined && existsSync(join(dir, "INSTALLATION_COMPLETE")), where: dir };
  } catch {
    return { available: false, where: "playwright-core is not installed" };
  }
}

/** `playwright-core install chromium-headless-shell`, run by this Node, its output on stderr. Resolves true when it succeeded. */
export function downloadChromium(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(playwrightDir(), "cli.js"), "install", "chromium-headless-shell"], { stdio: ["ignore", 2, 2] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

interface LooksOptions {
  /** A Chromium to use instead of the headless shell (YOUI_CHROMIUM). */
  readonly executablePath?: string;
  readonly cache?: SpecimenCache;
  readonly log?: (line: string) => void;
}

const dataUri = (file: string | undefined): string | null => (file && existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString("base64")}` : null);

/** Draw each project's most-used components into the model; a project that cannot be drawn says why. */
export async function addLooks(model: ReportModel, repoRoot: string, options: LooksOptions = {}): Promise<void> {
  const drawn: string[] = [];
  const problems: string[] = [];
  // Where missing dependencies stopped a draw: said once for the whole report, not per project or component.
  const missing: string[] = [];
  for (const section of model.projects) {
    const names = [...new Set(section.components.map((c) => c.name))].slice(0, LOOKS_PER_PROJECT);
    if (names.length === 0) continue;
    const where = section.dir === "." ? "this repo" : section.dir;
    try {
      // Missing dependencies are known before starting Chromium, including in a cache-only run.
      const installed = (name: string): boolean => {
        let dir = join(repoRoot, section.dir);
        while (true) {
          if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
          if (dir === repoRoot || dirname(dir) === dir) return false;
          dir = dirname(dir);
        }
      };
      if (!installed("react") || !installed("react-dom")) { missing.push(where); continue; }
      const projectRoot = join(repoRoot, section.dir);
      const target = await loadInventoryTarget(projectRoot);
      if (findStylesheets(projectRoot, target.files, { tsconfig: target.tsconfig, override: target.specimenCss, templates: target.templates }).found.length === 0) {
        missing.push(where);
        continue;
      }
      const report = await renderShots(join(repoRoot, section.dir), names, { download: false, base: "HEAD", ...(options.executablePath ? { executablePath: options.executablePath } : {}), ...(options.cache ? { cache: options.cache } : {}), ...(options.log ? { log: options.log } : {}) });
      const unavailable = report.notes.some((note) => UNDRAWABLE.test(note));
      if (unavailable) {
        missing.push(where);
        continue;
      }
      for (const component of report.components) {
        if (component.notes.some((note) => UNDRAWABLE.test(note))) {
          missing.push(component.component);
          continue;
        }
        const shot = (scheme: string) => component.shots.find((s) => s.scheme === scheme && s.width === 390)?.path ?? component.shots.find((s) => s.scheme === scheme)?.path;
        const light = dataUri(shot("light"));
        const dark = dataUri(shot("dark"));
        if (!light && !dark) {
          problems.push(`${component.component}${section.dir === "." ? "" : ` in ${section.dir}`}: ${component.notes[0] ?? "nothing could be drawn"}`);
          continue;
        }
        const file = section.components.find((c) => c.name === component.component)?.file ?? component.file ?? "";
        section.rendered.push({ component: component.component, file, looks: model.includeCode ? component.looks : component.looks.map(publicLook), light, dark });
        drawn.push(component.component);
      }
    } catch (error: unknown) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof RenderUnavailableError) break;
    }
  }
  if (missing.length > 0) problems.unshift(`${DEPENDENCIES} (${[...new Set(missing)].join(", ")})`);
  const next = missing.length > 0 ? `install the repo's dependencies with its package manager (pnpm install, npm install or yarn), then run ${NPX} again` : undefined;
  if (drawn.length > 0) model.render = { state: "drawn", note: `The ${drawn.length === 1 ? "most-used component is" : `${drawn.length} most-used components are`} drawn with the project's own code and CSS, light and dark at phone width.${problems.length > 0 ? ` Not drawn: ${problems.join("; ")}.` : ""}`, ...(next ? { next } : {}) };
  else model.render = { state: "failed", note: problems.length > 0 ? `No component could be drawn: ${problems.join("; ")}.` : "No component is used often enough to draw.", ...(next ? { next } : {}) };
}

/** What the report says when no Chromium is here. */
export function looksOff(model: ReportModel): void {
  model.render = { state: "off", note: `Rendered looks are off: no Chromium was found. Run ${NPX} --render to draw the most-used components; it asks before downloading the headless Chromium (${DOWNLOAD_SIZE}, once), and everything else in this report works without it.` };
}
