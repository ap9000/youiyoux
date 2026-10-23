/**
 * How a check result reads: in a terminal, as GitHub Actions annotations on the
 * PR's lines, and as the job summary that states which rules version decided it.
 */
import { ruleSlug, type Violation } from "@youiyoux/core";
import { describeIdentity } from "@youiyoux/scanner";
import type { CheckResult, DiffCheckResult } from "./check.ts";
import type { DiffFinding } from "./check-diff.ts";
import { renderCheck } from "./render.ts";
import { plural, style } from "./ui.ts";


/** The findings a reader must act on: everything, or only what the baseline does not accept. */
export function actionable(result: CheckResult): readonly Violation[] {
  if (!result.baseline) return result.violations;
  const { comparison } = result.baseline;
  return [...comparison.new, ...comparison.regressed].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function renderCheckText(result: CheckResult): string {
  const lines = [renderCheck(actionable(result), result.lock, result.scan.report)];
  if (result.baseline) {
    const { comparison, file, recorded } = result.baseline;
    const gone = comparison.fixed.reduce((n, f) => n + f.gone, 0);
    lines.push(
      style.dim(`baseline ${file}: ${plural(comparison.known.length, "known violation")} accepted · ${comparison.new.length} new · ${comparison.regressed.length} regressed`),
      ...(gone > 0 ? [style.ok(`  ${plural(gone, "baselined violation")} fixed: run \`youiyoux baseline\` to ratchet it down`)] : []),
      ...(recorded.definitions !== result.identity.definitions ? [style.dim(`  recorded against definitions ${recorded.definitions}; checking ${result.identity.definitions}`)] : []),
    );
  }
  for (const file of result.unmatched) lines.push(style.error(`✖ ${file} was not checked: it is not in this project's include globs (or does not exist)`));
  if (result.failed.length > 0) lines.push(style.warn(`! incomplete: ${result.failed.map((f) => f.file).join(", ")} could not be fully analysed, so 0 errors there is not a pass`));
  lines.push(style.dim(`rules ${describeIdentity(result.identity)}`));
  return lines.join("\n");
}

/* --------------------------------------------------------------- GitHub Actions */

const escapeData = (text: string): string => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text: string): string => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

function command(kind: "error" | "warning", message: string, props: Record<string, string | number> = {}): string {
  const list = Object.entries(props).map(([key, value]) => `${key}=${escapeProperty(String(value))}`).join(",");
  return `::${kind}${list ? ` ${list}` : ""}::${escapeData(message)}`;
}

/**
 * Workflow commands that annotate the PR: one per actionable finding at its file and line
 * (`prefix` is the project's path inside the repository), plus setup and coverage problems.
 * Accepted baseline debt is counted in the summary, never annotated.
 */
export function githubAnnotations(result: CheckResult, prefix: string): string[] {
  const regressed = new Set(result.baseline?.comparison.regressed ?? []);
  const lines = actionable(result).map((v) =>
    command(v.severity === "error" ? "error" : "warning", `${v.message}${v.suggestion ? ` → ${v.suggestion}` : ""}${regressed.has(v) ? " (a warning in the baseline)" : ""}`, {
      file: `${prefix}${v.file}`,
      line: v.line,
      col: v.column,
      title: `youi ${ruleSlug(v.rule)}`,
    }),
  );
  for (const issue of result.lock ?? []) lines.push(command(issue.severity === "error" ? "error" : "warning", issue.message, { file: `${prefix}${issue.file}`, title: "youi setup" }));
  for (const file of result.unmatched) lines.push(command("error", `${file} was not checked: not in this project's include globs`, { title: "youi incomplete" }));
  for (const failure of result.failed) lines.push(command("error", `could not be fully analysed (${failure.reason}); a clean result here is not a pass`, { file: `${prefix}${failure.file}`, title: "youi incomplete" }));
  for (const run of result.notRun) lines.push(command("error", `rule ${ruleSlug(run.rule)} did not run (${run.reason ?? run.state}); its findings are unknown`, { title: "youi incomplete" }));
  return lines;
}

const revision = (state: { commit: string | null; dirty: boolean }): string => (state.commit ? `\`${state.commit}\`${state.dirty ? " (dirty)" : ""}` : "not a git checkout");

