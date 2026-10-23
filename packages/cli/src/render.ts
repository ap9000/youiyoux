/** Human output for each command. Every command also has --json for scripts and agents. */
import { executionLabel, ruleSlug, type RuleExecution, type RuleSpec, type ScanReport, type Violation } from "@youiyoux/core";
import { failedChecks, shotsText, type ChangePlan, type MigrationResult, type RuleEvaluation, type ScreenBom, type ShotsReport, type WhereResult } from "@youiyoux/scanner";
import type { LockIssue, SyncAction, SyncResult } from "./sync.ts";
import { bar, ms, padEnd, padStart, plural, rule, style, truncate } from "./ui.ts";

const SHELL_NOTE = style.dim("app shell: on every screen");

function coverageLine(report: Pick<ScanReport, "coverage" | "commit" | "status" | "durationMs" | "checks" | "content">): string {
  const problems = [
    ...(report.coverage.failed.length > 0 ? [`${plural(report.coverage.failed.length, "file")} not fully parsed`] : []),
    ...(failedChecks(report.checks).length > 0 ? [`${plural(failedChecks(report.checks).length, "rule")} could not run`] : []),
  ];
  const status = report.status === "complete" ? style.ok("complete") : style.warn(`partial: ${problems.join(", ") || "incomplete"}`);
  const dirty = report.content?.dirtyCount ? ` + ${plural(report.content.dirtyCount, "uncommitted file")}` : "";
  return style.dim(`scanned ${plural(report.coverage.filesScanned, "file")}${report.commit ? ` at ${report.commit.slice(0, 12)}${dirty}` : ""} in ${ms(report.durationMs)} · `) + status;
}

/** Rules that should have run and did not: their silence is not a pass. */
function ruleProblemLines(report: Pick<ScanReport, "checks">): string[] {
  return failedChecks(report.checks).map((c) => style.warn(`  ! rule ${ruleSlug(c.rule)} did not run: ${c.reason ?? c.state}`));
}

export function renderScan(report: ScanReport, outFile: string): string {
  const byElement = Map.groupBy(report.usages, (u) => u.element);
  const width = Math.max(...[...byElement.keys()].map((id) => id.split("/").at(-1)!.length), 8);
  const max = Math.max(...[...byElement.values()].map((v) => v.length), 1);
  const errors = report.violations.filter((v) => v.severity === "error").length;
  const lines = [
    `${style.bold(report.project)} ${style.dim(`· ${report.system}`)}`,
    "",
    ...[...byElement].sort((a, b) => b[1].length - a[1].length).map(([id, sites]) => `  ${padEnd(id.split("/").at(-1)!, width)}  ${padStart(String(sites.length), 4)}  ${bar(sites.length, max)}`),
    "",
    `  ${plural(report.usages.length, "site")} · ${style.dim(`${plural(report.unknowns.length, "unknown")} (never counted as zero)`)} · ${report.lookalikes.length > 0 ? style.warn(plural(report.lookalikes.length, "lookalike")) : "0 lookalikes"}`,
    `  ${errors > 0 ? style.error(plural(errors, "error")) : style.ok("0 errors")} · ${plural(report.violations.length - errors, "warning")}${report.suppressed ? style.dim(` · ${report.suppressed} suppressed`) : ""}  ${style.dim("→ youiyoux check")}`,
    "",
    coverageLine(report),
    ...report.coverage.failed.map((f) => style.warn(`  ! ${f.file}: ${f.reason}`)),
    ...ruleProblemLines(report),
    style.dim(`usage map → ${outFile}`),
  ];
  return lines.join("\n");
}

