/**
 * What an agent sees after changing a component (`youiyoux render`, the MCP tool `ui_render`): its
 * looks drawn the way specimens are (server-rendered with the project's own React, on the
 * project's own CSS: render.ts, css.ts), laid out on one page per colour scheme and screenshotted
 * in headless Chromium at desktop and phone width; accessibility issues from axe-core on those
 * pages; and the same looks drawn from the base commit, compared pixel by pixel.
 *
 * The before side is never checked out: the files that differ from the base are served to
 * esbuild from `git show` (render.ts `overlay`), and their base contents are scanned by Tailwind
 * for class names, so the one sheet has the rules both sides use. Stylesheets come from the
 * working tree on both sides; a stylesheet that changed since the base is said in the notes.
 *
 * Fast by caching: per component, the files its bundle read (esbuild's metafile), its recipes,
 * every stylesheet, the package versions and the base commit make a key. A hit returns the saved
 * images and findings with no bundle, no Tailwind and no browser. With no target, only components
 * whose files differ from the base (or from their last render) are drawn. Everything is written
 * under the specimen cache, outside the project; nothing in the project is written or run beyond
 * what specimens already run (contain.ts).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Browser, Page } from "playwright-core";
import { sha256, type InventoryRecipe, type InventoryRole } from "@youiyoux/core";
import { buildInventory } from "../inventory/inventory.ts";
import { roleOfName } from "../inventory/roles.ts";
import { loadInventoryTarget } from "../inventory/target.ts";
import { browserLookOf, escapeHtml, markupOf } from "./build.ts";
import { newStats, SpecimenCache, versions, writeJsonAtomic, type SpecimenStats } from "./cache.ts";
import { realOf, relativeInside } from "./contain.ts";
import { buildProjectCss, SCHEMES, type Scheme } from "./css.ts";
import { renderComponents, withNamePlaceholders, type ComponentRecipe, type RenderJob } from "./render.ts";

/** Bump when what a render entry holds, or how it is drawn, changes: old entries are never read. */
export const SHOTS_FORMAT = "youiyoux.shots/4";
/** Desktop and phone. */
export const SHOT_WIDTHS: readonly number[] = [1280, 390];
/** Distinct looks drawn per component: enough to see its variants, few enough to read. */
export const MAX_LOOKS = 8;
/** A pixel counts as changed when a channel moved more than this (anti-aliasing stays under it). */
export const PIXEL_THRESHOLD = 40;
const VIEWPORT_HEIGHT = 720;
/** Changed files served from the base: past this, the rest are left as they are now (and said). */
const MAX_OVERLAY = 400;

export interface ShotStats extends SpecimenStats {
  /** Components whose looks were drawn in Chromium (the after side). */
  renders: number;
  /** Components whose base looks were drawn in Chromium. */
  baseRenders: number;
  /** Chromium launches. */
  browsers: number;
}

export const newShotStats = (): ShotStats => ({ ...newStats(), renders: 0, baseRenders: 0, browsers: 0 });

export interface Shot {
  readonly scheme: Scheme;
  readonly width: number;
  readonly path: string;
}

export interface A11yIssue {
  /** axe rule id: `label`, `color-contrast`. */
  readonly rule: string;
  readonly status: "new" | "pre-existing" | "fixed" | "not-compared";
  readonly specimenOnly: readonly string[] | null;
  /** Stable look and structural element path, independent of axe selectors and CSS classes. */
  readonly look: string;
  readonly path: string;
  readonly markup: string;
  readonly impact: string | null;
  readonly help: string;
  readonly url: string;
  /** Number of elements represented by this finding, across schemes and widths. */
  readonly count: number;
  readonly schemes: readonly Scheme[];
  readonly widths: readonly number[];
  /** The attributed element: a selector, its markup, and what axe says to fix. */
  readonly targets: ReadonlyArray<{ readonly selector: string; readonly html: string; readonly fix: string }>;
}

export interface DiffShot {
  readonly scheme: Scheme;
  readonly width: number;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
  /** Share of pixels that changed, 0–1. */
  readonly changed: number;
}

export type ShotDiff = { readonly base: string; readonly shots: readonly DiffShot[] } | { readonly none: string };

export interface ComponentShots {
  /** What was asked for (a file or a component name), or the changed file it was found by. */
  readonly component: string;
  /** Its defining file, project-relative; null when nothing matched. */
  readonly file: string | null;
  /** Each look drawn, for a reader: `Button variant="outline"`. */
  readonly looks: readonly string[];
  readonly shots: readonly Shot[];
  readonly a11y: readonly A11yIssue[];
  readonly diff: ShotDiff;
  /** From the cache: nothing it depends on changed since it was last drawn. */
  readonly cached: boolean;
  readonly notes: readonly string[];
}

export interface ShotsReport {
  readonly project: string;
  readonly root: string;
  /** The base the before side comes from; null with the reason in `baseNote`. */
  readonly base: { readonly ref: string; readonly commit: string } | null;
  readonly baseNote: string | null;
  readonly components: readonly ComponentShots[];
  /** With no target: components whose files are the same as at the base, not drawn again. */
  readonly unchanged: readonly string[];
  readonly notes: readonly string[];
  /** Where this project's renders are kept. */
  readonly dir: string;
}