/** Markdown for $GITHUB_STEP_SUMMARY: the verdict and exactly which rules and revisions produced it. */
export function githubSummary(result: CheckResult): string {
  const { identity, baseline } = result;
  const verdict = result.incomplete ? "⚠️ incomplete" : result.errors > 0 ? `❌ ${plural(result.errors, "error")}` : "✅ passed";
  const baselineRow = baseline
    ? `${baseline.comparison.known.length} accepted · ${baseline.comparison.new.length} new · ${baseline.comparison.regressed.length} regressed · ${baseline.comparison.fixed.reduce((n, f) => n + f.gone, 0)} fixed (recorded against \`${baseline.recorded.definitions}\`)`
    : "none: every violation counts";
  const rows = [
    ["Rules", `\`${identity.system.id}@${identity.system.version}\`, definitions \`${identity.definitions}\``],
    ["Design repo", revision(identity.design)],
    ["Project", revision(identity.project)],
    ["Tool", `\`${identity.tool}\``],
    ["Baseline", baselineRow],
  ];
  return [`### youiyoux check: ${verdict}`, "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), ""].join("\n");
}

/* ------------------------------------------------------------ youiyoux check --diff */

const KIND_LABEL: Record<DiffFinding["kind"], string> = { "near-duplicate": "near-duplicate", "hardcoded-value": "hardcoded value", "off-library": "off-library import", rule: "rule" };

/** Why a diff result is not a pass even with no findings: files or analyses that could not be checked. */
export function diffGaps(result: DiffCheckResult): string[] {
  return [
    ...result.unmatched.map((f) => `${f} was not checked: it is not in this project's include globs`),
    ...result.failed.map((f) => `${f.file} could not be fully analysed (${f.reason})`),
    ...result.notRun.map((r) => `rule ${ruleSlug(r.rule)} did not run (${r.reason ?? r.state})`),
    ...(result.diff?.incomplete ?? []),
  ];
}

/** One finding as a line an agent or a person acts on: where, what, and the fix. */
export const diffFindingLine = (f: DiffFinding): string => `${f.file}:${f.line}:${f.column} ${kindOf(f)}: ${f.message} Fix: ${f.fix}`;

/** `hardcoded value (also rule raw-color)`, or `rule raw-color` for a plain rule violation. */
const kindOf = (f: DiffFinding): string => (f.kind === "rule" ? `rule ${f.rule}` : `${KIND_LABEL[f.kind]}${f.rule ? ` (also rule ${f.rule})` : ""}`);

/** `youiyoux check --diff` in a terminal: each finding with its fix, then what to do next. */
export function renderDiffText(result: DiffCheckResult): string {
  const diff = result.diff!;
  const lines: string[] = [style.dim(`youiyoux check --diff against ${diff.base}: ${plural(diff.files.length, "changed file")}`)];
  for (const [file, list] of Map.groupBy(diff.findings, (f) => f.file)) {
    lines.push(style.bold(file));
    for (const f of list) {
      const label = f.severity === "error" ? style.error(kindOf(f)) : style.warn(kindOf(f));
      lines.push(`  ${style.dim(`${f.line}:${f.column}`)}  ${label}  ${f.message}`, `      ${style.ok("→")} ${f.fix}`);
    }
  }
  const gaps = diffGaps(result);
  for (const gap of gaps) lines.push(style.warn(`! incomplete: ${gap}`));
  for (const note of diff.notes) lines.push(style.dim(`note: ${note}`));
  lines.push("");
  if (diff.findings.length > 0) lines.push(style.error(`✖ ${plural(diff.findings.length, "finding")} in this change: apply each fix (→), then run \`youiyoux check --diff\` again`));
  else if (gaps.length > 0) lines.push(style.warn("! Not a pass: parts of this change could not be checked (above). Fix what could not be read, then run `youiyoux check --diff` again"));
  else if (diff.files.length === 0) lines.push(style.ok(`✓ No checked files changed against ${diff.base}: nothing to check. Compare with a branch: youiyoux check --diff main`));
  else lines.push(style.ok(`✓ No drift in this change: ${plural(diff.files.length, "file")} checked against ${diff.base}. Nothing to fix`));
  return lines.join("\n");
}

/** The machine-readable result for agents: the base, the files and every finding with its fix. */
export function diffJson(result: DiffCheckResult): Record<string, unknown> {
  const diff = result.diff!;
  return {
    base: diff.base,
    commit: diff.commit,
    files: diff.files,
    findings: diff.findings,
    incomplete: result.incomplete,
    gaps: diffGaps(result),
    notes: diff.notes,
    next: diff.findings.length > 0 ? "apply each finding's fix, then run youiyoux check --diff again" : result.incomplete ? "not a pass: fix what could not be checked (gaps), then run youiyoux check --diff again" : "nothing to fix",
    identity: result.identity,
  };
}

/** PR annotations for `youiyoux check --diff --format github`: one per finding on its added line, plus what could not be checked. */
export function githubDiffAnnotations(result: DiffCheckResult, prefix: string): string[] {
  const lines = (result.diff?.findings ?? []).map((f) => command(f.severity === "error" ? "error" : "warning", `${f.message} Fix: ${f.fix}`, { file: `${prefix}${f.file}`, line: f.line, col: f.column, title: `youi ${kindOf(f)}` }));
  for (const gap of diffGaps(result)) lines.push(command("error", `${gap}; a clean result here is not a pass`, { title: "youi incomplete" }));
  return lines;
}

/** Markdown for $GITHUB_STEP_SUMMARY after `youiyoux check --diff`. */
export function githubDiffSummary(result: DiffCheckResult): string {
  const diff = result.diff!;
  const verdict = diff.findings.length > 0 ? `❌ ${plural(diff.findings.length, "finding")}` : result.incomplete ? "⚠️ incomplete" : "✅ no drift";
  const byKind = [...Map.groupBy(diff.findings, (f) => KIND_LABEL[f.kind])].map(([kind, list]) => `${list.length} ${kind}`).join(" · ") || "none";
  return [`### youiyoux check --diff: ${verdict}`, "", "| | |", "|---|---|", `| Base | ${diff.base} |`, `| Changed files | ${diff.files.length} |`, `| Findings | ${byKind} |`, result.identity ? `| Rules | \`${result.identity.system.id}@${result.identity.system.version}\`, definitions \`${result.identity.definitions}\` |` : "| Rules | Repository inference; run youiyoux init --design <dir> for rules |", ""].join("\n");
}
