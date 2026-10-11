/**
 * Changes: rule drafts on their way from an idea to a review branch, and the published
 * rules they start from. Live state from the local rule-editor service (`youi editor`).
 */
import { clsx } from "clsx";
import { GitPullRequestArrow, PencilLine, Plus, PlugZap, RotateCw } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { asRequestError, type DraftView, type PublishedRule, type WorkflowInfo, workflowApi, type WorkflowRequestError, useRemote } from "../../data/workflow.ts";
import { SeverityBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, PaneSkeleton, SplitView } from "../../ui/Pane.tsx";
import { DraftEditor, DraftStatusBadge } from "./DraftEditor.tsx";

const START = "pnpm youi editor --project <project> --design <design repo> [--config <youi.project.json>]";

interface Overview {
  readonly info: WorkflowInfo;
  readonly drafts: readonly DraftView[];
  readonly rules: readonly PublishedRule[];
}

async function loadOverview(): Promise<Overview> {
  const [info, { drafts }, rules] = await Promise.all([workflowApi.info(), workflowApi.drafts(), workflowApi.rules()]);
  return { info, drafts, rules };
}

const OPEN: ReadonlySet<DraftView["status"]> = new Set(["draft", "previewed", "approved"]);

export function ChangesScreen() {
  const { state, reload } = useRemote(loadOverview, "overview");
  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") return <ServiceDown error={state.error} onRetry={reload} />;
  return <Changes overview={state.value} reload={reload} />;
}

function ServiceDown({ error, onRetry }: { error: WorkflowRequestError; onRetry: () => void }) {
  return (
    <EmptyState
      icon={PlugZap}
      title={error.offline ? "Start the rule editor" : "The rule editor had a problem"}
      actions={
        <Button onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      }
    >
      {error.offline ? (
        <>
          <p>Editing rules needs the local workflow service. From the YouIyouX checkout, run:</p>
          <p className="mt-2 flex items-center justify-center gap-1 rounded-md bg-sunken px-2 py-1">
            <code className="truncate font-mono text-mono-sm text-ink-2">{START}</code>
            <CopyButton value={START} label="Copy command" />
          </p>
        </>
      ) : (
        <p>{error.message}</p>
      )}
    </EmptyState>
  );
}

function Changes({ overview, reload }: { overview: Overview; reload: () => void }) {
  const params = useParams<{ "*"?: string }>();
  const selected = params["*"]?.split("/")[0] || null;
  const [, navigate] = useLocation();
  const [failure, setFailure] = useState<string | null>(null);
  const start = async (make: () => Promise<DraftView>): Promise<void> => {
    setFailure(null);
    try {
      const draft = await make();
      reload();
      navigate(`/changes/${draft.id}`);
    } catch (error: unknown) {
      setFailure(asRequestError(error).message);
    }
  };
  return (
    <SplitView
      listLabel="Changes"
      backHref="/changes"
      hasDetail={selected !== null}
      list={<ChangeList overview={overview} selected={selected} failure={failure} onNew={() => void start(workflowApi.create)} onEdit={(ruleId) => void start(() => workflowApi.edit(ruleId))} />}
      detail={selected ? <DraftPane key={selected} id={selected} info={overview.info} onChanged={reload} /> : <Intro info={overview.info} />}
    />
  );
}

function DraftPane({ id, info, onChanged }: { id: string; info: WorkflowInfo; onChanged: () => void }) {
  const load = useCallback(() => workflowApi.draft(id), [id]);
  const { state, reload, set } = useRemote(load, id);
  const onUpdate = useCallback(
    (draft: DraftView) => {
      set(draft);
      onChanged();
    },
    [set, onChanged],
  );
  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") return <ServiceDown error={state.error} onRetry={reload} />;
  return <DraftEditor draft={state.value} info={info} onUpdate={onUpdate} />;
}

interface ChangeListProps {
  overview: Overview;
  selected: string | null;
  failure: string | null;
  onNew: () => void;
  onEdit: (ruleId: string) => void;
}

