/**
 * `youiyoux report`'s model: what a repo with no youiyoux setup has, read with the pieces `youi
 * check --diff` (repo mode), `youiyoux inventory` and `youiyoux detect` already use, over every line
 * instead of a change's added ones. Per project: the UI libraries (detect), the component
 * inventory, near-duplicate families (inventory), values a theme variable already holds
 * (hardcodedValues against themeTokens) and imports from a library other than the one the code
 * already chose (offLibraryImports against chosenLibraries). Every finding names repo-relative
 * places and a concrete next step; the top fixes are ranked by the places they touch.
 *
 * Paths here are repo-relative and nothing else of the code is kept, unless `includeCode` asks
 * for the line at each place. safe.ts cleans the whole model before anything is written.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INVENTORY_ROLES, type InventoryReport, type InventoryRole } from "@youiyoux/core";
import { buildReport, detectRepo } from "@youiyoux/detect";
import { buildInventory, loadInventoryTarget, offLibraryImports, parseModule, type DriftFinding, type InventoryTarget, type ModuleInfo } from "@youiyoux/scanner";
import { chosenLibraries, classify, importOf } from "../check-diff.ts";
import { inferProject, themeTokens } from "../check-repo.ts";
import { isShowcase, SHOWCASE_GLOBS, reportTokens, tokenUsage, uiDefinition } from "./filters.ts";
import { COMMAND } from "../command.ts";
import { plural } from "../ui.ts";
import { factsOf, nearDuplicateGroups, repoPath, SITES_PER_FINDING, type ProjectFacts } from "./groups.ts";
import { clearImportCache } from "./imports.ts";
import { findProjects, type ReportProject } from "./projects.ts";

const REPORT_SCHEMA = "youiyoux.report/1";
/** How the report's own next steps run a command: anywhere, with nothing installed. */
export const NPX = `npx ${COMMAND}`;
const TOP_COMPONENTS = 10;
const TOP_FIXES = 5;
const AGENT_LINE = `Set up youiyoux for your agent: run ${NPX} agents install, and your coding agent looks up these components before it writes a new one.`;

type FindingKind = "near-duplicate" | "hardcoded-value" | "off-library";

interface Site {
  /** `apps/web/src/button.tsx:12`, repo-relative. */
  readonly at: string;
  /** The line itself, only with --include-code. */
  readonly code?: string;
}

export interface Finding {
  readonly kind: FindingKind;
  /** The project's repo-relative directory. */
  readonly project: string;
  readonly title: string;
  /** Always null: kept so the JSON keeps its shape. */
  readonly detail: null;
  /** Places it touches; `sites` lists the first few. */
  readonly count: number;
  readonly sites: readonly Site[];
  /** What to do, concretely: for a near-duplicate, what to keep and the first few files to change. */
  readonly next: string;
  /** A near-duplicate's keeper sentence and every file's step (`next` lists the first few). */
  readonly lead?: string;
  readonly steps?: readonly string[];
  /** A near-duplicate's distinct exported components (the kept one and the copies). */
  readonly exported?: number;
}

interface ComponentUse {
  readonly name: string;
  /** Repo-relative defining file. */
  readonly file: string;
  readonly role: InventoryRole;
  readonly uses: number;
}

export interface RenderedLook {
  readonly component: string;
  readonly file: string;
  readonly looks: readonly string[];
  /** PNG data: URIs, light and dark at phone width. */
  readonly light: string | null;
  readonly dark: string | null;
}

export interface ProjectSection {
  /** Repo-relative directory, `.` for the repo itself. */
  readonly dir: string;
  readonly name: string | null;
  readonly files: number;
  /** Files that could not be read or parsed: what they hold is unknown, never zero. */
  readonly failed: readonly string[];
  readonly libraries: ReadonlyArray<{ readonly name: string; readonly confidence: string; readonly for: readonly string[] }>;
  readonly unused: readonly string[];
  readonly definitions: number;
  readonly kits: ReadonlyArray<{ readonly path: string; readonly kind: string; readonly members: number }>;
  readonly roles: ReadonlyArray<{ readonly role: InventoryRole; readonly uses: number; readonly families: number }>;
  readonly uses: number;
  readonly components: readonly ComponentUse[];
  readonly nearDuplicates: readonly Finding[];
  readonly hardcoded: readonly Finding[];
  readonly offLibrary: readonly Finding[];
  /** Analyses that could not run, and why: their findings are unknown. */
  readonly incomplete: readonly string[];
  readonly notes: readonly string[];
  rendered: RenderedLook[];
}

