/**
 * `youiyoux check --diff`: what a change adds, from git. The working tree (or the staged
 * content, for the pre-commit hook) is compared with a base: HEAD, or the merge-base of
 * a branch and HEAD. Only added lines count; an untracked file is wholly added, and a
 * renamed file's unchanged lines are not new. Without git the check stops and says why:
 * it never reports a pass it could not compute.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { matchesAny, type RuleSpec, type Violation } from "@youiyoux/core";
import { detectRepo, elementTypes, EXPORT_TYPES, LIBRARY_BY_ID, libraryOfPackage, packageOf } from "@youiyoux/detect";
import { buildInventory, loadInventoryTarget, parseModule, hardcodedValues, importSpecifier, langOf, nearDuplicates, offLibraryImports, type ChosenLibrary, type DriftFinding, type DriftKind, type ImportClass, type Project, type ScanResult, type ModuleInfo } from "@youiyoux/scanner";

import { aliasRoot } from "./init.ts";

export interface ChangeProject {
  readonly root: string;
  readonly config: Pick<Project["config"], "include" | "exclude" | "componentsDir" | "importFrom" | "tsconfig"> & { outputs?: { dir: string } };
  readonly system?: Project["system"];
}

const run = promisify(execFile);
const ALWAYS_SKIPPED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.youi/**"];

/** Whether a project-relative file is one youi checks: included, not excluded, not generated output, a checked language. */
export function isChecked(project: ChangeProject, file: string): boolean {
  const { include, exclude, outputs } = project.config;
  if (file.startsWith("../") || isAbsolute(file) || (outputs && file.startsWith(`${outputs.dir}/`)) || langOf(file) === null) return false;
  return matchesAny(file, include) && !matchesAny(file, [...ALWAYS_SKIPPED, ...exclude]);
}

/** Added lines per project-relative file: "all" for a new or untracked file. */
export type AddedLines = ReadonlyMap<string, ReadonlySet<number> | "all">;

export interface ChangeSet {
  /** What the change is compared with, as a person reads it: `HEAD`, `main (merge-base 1a2b3c4)`, `the index (staged)`. */
  readonly base: string;
  /** The base commit, or null when the repository has no commit yet. */
  readonly commit: string | null;
  /** Checked files the change adds lines to, with those lines. */
  readonly added: AddedLines;
  /** Staged contents by project-relative path (pre-commit): what the commit will carry, not the working tree. */
  readonly sources?: Readonly<Record<string, string>>;
}

/** Whether a line of a file is one the change adds. */
export const isAdded = (added: AddedLines, file: string, line: number): boolean => {
  const lines = added.get(file);
  return lines === "all" || (lines !== undefined && lines.has(line));
};

export class DiffError extends Error {}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    return (await run("git", ["-c", "core.quotePath=false", ...args], { cwd, maxBuffer: 256 * 1024 * 1024 })).stdout;
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new DiffError(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

/** A path from a diff header: git C-quotes names with unusual characters (`"a\tb.tsx"`). */
function headerPath(raw: string): string {
  const text = raw.replace(/\t$/, "");
  if (!text.startsWith('"')) return text;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = text[++i]!;
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(text.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Added line numbers per file from `git diff -U0` output (new-side paths, `--no-prefix`).
 * A hunk `@@ -a,b +c,d @@` adds lines c … c+d-1; d is 1 when omitted and 0 for a pure deletion.
 */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) current = null;
    else if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = path === "/dev/null" ? null : (files.get(headerPath(path)) ?? new Set<number>());
      if (current) files.set(headerPath(path), current);
    } else if (current && line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let n = start; n < start + count; n++) current.add(n);
    }
  }
  return files;
}

const DIFF_ARGS = ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-prefix", "--diff-filter=ACMR", "--relative"];

async function headCommit(root: string): Promise<string | null> {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then(
    (out) => out.trim() || null,
    () => null,
  );
}

async function ensureRepo(root: string): Promise<void> {
  await git(root, ["rev-parse", "--is-inside-work-tree"]).catch((error: unknown) => {
    throw new DiffError(`youiyoux check --diff needs a git checkout, and ${root} is not in one (${error instanceof Error ? error.message : String(error)}); without git there is no change to compare, so nothing was checked; run \`git init\` and make an initial commit, then run \`youiyoux check --diff\``);
  });
}

