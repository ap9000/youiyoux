/**
 * Changes: the review queue for every change to the design system, by status: draft,
 * waiting for approval, approved, sent for review, rolled out. Rule drafts today;
 * component and token changes, adoptions and replacements join it later. Opening a
 * change returns to the editor it was made in.
 */
import { GitPullRequestArrow, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { type DraftView, workflowApi, useRemote } from "../../data/workflow.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, PaneSkeleton } from "../../ui/Pane.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { DraftStatusBadge, STAGE, stageOf, type Stage } from "./DraftEditor.tsx";
import { ServiceDown } from "./ServiceDown.tsx";

type Queued = Exclude<Stage, "discarded">;

const STAGES: readonly Queued[] = ["draft", "waiting", "approved", "review", "rolled-out"];

export function ChangesScreen() {
  const { state, reload } = useRemote(() => workflowApi.drafts(), "changes");
  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") return <ServiceDown error={state.error} onRetry={reload} />;
  return <Queue drafts={state.value.drafts} />;
}

function Queue({ drafts }: { drafts: readonly DraftView[] }) {
  const [filter, setFilter] = useState<Queued | "all">("all");
  const queued = useMemo(() => drafts.flatMap((draft) => {
    const stage = stageOf(draft);
    return stage === "discarded" ? [] : [{ draft, stage }];
  }), [drafts]);
  const shown = filter === "all" ? queued : queued.filter((q) => q.stage === filter);
  const options = [{ value: "all" as const, label: "All", count: queued.length }, ...STAGES.map((value) => ({ value, label: STAGE[value].label, count: queued.filter((q) => q.stage === value).length }))];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader title="Changes" count={queued.length}>
        <Button size="sm" asChild>
          <Link href="/rules">
            <ShieldCheck /> Rules
          </Link>
        </Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6 animate-enter">
          <Segmented label="Status" value={filter} options={options} onChange={setFilter} className="max-w-full overflow-x-auto" />
          {shown.length === 0 ? (
            <EmptyState icon={GitPullRequestArrow} title={queued.length === 0 ? "No changes yet" : "Nothing in this status"}>
              Changes to the system appear here, from draft to rolled out. Start one from Rules: Edit a rule, or New rule.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
              {shown.map(({ draft }) => (
                <li key={draft.id}>
                  <Link href={`/rules/draft/${draft.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-raised">
                    <Badge tone="outline">Rule</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body text-ink">{draft.content.rule.title || "Untitled rule"}</p>
                      <p className="truncate text-small text-muted">
                        {draft.mode === "edit" ? "Edit" : "New rule"} · revision {draft.revision}
                        {draft.preview ? ` · flags ${draft.preview.flagged}` : ""}
                        {draft.handoff ? ` · ${draft.handoff.branch}` : ""}
                        {draft.needsRebase ? " · needs rebase" : ""} · {new Date(draft.updatedAt).toLocaleString()}
                      </p>
                    </div>
                    <DraftStatusBadge draft={draft} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