export interface ShotsOptions {
  readonly cache?: SpecimenCache;
  readonly stats?: ShotStats;
  /** A git ref to compare with (default: the merge base with origin/main, else main, else HEAD). */
  readonly base?: string;
  /** A Chromium to use instead of the headless shell (YOUI_CHROMIUM). */
  readonly executablePath?: string;
  /** false: a missing headless shell is an error with the install command, never a download (tests). */
  readonly download?: boolean;
  /** Where the download notice goes (default stderr). */
  readonly log?: (line: string) => void;
}

/** Why the render could not run at all (no browser, no project): said plainly, never as a pass. */
export class RenderUnavailableError extends Error {
  override name = "RenderUnavailableError";
}

type Look = { readonly key: string; readonly recipe: InventoryRecipe; readonly role: InventoryRole | null; readonly uses: number; readonly dynamic: readonly string[]; readonly namedAtEverySite: boolean };

interface Group {
  readonly name: string;
  readonly file: string | null;
  readonly looks: readonly Look[];
  readonly notes: string[];
}

interface Manifest {
  readonly format: typeof SHOTS_FORMAT;
  readonly name: string;
  readonly file: string | null;
  readonly key: string;
  /** Project-relative files its bundle read (and its own file). */
  readonly inputs: readonly string[];
  readonly result: ComponentShots;
}

