/**
 * The one check service behind `youi check`, `youi watch`, the agent hooks and CI:
 * scan (whole project, or focused on some files), apply an existing-violation
 * baseline if there is one, verify the lockfile, and decide pass, fail or incomplete.
 * Every result carries the identity it was computed against.
 */
import { dirname, join, relative, resolve, sep } from "node:path";
import { Baseline, readDefinition, readTextOrNull, writeFileAtomic, type CheckIdentity, type RuleRun, type Violation } from "@youiyoux/core";
import { BASELINE_FILE, compareToBaseline, createBaseline, failedChecks, PROJECT_FILE, ratchetBaseline, scanProject, type BaselineComparison, type Project, type ScanCache, type ScanResult } from "@youiyoux/scanner";
import { analyseChange, type ChangeSet, type DiffReport } from "./check-diff.ts";
import { verifyLock, verifyWiring, type LockIssue } from "./sync.ts";

export interface CheckOptions {
  /** Check only these files (absolute, or relative to the current directory); default: the whole project. */
  readonly files?: readonly string[];
  /** Contents to check instead of the files on disk (staged blobs, unsaved edits), by project-relative path. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Only this rule (its slug, e.g. raw-color). */
  readonly rule?: string;
  /** Errors only. */
  readonly quiet?: boolean;
  /** Compare against this baseline file; null: no baseline. */
  readonly baseline?: string | null;
  /** Verify the lockfile and generated-file wiring (default true; hooks skip it). */
  readonly lock?: boolean;
  readonly cache?: ScanCache;
  /** Also report what this change adds (`youi check --diff`): its files are the scope unless `files` is given, its staged sources the content. */
  readonly diff?: ChangeSet;
}

export interface CheckResult {
  readonly identity: CheckIdentity;
  readonly scan: ScanResult;
  /** Project-relative files that were asked about, or null for the whole project. */
  readonly scope: ReadonlySet<string> | null;
  /** Asked-about files the project does not include. */
  readonly unmatched: readonly string[];
  /** Files that could not be fully analysed: a clean result there is not a pass. */
  readonly failed: ReadonlyArray<{ file: string; reason: string }>;
  /** Rules that should have run and could not (unsupported or errored): their findings are unknown, never zero. */
  readonly notRun: readonly RuleRun[];
  readonly violations: readonly Violation[];
  readonly lock: readonly LockIssue[] | null;
  readonly baseline: { readonly file: string; readonly recorded: CheckIdentity; readonly comparison: BaselineComparison } | null;
  /** What fails the check: errors (beyond the baseline, when there is one) plus lockfile errors. */
  readonly errors: number;
  readonly incomplete: boolean;
  /** What the change adds that drifts from the System, when `diff` was given. */
  readonly diff: DiffReport | null;
}

/** Common diff output for configured projects and inferred repositories. */
export type DiffCheckResult = Pick<CheckResult, "diff" | "incomplete" | "unmatched" | "failed" | "notRun"> & { readonly identity: CheckIdentity | null };

export const toProjectPath = (project: Project, file: string): string => relative(project.root, resolve(file)).split(sep).join("/");

/** The baseline file for a project: next to its config (which may live outside the project). */
export function baselinePath(project: Project, configPath?: string): string {
  return join(dirname(resolve(configPath ?? project.configFile ?? join(project.root, PROJECT_FILE))), BASELINE_FILE);
}

export async function readBaseline(file: string): Promise<Baseline | null> {
  if ((await readTextOrNull(file)) === null) return null;
  return readDefinition(file, Baseline);
}

