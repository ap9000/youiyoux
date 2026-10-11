/**
 * Impact preview: the draft rule and the published rule it replaces run over one scan
 * snapshot, so every difference in what they flag comes from the rule, never from the
 * code moving between two scans.
 */
import type { RuleSpec, Violation } from "@youiyoux/core";
import type { Project, ScanResult } from "@youiyoux/scanner";
import type { PreviewFinding } from "./api.ts";
import type { RuleExecution } from "./execution.ts";

export const MAX_FINDINGS = 400;

export interface Comparison {
  readonly enforced: boolean;
  readonly flagged: number;
  readonly counts: { readonly new: number; readonly kept: number; readonly resolved: number; readonly suppressed: number };
  readonly baseline: number;
  readonly files: number;
  readonly findings: readonly PreviewFinding[];
  readonly truncated: boolean;
  readonly limits: readonly string[];
}

const keyOf = (v: Violation): string => `${v.file}:${v.line}:${v.column}:${v.text}`;
const ORDER: Record<PreviewFinding["change"], number> = { new: 0, kept: 1, resolved: 2 };

function finding(v: Violation, change: PreviewFinding["change"]): PreviewFinding {
  return { file: v.file, line: v.line, column: v.column, text: v.text, message: v.message, ...(v.suggestion ? { suggestion: v.suggestion } : {}), severity: v.severity, change };
}

function limitsOf(rule: RuleSpec, scan: ScanResult, flagged: number): string[] {
  const limits: string[] = [];
  const { report } = scan;
  if (rule.check.engine === "advisory") limits.push("Advisory rules are not checked, so nothing can be flagged. Agents and people still see the guidance.");
  if (rule.severity === "off") limits.push("Severity is off: once published, this rule flags nothing anywhere.");
  if (report.coverage.failed.length > 0) limits.push(`${report.coverage.failed.length} file(s) could not be fully parsed; places in them may be missing from this count.`);
  if (rule.check.engine === "youi" && (rule.check.id === "prop-values" || rule.check.id === "lookalike-component") && report.unknowns.length > 0) {
    limits.push(`${report.unknowns.length} component use(s) could not be resolved to a component and are not checked.`);
  }
  if (rule.severity === "warn" && rule.rollout && flagged > 0) limits.push(`Ships as a warning. Tightening it to an error later would turn these ${flagged} place(s) into errors.`);
  return limits;
}

export function comparePreview(input: { project: Project; scan: ScanResult; execution: RuleExecution; draft: RuleSpec; baseline: RuleSpec | null }): Comparison {
  const { project, scan, execution, draft, baseline } = input;
  const next = execution.evaluate(project, scan, [draft]);
  const before = baseline ? execution.evaluate(project, scan, [baseline]).violations : [];
  const beforeKeys = new Set(before.map(keyOf));
  const nextKeys = new Set(next.violations.map(keyOf));
  const all = [
    ...next.violations.map((v) => finding(v, beforeKeys.has(keyOf(v)) ? "kept" : "new")),
    ...before.filter((v) => !nextKeys.has(keyOf(v))).map((v) => finding(v, "resolved")),
  ].sort((a, b) => ORDER[a.change] - ORDER[b.change] || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  const count = (change: PreviewFinding["change"]): number => all.filter((f) => f.change === change).length;
  return {
    enforced: draft.check.engine !== "advisory" && draft.severity !== "off",
    flagged: next.violations.length,
    counts: { new: count("new"), kept: count("kept"), resolved: count("resolved"), suppressed: next.suppressed },
    baseline: before.length,
    files: new Set(next.violations.map((v) => v.file)).size,
    findings: all.slice(0, MAX_FINDINGS),
    truncated: all.length > MAX_FINDINGS,
    limits: limitsOf(draft, scan, next.violations.length),
  };
}