interface ReportTotals {
  readonly projects: number;
  readonly files: number;
  readonly libraries: readonly string[];
  readonly definitions: number;
  readonly uses: number;
  readonly nearDuplicates: number;
  /** Near-duplicate groups with two or more exported components: the card's and summary's headline. */
  readonly componentDuplicates: number;
  readonly hardcoded: number;
  readonly offLibrary: number;
}

interface RenderStatus {
  /** drawn: looks embedded; off: no Chromium (how to turn it on is said); failed: it ran and could not draw. */
  state: "drawn" | "off" | "failed" | "none";
  note: string;
  /** The next step, when it is not the default for the state (install dependencies, then run again). */
  next?: string;
}

export interface ReportModel {
  readonly schema: typeof REPORT_SCHEMA;
  readonly repo: string;
  readonly layout: string;
  readonly generatedAt: string;
  durationMs: number;
  readonly includeCode: boolean;
  readonly projects: readonly ProjectSection[];
  readonly totals: ReportTotals;
  readonly topFixes: readonly Finding[];
  summary: string[];
  readonly agent: string;
  render: RenderStatus;
}

interface ModelOptions {
  /** Keep the line of code at each place (default: no code at all). */
  readonly includeCode?: boolean;
  readonly now?: Date;
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Source lines by repo-relative file, read once, only when code is asked for. */
class Lines {
  private readonly files = new Map<string, string[]>();
  private readonly root: string;
  private readonly enabled: boolean;
  constructor(root: string, enabled: boolean) {
    this.root = root;
    this.enabled = enabled;
  }
  async site(at: string, file: string, line: number): Promise<Site> {
    if (!this.enabled) return { at };
    let lines = this.files.get(file);
    if (!lines) {
      lines = (await readFile(join(this.root, file), "utf8").catch(() => "")).split("\n");
      this.files.set(file, lines);
    }
    const code = lines[line - 1]?.trim();
    return code ? { at, code: code.length > 160 ? `${code.slice(0, 159)}…` : code } : { at };
  }
}

/** The value a hardcoded-value finding is about, as a person reads it: `#2563eb`, `8px` (radius). */
function hardcodedValue(finding: DriftFinding): { word: string; value: string; tokens: string } {
  const word = /^Hardcoded (colour|radius|spacing|type)\b/.exec(finding.message)?.[1] ?? "value";
  const tokens = /the token (.+?) has this value/.exec(finding.message)?.[1] ?? /: (.+?) (?:has|have) this value/.exec(finding.message)?.[1] ?? "a theme token";
  const bracket = /\[([^\]]+)\]$/.exec(finding.text)?.[1];
  const declaration = /^([a-z-]+):\s*(.+)$/.exec(finding.text);
  const value = bracket ?? (declaration ? `${declaration[2]} (${declaration[1]})` : finding.text);
  return { word: word === "type" ? "text size" : word, value, tokens };
}

interface Analysed {
  readonly section: Omit<ProjectSection, "nearDuplicates">;
  readonly facts: ProjectFacts;
}

/** The project's own modules, parsed once for the theme, hardcoded values and imports. */
async function modulesOf(project: ReportProject, target: InventoryTarget, failed: string[]): Promise<ModuleInfo[]> {
  const modules: ModuleInfo[] = [];
  for (const file of target.files) {
    if (isShowcase(file)) continue;
    try {
      const module = await parseModule(file, await readFile(join(project.root, file), "utf8"));
      if (module) modules.push(module);
    } catch (error: unknown) {
      failed.push(`${repoPath(project.dir, file)}: ${errorText(error)}`);
    }
  }
  return modules;
}

