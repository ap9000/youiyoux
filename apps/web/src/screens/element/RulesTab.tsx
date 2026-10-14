/** Rules: what the component promises to obey, how each rule is checked, and where projects break it. */
import { executionLabel, ruleExecution, type RuleExecution } from "@youiyoux/core/rules";
import { Link } from "wouter";
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { useUsageState } from "../../data/store.ts";
import type { ComponentContract, RuleSpec } from "../../data/types.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { Section } from "../../ui/Section.tsx";

/**
 * How youiyoux check runs this rule: compiled by the snapshot when it says so. The browser cannot compile
 * an ast-grep body, so without that answer an ast-grep rule is shown as unverified, never as enforced.
 */
export function executionOf(rule: RuleSpec & { execution?: RuleExecution }): RuleExecution {
  if (rule.execution) return rule.execution;
  if (rule.severity !== "off" && rule.check.engine === "ast-grep") return { state: "unsupported", reason: "not verified: this snapshot predates compiled rule checks (run pnpm data)" };
  return ruleExecution(rule);
}

export function checkLabel(rule: RuleSpec): string {
  return executionLabel(executionOf(rule));
}

export function RulesTab({ model, contract }: { model: Model; contract: ComponentContract }) {
  const usage = useUsageState();
  return (
    <div className="p-6">
      <Section title="Rules this component follows" count={contract.rules.length}>
        <ul className="divide-y divide-line rounded-md border border-line">
          {contract.rules.map((id) => {
            const rule = model.rules.get(id);
            if (!rule) return null;
            const violations = usage.status === "ready" ? (usage.value.violationsByRule.get(id)?.length ?? 0) : null;
            return (
              <li key={id} className="space-y-1.5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={rule.severity} />
                  <Link href={elementHref(id)} className="font-medium text-ink hover:underline">
                    {rule.title}
                  </Link>
                  {violations !== null && violations > 0 && (
                    <Badge tone="outline" className="ml-auto tabular">
                      {violations} {violations === 1 ? "violation" : "violations"} in projects
                    </Badge>
                  )}
                  <Link href={`/rules/${id.slice(id.indexOf("/rule/") + 6)}`} className={`${violations ? "" : "ml-auto "}text-small text-accent hover:underline`}>
                    Edit rule
                  </Link>
                </div>
                <p className="text-body text-ink-2">{rule.statement}</p>
                <p className="text-small text-muted">{checkLabel(rule)}</p>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