export function renderWhere(where: WhereResult, report: ScanReport): string {
  const all = where.sites;
  const max = Math.max(...where.byRoute.map((r) => r.sites), 1);
  const routeWidth = Math.max(...where.byRoute.map((r) => r.route.length), 6);
  const unknown = where.unknown.length > 0 ? style.warn(plural(where.unknown.length, "unknown")) : style.dim("0 unknown");
  const lookalikes = where.lookalikes.reduce((n, l) => n + l.sites, 0);
  const lines = [
    `${style.accent(where.name)}  ${style.dim(`${where.element} · v${where.version} · ${where.status}`)}`,
    style.dim(where.import),
    "",
    `${style.bold(plural(where.total, "site"))} in ${plural(where.files, "file")} across ${plural(where.screens, "screen")}   ${unknown}   ${lookalikes > 0 ? style.warn(`${plural(lookalikes, "lookalike")} not counted`) : style.dim("0 lookalikes")}`,
    rule(),
    ...where.byRoute.map((r) => `${padEnd(r.route, routeWidth)}  ${padStart(String(r.sites), 4)}  ${bar(r.sites, max)}${r.route === "*" ? `  ${SHELL_NOTE}` : ""}`),
    ...(where.unrouted > 0 ? [`${padEnd(style.warn("(unrouted)"), routeWidth)}  ${padStart(String(where.unrouted), 4)}  ${style.dim("no screen imports these files")}`] : []),
    "",
    ...Object.entries(where.props).map(([prop, counts]) => `${style.dim(padEnd(prop, 9))}${Object.entries(counts).map(([value, n]) => `${value.startsWith("(") ? style.dim(value) : value} ${style.dim(String(n))}`).join(style.dim(" · "))}`),
    "",
  ];
  const byRoute = Map.groupBy(all, (s) => s.routes[0] ?? "(unrouted)");
  for (const [route, sites] of byRoute) {
    lines.push(style.bold(route));
    for (const site of sites) lines.push(`  ${padEnd(style.dim(site.at), 46)} ${padEnd(site.use, 14)} ${site.props}`);
  }
  if (where.nextOffset !== null) lines.push(style.dim(`  … ${where.total - all.length} more (--all, or --route <route>)`));
  for (const l of where.lookalikes) lines.push("", style.warn(`lookalike: ${plural(l.sites, "site")} render ${l.resolved}, a different ${where.name}`), style.dim("  not counted above · youiyoux check --rule components.canonical-import lists them"));
  for (const u of where.unknown) lines.push(style.warn(`unknown: ${u.at} <${u.name}> (${u.reason})`));
  lines.push("", coverageLine(report));
  return lines.join("\n");
}

export function renderCheck(violations: readonly Violation[], lockIssues: readonly LockIssue[] | null, report: ScanReport): string {
  const { suppressed } = report;
  const lines: string[] = [];
  for (const [file, list] of Map.groupBy(violations, (v) => v.file)) {
    lines.push(style.bold(file));
    for (const v of list) {
      const severity = v.severity === "error" ? style.error("error") : style.warn("warn ");
      lines.push(`  ${padEnd(style.dim(`${v.line}:${v.column}`), 9)} ${severity}  ${truncate(v.message, 70)}${v.suggestion ? style.dim(`  → ${truncate(v.suggestion, 70)}`) : ""}  ${style.dim(ruleSlug(v.rule))}`);
    }
  }
  if (lockIssues && lockIssues.length > 0) {
    lines.push(style.bold("setup (lockfile, generated files, theme wiring)"));
    for (const issue of lockIssues) lines.push(`  ${issue.severity === "error" ? style.error("error") : style.warn("warn ")}  ${issue.file}: ${issue.message}`);
  }
  const errors = violations.filter((v) => v.severity === "error").length + (lockIssues ?? []).filter((i) => i.severity === "error").length;
  const warnings = violations.length + (lockIssues?.length ?? 0) - errors;
  const files = new Set(violations.map((v) => v.file)).size;
  const byRule = Map.groupBy(violations, (v) => ruleSlug(v.rule));
  lines.push(
    "",
    errors > 0 ? style.error(`✖ ${plural(errors, "error")} · ${plural(warnings, "warning")} in ${plural(files, "file")}`) : warnings > 0 ? style.warn(`✓ 0 errors · ${plural(warnings, "warning")} in ${plural(files, "file")}`) : style.ok("✓ 0 errors · 0 warnings"),
    ...[...byRule].sort((a, b) => b[1].length - a[1].length).map(([slug, list]) => style.dim(`  ${padStart(String(list.length), 4)}  ${slug}`)),
    ...(suppressed > 0 ? [style.dim(`  ${padStart(String(suppressed), 4)}  suppressed by youi-ignore`)] : []),
    ...(lockIssues === null ? [style.dim("  no youi.lock.json yet: generated-file and drift checks start after `youiyoux sync`")] : []),
    coverageLine(report),
    ...ruleProblemLines(report),
  );
  return lines.join("\n");
}