function ChangeList({ overview, selected, failure, onNew, onEdit }: ChangeListProps) {
  const open = overview.drafts.filter((d) => OPEN.has(d.status));
  const review = overview.drafts.filter((d) => d.status === "handed-off");
  const editing = new Map(open.map((d) => [d.ruleId, d.id]));
  return (
    <>
      <PaneHeader title="Changes" count={open.length}>
        <Button variant="primary" size="sm" onClick={onNew}>
          <Plus /> New rule
        </Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failure && <p className="border-b border-line bg-danger-soft px-4 py-2 text-small text-ink-2">{failure}</p>}
        <p className="border-b border-line px-4 py-2.5 text-small text-muted">
          Live rules of <span className="font-medium text-ink-2">{overview.info.project.id}</span>, from {overview.info.design.branch}@{overview.info.design.head.slice(0, 7)}
        </p>
        <Group title="Drafts" empty="No drafts. Edit a published rule below, or start a new one.">
          {open.map((d) => (
            <DraftRow key={d.id} draft={d} active={d.id === selected} />
          ))}
        </Group>
        {review.length > 0 && (
          <Group title="Sent for review">
            {review.map((d) => (
              <DraftRow key={d.id} draft={d} active={d.id === selected} />
            ))}
          </Group>
        )}
        <Group title="Published rules">
          {overview.rules.map(({ rule }) => {
            const draftId = editing.get(rule.id);
            return (
              <li key={rule.id} className="flex items-center gap-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body text-ink">{rule.title}</p>
                  <p className="flex items-center gap-1.5 text-small text-muted">
                    <SeverityBadge severity={rule.severity} />
                    {rule.rollout && <span>→ error{rule.rollout.after ? ` after ${rule.rollout.after}` : " later"}</span>}
                    {rule.check.engine === "advisory" && <span>advisory</span>}
                  </p>
                </div>
                {draftId ? (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/changes/${draftId}`}>Open draft</Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onEdit(rule.id)} aria-label={`Edit ${rule.title}`}>
                    <PencilLine /> Edit
                  </Button>
                )}
              </li>
            );
          })}
        </Group>
      </div>
    </>
  );
}

function Group({ title, empty, children }: { title: string; empty?: string; children: ReactNode[] }) {
  return (
    <section className="border-b border-line py-2">
      <h2 className="px-4 py-1.5 text-caption font-medium text-muted">{title}</h2>
      {children.length === 0 && empty ? <p className="px-4 py-2 text-small text-muted">{empty}</p> : <ul>{children}</ul>}
    </section>
  );
}

function DraftRow({ draft, active }: { draft: DraftView; active: boolean }) {
  const outdated = draft.baseStale.length > 0 || draft.previewStale.length > 0;
  return (
    <li>
      <Link href={`/changes/${draft.id}`} aria-current={active ? "page" : undefined} className={clsx("block px-4 py-2 hover:bg-raised", active && "bg-raised")}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body text-ink">{draft.content.rule.title || "Untitled rule"}</span>
          <DraftStatusBadge status={draft.status} />
        </div>
        <p className="truncate text-small text-muted">
          {draft.mode === "edit" ? "Edit" : "New"} · revision {draft.revision}
          {draft.preview ? ` · flags ${draft.preview.flagged}` : ""}
          {outdated ? " · out of date" : ""}
        </p>
      </Link>
    </li>
  );
}

function Intro({ info }: { info: WorkflowInfo }) {
  return (
    <EmptyState icon={GitPullRequestArrow} title="Change a rule safely">
      <p>
        Edit a rule or start a new one. Saving never publishes. Preview what it would flag in {info.project.id}, approve that exact revision, then send it to review as a branch of the design repository.
      </p>
      <ul className="mt-3 space-y-1 text-left">
        {info.limits.map((limit) => (
          <li key={limit}>· {limit}</li>
        ))}
      </ul>
    </EmptyState>
  );
}