/** Untracked files under the project (relative to it), which a change adds whole. */
async function untracked(root: string, paths: readonly string[] = []): Promise<string[]> {
  return (await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...(paths.length > 0 ? paths : ["."])])).split("\0").filter(Boolean);
}

function collect(project: ChangeProject, diff: string, wholly: readonly string[]): Map<string, ReadonlySet<number> | "all"> {
  const added = new Map<string, ReadonlySet<number> | "all">();
  for (const [file, lines] of parseAddedLines(diff)) if (isChecked(project, file) && lines.size > 0) added.set(file, lines);
  for (const file of wholly) if (isChecked(project, file)) added.set(file, "all");
  return added;
}

/**
 * The change in the working tree: against HEAD when `base` is not given, else against the
 * merge-base of `base` and HEAD (what a pull request into `base` adds, plus uncommitted edits).
 * `paths` limits it to some project-relative files (the Claude Code hook's edited file).
 */
export async function workingTreeChange(project: ChangeProject, base?: string, paths: readonly string[] = []): Promise<ChangeSet> {
  const root = project.root;
  await ensureRepo(root);
  const head = await headCommit(root);
  let commit: string | null;
  let label: string;
  if (base === undefined) {
    commit = head;
    label = head ? "HEAD" : "an empty repository (no commit yet)";
  } else {
    if (!head) throw new DiffError(`this repository has no commit yet, so it has no merge-base with ${base}; run youiyoux check --diff without a base`);
    const resolved = await git(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`]).catch(() => "");
    if (!resolved.trim()) throw new DiffError(`${base} is not a commit or branch git knows here; fetch it first (in CI: actions/checkout with fetch-depth: 0) or name another base`);
    commit = (await git(root, ["merge-base", resolved.trim(), "HEAD"]).catch(() => "")).trim();
    if (!commit) throw new DiffError(`${base} and HEAD share no history (no merge-base); name a base this branch grew from`);
    label = `${base} (merge-base ${commit.slice(0, 7)})`;
  }
  const scope = ["--", ...(paths.length > 0 ? paths : ["."])];
  // No commit yet: every file is untracked or staged, so every line is added.
  const diff = commit ? await git(root, [...DIFF_ARGS, commit, ...scope]) : "";
  const staged = commit ? [] : (await git(root, ["diff", "--cached", "--name-only", "-z", "--relative", ...scope]).catch(() => "")).split("\0").filter(Boolean);
  return { base: label, commit, added: collect(project, diff, [...(await untracked(root, paths)), ...staged]) };
}

/** The staged change (pre-commit): the index against HEAD, with the staged content of each file. */
export async function stagedChange(project: ChangeProject): Promise<ChangeSet> {
  const root = project.root;
  await ensureRepo(root);
  const head = await headCommit(root);
  const diff = head ? await git(root, [...DIFF_ARGS, "--cached", head, "--", "."]) : "";
  const fresh = head ? [] : (await git(root, ["diff", "--cached", "--name-only", "-z", "--relative", "--", "."]).catch(() => "")).split("\0").filter(Boolean);
  const added = collect(project, diff, fresh);
  // The project's path inside the repo, from git itself: comparing paths would trip over symlinks (/var vs /private/var).
  const prefix = (await git(root, ["rev-parse", "--show-prefix"])).trim();
  const sources: Record<string, string> = {};
  for (const file of added.keys()) sources[file] = await git(root, ["show", `:${prefix}${file}`]);
  return { base: "HEAD (staged changes)", commit: head, added, sources };
}

/* ------------------------------------------------------------------ analysis */

export interface DiffFinding {
  /** A drift kind, or `rule` for a rule violation on an added line. */
  readonly kind: DriftKind | "rule";
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** What to do instead. */
  readonly fix: string;
  readonly severity: Violation["severity"];
  /** The rule slug, when a rule (also) reports this line. */
  readonly rule?: string;
}

export interface DiffReport {
  readonly base: string;
  readonly commit: string | null;
  /** Checked files the change adds lines to. */
  readonly files: readonly string[];
  readonly findings: readonly DiffFinding[];
  /** What was compared with what, when it limits the result (no package.json: imports compared only with the System). */
  readonly notes: readonly string[];
  /** Analyses that could not run: findings there are unknown, never zero. */
  readonly incomplete: readonly string[];
}

const slugOf = (rule: string): string => rule.slice(rule.indexOf("/rule/") + 6);
const DRIFT_SEVERITY: Record<DriftKind, DiffFinding["severity"]> = { "near-duplicate": "warn", "hardcoded-value": "error", "off-library": "error" };

/** Where a project file is imported from, by another: the owned kit by its configured specifier, anything else by a relative path. */
export async function importOf(project: ChangeProject): Promise<(file: string, fromFile: string) => string> {
  const alias = await aliasRoot(project.root, project.config.tsconfig);
  return (file, fromFile) => {
    if (project.system && file.startsWith(`${project.config.componentsDir}/`)) return importSpecifier(project.config, fromFile);
    if (alias !== undefined && file.startsWith(alias)) return `@/${file.slice(alias.length).replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/\/index$/, "")}`;
    const path = posix.relative(posix.dirname(fromFile), file).replace(/\.(tsx?|jsx?|mjs|astro)$/, "").replace(/\/index$/, "");
    return path.startsWith(".") ? path : `./${path}`;
  };
}

export const classify = (specifier: string, names: readonly string[]): ImportClass | null => {
  const pkg = packageOf(specifier);
  const library = pkg ? libraryOfPackage(pkg) : undefined;
  if (!pkg || !library) return null;
  const types = elementTypes({ specifier, names, file: "", line: 0 }, pkg, library.packageElements);
  return types.length > 0 ? { library: library.id, label: library.name, types } : null;
};

/**
 * The library each element type comes from in this project: the System's own component when it
 * has one, else the library the rest of the code already imports it from (most imports wins).
 */
export async function chosenLibraries(project: ChangeProject, added: AddedLines, notes: string[]): Promise<Map<string, ChosenLibrary>> {
  const chosen = new Map<string, ChosenLibrary>();
  for (const { contract } of project.system?.components ?? []) {
    const type = EXPORT_TYPES[contract.name];
    if (type && !chosen.has(type)) chosen.set(type, { library: "system", label: `the System's ${contract.name} (${contract.id})`, fix: (from) => `import { ${contract.name} } from "${importSpecifier(project.config, from)}"` });
  }
  let hits;
  try {
    hits = (await detectRepo(project.root)).hits;
  } catch (error: unknown) {
    notes.push(`imports were compared only with the System's components (${error instanceof Error ? error.message : String(error)})`);
    return chosen;
  }
  const outside = hits.filter((hit) => (hit.where ?? []).some((where) => {
    const at = where.lastIndexOf(":");
    return !isAdded(added, where.slice(0, at), Number(where.slice(at + 1)));
  }));
  const byType = new Map<string, Map<string, { count: number; detail: string; label: string }>>();
  for (const hit of outside) {
    const libraries = byType.get(hit.type) ?? new Map();
    const entry = libraries.get(hit.library) ?? { count: 0, detail: hit.detail, label: LIBRARY_BY_ID.get(hit.library)?.name ?? hit.library };
    entry.count += hit.count;
    libraries.set(hit.library, entry);
    byType.set(hit.type, libraries);
  }
  const target = await loadInventoryTarget(project.root);
  const modules: ModuleInfo[] = [];
  for (const file of target.files) {
    const module = await parseModule(file, await readFile(join(project.root, file), "utf8"));
    if (module && !isAdded(added, file, 1)) modules.push(module);
  }
  const pathOf = await importOf({ ...project, system: undefined });
  for (const [type, libraries] of byType) {
    if (chosen.has(type)) continue;
    const [library, top] = [...libraries].sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b))[0]!;
    const imports = `${top.count} existing import${top.count === 1 ? "" : "s"}`;
    // detect's detail reads `Dialog from @radix-ui/react-dialog`, or the bare specifier for a namespace import.
    const [names, from] = top.detail.includes(" from ") ? top.detail.split(" from ") : [top.detail, top.detail];
    const what = names === from ? `the ${type} from "${from}"` : `${names} from "${from}"`;
    const wrappers = modules.flatMap((module) => {
      if (!module.imports.some((i) => !i.typeOnly && classify(i.specifier, [i.imported])?.library === library)) return [];
      return module.exports.filter((e) => EXPORT_TYPES[e.name] === type).map((e) => ({ file: module.file, name: e.name,
        owned: module.file.startsWith(`${project.config.componentsDir}/`) ? 1 : 0,
        uses: modules.filter((m) => m.imports.some((i) => i.imported === e.name && i.specifier === pathOf(module.file, m.file))).length }));
    }).sort((a, b) => b.owned - a.owned || b.uses - a.uses || a.file.localeCompare(b.file));
    const wrapper = wrappers[0];
    if (wrapper) {
      chosen.set(type, { library, label: `${top.label} via ${wrapper.name}`, fix: (from) => `import { ${wrapper.name} } from "${pathOf(wrapper.file, from)}"` });
      continue;
    }
    chosen.set(type, { library, label: `${top.label} (${imports})`, fix: () => `use ${what} instead, as the ${top.count === 1 ? "existing import does" : `${imports} do`}` });
  }
  return chosen;
}