export function renderBom(bom: ScreenBom): string {
  const lines = [`${style.accent(bom.route)}  ${style.dim(plural(bom.files.length, "file"))}`, ...bom.files.map((f) => style.dim(`  ${f}`)), rule()];
  for (const e of bom.elements) {
    lines.push(`${padEnd(e.name, 12)} ${padStart(String(e.sites), 4)}   ${style.dim(Object.entries(e.props).map(([p, n]) => `${p || "(no props)"} ×${n}`).join(" · "))}`);
  }
  for (const l of bom.lookalikes) lines.push(style.warn(`lookalike  ${l.resolved} ×${l.sites}`));
  const violations = Object.entries(bom.violations);
  if (violations.length) lines.push("", ...violations.map(([id, n]) => `${style.dim(padStart(String(n), 4))}  ${ruleSlug(id)}`));
  return lines.join("\n");
}

function planImpactLine(plan: ChangePlan): string {
  const bound = plan.completeness.exact ? "" : "≥ ";
  const screens = plan.impact.routes.filter((r) => r.route !== "*").length;
  const counted = `${style.bold(`${bound}${plural(plan.impact.sites, "site")}`)} in ${bound}${plural(plan.impact.files, "file")} on ${bound}${plural(screens, "screen")}`;
  const extras = `${plan.impact.unknownCandidates ? style.warn(` · ${plan.impact.unknownCandidates} unknown in scope`) : ""}${plan.impact.lookalikes ? style.warn(` · ${plan.impact.lookalikes} lookalikes outside`) : ""}`;
  return counted + extras;
}

function tokenLines(token: NonNullable<ChangePlan["token"]>): string[] {
  const lines = [
    `reads it: ${token.contracts.length ? token.contracts.map((c) => `${c.name}${c.via === "implementation" ? style.dim(" (implementation)") : ""}`).join(", ") : style.dim("no contract found")}${token.dependents.length ? style.dim(` · via ${token.dependents.join(", ")}`) : ""}`,
    `direct uses: ${token.direct.uses ? `${token.direct.uses} in ${plural(token.direct.files, "file")}` : style.warn("none found (not proof of none: see limits)")}`,
  ];
  for (const site of token.direct.sites) lines.push(style.dim(`  · ${site.file}:${site.line} ${site.text}${site.uses > 1 ? ` ×${site.uses}` : ""}`));
  return lines;
}

