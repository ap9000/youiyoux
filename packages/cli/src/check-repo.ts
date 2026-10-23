/** Config-free drift checks reuse inventory, parsing, theme and drift analysis. */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseCssColor, type ResolvedToken } from "@youiyoux/tokens";
import { buildInventory, buildTheme, hardcodedValues, loadInventoryTarget, loadProject, nearDuplicates, offLibraryImports, parseModule, PROJECT_FILE, readStylesheet, substituteVars, type LoadProjectOptions, type InventoryTarget, type ModuleInfo, type Project, type TokenIndex } from "@youiyoux/scanner";
import { chosenLibraries, classify, DRIFT_SEVERITY, importOf, isAdded, type ChangeProject, type ChangeSet, type DiffFinding } from "./check-diff.ts";
import type { DiffCheckResult } from "./check.ts";
import { repoRootOf } from "./hooks-install.ts";
import { exists } from "./init.ts";

/** Explicit configs must load successfully; only absent configs trigger inference. */
export async function loadCheckProject(root: string, options: LoadProjectOptions = {}, inferTop = false): Promise<Project | ChangeProject> {
  let dir = resolve(root);
  if (options.configPath) return loadProject(dir, options);
  if (inferTop) {
    for (let ancestor = dir;; ancestor = dirname(ancestor)) {
      if (await exists(join(ancestor, PROJECT_FILE))) return loadProject(ancestor, options);
      if (dirname(ancestor) === ancestor) break;
    }
    dir = await repoRootOf(dir);
  }
  if (await exists(join(dir, PROJECT_FILE))) return loadProject(dir, options);
  return inferProject(options.productRoot ?? dir);
}

/** A project read from its files alone: the inventory's globs and tsconfig, and the usual components directory. */
export async function inferProject(dir: string, loaded?: InventoryTarget): Promise<ChangeProject> {
  const target = loaded ?? (await loadInventoryTarget(dir));
  const componentsDir = ["components/ui", "src/components/ui", "src/browser/components/ui"].find((p) => target.files.some((f) => f.startsWith(`${p}/`))) ?? "components/ui";
  return { root: target.root, config: { include: [...target.include], exclude: [...target.exclude], tsconfig: target.tsconfig, componentsDir } };
}

export const configured = (p: ChangeProject): p is Project => "repo" in p;

/** The CSS and Tailwind theme variables a project declares, as tokens a hardcoded value can be matched against. */
export async function themeTokens(root: string, modules: readonly ModuleInfo[]): Promise<TokenIndex> {
  const sheets = await Promise.all(modules.filter((m) => m.lang === "css").map((m) => readStylesheet(m.file, m.source)));
  const theme = await buildTheme(root, sheets, false);
  const tokens: ResolvedToken[] = [];
  const byVar = new Map<string, ResolvedToken>();
  for (const [name, raw] of theme.declared) {
    const value = substituteVars(raw, (key) => theme.variable(key));
    if (value === null) continue;
    const color = parseCssColor(value);
    const kind = /(?:^|-)radius(?:-|$)|(?:^|-)radii(?:-|$)/.test(name) ? "radius" : /(?:^|-)(?:space|spacing)(?:-|$)/.test(name) ? "spacing" : null;
    const px = kind ? theme.length(value) : null;
    if (!color && px === null) continue;
    const light = color ?? { value: px, unit: "px" };
    const token: ResolvedToken = { id: `${color ? "color" : kind}.${name.slice(2)}`, type: color ? "color" : "dimension", cssName: name.slice(2), light, dark: light };
    tokens.push(token);
    byVar.set(name, token);
  }
  return { prefix: "", tokens, byVar, themeKeys: new Map() };
}

export async function runRepoCheck(project: ChangeProject, change: ChangeSet): Promise<DiffCheckResult> {
  const target = await loadInventoryTarget(project.root);
  const notes = ["Repository inference uses existing components, library imports and declared theme variables. Run `youiyoux init --design <dir>` to add design-system rules."];
  const incomplete: string[] = [];
  const modules: ModuleInfo[] = [];
  const changedUi = (file: string) => change.added.has(file) && (/\.(tsx|jsx|astro|css)$/.test(file) || modules.some((m) => m.file === file && m.jsx.length > 0));
  for (const file of new Set([...target.files, ...change.added.keys()])) {
    try {
      const module = await parseModule(file, change.sources?.[file] ?? await readFile(join(project.root, file), "utf8"));
      if (module) {
        modules.push(module);
        if (changedUi(file) && module.parseErrors > 0) incomplete.push(`${file}: fix the syntax errors, then run youiyoux check --diff again`);
      }
    } catch (error) { if (changedUi(file)) incomplete.push(`${file}: could not read source (${String(error)}); restore the file and run youiyoux check --diff`); }
  }
  if (!modules.some((m) => m.lang === "tsx")) incomplete.push("No checked UI files found. Run `youiyoux init --design <dir>` and set include to your UI files, then run `youiyoux check --diff`.");
  const added = (file: string, line: number) => isAdded(change.added, file, line);
  const drift = [];
  const tokens = await themeTokens(project.root, modules);
  const chosen = await chosenLibraries(project, change.added, notes);
  for (const module of modules.filter((m) => change.added.has(m.file))) {
    drift.push(...hardcodedValues(module, tokens, { isTokenSource: module.lang === "css", added }));
    drift.push(...offLibraryImports(module, { added, classify, chosen }));
  }
  try {
    const inventory = await buildInventory([project.root], { cwd: project.root, definitionRoots: true });
    for (const failure of inventory.projects.flatMap((p) => p.failed)) if (changedUi(failure.file)) incomplete.push(`${failure.file}: ${failure.reason}; fix this file and rerun youiyoux check --diff`);
    drift.push(...nearDuplicates({ inventory, added, importOf: await importOf(project) }));
  } catch (error) { incomplete.push(`Components could not be compared (${String(error)}); run youiyoux inventory --project ${project.root} to diagnose`); }
  const findings: DiffFinding[] = drift.map((d) => ({ ...d, severity: DRIFT_SEVERITY[d.kind] }));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { identity: null, unmatched: [], failed: [], notRun: [], incomplete: incomplete.length > 0, diff: { base: change.base, commit: change.commit, files: [...change.added.keys()].sort(), findings, notes, incomplete } };
}
