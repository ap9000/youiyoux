/** Issue counts for a screen: one badge on a card, the full breakdown on the screen page. */
import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import type { IssueCounts } from "../../data/screens.ts";
import { plural } from "../../lib/plural.ts";
import { Badge } from "../../ui/Badge.tsx";

export function issueBreakdown(issues: IssueCounts): string[] {
  const otherNotRun = issues.notChecked - issues.behaviourNotChecked;
  return [
    issues.errors > 0 && plural(issues.errors, "error"),
    issues.warnings > 0 && plural(issues.warnings, "warning"),
    issues.lookalikes > 0 && plural(issues.lookalikes, "lookalike"),
    issues.unresolved > 0 && plural(issues.unresolved, "unresolved site"),
    issues.behaviourNotChecked > 0 && `${plural(issues.behaviourNotChecked, "behaviour rule")} not checked`,
    otherNotRun > 0 && `${plural(otherNotRun, "rule")} not run`,
  ].filter((part): part is string => Boolean(part));
}

/** What a screen with no issues but unrun rules says: unknown, so neither green nor a warning. */
export function notCheckedLabel(issues: IssueCounts): string | null {
  if (issues.notChecked === 0) return null;
  return issues.behaviourNotChecked === issues.notChecked ? "Behaviour not checked" : "Not fully checked";
}

/** Errors make it red, anything else amber; a rule that did not run keeps it from reading clean; nothing at all says so. */
export function IssueBadge({ issues }: { issues: IssueCounts }) {
  const notChecked = notCheckedLabel(issues);
  if (issues.total === 0 && notChecked) {
    return (
      <Badge tone="neutral" title={issueBreakdown(issues).join(" · ")}>
        <CircleDashed /> {notChecked}
      </Badge>
    );
  }
  if (issues.total === 0) {
    return (
      <Badge tone="success">
        <CheckCircle2 /> No issues
      </Badge>
    );
  }
  return (
    <Badge tone={issues.errors > 0 ? "danger" : "warning"} title={issueBreakdown(issues).join(" · ")} className="tabular">
      <AlertTriangle /> {plural(issues.total, "issue")}
    </Badge>
  );
}
