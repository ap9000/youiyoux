/**
 * How a check result reads: in a terminal, as GitHub Actions annotations on the
 * PR's lines, and as the job summary that states which rules version decided it.
 */
import type { Violation } from "@youiyoux/core";
import { describeIdentity } from "@youiyoux/scanner";
import type { CheckResult } from "./check.ts";
import { renderCheck } from "./render.ts";
import { plural, style } from "./ui.ts";

const slug = (rule: string): string => rule.slice(rule.indexOf("/rule/") + 6);

/** The findings a reader must act on: everything, or only what the baseline does not accept. */
export function actionable(result: CheckResult): readonly Violation[] {
  if (!result.baseline) return result.violations;
  const { comparison } = result.baseline;
  return [...comparison.new, ...comparison.regressed].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function renderCheckText(result: CheckResult): string {
  const lines = [renderCheck(actionable(result), result.lock, result.scan.report, result.scan.report.suppressed)];
  if (result.baseline) {
    const { comparison, file, recorded } = result.baseline;
    const gone = comparison.fixed.reduce((n, f) => n + f.gone, 0);
    lines.push(
      style.dim(`baseline ${file}: ${plural(comparison.known.length, "known violation")} accepted · ${comparison.new.length} new · ${comparison.regressed.length} regressed`),
      ...(gone > 0 ? [style.ok(`  ${plural(gone, "baselined violation")} fixed: run \`youi baseline\` to ratchet it down`)] : []),
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
      title: `youi ${slug(v.rule)}`,
    }),
  );
  for (const issue of result.lock ?? []) lines.push(command(issue.severity === "error" ? "error" : "warning", issue.message, { file: `${prefix}${issue.file}`, title: "youi setup" }));
  for (const file of result.unmatched) lines.push(command("error", `${file} was not checked: not in this project's include globs`, { title: "youi incomplete" }));
  for (const failure of result.failed) lines.push(command("error", `could not be fully analysed (${failure.reason}); a clean result here is not a pass`, { file: `${prefix}${failure.file}`, title: "youi incomplete" }));
  for (const run of result.notRun) lines.push(command("error", `rule ${slug(run.rule)} did not run (${run.reason ?? run.state}); its findings are unknown`, { title: "youi incomplete" }));
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
  return [`### youi check: ${verdict}`, "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), ""].join("\n");
}
