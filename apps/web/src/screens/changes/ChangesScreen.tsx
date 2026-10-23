/**
 * Changes: the review queue for every change to the design system, by status: draft,
 * waiting for approval, approved, sent for review, rolled out. Rule drafts, style drafts
 * (token values and component states), library drafts (Discover's Save to Library and
 * adoption requests) and ingest drafts (everything one link holds, to keep or drop). A rule draft opens on its rule's page; the others open here, at /changes/<id>.
 */
import { ArrowRight, GitPullRequestArrow, Link2, Paintbrush, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { type DraftView, workflowApi, useRemote, type WorkflowRequestError } from "../../data/workflow.ts";
import { Badge } from "../../ui/Badge.tsx";
import { CONTROL } from "../../ui/Field.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, PaneSkeleton } from "../../ui/Pane.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { DraftEditor, DraftStatusBadge, STAGE, stageOf, type Stage } from "./DraftEditor.tsx";
import { plural } from "../../lib/plural.ts";
import { ServiceDown, ServiceDownPanel } from "./ServiceDown.tsx";
import { describeIngestDraft, ingestSummary } from "./IngestDraftReview.tsx";
import { describeLibraryDraft } from "./LibraryDraftReview.tsx";
import { describeStyleDraft } from "./StyleDraftReview.tsx";

type Queued = Exclude<Stage, "discarded">;

const STAGES: readonly Queued[] = ["draft", "waiting", "approved", "review", "rolled-out"];

export function ChangesScreen() {
  const params = useParams<{ "*"?: string }>();
  const id = /^d-[0-9a-f]{10}$/.exec(params["*"] ?? "")?.[0] ?? null;
  const { state, reload } = useRemote(() => workflowApi.drafts(), "changes");
  if (id) return <DraftPage id={id} onChanged={reload} />;
  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") return <QueueOffline error={state.error} onRetry={reload} />;
  return <Queue drafts={state.value.drafts} />;
}

function QueueHeader({ count }: { count?: number }) {
  return (
    <PaneHeader title="Changes" {...(count === undefined ? {} : { count })}>
      <Button size="sm" asChild>
        <Link href="/style">
          <Paintbrush /> Style
        </Link>
      </Button>
      <Button size="sm" asChild>
        <Link href="/rules">
          <ShieldCheck /> Rules
        </Link>
      </Button>
    </PaneHeader>
  );
}

/** The queue without its service: the frame, what to run, and the path a change takes. No counts, since none are known. */
function QueueOffline({ error, onRetry }: { error: WorkflowRequestError; onRetry: () => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <QueueHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-8 p-6 max-sm:p-4">
          <ServiceDownPanel error={error} onRetry={onRetry} />
          <section aria-labelledby="change-path" className="space-y-3">
            <h2 id="change-path" className="text-heading">
              How a change moves
            </h2>
            <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
              {STAGES.map((stage, i) => (
                <li key={stage} className="flex items-center gap-1.5">
                  {i > 0 && <ArrowRight aria-hidden className="size-3.5 text-faint" />}
                  <Badge tone={STAGE[stage].tone}>{STAGE[stage].label}</Badge>
                </li>
              ))}
            </ol>
            <p className="max-w-2xl text-body text-muted">Start one from Rules (edit a rule, or a new rule) or from Style (tokens and component states). Style edits and previews work now; saving a draft needs the editor.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

export const draftHref = (draft: DraftView): string => (draft.kind === "rule" ? `/rules/draft/${draft.id}` : `/changes/${draft.id}`);

function summary(draft: DraftView): string {
  if (draft.kind === "rule") return `${draft.mode === "edit" ? "Edit" : "New rule"} · revision ${draft.revision}${draft.preview ? ` · flags ${draft.preview.flagged}` : ""}`;
  if (draft.kind === "ingest") return `${ingestSummary(draft)} · revision ${draft.revision}${draft.preview ? ` · writes ${plural(draft.preview.files.length, "item")}` : ""}`;
  if (draft.kind === "library") return `${draft.content.request === "adopt" ? "Adoption request" : "Library reference"} · revision ${draft.revision}${draft.content.swapsWith.length ? ` · swaps with ${draft.content.swapsWith.join(", ")}` : ""}`;
  const p = draft.preview;
  return `${plural(draft.content.tokens.length, "token")}, ${plural(draft.content.states.length, "state binding")} · revision ${draft.revision}${p ? ` · ${plural(p.totals.sites, "site")} on ${plural(p.totals.routes, "screen")}` : ""}`;
}

/**
 * Ingest a link: the service reads a GitHub repository, a Storybook, a Figma file or a DESIGN.md
 * into Library items and files them as one draft, which opens for a person to keep or drop each.
 */
export function IngestLink() {
  const [, navigate] = useLocation();
  const [link, setLink] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setState({ busy: true, error: null });
    workflowApi.ingest(link.trim()).then(
      (draft) => navigate(`/changes/${draft.id}`),
      (error: unknown) => setState({ busy: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-1.5" aria-label="Ingest a link into the Library">
      <div className="flex gap-2 max-sm:flex-col">
        <input
          type="text"
          spellCheck={false}
          aria-label="Link to ingest"
          placeholder="github:owner/repo, a Storybook, a Figma file or a DESIGN.md URL"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          className={`${CONTROL} h-8 min-w-0 flex-1`}
        />
        <Button type="submit" disabled={state.busy || link.trim().length === 0}>
          <Link2 /> {state.busy ? "Reading…" : "Ingest"}
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-small text-danger">
          {state.error}
        </p>
      ) : (
        <p className="text-small text-muted">Reads what the link holds into Library items, as one draft: you keep or drop each, then approve. Nothing is installed.</p>
      )}
    </form>
  );
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <QueueHeader count={queued.length} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6 animate-enter max-sm:p-4">
          <IngestLink />
          <Segmented label="Status" value={filter} options={options} onChange={setFilter} className="max-w-full overflow-x-auto" />
          {shown.length === 0 ? (
            <EmptyState icon={GitPullRequestArrow} title={queued.length === 0 ? "No changes yet" : "Nothing in this status"}>
              Changes to the system appear here, from draft to rolled out. Start one from Rules (Edit a rule, or New rule), from Style (tokens and component states), or by ingesting a link into the Library above.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
              {shown.map(({ draft }) => (
                <li key={draft.id}>
                  <Link href={draftHref(draft)} className="flex items-center gap-3 px-4 py-3 hover:bg-raised">
                    <Badge tone="outline">{draft.kind === "rule" ? "Rule" : draft.kind === "style" ? "Style" : draft.kind === "ingest" ? "Ingest" : "Library"}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body text-ink">{draft.kind === "rule" ? draft.content.rule.title || "Untitled rule" : draft.kind === "style" ? describeStyleDraft(draft) : draft.kind === "ingest" ? describeIngestDraft(draft) : describeLibraryDraft(draft)}</p>
                      <p className="truncate text-small text-muted">
                        {summary(draft)}
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

/** A style or library draft's review page (rule drafts redirect to their rule). */
function DraftPage({ id, onChanged }: { id: string; onChanged: () => void }) {
  const load = useCallback(async () => {
    const [draft, info] = await Promise.all([workflowApi.draft(id), workflowApi.info()]);
    return { draft, info };
  }, [id]);
  const { state, reload, set } = useRemote(load, id);
  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") return <ServiceDown error={state.error} onRetry={reload} />;
  const { draft, info } = state.value;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-6 text-small text-muted max-sm:px-4">
        <Link href="/changes" className="hover:text-ink">
          Changes
        </Link>
        <span>/</span>
        <span className="truncate text-ink-2">{draft.kind === "style" ? describeStyleDraft(draft) : draft.kind === "library" ? describeLibraryDraft(draft) : draft.kind === "ingest" ? describeIngestDraft(draft) : draft.content.rule.title}</span>
        {draft.kind === "rule" && (
          <Link href={`/rules/draft/${draft.id}`} className="ml-auto hover:text-ink">
            Open on its rule
          </Link>
        )}
      </nav>
      <DraftEditor
        draft={draft}
        info={info}
        onUpdate={(next) => {
          set({ draft: next, info });
          onChanged();
        }}
      />
    </div>
  );
}