export interface AnalyseOptions {
  /** Rule violations to report on added lines (already filtered by --rule and --quiet). */
  readonly violations: readonly Violation[];
}

/** The same place and the same text: one finding, keeping the fix that names the token or the component. */
const samePlace = (a: { file: string; line: number }, b: { file: string; line: number }): boolean => a.file === b.file && a.line === b.line;
const sameText = (a: string, b: string): boolean => a.includes(b) || b.includes(a);

/** Everything the change adds that drifts from the System, with the fix: drift findings plus rule violations on added lines. */
export async function analyseChange(project: Project, scan: ScanResult, change: ChangeSet, options: AnalyseOptions): Promise<DiffReport> {
  const added = (file: string, line: number): boolean => isAdded(change.added, file, line);
  const files = [...change.added.keys()].sort();
  const notes: string[] = [];
  const incomplete: string[] = [];
  const drift: DriftFinding[] = [];
  const modules = files.flatMap((f) => (scan.modules.get(f) ? [scan.modules.get(f)!] : []));
  if (modules.length > 0) {
    const tokenSources = project.config.tokenSources;
    for (const module of modules) drift.push(...hardcodedValues(module, scan.tokens, { isTokenSource: matchesAny(module.file, tokenSources), added }));
    try {
      const inventory = await buildInventory([project.root], { include: project.config.include, exclude: project.config.exclude, cwd: project.root, definitionRoots: true });
      for (const failure of inventory.projects.flatMap((p) => p.failed)) if (change.added.has(failure.file)) incomplete.push(`${failure.file}: its components could not be compared (${failure.reason})`);
      drift.push(...nearDuplicates({ inventory, added, importOf: await importOf(project) }));
    } catch (error: unknown) {
      incomplete.push(`near-duplicate components were not checked (${error instanceof Error ? error.message : String(error)})`);
    }
    const chosen = await chosenLibraries(project, change.added, notes);
    for (const module of modules) drift.push(...offLibraryImports(module, { added, classify, chosen, exempt: scan.elements.isOwned }));
  }
  const rules = new Map<string, RuleSpec>(project.system.rules.map((r) => [r.id, r]));
  const findings: DiffFinding[] = drift.map((d) => ({ kind: d.kind, file: d.file, line: d.line, column: d.column, message: d.message, fix: d.fix, severity: DRIFT_SEVERITY[d.kind] }));
  for (const violation of options.violations) {
    if (!added(violation.file, violation.line)) continue;
    const merged = findings.findIndex((f, i) => f.kind !== "rule" && samePlace(f, violation) && sameText(drift[i]?.text ?? "", violation.text));
    if (merged >= 0) {
      const into = findings[merged]!;
      findings[merged] = { ...into, rule: slugOf(violation.rule), severity: violation.severity === "error" ? "error" : into.severity };
      continue;
    }
    const fix = violation.suggestion ?? rules.get(violation.rule)?.agent ?? `see \`youiyoux rules\` for ${slugOf(violation.rule)}`;
    findings.push({ kind: "rule", file: violation.file, line: violation.line, column: violation.column, message: violation.message, fix, severity: violation.severity, rule: slugOf(violation.rule) });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { base: change.base, commit: change.commit, files, findings, notes, incomplete };
}