/** Group drift findings by what fixes them, each group one finding with its places. */
async function grouped(project: ReportProject, found: readonly DriftFinding[], lines: Lines, describe: (first: DriftFinding, count: number) => { title: string; next: string }): Promise<Finding[]> {
  const groups = new Map<string, DriftFinding[]>();
  for (const finding of found) {
    const key = `${finding.kind}\0${finding.kind === "off-library" ? finding.message : finding.fix}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  const findings: Finding[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const sites = await Promise.all(list.slice(0, SITES_PER_FINDING).map((f) => lines.site(`${repoPath(project.dir, f.file)}:${f.line}`, repoPath(project.dir, f.file), f.line)));
    const { title, next } = describe(first, list.length);
    findings.push({ kind: first.kind, project: project.dir, count: list.length, sites, title, detail: null, next });
  }
  return findings.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** Everything but the near-duplicates, which need every project's facts; the parsed modules are dropped after. */
async function analyseProject(project: ReportProject, index: number, inventory: InventoryReport | null, inventoryError: string | null, workspaceNames: ReadonlySet<string>, lines: Lines): Promise<Analysed> {
  const failed: string[] = [];
  const incomplete: string[] = [];
  const notes: string[] = [];
  const projectId = inventory?.projects[index]?.id;
  let modules: ModuleInfo[] = [];
  let target: InventoryTarget | null = null;
  try {
    target = await loadInventoryTarget(project.root);
    modules = await modulesOf(project, target, failed);
  } catch (error: unknown) { incomplete.push(`The code could not be read (${errorText(error)})`); }
  const changeProject = target ? await inferProject(project.root, target) : null;
  const moduleMap = new Map(modules.map((m) => [m.file, m]));
  const eligible = new Set(inventory?.definitions.filter((d) => d.project === projectId && uiDefinition(d, moduleMap)).map((d) => d.id));
  const looks = inventory ? inventory.looks.filter((l) => l.project === projectId && !l.story && !isShowcase(l.file)) : [];

  // Libraries: detect's verdicts, and which element types each supplies.
  let libraries: ProjectSection["libraries"] = [];
  let unused: string[] = [];
  const showcaseFiles = new Set<string>();
  try {
    const scan = await detectRepo(project.root);
    for (const item of [...scan.signals, ...scan.hits]) for (const at of item.where ?? []) {
      if (isShowcase(at)) showcaseFiles.add(at.replace(/:\d+(?::\d+)?$/, ""));
    }
    const live = <T extends { where?: readonly string[]; count: number }>(items: T[]): T[] => items.flatMap((item) => {
      const where = item.where?.filter((at) => !isShowcase(at));
      return item.where?.length && !where?.length ? [] : [{ ...item, ...(where ? { where, count: Math.min(item.count, where.length) } : {}) }];
    });
    const signals = live(scan.signals);
    const used = new Set(signals.filter((s) => s.kind !== "package" && s.kind !== "lockfile").map((s) => s.library));
    const detect = buildReport({ kind: "repo", inputs: [project.root], name: scan.name, coverage: scan.coverage, signals: signals.filter((s) => used.has(s.library)), hits: live(scan.hits), unused: scan.unused });
    libraries = detect.libraries.map((l) => ({ name: l.name, confidence: l.confidence, for: detect.elements.filter((e) => e.library === l.id).map((e) => e.type) }));
    unused = detect.unused.map((u) => u.package);
  } catch (error: unknown) {
    incomplete.push(`UI libraries were not read (${errorText(error)}); run ${NPX} detect ${project.dir} to see why`);
  }

  // Inventory: definitions, kits, uses per role, the most-used components.
  const roles = INVENTORY_ROLES.flatMap((role) => {
    const of = looks.filter((l) => l.role === role);
    return of.length === 0 ? [] : [{ role, uses: of.length, families: new Set(of.flatMap((l) => (l.family ? [l.family] : []))).size }];
  });
  const byComponent = new Map<string, { name: string; file: string; roles: InventoryRole[] }>();
  for (const look of looks) {
    if (look.recipe?.kind !== "component") continue;
    const key = `${look.recipe.file}#${look.recipe.export}`;
    const entry = byComponent.get(key) ?? { name: look.recipe.export, file: repoPath(project.dir, look.recipe.file), roles: [] };
    entry.roles.push(look.role);
    byComponent.set(key, entry);
  }
  const components = [...byComponent.values()]
    .map((c) => ({ name: c.name, file: c.file, uses: c.roles.length, role: [...new Set(c.roles)].sort((a, b) => c.roles.filter((r) => r === b).length - c.roles.filter((r) => r === a).length)[0]! }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
    .slice(0, TOP_COMPONENTS);
  const inventoryProject = inventory?.projects[index];
  if (inventoryError) incomplete.push(`The component inventory could not be built (${inventoryError}); run ${NPX} inventory --project ${project.dir} to see why`);
  for (const f of inventoryProject?.failed ?? []) failed.push(`${repoPath(project.dir, f.file)}: ${f.reason}`);

  // Hardcoded values and off-library imports, over every line.
  let hardcoded: Finding[] = [];
  let offLibrary: Finding[] = [];
  const everyLine = (): boolean => true;
  if (modules.length > 0) {
    try {
      const tokens = await themeTokens(project.root, modules);
      if (tokens.tokens.length === 0) notes.push("No theme variables (CSS custom properties or Tailwind @theme) were found, so hardcoded values had nothing to be compared with");
      const usage = tokenUsage(modules);
      const found = (await Promise.all(modules.map((module) => reportTokens(module, tokens, usage)))).flat();
      hardcoded = await grouped(project, found, lines, (first, count) => {
        const { word, value, tokens: names } = hardcodedValue(first);
        return { title: `${sentence(word)} ${value} is hardcoded in ${plural(count, "place")}; the theme already has it as ${names}`, next: `${sentence(first.fix)} in each place` };
      });
    } catch (error: unknown) {
      incomplete.push(`Hardcoded values were not checked (${errorText(error)}); run ${NPX} check --diff to see why`);
    }
    try {
      if (!changeProject || !target) throw new Error("the project's files could not be listed");
      const showcase = new Map<string, "all">([...showcaseFiles, ...target.files.filter(isShowcase)].map((file) => [file, "all"]));
      const chosen = await chosenLibraries(changeProject, showcase, notes);
      const kitDirs = [changeProject.config.componentsDir, ...(inventory?.kits.filter((k) => k.project === projectId && k.kind === "cva-folder").map((k) => k.path) ?? [])];
      // A kit's own files wrap the library they are built on: that is the choice, not a drift from it.
      const exempt = (file: string): boolean => kitDirs.some((dir) => file === dir || file.startsWith(`${dir}/`));
      const found = modules.flatMap((module) => offLibraryImports(module, { added: everyLine, classify, chosen, exempt }));
      offLibrary = await grouped(project, found, lines, (first) => ({ title: first.message.replace(/^This imports/, "Imports"), next: sentence(first.fix) }));
    } catch (error: unknown) {
      incomplete.push(`Library choices were not compared (${errorText(error)}); run ${NPX} detect ${project.dir} to see why`);
    }
  }

  // What grouping near-duplicates across projects needs from this one's code.
  const pkg = await readFile(join(project.root, "package.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
  const dependencies = new Set(["dependencies", "devDependencies", "peerDependencies"].flatMap((key) => Object.keys((pkg?.[key] as Record<string, unknown> | undefined) ?? {})));
  const importer = changeProject ? await importOf(changeProject) : () => "";
  const facts = factsOf(project, projectId ?? null, modules, eligible, workspaceNames, dependencies, target?.files ?? [], importer);

  const section: Omit<ProjectSection, "nearDuplicates"> = {
    dir: project.dir,
    name: project.name,
    files: inventoryProject?.files ?? modules.length,
    failed,
    libraries,
    unused,
    definitions: inventory ? inventory.definitions.filter((d) => d.project === projectId && !isShowcase(d.file)).length : 0,
    kits: inventory ? inventory.kits.filter((k) => k.project === projectId).map((k) => ({ path: repoPath(project.dir, k.path), kind: k.kind === "cva-folder" ? "CVA components" : "CSS classes", members: k.members.length })) : [],
    roles,
    uses: looks.length,
    components,
    hardcoded,
    offLibrary,
    incomplete,
    notes: [...new Set(notes)],
    rendered: [],
  };
  return { section, facts };
}

/** A fix's next step in one line: a near-duplicate's keeper and how many files change; anything else as written. */
function topNext(f: Finding): string {
  const text = f.lead && f.steps ? `${f.lead}${f.steps.length > 1 ? `, then change ${plural(f.steps.length, "file")} (each listed in the report)` : `; ${f.steps[0]!.charAt(0).toLowerCase()}${f.steps[0]!.slice(1)}`}` : f.next;
  return `${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.$/, "")}`;
}

/** The rule behind the headline duplicate count, said once wherever that count is shown. */
export const DUPLICATE_RULE = "Duplicated components: groups of 2+ exported components that look alike or share a name.";
const isComponentDuplicate = (f: Finding): boolean => (f.exported ?? 0) >= 2;

/** The five plain-English lines printed and put at the top of every output. */
function summaryLines(model: Pick<ReportModel, "repo" | "totals" | "topFixes" | "projects">): string[] {
  const t = model.totals;
  const top = model.projects.flatMap((p) => p.components).sort((a, b) => b.uses - a.uses)[0];
  const first = model.topFixes[0];
  return [
    `${model.repo}: ${plural(t.projects, "project")}, ${plural(t.files, "file")} scanned; UI libraries: ${t.libraries.length > 0 ? t.libraries.join(", ") : "none found"}.`,
    `Components: ${t.definitions} defined, ${plural(t.uses, "button, input, card or other UI element", "buttons, inputs, cards and other UI elements")} in use${top ? `; most used: ${top.name} (${plural(top.uses, "use")})` : ""}.`,
    `Near-duplicates: ${plural(t.nearDuplicates, "group")} of UI that looks the same but is built more than once; ${t.componentDuplicates} of them between exported components.`,
    `Hardcoded values: ${plural(t.hardcoded, "colour, spacing or radius", "colours, spacings and radii")} a theme token already holds; off-library imports: ${t.offLibrary}.`,
    first ? `Top fix: ${first.title.replace(/\.$/, "")}; ${topNext(first)}.` : `Nothing to fix first; next: ${NPX} agents install, so your agent keeps it that way.`,
  ];
}

export async function buildReportModel(dir: string, options: ModelOptions = {}): Promise<ReportModel> {
  const started = performance.now();
  clearImportCache();
  const repo = await findProjects(dir);
  const lines = new Lines(repo.root, options.includeCode === true);
  let inventory: InventoryReport | null = null;
  let inventoryError: string | null = null;
  try {
    inventory = await buildInventory(repo.projects.map((p) => p.root), { cwd: repo.root, exclude: SHOWCASE_GLOBS });
  } catch (error: unknown) {
    inventoryError = errorText(error);
  }
  const analysed: Analysed[] = [];
  const workspaceNames = new Set(repo.projects.flatMap((p) => (p.name ? [p.name] : [])));
  for (const [index, project] of repo.projects.entries()) analysed.push(await analyseProject(project, index, inventory, inventoryError, workspaceNames, lines));
  // Near-duplicates across every project at once; each group sits in the section of the project most of its copies are in.
  const groups = inventory ? await nearDuplicateGroups({ inventory, facts: analysed.map((a) => a.facts), lines }) : [];
  const near: Finding[] = await Promise.all(groups.map(async ({ sites, ...group }) => ({ ...group, sites: await Promise.all(sites.map((s) => lines.site(s.at, s.file, s.line))) })));
  const projects: ProjectSection[] = analysed.map((a) => ({ ...a.section, nearDuplicates: near.filter((f) => f.project === a.section.dir) }));
  const libraries = [...new Set(projects.flatMap((p) => p.libraries.map((l) => l.name)))];
  const totals: ReportTotals = {
    projects: projects.length,
    files: projects.reduce((n, p) => n + p.files, 0),
    libraries,
    definitions: projects.reduce((n, p) => n + p.definitions, 0),
    uses: projects.reduce((n, p) => n + p.uses, 0),
    nearDuplicates: near.length,
    componentDuplicates: near.filter(isComponentDuplicate).length,
    hardcoded: projects.reduce((n, p) => n + p.hardcoded.reduce((m, f) => m + f.count, 0), 0),
    offLibrary: projects.reduce((n, p) => n + p.offLibrary.reduce((m, f) => m + f.count, 0), 0),
  };
  const topFixes = [...near, ...projects.flatMap((p) => [...p.hardcoded, ...p.offLibrary])].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title)).slice(0, TOP_FIXES);
  const layout = repo.skipped.length > 0 ? `${repo.layout}; ${plural(repo.skipped.length, "package")} without UI files left out (${repo.skipped.join(", ")})` : repo.layout;
  const model: ReportModel = {
    schema: REPORT_SCHEMA,
    repo: repo.name,
    layout,
    generatedAt: (options.now ?? new Date()).toISOString(),
    durationMs: 0,
    includeCode: options.includeCode === true,
    projects,
    totals,
    topFixes,
    summary: [],
    agent: AGENT_LINE,
    render: { state: "none", note: "" },
  };
  model.summary = summaryLines(model);
  model.durationMs = Math.round(performance.now() - started);
  return model;
}
