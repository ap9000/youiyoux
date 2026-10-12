/**
 * Specimens: every inventoried look drawn for real, built at hub snapshot time (never by
 * `youi inventory`), once per project and commit. Per project: its CSS, light and dark
 * (css.ts), and static HTML per distinct recipe: a component look server-rendered from the
 * project's own code (render.ts), anything else, or a component that would not render, as its
 * tag and classes. Entries are cached outside the project by the content of every input
 * (cache.ts); a hit runs neither Tailwind nor esbuild. Each scheme's sheet carries forced-state
 * twins (states.ts), added once, so a look's static HTML can show hover, focus, pressed and
 * disabled with no script. Nothing is written into the project, and
 * nothing outside its root is read or run (contain.ts): a source file or recipe that leads out of
 * it is refused with a note, and that look is drawn from its tag and classes.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { InventoryLook, InventoryRecipe, InventoryRole } from "@youiyoux/core";
import { loadInventoryTarget } from "../inventory/target.ts";
import { newStats, SPECIMEN_FORMAT, SpecimenCache, specimenKey, type SpecimenStats } from "./cache.ts";
import { relativeInside } from "./contain.ts";
import { buildProjectCss, describeSkipped, describeSources, type Scheme, type SheetSource } from "./css.ts";
import { forcedStates } from "./states.ts";
import { ICON_HTML, renderComponents, type ComponentRecipe, type RenderJob, type RenderOptions } from "./render.ts";

export { SpecimenCache, defaultCacheDir, newStats, type SpecimenStats } from "./cache.ts";
export { buildProjectCss, describeSkipped, describeSources, findStylesheets, forScheme, pageStylesheets, projectTailwind, SCHEMES, stylesheetLinks, tailwindCliBuilds, type Scheme, type SheetSource } from "./css.ts";
export { escapingLinks, isBarePackageUnderRoot, relativeInside, within } from "./contain.ts";
export { BrowserBundleCache, bundleForBrowser, MAX_SIBLINGS, type BrowserBundle, type BrowserLook, type BrowserResult, type TryMessage } from "./client.ts";
export { forcedStates, STATE_CLASSES, STATES_MARKER, type ForcedState } from "./states.ts";

/** component: server-rendered from the project's code; markup: a tag with its classes. */
export interface Specimen {
  readonly kind: "component" | "markup";
  readonly html: string;
}

export interface ProjectSpecimens {
  readonly format: typeof SPECIMEN_FORMAT;
  readonly project: string;
  readonly key: string;
  /** Per scheme; null when the project loads no stylesheet (its looks fall back to their shape). */
  readonly css: Readonly<Record<Scheme, string>> | null;
  /** Specimen id → specimen; looks drawn the same share one. */
  readonly specimens: Readonly<Record<string, Specimen>>;
  /** Look id → specimen id. */
  readonly looks: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  readonly tailwind: string;
  readonly sheets: readonly string[];
  /** Each sheet used, how the page gets it, and how it was built. */
  readonly sources: readonly SheetSource[];
  /** The same for a reader: `built: src/app.css (link /app.css in index.html, Tailwind 4.1.0)`. */
  readonly used: readonly string[];
  /** Tailwind entries left out, for a reader: `skipped: design/src/globals.css (…)`. */
  readonly skipped: readonly string[];
  /** The project's tsconfig, project-relative, for bundling a look on request (client.ts). */
  readonly tsconfig: string;
}

export interface SpecimenProject {
  readonly id: string;
  /** Absolute root. */
  readonly root: string;
  readonly commit: string | null;
  readonly looks: ReadonlyArray<Pick<InventoryLook, "id" | "role" | "recipe">>;
}

export interface SpecimenOptions {
  readonly cache?: SpecimenCache;
  readonly stats?: SpecimenStats;
  /** Time limits for Tailwind and rendering (defaults in css.ts and render.ts). */
  readonly timeouts?: RenderOptions & { readonly tailwindMs?: number };
  /**
   * `specimens.css` from a project config kept outside the product (`--config <file>` with its
   * `root`): exactly these sheets, project-relative, in this order, instead of the product's own
   * youi.project.json; `from` names that config for a reader.
   */
  readonly css?: { readonly sheets: readonly string[]; readonly from: string };
}

/** What a look with no text of its own shows, so a card or a tab list is not an empty box. */
const PLACEHOLDER: Readonly<Record<InventoryRole, string>> = { button: "Button", "link-as-button": "Link", input: "", card: "Card", badge: "Badge", dialog: "Dialog", tabs: "Tab" };
const MAX_NOTES = 10;
const VOID = /^(?:input|img|hr|br|area|col|embed|source|track|wbr)$/;

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const idOf = (recipe: InventoryRecipe, role: InventoryRole): string => createHash("sha256").update(`${role}\0${JSON.stringify(recipe)}`).digest("hex").slice(0, 12);

/** A component look sized as an icon (shadcn's `size="icon"`, `icon-sm`, …) with no text of its own: it shows an icon, not a word. */
const iconSized = (recipe: InventoryRecipe): boolean => recipe.kind === "component" && recipe.label === null && typeof recipe.props.size === "string" && /^icon(?:$|-)/.test(recipe.props.size);

/** A component look as a server render or a browser bundle draws it: its recipe, the children it shows when it has no text, and whether those are an icon. */
export function browserLookOf(recipe: ComponentRecipe, role: InventoryRole): { recipe: ComponentRecipe; label: string | null; icon: boolean } {
  return { recipe, label: recipe.label ?? (VOID.test(recipe.tag) ? null : PLACEHOLDER[role] || null), icon: iconSized(recipe) };
}

