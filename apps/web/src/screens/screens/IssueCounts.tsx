/** Issue counts for a screen: one badge on a card, the full breakdown on the screen page. */
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { IssueCounts } from "../../data/screens.ts";
import { plural } from "../../lib/plural.ts";
import { Badge } from "../../ui/Badge.tsx";

export function issueBreakdown(issues: IssueCounts): string[] {
  return [
    issues.errors > 0 && plural(issues.errors, "error"),
    issues.warnings > 0 && plural(issues.warnings, "warning"),
    issues.lookalikes > 0 && plural(issues.lookalikes, "lookalike"),
    issues.unresolved > 0 && plural(issues.unresolved, "unresolved site"),
  ].filter((part): part is string => Boolean(part));
}

/** Errors make it red, anything else amber, nothing at all says so. */
export function IssueBadge({ issues }: { issues: IssueCounts }) {
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