export function renderPlan(plan: ChangePlan): string {
  const tone = plan.class === "api-breaking" ? style.error : plan.class === "deprecation" || plan.class === "behavior" ? style.warn : style.ok;
  const lines = [
    `${style.accent(plan.target)}  ${tone(plan.class)}  ${style.dim("→")} ${plan.semver}${plan.version ? style.dim(`  ${plan.version.current} → ${plan.version.next}`) : ""}`,
    ...plan.reasons.map((r) => style.dim(`  · ${r}`)),
    "",
    planImpactLine(plan),
  ];
  if (plan.token) lines.push(...tokenLines(plan.token));
  if (plan.callSites) {
    const unresolved = plan.callSites.unresolved > 0 ? style.warn(` (${plan.callSites.unresolved} cannot be decided statically)`) : "";
    lines.push(`call sites: ${plan.callSites.affected} affected · ${style.ok(`${plan.callSites.auto} automatic`)} · ${plan.callSites.residual > 0 ? style.warn(`${plan.callSites.residual} need a person`) : "0 need a person"}${unresolved}`);
    for (const site of plan.callSites.residualSites) lines.push(style.dim(`  · ${site}`));
  }
  if (plan.review) {
    lines.push(`review: ${plural(plan.review.sites, "site")} render differently with no code change${plan.review.unresolved ? style.warn(` (${plan.review.unresolved} spread props: may)`) : ""}`);
    for (const site of plan.review.listed) lines.push(style.dim(`  · ${site}`));
  }
  if (plan.impact.everyScreen) lines.push(`visual check: ${style.warn("every screen")} ${style.dim("(a stylesheet, the app shell or an unrouted file uses it)")}`);
  else if (plan.impact.routes.length) lines.push(`visual check: ${plan.impact.routes.map((r) => r.route).join(", ")}`);
  if (plan.gates) lines.push(`gates (dry run): ${plan.gates.map((g) => (g.ok ? style.ok(`✓ ${g.name}`) : style.error(`✖ ${g.name}`))).join("  ")}`);
  if (!plan.completeness.exact) lines.push("", style.warn("not the whole impact: counts are a lower bound"), ...plan.completeness.limits.map((l) => style.dim(`  · ${l}`)));
  lines.push("", style.dim(`recipe: ${plan.recipe}`), style.dim(`scan: ${plan.coverage.status} at ${plan.coverage.commit?.slice(0, 12) ?? "uncommitted"}`));
  return lines.join("\n");
}

const EXECUTION_STYLE: Record<RuleExecution["state"], (s: string) => string> = { enforced: style.ok, advisory: style.dim, off: style.dim, unsupported: style.warn };

export function renderRules(rules: ReadonlyArray<{ rule: RuleSpec; execution: RuleExecution }>): string {
  const width = Math.max(...rules.map(({ rule }) => ruleSlug(rule.id).length), 8);
  return rules.map(({ rule, execution }) => `${padEnd(ruleSlug(rule.id), width)}  ${padEnd(rule.severity, 5)}  ${EXECUTION_STYLE[execution.state](executionLabel(execution))}`).join("\n");
}

export function renderRulePreview(evaluation: RuleEvaluation): string {
  if (!evaluation.ok) return [style.error("✖ not a valid youi.rule/v1"), ...evaluation.errors.map((e) => `  · ${e}`)].join("\n");
  const lines = [`${style.accent(evaluation.rule)}  ${EXECUTION_STYLE[evaluation.execution.state](executionLabel(evaluation.execution))}`];
  const { findings, snapshot } = evaluation;
  if (!findings) lines.push(style.warn("nothing ran, so there are no findings to show (this is not a clean result)"));
  else {
    const versus = findings.versusPublished;
    lines.push(`${style.bold(plural(findings.total, "finding"))} in ${plural(findings.files, "file")}${findings.suppressed ? style.dim(` · ${findings.suppressed} suppressed`) : ""}`);
    if (versus) lines.push(versus.findings === null ? style.dim(`published rule: ${versus.execution}, not run in this scan`) : `versus published: ${versus.findings} now · ${style.warn(`+${versus.added}`)} · ${style.ok(`-${versus.removed}`)}`);
    for (const site of findings.sites) lines.push(`  ${padEnd(style.dim(`${site.file}:${site.line}:${site.column}`), 40)} ${truncate(site.text, 60)}`);
  }
  lines.push("", style.dim(`snapshot: ${snapshot.status}, ${plural(snapshot.files, "file")} at ${snapshot.commit?.slice(0, 12) ?? "no commit"} · content ${snapshot.content ?? "?"} · config ${snapshot.configDigest}`));
  return lines.join("\n");
}