/** The static fallback: the recipe's tag and classes around its label (an icon for an icon size). */
export function markupOf(recipe: InventoryRecipe, role: InventoryRole): string {
  const tag = /^[a-z][a-z0-9-]*$/.test(recipe.tag) ? recipe.tag : "div";
  const attributes = `${recipe.classes.length > 0 ? ` class="${escape(recipe.classes.join(" "))}"` : ""}${tag === "a" ? ' href="#"' : ""}${tag === "button" ? ' type="button"' : ""}`;
  if (VOID.test(tag)) return `<${tag}${attributes}${tag === "input" ? ' value=""' : ""}>`;
  return `<${tag}${attributes}>${iconSized(recipe) ? ICON_HTML : escape(recipe.label ?? PLACEHOLDER[role])}</${tag}>`;
}

/** One project's specimens: from the cache when its inputs are unchanged, else built. */
export async function projectSpecimens(project: SpecimenProject, options: SpecimenOptions = {}): Promise<ProjectSpecimens & { cached: boolean }> {
  const cache = options.cache ?? new SpecimenCache();
  const stats = options.stats ?? newStats();
  const target = await loadInventoryTarget(project.root);
  // A source file whose real path leaves the root (a symlink out of it) is neither read nor hashed.
  const outside = [...target.files, ...target.templates].filter((f) => "refused" in relativeInside(project.root, f));
  const files = target.files.filter((f) => !outside.includes(f));
  const templates = target.templates.filter((f) => !outside.includes(f));
  const byId = new Map<string, { recipe: InventoryRecipe; role: InventoryRole }>();
  const looks: Record<string, string> = {};
  for (const look of project.looks) {
    if (!look.recipe) continue;
    const id = idOf(look.recipe, look.role);
    byId.set(id, { recipe: look.recipe, role: look.role });
    looks[look.id] = id;
  }
  const recipes = [...byId].sort(([a], [b]) => a.localeCompare(b));
  const override = options.css ? { override: options.css.sheets, overrideFrom: options.css.from } : { override: target.specimenCss };
  const key = specimenKey(project.root, project.commit, [...files, ...templates], { recipes, css: override.override, ...(options.css ? { from: options.css.from } : {}) });
  const hit = cache.read<ProjectSpecimens>(project.id, key);
  if (hit?.format === SPECIMEN_FORMAT) {
    stats.hits++;
    return { ...hit, looks, cached: true };
  }
  stats.misses++;
  const css = await buildProjectCss(project.root, files, stats, { tsconfig: target.tsconfig, ...override, templates, ...(options.timeouts?.tailwindMs ? { tailwindTimeoutMs: options.timeouts.tailwindMs } : {}) });
  const warnings = [...outside.map((f) => `refused ${f}: a symlink that leads outside the project root`), ...css.warnings];
  // A recipe that names a file outside the root is never bundled: its look is drawn from its classes.
  const jobs: RenderJob[] = [];
  for (const [id, { recipe, role }] of recipes) {
    if (recipe.kind !== "component") continue;
    const refused = [recipe.file, ...recipe.wrappers.map((w) => w.file)].map((f) => relativeInside(project.root, f)).find((r) => "refused" in r);
    if (refused && "refused" in refused) warnings.push(`refused recipe ${recipe.file}#${recipe.export}: ${refused.refused}: drawn from its classes`);
    else jobs.push({ key: id, ...browserLookOf(recipe as ComponentRecipe, role) });
  }
  const scratch = cache.scratch(project.id, key);
  const rendered = await renderComponents(project.root, target.tsconfig, jobs, scratch, stats, options.timeouts);
  rmSync(scratch, { recursive: true, force: true });
  const specimens: Record<string, Specimen> = {};
  warnings.push(...rendered.warnings);
  for (const [id, { recipe, role }] of recipes) {
    const html = rendered.html.get(id);
    // A root that renders only its children (Radix's Dialog.Root) draws nothing of its own.
    if (html && html.includes("<")) specimens[id] = { kind: "component", html };
    else specimens[id] = { kind: "markup", html: markupOf(recipe, role) };
  }
  // One note per component and reason, counted, so the notes stay short however many looks fail.
  const failed = new Map<string, number>();
  if (!rendered.warnings.some((w) => w.startsWith("the component bundle failed") || w.startsWith("react and react-dom"))) {
    for (const [id, reason] of rendered.failures) {
      const recipe = byId.get(id)!.recipe as ComponentRecipe;
      const note = `${recipe.file}#${recipe.export} did not render (${reason})`;
      failed.set(note, (failed.get(note) ?? 0) + 1);
    }
  }
  const notes = [...failed].sort(([a], [b]) => a.localeCompare(b));
  for (const [note, count] of notes.slice(0, MAX_NOTES)) warnings.push(`${note}: ${count === 1 ? "drawn" : `${count} looks drawn`} from its classes`);
  if (notes.length > MAX_NOTES) warnings.push(`${notes.length - MAX_NOTES} more components did not render`);
  const entry: ProjectSpecimens = { format: SPECIMEN_FORMAT, project: project.id, key, css: css.light !== null && css.dark !== null ? { light: forcedStates(css.light), dark: forcedStates(css.dark) } : null, specimens, looks, warnings, tailwind: css.tailwind, sheets: css.sheets, sources: css.sources, used: describeSources(css.sources, css.tailwindVersion), skipped: describeSkipped(css.skipped), tsconfig: target.tsconfig };
  cache.write(project.id, key, entry);
  return { ...entry, cached: false };
}