export async function runCheck(project: Project, options: CheckOptions = {}): Promise<CheckResult> {
  const { diff } = options;
  const scope = options.files ? new Set(options.files.map((f) => toProjectPath(project, f))) : diff ? new Set(diff.added.keys()) : null;
  const overrides = { ...diff?.sources, ...options.overrides };
  const scan = await scanProject(project, { ...(scope ? { focus: [...scope] } : {}), ...(Object.keys(overrides).length > 0 ? { overrides } : {}), ...(options.cache ? { cache: options.cache } : {}) });
  const { report } = scan;
  const checked = new Set(scan.files);
  const unmatched = scope ? [...scope].filter((f) => !checked.has(f)) : [];
  const failed = report.coverage.failed.filter((f) => !scope || scope.has(f.file) || !/\.(tsx?|css)$/.test(f.file));
  const wantedRule = (id: string): boolean => !options.rule || id.endsWith(`/rule/${options.rule}`);
  const violations = report.violations.filter((v) => wantedRule(v.rule) && (!options.quiet || v.severity === "error"));
  const notRun = failedChecks(report.checks).filter((c) => wantedRule(c.rule));
  const lock = options.lock === false || (diff && options.lock !== true) ? null : await lockIssues(project);
  const recorded = options.baseline ? await readBaseline(options.baseline) : null;
  if (options.baseline && !recorded) throw new Error(`no baseline at ${options.baseline}; record one with \`youi baseline\``);
  const baseline = recorded && options.baseline ? { file: options.baseline, recorded: recorded.identity, comparison: compareToBaseline(recorded, violations, scope ?? undefined) } : null;
  const failing = baseline ? [...baseline.comparison.new, ...baseline.comparison.regressed] : violations;
  const errors = failing.filter((v) => v.severity === "error").length + (lock ?? []).filter((i) => i.severity === "error").length;
  const drift = diff ? await analyseChange(project, scan, diff, { violations }) : null;
  // A clean result only counts when everything asked about was actually checked.
  return { identity: scan.identity, scan, scope, unmatched, failed, notRun, violations, lock, baseline, errors, incomplete: unmatched.length > 0 || failed.length > 0 || notRun.length > 0 || (drift?.incomplete.length ?? 0) > 0, diff: drift };
}

async function lockIssues(project: Project): Promise<LockIssue[] | null> {
  const lock = await verifyLock(project);
  return lock === null ? null : [...lock, ...(await verifyWiring(project))];
}

/** 0 passes, 1 fails or is incomplete. */
export const exitCodeOf = (result: CheckResult): number => (result.errors > 0 || result.incomplete ? 1 : 0);

/** `youi check --diff`: advisory (0) unless `strict`, which fails on any finding or an incomplete result. */
export const diffExitCodeOf = (result: DiffCheckResult, strict: boolean): number => (strict && ((result.diff?.findings.length ?? 0) > 0 || result.incomplete) ? 1 : 0);

export interface BaselineWrite {
  readonly file: string;
  readonly action: "created" | "ratcheted" | "rewritten";
  readonly baseline: Baseline;
  /** Current findings a ratchet left out (new debt is only accepted by a deliberate rewrite). */
  readonly notAdded: number;
}

/**
 * Record or tighten a baseline. A first run records every current violation; later runs
 * only drop fixed occurrences, unless `force` deliberately rewrites it (accepting new debt).
 * An incomplete scan records one only with `force`: files it could not read would come back as "new".
 */
export async function writeBaseline(project: Project, file: string, options: { force?: boolean; cache?: ScanCache } = {}): Promise<BaselineWrite> {
  const scan = await scanProject(project, options.cache ? { cache: options.cache } : {});
  if (scan.report.status !== "complete" && !options.force) {
    const gaps = [...scan.report.coverage.failed.map((f) => f.file), ...failedChecks(scan.report.checks).map((c) => `rule ${c.rule.split("/rule/")[1]}`)];
    throw new Error(`the scan is partial (${gaps.join(", ")}): findings there would later look new. Fix what could not be analysed or run, or record anyway with --force`);
  }
  const existing = await readBaseline(file);
  const violations = scan.report.violations;
  const baseline = existing && !options.force ? ratchetBaseline(existing, violations, scan.identity) : createBaseline(project.config.id, scan.identity, violations);
  const kept = baseline.totals.errors + baseline.totals.warnings;
  await writeFileAtomic(file, `${JSON.stringify(baseline, null, 2)}\n`);
  const action = !existing ? "created" : options.force ? "rewritten" : "ratcheted";
  return { file, action, baseline, notAdded: violations.length - kept };
}