export function renderMigration(result: MigrationResult, showDiff: boolean): string {
  const verdict = { applied: style.ok("applied"), "dry-run": style.live("dry run: nothing written"), rejected: style.error("rejected: nothing written"), noop: style.dim("nothing to change") }[result.status];
  const lines = [`${style.accent(result.migration)}  ${verdict}`, `${plural(result.edited, "site")} rewritten in ${plural(result.changes.length, "file")} · ${result.residuals.length > 0 ? style.warn(`${plural(result.residuals.length, "residual")} for a person`) : "0 residuals"}`, ""];
  for (const gate of result.gates) lines.push(`${gate.ok ? style.ok("✓") : style.error("✖")} ${padEnd(gate.name, 13)} ${style.dim(gate.detail)}`);
  if (result.keptBarrels.length) lines.push("", "Barrel public names kept:", ...result.keptBarrels.map((b) => `  ${b.file}:${b.line}  ${b.name}`));
  if (result.residuals.length) lines.push("", style.bold("residuals"), ...result.residuals.map((r) => `  ${style.dim(`${r.file}:${r.line}`)}  ${r.reason}`));
  if (showDiff) for (const change of result.changes) lines.push("", ...change.diff.trimEnd().split("\n").map((l) => (l.startsWith("+") && !l.startsWith("+++") ? style.ok(l) : l.startsWith("-") && !l.startsWith("---") ? style.error(l) : style.dim(l))));
  if (result.status === "dry-run") lines.push("", style.dim("run again with --write to apply"));
  return lines.join("\n");
}

const ACTION_STYLE: Record<SyncAction["action"], (s: string) => string> = {
  created: style.ok, updated: style.live, unchanged: style.dim, adopted: style.ok, merged: style.live, "kept-local": style.warn, conflict: style.error, skipped: style.warn, removed: style.live,
};

export function renderSync({ actions, unknownTools }: Pick<SyncResult, "actions" | "unknownTools">, dryRun: boolean): string {
  const lines = actions.filter((a) => a.action !== "unchanged").map((a) => `${padEnd(ACTION_STYLE[a.action](a.action), 11)} ${a.file}${a.detail ? style.dim(`  ${a.detail}`) : ""}`);
  const warnings = unknownTools.map((m) => `${style.warn("warning")}  ${m.rule} tells agents to call ${m.tool}, which the youiyoux MCP server does not expose; update the rule's agent text`);
  const counts = Map.groupBy(actions, (a) => a.action);
  const summary = [...counts].map(([action, list]) => `${list.length} ${action}`).join(" · ");
  return [...lines, lines.length ? "" : style.dim("everything up to date"), ...(warnings.length ? [...warnings, ""] : []), `${dryRun ? style.live("dry run · ") : ""}${summary}`].join("\n");
}

export function renderShow(card: Record<string, unknown>): string {
  const props = card.props as Record<string, { values?: string[]; default?: string; note?: string; type?: string }>;
  const lines = [`${style.accent(String(card.name))}  ${style.dim(`${String(card.id)} · v${String(card.version)} · ${String(card.status)}`)}`, String(card.summary), style.dim(String(card.import)), ""];
  for (const [name, spec] of Object.entries(props)) {
    lines.push(`${padEnd(style.bold(name), 12)} ${spec.values ? spec.values.map((v) => (v === spec.default ? style.bold(v) : v)).join(style.dim(" | ")) : style.dim(spec.type ?? "")}`);
    if (spec.note) lines.push(style.dim(`             ${spec.note}`));
  }
  const list = (title: string, items: unknown): void => {
    const values = (items as string[] | undefined) ?? [];
    if (values.length) lines.push("", style.bold(title), ...values.map((v) => `  · ${v}`));
  };
  list("do", card.do);
  list("don't", card.dont);
  list("a11y", card.a11y);
  for (const example of (card.examples as Array<{ title: string; code: string }> | undefined) ?? []) lines.push("", style.dim(example.title), `  ${example.code}`);
  return lines.join("\n");
}

/** `youiyoux render`: the plain text an agent reads (shots.ts, shared with ui_render), with a component's first line in bold and its issues in amber. */
export function renderShots(report: ShotsReport): string {
  return shotsText(report)
    .split("\n")
    .map((line) => (line.startsWith("next: ") ? style.bold(line) : /^ {4}- /.test(line) || /^ {2}accessibility: \d/.test(line) ? style.warn(line) : /^\S/.test(line) && !line.startsWith("note: ") ? style.bold(line) : /^ {2}(?:note|before\/after):/.test(line) ? style.dim(line) : line))
    .join("\n");
}
