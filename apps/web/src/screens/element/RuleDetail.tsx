/** A rule's page: the statement, why it exists, examples, who declares it, and where projects break it. */
import type { RuleExecution } from "@youiyoux/core/rules";
import { ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { Link } from "wouter";
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { retryUsage, useUsageState } from "../../data/store.ts";
import type { CatalogRule, RuleSpec, ScanReport } from "../../data/types.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { ResourceState } from "../../ui/Pane.tsx";
import { Facts, Section } from "../../ui/Section.tsx";
import { EditRuleButton } from "../changes/EditRuleButton.tsx";
import { checkLabel, executionOf } from "./RulesTab.tsx";

const MAX_LISTED = 40;

const BADGE: Record<RuleExecution["state"], string> = { enforced: "Enforced", advisory: "Advisory", off: "Off", unsupported: "Not checked" };

/**
 * Projects whose scan did not run this rule, with why. Scans from before rules reported how they ran
 * never ran ast-grep rules, so for those only the built-in checks are known to have run.
 */
export function notRunIn(reports: readonly ScanReport[], rule: RuleSpec): string[] {
  return reports.flatMap((report) => {
    // Snapshots are read as JSON without validation, so an older map has no `checks` at all.
    const checks = report.checks ?? [];
    const run = checks.find((c) => c.rule === rule.id);
    if (run) return run.state === "ran" ? [] : [`${report.project}: ${run.reason ?? run.state}`];
    if (checks.length === 0 && rule.check.engine === "youi") return [];
    return [`${report.project}: this scan did not run it`];
  });
}

function Violations({ rule }: { rule: CatalogRule }) {
  const usage = useUsageState();
  const violations = useMemo(() => (usage.status === "ready" ? (usage.value.violationsByRule.get(rule.id) ?? []) : []), [usage, rule.id]);
  const execution = executionOf(rule);
  if (execution.state !== "enforced") return <p className="text-body text-muted">Not checked, so no project is measured against it.</p>;
  if (usage.status !== "ready") return <ResourceState state={usage} onRetry={retryUsage} what="the usage map" />;
  const notRun = notRunIn(usage.value.reports, rule);
  const gaps = notRun.length > 0 && (
    <ul className="space-y-1 text-small text-ink-2">
      {notRun.map((line) => (
        <li key={line}>Not checked in {line}</li>
      ))}
    </ul>
  );
  if (violations.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-body text-muted">{notRun.length === usage.value.reports.length ? "No scanned project ran this rule yet." : "No project that ran this rule breaks it."}</p>
        {gaps}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <ul className="divide-y divide-line">
        {violations.slice(0, MAX_LISTED).map((v) => (
          <li key={`${v.project}:${v.file}:${v.line}:${v.column}`} className="space-y-1 px-3 py-2">
            <div className="flex items-center gap-2 font-mono text-mono-sm">
              <span className="text-muted">{v.project}</span>
              <span className="truncate text-ink-2">
                {v.file}
                <span className="text-muted">:{v.line}</span>
              </span>
            </div>
            <p className="text-small text-ink-2">{v.message}</p>
            <code className="block truncate font-mono text-mono-sm text-muted">{v.text}</code>
          </li>
        ))}
      </ul>
      {violations.length > MAX_LISTED && <p className="border-t border-line bg-sunken px-3 py-2 text-small text-muted">and {violations.length - MAX_LISTED} more</p>}
      {gaps && <div className="border-t border-line px-3 py-2">{gaps}</div>}
    </div>
  );
}

export function RuleDetail({ model, rule }: { model: Model; rule: CatalogRule }) {
  const components = model.ruleComponents.get(rule.id) ?? [];
  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <header className="border-b border-line px-6 pt-5 pb-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-2">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 data-detail-heading tabIndex={-1} className="text-title outline-none">
                {rule.title}
              </h2>
              <SeverityBadge severity={rule.severity} />
              <Badge tone="outline">{BADGE[executionOf(rule).state]}</Badge>
            </div>
            <div className="flex min-w-0 items-center gap-0.5 font-mono text-mono-sm text-muted">
              <span className="truncate">{rule.id}</span>
              <CopyButton value={rule.id} label="Copy rule id" />
            </div>
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-reading text-ink">{rule.statement}</p>
        <div className="mt-3">
          <EditRuleButton ruleId={rule.id} />
        </div>
      </header>
      <div className="space-y-8 p-6">
        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="Why">
            <p className="text-body text-ink-2">{rule.rationale || "No rationale recorded."}</p>
          </Section>
          <Section title="Enforcement">
            <Facts
              rows={[
                ["Check", checkLabel(rule)],
                ["Files", <code className="font-mono text-mono-sm">{rule.files.join(", ")}</code>],
                [
                  "Declared by",
                  components.length ? (
                    <span className="flex flex-wrap gap-x-2">
                      {components.map((id) => (
                        <Link key={id} href={elementHref(id, "rules")} className="text-accent hover:underline">
                          {model.byId.get(id)?.name ?? id}
                        </Link>
                      ))}
                    </span>
                  ) : (
                    "No component yet"
                  ),
                ],
              ]}
            />
          </Section>
        </div>
        <Section title="For agents">
          <blockquote className="rounded-md border-l-2 border-line-strong bg-sunken px-3 py-2 text-body text-ink-2">{rule.agent}</blockquote>
        </Section>
        {(rule.examples.bad.length > 0 || rule.examples.good.length > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            <Section title="Breaks the rule">
              <CodeBlock code={rule.examples.bad.join("\n")} maxHeight="sm" />
            </Section>
            <Section title="Follows the rule">
              <CodeBlock code={rule.examples.good.join("\n")} maxHeight="sm" />
            </Section>
          </div>
        )}
        <Section title="In projects">
          <Violations rule={rule} />
        </Section>
      </div>
    </article>
  );
}