const exec = promisify(execFile);
const slug = (text: string): string => `${text.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-48) || "component"}-${sha256(text).slice(0, 8)}`;
const SOURCE = /\.(?:tsx|ts|jsx|js|mjs|cjs|mts|cts)$/;
/** The scheme's canvas, set before the project's CSS so its own page background wins: axe reads an unset one as white, even in dark. */
const PAGE_BACKGROUND = "html{background-color:Canvas;color:CanvasText}";
const PAGE_CSS = `body{margin:0}.youi-shots{display:flex;flex-direction:column;align-items:flex-start;gap:20px;padding:24px;box-sizing:border-box;max-width:100%}.youi-look{max-width:100%}.youi-caption{margin:0 0 6px;font:12px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#888}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`;

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await exec("git", [...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" })).stdout;
}

const gitOr = (root: string, args: readonly string[]): Promise<string | null> => git(root, args).catch(() => null);

/** The base commit to compare with, or why there is none. */
async function resolveBase(root: string, asked: string | undefined): Promise<{ ref: string; commit: string } | { none: string }> {
  if ((await gitOr(root, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return { none: "no base: not a git checkout" };
  if (asked !== undefined) {
    const commit = (await gitOr(root, ["rev-parse", "--verify", "--quiet", `${asked}^{commit}`]))?.trim();
    return commit ? { ref: asked, commit } : { none: `no base: ${asked} is not a commit in this repository` };
  }
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    const commit = (await gitOr(root, ["merge-base", "HEAD", ref]))?.trim();
    if (commit) return { ref, commit };
  }
  const head = (await gitOr(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?.trim();
  return head ? { ref: "HEAD", commit: head } : { none: "no base: the repository has no commits yet" };
}

/** Project-relative files that differ from the base in the working tree, untracked ones included. */
async function changedSince(root: string, commit: string): Promise<Set<string>> {
  const tracked = await git(root, ["diff", "--name-only", "-z", "--relative", commit, "--"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  return new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
}

/** A file as it was at the base, or null when it did not exist there. */
const atBase = (root: string, commit: string, file: string): Promise<string | null> => gitOr(root, ["show", `${commit}:./${file}`]);

/** `Button variant="outline" "Save"`: how a look is named in captions and summaries. */
function describe(recipe: InventoryRecipe): string {
  if (recipe.kind === "class") return `<${recipe.tag}${recipe.classes.length ? ` class="${recipe.classes.join(" ")}"` : ""}>${recipe.label ? ` "${recipe.label}"` : ""}`;
  const props = Object.entries(recipe.props).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  return [...recipe.wrappers.map((w) => `${w.export} >`), recipe.export, ...props, ...(recipe.label ? [JSON.stringify(recipe.label)] : [])].join(" ");
}

const NAME_PROPS = new Set(["aria-label", "aria-labelledby", "title", "id", "alt", "children"]);
const NAME_RULES = new Set(["button-name", "link-name", "label", "input-button-name", "aria-input-field-name", "aria-command-name", "aria-toggle-field-name", "select-name", "image-alt", "svg-img-alt", "frame-title", "input-image-alt", "area-alt", "object-alt", "aria-dialog-name", "aria-meter-name", "aria-progressbar-name", "aria-tooltip-name", "aria-treeitem-name"]);
const lookKey = (recipe: InventoryRecipe, role: InventoryRole | null): string => {
  // Component identity uses its inputs; implementation classes must not invalidate a cached base audit.
  const visual = recipe.kind === "component" ? { ...recipe, parent: undefined, tag: undefined, classes: undefined, wrappers: recipe.wrappers } : recipe;
  return sha256(`${role}\0${JSON.stringify(visual)}`).slice(0, 12);
};

/** Distinct looks, most used first, at most MAX_LOOKS. */
function distinct(looks: ReadonlyArray<{ recipe: InventoryRecipe; role: InventoryRole | null }>): Look[] {
  const byKey = new Map<string, Look>();
  for (const { recipe, role } of looks) {
    const key = lookKey(recipe, role);
    const seen = byKey.get(key);
    const dynamic = recipe.kind === "component" ? recipe.dynamic ?? [] : [];
    byKey.set(key, { key, recipe, role, uses: (seen?.uses ?? 0) + 1,
      dynamic: [...new Set([...(seen?.dynamic ?? []), ...dynamic])].sort(),
      namedAtEverySite: (seen?.namedAtEverySite ?? true) && dynamic.some((p) => NAME_PROPS.has(p)),
    });
  }
  return [...byKey.values()].sort((a, b) => b.uses - a.uses || a.key.localeCompare(b.key)).slice(0, MAX_LOOKS);
}

/** Exported PascalCase components a file defines, read from its text: for a component no site renders yet. */
function exportedComponents(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Z][A-Za-z0-9_]*)/g)) names.add(match[1]!);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of match[1]!.split(",")) {
    const name = part.trim().split(/\s+as\s+/).pop()?.trim();
    if (name && /^[A-Z]/.test(name)) names.add(name);
  }
  return [...names];
}

type Sited = { file: string; recipe?: InventoryRecipe | undefined; role: InventoryRole };

/** A file (project-relative) or component name → the looks to draw. */
export function groupOf(root: string, rawLooks: readonly Sited[], target: string, file: string | null): Group {
  const byComponent = Map.groupBy(rawLooks.flatMap((l) => l.recipe?.kind === "component" ? [l.recipe] : []), (r) => `${r.file}#${r.export}`);
  const parents = new Map([...byComponent].flatMap(([key, sites]) => {
    const parent = sites[0]?.parent;
    return parent && sites.every((r) => r.parent?.file === parent.file && r.parent?.export === parent.export) ? [[key, parent] as const] : [];
  }));
  const looks = rawLooks.map((look) => {
    const recipe = look.recipe;
    if (recipe?.kind !== "component") return look;
    const parent = parents.has(`${recipe.file}#${recipe.export}`) ? recipe.parent : undefined;
    if (!parent || recipe.wrappers.some((w) => w.file === parent.file && w.export === parent.export)) return look;
    return { ...look, recipe: { ...recipe, wrappers: [parent, ...recipe.wrappers] } };
  });
  const notes: string[] = [];
  const components = (l: Sited): l is Sited & { recipe: ComponentRecipe } => l.recipe?.kind === "component";
  if (file !== null) {
    const defined = looks.filter(components).filter((l) => l.recipe.file === file || l.recipe.wrappers.some((w) => w.file === file));
    if (defined.length > 0) return { name: target, file, looks: distinct(defined.map((l) => ({ recipe: l.recipe, role: l.role }))), notes };
    const sited = looks.filter((l) => l.file === file && l.recipe);
    if (sited.length > 0) return { name: target, file, looks: distinct(sited.map((l) => ({ recipe: l.recipe!, role: l.role }))), notes: [`no site renders a component defined in ${file}: drawn are the looks its own markup renders`] };
    let source = "";
    try {
      source = SOURCE.test(file) ? readFileSync(join(root, file), "utf8") : "";
    } catch {
      /* unreadable: no exports */
    }
    const names = exportedComponents(source);
    const synthesized = names.map((name) => ({ recipe: { kind: "component" as const, file, export: name, props: {}, label: null, wrappers: [], tag: "div", classes: [] }, role: roleOfName(name) }));
    if (synthesized.length > 0) return { name: target, file, looks: distinct(synthesized), notes: [`no site in the project renders ${names.join(", ")} yet: drawn with no props`] };
    return { name: target, file, looks: [], notes: [`${file} renders no component youi can draw: pass a file that defines or uses a component, or an exported component name`] };
  }
  const wanted = target.toLowerCase();
  const named = looks.filter(components).filter((l) => l.recipe.export.toLowerCase() === wanted);
  if (named.length === 0) return { name: target, file: null, looks: [], notes: [`no component or file "${target}" in the project: pass a file path inside it or an exported component name`] };
  const files = Map.groupBy(named, (l) => l.recipe.file);
  const [home] = [...files].sort((a, b) => b[1].length - a[1].length)[0]!;
  if (files.size > 1) notes.push(`${target} is defined in ${files.size} files; drawn: ${home} (pass a file to choose another)`);
  return { name: target, file: home, looks: distinct(files.get(home)!.map((l) => ({ recipe: l.recipe, role: l.role }))), notes };
}

/** One scheme's page: every look, each under a caption axe is told to skip. */
function pageHtml(title: string, css: string, scheme: Scheme, looks: ReadonlyArray<{ key: string; caption: string; html: string }>): string {
  const dark = scheme === "dark";
  const sections = looks.map((l) => `<section class="youi-look" data-youi-look="${l.key}"><p class="youi-caption" aria-hidden="true">${escapeHtml(l.caption)}</p><div class="youi-specimen">${l.html}</div></section>`).join("");
  return `<!doctype html><html lang="en"${dark ? ' class="dark"' : ""} data-theme="${scheme}" style="color-scheme:${scheme}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_BACKGROUND}</style><style>${css}</style><style>${PAGE_CSS}</style></head><body><main class="youi-shots">${sections}</main></body></html>`;
}

/** The pixel comparison, run in the page: both images padded to the larger size, changed pixels marked on a faded copy of the after side. */
const DIFF_SOURCE = `async ([before, after, threshold]) => {
  const load = (src) => new Promise((done, fail) => { const image = new Image(); image.onload = () => done(image); image.onerror = () => fail(new Error("an image did not load")); image.src = src; });
  const [a, b] = await Promise.all([load(before), load(after)]);
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const pixels = (image) => { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); return context.getImageData(0, 0, width, height).data; };
  const x = pixels(a), y = pixels(b);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  const out = context.createImageData(width, height);
  let changed = 0;
  for (let i = 0; i < x.length; i += 4) {
    const moved = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]), Math.abs(x[i + 3] - y[i + 3]));
    if (moved > threshold) { changed++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 128; out.data[i + 3] = 255; }
    else { const grey = Math.round(((y[i] + y[i + 1] + y[i + 2]) / 3) * 0.3 + 255 * 0.7); out.data[i] = grey; out.data[i + 1] = grey; out.data[i + 2] = grey; out.data[i + 3] = 255; }
  }
  context.putImageData(out, 0, 0);
  return { changed: changed / (width * height), png: canvas.toDataURL("image/png") };
}`;

/** axe on the page, WCAG 2.2 A and AA only (best practices such as "one h1 per page" do not apply to a sheet of looks), captions left out. */
const AXE_RUN = `axe.run({ exclude: [[".youi-caption"]] }, { elementRef: true, runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] }).then((result) => result.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.map((n) => {
  const section = n.element?.closest("[data-youi-look]");
  const path = [];
  for (let el = n.element; el && el !== section; el = el.parentElement) {
    path.unshift(el.tagName.toLowerCase() + ":nth-child(" + (Array.from(el.parentElement?.children ?? []).indexOf(el) + 1) + ")");
  }
  const clone = n.element?.cloneNode(true);
  if (clone) for (const el of [clone, ...clone.querySelectorAll("*")]) el.removeAttribute("class");
  return { target: n.target, html: n.html, failureSummary: n.failureSummary ?? "", look: section?.dataset.youiLook ?? "", path: path.join(" > "), markup: clone?.outerHTML ?? n.html };
}) })))`;

interface AxeNode { readonly target: unknown[]; readonly html: string; readonly failureSummary?: string; readonly look: string; readonly path: string; readonly markup: string }
interface AxeViolation { readonly id: string; readonly impact?: string | null; readonly help: string; readonly helpUrl: string; readonly nodes: readonly AxeNode[] }

/** The browser, launched on first use and closed by the caller. */
class Eyes {
  private browser: Browser | null = null;
  private axe: string | null = null;
  private readonly options: ShotsOptions;
  private readonly stats: ShotStats;

  constructor(options: ShotsOptions, stats: ShotStats) {
    this.options = options;
    this.stats = stats;
  }

  private async open(): Promise<Browser> {
    if (this.browser) return this.browser;
    const { launchBrowser } = await import("@youiyoux/detect");
    try {
      this.browser = await launchBrowser(this.options.executablePath, { purpose: { what: "youiyoux render", command: "youiyoux render" }, ...(this.options.download === false ? { download: false } : {}), ...(this.options.log ? { log: this.options.log } : {}) });
    } catch (error: unknown) {
      throw new RenderUnavailableError(error instanceof Error ? error.message : String(error));
    }
    this.stats.browsers++;
    return this.browser;
  }

  private async page(scheme: Scheme): Promise<Page> {
    const context = await (await this.open()).newContext({ deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "reduce", viewport: { width: SHOT_WIDTHS[0]!, height: VIEWPORT_HEIGHT } });
    // Nothing leaves this machine: a remote font or @import is not fetched (data: URLs are inline).
    await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    return context.newPage();
  }

  /** Screenshots of one page per scheme at each width, with axe's findings when `audit`. */
  async shoot(dir: string, pages: Readonly<Record<Scheme, string>>, audit: boolean): Promise<{ shots: Shot[]; violations: Array<{ scheme: Scheme; width: number; found: AxeViolation[] }> }> {
    mkdirSync(dir, { recursive: true });
    const shots: Shot[] = [];
    const violations: Array<{ scheme: Scheme; width: number; found: AxeViolation[] }> = [];
    for (const scheme of SCHEMES) {
      const page = await this.page(scheme);
      try {
        await page.setContent(pages[scheme], { waitUntil: "load" });
        await page.evaluate("document.fonts.ready.then(() => undefined)");
        if (audit) await page.addScriptTag({ content: this.axeSource() });
        for (const width of SHOT_WIDTHS) {
          await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
          const path = join(dir, `${scheme}-${width}.png`);
          await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
          shots.push({ scheme, width, path });
          if (audit) {
            violations.push({ scheme, width, found: (await page.evaluate(AXE_RUN)) as AxeViolation[] });
          }
        }
      } finally {
        await page.context().close();
      }
    }
    return { shots, violations };
  }

  /** Before and after compared in the page; writes the diff PNG. */
  async diff(before: string, after: string, out: string): Promise<number> {
    const page = await this.page("light");
    try {
      const url = (file: string): string => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
      const result = (await page.evaluate(`(${DIFF_SOURCE})(${JSON.stringify([url(before), url(after), PIXEL_THRESHOLD])})`)) as { changed: number; png: string };
      writeFileSync(out, Buffer.from(result.png.slice(result.png.indexOf(",") + 1), "base64"));
      return result.changed;
    } finally {
      await page.context().close();
    }
  }

  private axeSource(): string {
    this.axe ??= readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    return this.axe;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

/** Keep each element attributable, including when the same rule has both old and new hits. */
function issuesOf(runs: ReadonlyArray<{ scheme: Scheme; width: number; found: readonly AxeViolation[] }>, looks: readonly Look[]): A11yIssue[] {
  const entries = new Map<string, { v: AxeViolation; node: AxeNode; schemes: Set<Scheme>; widths: Set<number> }>();
  for (const run of runs) for (const v of run.found) for (const node of v.nodes) {
    const key = `${v.id}\0${node.look}\0${node.path}`;
    const entry = entries.get(key) ?? { v, node, schemes: new Set(), widths: new Set() };
    entry.schemes.add(run.scheme);
    entry.widths.add(run.width);
    entries.set(key, entry);
  }
  const order = ["critical", "serious", "moderate", "minor"];
  return [...entries.values()].map(({ v, node: n, schemes, widths }): A11yIssue => {
    const look = looks.find((l) => l.key === n.look);
    const specimenOnly = NAME_RULES.has(v.id) && look?.namedAtEverySite ? look.dynamic.filter((p) => NAME_PROPS.has(p)) : null;
    return {
      rule: v.id, impact: v.impact ?? null, help: v.help, url: v.helpUrl,
      status: "not-compared", specimenOnly: specimenOnly?.length ? specimenOnly : null, look: n.look, path: n.path, markup: n.markup,
      count: 1, schemes: SCHEMES.filter((s) => schemes.has(s)), widths: SHOT_WIDTHS.filter((w) => widths.has(w)),
      targets: [{ selector: n.target.map(String).join(" "), html: n.html.length > 160 ? `${n.html.slice(0, 159)}…` : n.html, fix: (n.failureSummary ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Fix (any|all) of the following:$/.test(l)).slice(0, 2).join("; ") }],
    };
  }).sort((a, b) => order.indexOf(a.impact ?? "minor") - order.indexOf(b.impact ?? "minor") || a.rule.localeCompare(b.rule));
}

/** Match one-to-one so additional failing elements are new, even for a shared rule. */
export function compareA11yIssues(after: readonly A11yIssue[], before: readonly A11yIssue[]): A11yIssue[] {
  const remaining = [...before];
  const result = after.map((issue): A11yIssue => {
    const same = (old: A11yIssue): boolean => old.rule === issue.rule && old.look === issue.look;
    let index = remaining.findIndex((old) => same(old) && old.path === issue.path);
    if (index < 0) index = remaining.findIndex((old) => same(old) && old.markup === issue.markup);
    const old = index < 0 ? undefined : remaining.splice(index, 1)[0];
    return { ...issue, status: !old || issue.count > old.count || issue.schemes.some((s) => !old.schemes.includes(s)) || issue.widths.some((w) => !old.widths.includes(w)) ? "new" : "pre-existing" };
  });
  return [...result, ...remaining.map((issue): A11yIssue => ({ ...issue, status: "fixed" }))];
}

/** Content hash of project files (missing ones count as missing). */
function contentHash(root: string, files: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash.update(`${file}\0`);
    const path = join(root, file);
    try {
      if (statSync(path).isFile()) hash.update(readFileSync(path));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readManifest(file: string): Manifest | null {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    return manifest.format === SHOTS_FORMAT ? manifest : null;
  } catch {
    return null;
  }
}

/** Leave only `keep` among a component's saved renders. */
function prune(dir: string, prefix: string, keep: string): void {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name.startsWith(prefix) && name !== keep) rmSync(join(dir, name), { recursive: true, force: true });
}

const allExist = (paths: readonly string[]): boolean => paths.every((p) => existsSync(p));

/**
 * Draw the components `targets` name (files, project-relative or absolute, or exported component
 * names), or with none, the components whose files differ from the base. See the file comment.
 */
export async function renderShots(rootDir: string, targets: readonly string[], options: ShotsOptions = {}): Promise<ShotsReport> {
  const stats = options.stats ?? newShotStats();
  const cache = options.cache ?? new SpecimenCache();
  const root = realOf(rootDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new RenderUnavailableError(`${rootDir} is not a directory: pass --project <dir> (the project root)`);
  const target = await loadInventoryTarget(root);
  const report = await buildInventory([root], { cwd: root });
  const project = report.projects[0]?.id ?? target.id;
  // slug(): the id can come from a cloned repo's youi.project.json, so it never becomes a path as written.
  const dir = join(cache.dir, "shots", `${slug(project)}-${sha256(root).slice(0, 8)}`);
  const notes: string[] = [];

  const base = await resolveBase(root, options.base);
  const baseNote = "none" in base ? base.none : null;
  const changed = "commit" in base ? await changedSince(root, base.commit) : new Set<string>();
  const sited: Sited[] = report.looks.map((l) => ({ file: l.file, recipe: l.recipe, role: l.role }));

  // What to draw: each target, or with none, every component whose files changed.
  const groups: Group[] = [];
  const unchanged: string[] = [];
  if (targets.length > 0) {
    for (const asked of targets) {
      const path = isAbsolute(asked) ? asked : join(root, asked);
      const fileLike = /[\\/]/.test(asked) || extname(asked) !== "" || existsSync(path);
      if (!fileLike) {
        groups.push(groupOf(root, sited, asked, null));
        continue;
      }
      const inside = relativeInside(root, relative(root, realOf(path)));
      if ("refused" in inside) groups.push({ name: asked, file: null, looks: [], notes: [`${asked}: ${inside.refused}; pass a file inside the project`] });
      else if (!existsSync(join(root, inside.ok))) groups.push({ name: asked, file: null, looks: [], notes: [`${inside.ok} does not exist in the project`] });
      else groups.push(groupOf(root, sited, inside.ok, inside.ok));
    }
  } else {
    if (baseNote) notes.push(`${baseNote}: with no target, nothing is known to have changed; pass a file or component name`);
    const files = [...new Set(sited.flatMap((l) => (l.recipe?.kind === "component" ? [l.recipe.file] : [])))].sort();
    const saved = existsSync(dir) ? readdirSync(dir).map((name) => readManifest(join(dir, name, "manifest.json"))).filter((m): m is Manifest => m !== null) : [];
    const touched = (inputs: readonly string[]): boolean => inputs.some((f) => changed.has(f));
    for (const file of files) {
      const wrappersOf = sited.flatMap((l) => (l.recipe?.kind === "component" && l.recipe.file === file ? l.recipe.wrappers.map((w) => w.file) : []));
      const manifest = saved.find((m) => m.file === file);
      if (changed.has(file) || touched(wrappersOf) || (manifest && touched(manifest.inputs))) groups.push(groupOf(root, sited, file, file));
      else unchanged.push(file);
    }
  }

  // Keys: everything a component's images depend on, read without bundling or compiling anything.
  const sheets = target.files.filter((f) => f.endsWith(".css"));
  const common = sha256(JSON.stringify([SHOTS_FORMAT, versions(root), SHOT_WIDTHS, PIXEL_THRESHOLD, "commit" in base ? base.commit : baseNote, contentHash(root, sheets), target.specimenCss, target.tsconfig]));
  const changedSheets = sheets.filter((f) => changed.has(f));
  const keyOf = (group: Group, inputs: readonly string[]): string => sha256(`${common}\0${JSON.stringify(group.looks.map((l) => [l.key, l.recipe, l.role, l.dynamic, l.namedAtEverySite]))}\0${contentHash(root, [...inputs, ...(group.file ? [group.file] : [])])}`).slice(0, 24);

  const components: ComponentShots[] = [];
  const pending: Array<{ group: Group; groupDir: string; index: number }> = [];
  for (const group of groups) {
    const groupDir = join(dir, slug(group.file ?? group.name));
    if (group.looks.length === 0) {
      components.push({ component: group.name, file: group.file, looks: [], shots: [], a11y: [], diff: { none: "nothing drawn" }, cached: false, notes: group.notes });
      continue;
    }
    const manifest = readManifest(join(groupDir, "manifest.json"));
    if (manifest && manifest.key === keyOf(group, manifest.inputs) && allExist([...manifest.result.shots.map((s) => s.path), ...("shots" in manifest.result.diff ? manifest.result.diff.shots.flatMap((d) => [d.before, d.after, d.diff]) : [])])) {
      stats.hits++;
      components.push({ ...manifest.result, component: group.name, cached: true });
      continue;
    }
    stats.misses++;
    pending.push({ group, groupDir, index: components.length });
    components.push(null as unknown as ComponentShots);
  }

  if (pending.length > 0) {
    const eyes = new Eyes(options, stats);
    try {
      // The base's versions of changed sources, for Tailwind to scan (class names only) and esbuild to load.
      const overlay = new Map<string, string | null>();
      let baseSources: string | null = null;
      if ("commit" in base) {
        const sources = [...changed].filter((f) => SOURCE.test(f)).sort();
        if (sources.length > MAX_OVERLAY) notes.push(`${sources.length} source files differ from ${base.ref}: the first ${MAX_OVERLAY} are drawn as they were there, the rest as they are now`);
        baseSources = join(dir, `base-${base.commit.slice(0, 12)}`);
        for (const file of sources.slice(0, MAX_OVERLAY)) {
          const contents = await atBase(root, base.commit, file);
          for (const key of [join(root, file), join(rootDir, file)]) overlay.set(key, contents);
          if (contents !== null) {
            const copy = join(baseSources, file);
            mkdirSync(dirname(copy), { recursive: true });
            writeFileSync(copy, contents);
          }
        }
      }
      const css = await buildProjectCss(root, target.files, stats, { tsconfig: target.tsconfig, override: target.specimenCss, templates: target.templates, ...(baseSources && existsSync(baseSources) ? { extraSources: [baseSources] } : {}) });
      if (baseSources) rmSync(baseSources, { recursive: true, force: true });
      const sheetOf = (scheme: Scheme): string => (scheme === "light" ? css.light : css.dark) ?? "";
      if (css.light === null) notes.push("the project loads no stylesheet youi could find: looks are drawn unstyled");

      for (const { group, groupDir, index } of pending) {
        const groupNotes = [...group.notes];
        const jobs: RenderJob[] = [];
        for (const look of group.looks) {
          if (look.recipe.kind !== "component") continue;
          jobs.push(look.role ? { key: look.key, ...browserLookOf(look.recipe as ComponentRecipe, look.role) } : { key: look.key, recipe: look.recipe as ComponentRecipe, label: look.recipe.label });
        }
        const namedJobs = jobs.map(withNamePlaceholders);
        const draw = async (side: "after" | "before") => {
          const scratch = join(groupDir, `build-${side}`);
          mkdirSync(scratch, { recursive: true });
          try {
            const rendered = await renderComponents(root, target.tsconfig, namedJobs, scratch, stats, side === "before" ? { overlay } : {});
            const auditLooks = group.looks.map((look) => ({ ...look, dynamic: look.dynamic.filter((p) => !rendered.suppliedNames.get(look.key)?.includes(p)) }));
            // A look that did not render (or renders only its children) is drawn from its tag and classes, as specimens are.
            const looks = group.looks.map((look) => {
              const html = rendered.html.get(look.key);
              return { key: look.key, caption: describe(look.recipe), html: html && html.includes("<") ? html : markupOf(look.recipe, look.role ?? "card"), failed: rendered.failures.get(look.key) ?? null, recipe: look.recipe };
            });
            return { looks, auditLooks, inputs: rendered.inputs, warnings: rendered.warnings };
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        };
        const after = await draw("after");
        for (const look of after.looks) if (look.failed && look.recipe.kind === "component") groupNotes.push(`${look.recipe.file}#${look.recipe.export} did not render (${look.failed}): drawn from its tag and classes`);
        groupNotes.push(...after.warnings.filter((w) => !w.startsWith("the component bundle failed") || after.looks.every((l) => l.failed)));
        const inputs = [...new Set([...after.inputs, ...(group.file ? [group.file] : [])])].sort();
        const key = keyOf(group, inputs);
        const pages = (looks: ReadonlyArray<{ key: string; caption: string; html: string }>): Record<Scheme, string> => ({ light: pageHtml(group.name, sheetOf("light"), "light", looks), dark: pageHtml(group.name, sheetOf("dark"), "dark", looks) });

        const afterDir = join(groupDir, `after-${key}`);
        const shot = await eyes.shoot(afterDir, pages(after.looks), true);
        stats.renders++;
        prune(groupDir, "after-", `after-${key}`);

        let diff: ShotDiff;
        let a11y = issuesOf(shot.violations, after.auditLooks);
        const differing = inputs.filter((f) => changed.has(f));
        if (!("commit" in base)) diff = { none: base.none };
        else if (group.file && (await atBase(root, base.commit, group.file)) === null) {
          diff = { none: `new component: ${group.file} is not in ${base.ref}, so there is no before render` };
          a11y = compareA11yIssues(a11y, []);
        } else if (differing.length === 0) {
          diff = { none: `unchanged since ${base.ref} (${base.commit.slice(0, 7)}): its files are the same there, so before and after match` };
          a11y = compareA11yIssues(a11y, a11y);
        } else {
          // A recipe's tag and classes are read from today's source; the base side depends only on what it renders and with which props.
          const identity = group.looks.map((l) => (l.recipe.kind === "component" ? [l.key, l.dynamic, l.namedAtEverySite, l.recipe.file, l.recipe.export, l.recipe.props, l.recipe.label, l.recipe.wrappers, l.role] : [l.recipe, l.role]));
          const beforeKey = sha256(`${common}\0${JSON.stringify(identity)}\0${JSON.stringify(inputs)}`).slice(0, 24);
          const beforeDir = join(groupDir, `before-${beforeKey}`);
          let beforeShots = SCHEMES.flatMap((scheme) => SHOT_WIDTHS.map((width) => ({ scheme, width, path: join(beforeDir, `${scheme}-${width}.png`) })));
          const issuesFile = join(beforeDir, "issues.json");
          if (!allExist([...beforeShots.map((s) => s.path), issuesFile])) {
            const before = await draw("before");
            for (const look of before.looks) if (look.failed && look.recipe.kind === "component") groupNotes.push(`before (${base.ref}): ${look.recipe.file}#${look.recipe.export} did not render (${look.failed})`);
            const beforeShot = await eyes.shoot(beforeDir, pages(before.looks), true);
            beforeShots = beforeShot.shots;
            writeJsonAtomic(issuesFile, issuesOf(beforeShot.violations, before.auditLooks));
            stats.baseRenders++;
            prune(groupDir, "before-", `before-${beforeKey}`);
          }
          a11y = compareA11yIssues(a11y, JSON.parse(readFileSync(issuesFile, "utf8")) as A11yIssue[]);
          const shots: DiffShot[] = [];
          for (const s of shot.shots) {
            const b = beforeShots.find((x) => x.scheme === s.scheme && x.width === s.width)!;
            const out = join(afterDir, `diff-${s.scheme}-${s.width}.png`);
            shots.push({ scheme: s.scheme, width: s.width, before: b.path, after: s.path, diff: out, changed: await eyes.diff(b.path, s.path, out) });
          }
          diff = { base: `${base.ref} (${base.commit.slice(0, 7)})`, shots };
          groupNotes.push(`drawn from ${base.ref}: ${differing.join(", ")}`);
          if (group.looks.some((l) => l.recipe.kind === "class")) groupNotes.push("looks drawn from a tag and its classes use today's classes on both sides: only component looks show a change");
        }
        if (changedSheets.length > 0 && "shots" in diff) groupNotes.push(`stylesheets changed since ${"commit" in base ? base.ref : "the base"} (${changedSheets.join(", ")}): both sides use today's CSS, so the diff shows component changes only`);
        const result: ComponentShots = { component: group.name, file: group.file, looks: after.looks.map((l) => l.caption), shots: shot.shots, a11y, diff, cached: false, notes: groupNotes };
        writeJsonAtomic(join(groupDir, "manifest.json"), { format: SHOTS_FORMAT, name: group.name, file: group.file, key, inputs, result } satisfies Manifest);
        components[index] = result;
      }
    } finally {
      await eyes.close();
    }
  }
  return { project, root, base: "commit" in base ? base : null, baseNote, components, unchanged, notes, dir };
}

const percent = (share: number): string => (share === 0 ? "0%" : share < 0.0001 ? "<0.01%" : `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`);
const listOf = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const counted = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/** How to render again: one component's file, or null for every changed one (no target). */
export type Again = (target: string | null) => string;

/** What the agent should do next, from what the render found. */
export function shotsNext(report: ShotsReport, again: Again): string {
  const missing = report.components.filter((c) => c.shots.length === 0);
  const issues = report.components.map((c) => ({ ...c, a11y: c.a11y.filter((i) => i.status === "new" && !i.specimenOnly) })).filter((c) => c.a11y.length > 0);
  if (report.components.length === 0) return report.baseNote ? "pass the file you changed (youiyoux render <file>) or a component name" : "nothing changed since the base; nothing to do";
  if (missing.length === report.components.length) return "pass a file that defines or uses a component, or an exported component name";
  if (issues.length > 0) {
    const total = issues.reduce((n, c) => n + c.a11y.length, 0);
    const where = issues.flatMap((c) => c.a11y.map((i) => `${i.rule}${i.schemes.length === 1 ? ` in ${i.schemes[0]}` : ""}`));
    return `fix the ${counted(total, "accessibility issue")} (${listOf([...new Set(where)])}), then ${again(issues.length === 1 ? (issues[0]!.file ?? issues[0]!.component) : null)}`;
  }
  const changed = report.components.filter((c) => "shots" in c.diff && c.diff.shots.some((s) => s.changed > 0));
  if (changed.length > 0) return `open the diff images and confirm the change in ${listOf(changed.map((c) => c.file ?? c.component))} is the one you meant; nothing else to fix`;
  const same = report.components.filter((c) => "shots" in c.diff);
  if (same.length > 0) return "looks unchanged; nothing to do (if you meant to change how it looks, check that the classes you edited are the ones it renders)";
  if (report.components.some((c) => c.a11y.some((i) => i.status === "not-compared" && !i.specimenOnly))) return "choose a valid git base and render again to determine which accessibility issues this change introduced";
  if (report.components.some((c) => c.a11y.length > 0)) return "look at the screenshots; no new accessibility issues were confirmed; nothing to fix from this change";
  return "look at the screenshots and check them against what you meant; no accessibility issues were found";
}

/** The plain-text answer the CLI and the MCP tool both give: per component its images, issues and diff, then `next:`. */
export function shotsText(report: ShotsReport, again: Again = (t) => `run youiyoux render${t ? ` ${t}` : ""} again`): string {
  const lines: string[] = [];
  const base = report.base ? `${report.base.ref} (${report.base.commit.slice(0, 7)})` : null;
  for (const c of report.components) {
    if (c.shots.length === 0) {
      lines.push(`${c.component}: nothing drawn`, ...c.notes.map((n) => `  ${n}`));
      continue;
    }
    lines.push(`${c.component}${c.file && c.file !== c.component ? ` (${c.file})` : ""}: ${counted(c.looks.length, "look")} (${c.looks.join(" · ")}), light and dark at ${SHOT_WIDTHS.join(" and ")} px${c.cached ? "; from the cache: nothing it uses changed since it was last drawn" : ""}`);
    for (const s of c.shots) lines.push(`  ${s.scheme} ${s.width}: ${s.path}`);
    if ("shots" in c.diff) {
      const moved = c.diff.shots.filter((d) => d.changed > 0);
      lines.push(moved.length === 0 ? `  before/after against ${c.diff.base}: no visible change` : `  before/after against ${c.diff.base}: pixels changed ${moved.map((d) => `${percent(d.changed)} in ${d.scheme} ${d.width}`).join(", ")}`);
      for (const d of moved) lines.push(`    diff ${d.scheme} ${d.width}: ${d.diff}`);
      if (c.diff.shots[0]) lines.push(`    before images: ${dirname(c.diff.shots[0].before)}`);
    } else lines.push(`  before/after: ${c.diff.none}`);
    if (c.a11y.length === 0) lines.push("  accessibility: no issues axe can find (WCAG 2.2 A and AA, both schemes and widths)");
    else {
      lines.push(`  accessibility: ${counted(c.a11y.length, "issue")}`);
      for (const issue of c.a11y) {
        const where = `${issue.schemes.length === 2 ? "light and dark" : issue.schemes[0]}${issue.widths.length === 1 ? ` at ${issue.widths[0]} px` : ""}`;
        const status = issue.status === "pre-existing" ? `pre-existing: already at ${base}, not from this change` : issue.status === "fixed" ? "fixed by this change" : issue.status;
        const reason = issue.specimenOnly ? `; specimen-only: real usages pass ${issue.specimenOnly.join(", ")}, which the specimen cannot supply` : "";
        lines.push(`    - ${issue.help} (${issue.rule}, ${issue.impact ?? "unrated"}, ${counted(issue.count, "element")} in ${where}): ${issue.targets.map((t) => `${t.html}${t.fix ? ` (${t.fix})` : ""}`).join("; ")} [${status}${reason}]`);
      }
    }
    for (const note of c.notes) lines.push(`  note: ${note}`);
  }
  if (report.unchanged.length > 0) lines.push(`unchanged since ${base ?? "the base"}, not re-rendered: ${counted(report.unchanged.length, "component file")} (${report.unchanged.slice(0, 6).join(", ")}${report.unchanged.length > 6 ? ", …" : ""})`);
  if (report.components.length === 0 && report.unchanged.length === 0 && !report.baseNote) lines.push(`no component files found in ${report.root}`);
  if (report.baseNote && report.components.some((c) => c.shots.length > 0)) lines.push(`before/after: ${report.baseNote}`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  lines.push(`next: ${shotsNext(report, again)}`);
  return lines.join("\n");
}
