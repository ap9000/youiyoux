/**
 * One draft: what it changes on the left (the rule form, or a style draft's edits), and on
 * the right the three deliberate steps that follow saving, the same for every kind of draft:
 * preview the impact, approve it, hand it to review as a branch.
 */
import { clsx } from "clsx";
import { CircleAlert, GitBranch, History as HistoryIcon, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { asRequestError, type DraftContent, type DraftView, type RuleDraftView, type WorkflowInfo, workflowApi, type WorkflowRequestError } from "../../data/workflow.ts";
import { Badge, type BadgeTone } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { Keys } from "../../ui/Kbd.tsx";
import { ContrastConfirm } from "./ContrastConfirm.tsx";
import { ImpactPreview } from "./ImpactPreview.tsx";
import { RuleForm } from "./RuleForm.tsx";
import { LibraryDraftReview } from "./LibraryDraftReview.tsx";
import { StyleDraftReview } from "./StyleDraftReview.tsx";

export type Busy = null | "save" | "preview" | "approve" | "handoff" | "rebase" | "discard";
export type Run = (kind: Exclude<Busy, null>, action: () => Promise<DraftView>) => Promise<void>;

/** Where a change stands: the statuses the Changes queue uses. */
export type Stage = "draft" | "waiting" | "approved" | "review" | "rolled-out" | "discarded";

export const STAGE: Record<Stage, { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  waiting: { label: "Waiting for approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  review: { label: "Sent for review", tone: "accent" },
  "rolled-out": { label: "Rolled out", tone: "success" },
  discarded: { label: "Discarded", tone: "outline" },
};

export function stageOf(draft: DraftView): Stage {
  switch (draft.status) {
    case "previewed":
      // A preview only counts while it still describes the draft, the design repo and the project.
      return draft.previewStale.length > 0 || draft.problems.length > 0 || draft.needsRebase ? "draft" : "waiting";
    case "handed-off":
      return "review";
    default:
      return draft.status;
  }
}

export function DraftStatusBadge({ draft }: { draft: DraftView }) {
  const stage = STAGE[stageOf(draft)];
  return <Badge tone={stage.tone}>{stage.label}</Badge>;
}

const same = (a: DraftContent, b: DraftContent): boolean => JSON.stringify(a) === JSON.stringify(b);

export const isOpen = (draft: DraftView): boolean => draft.status !== "handed-off" && draft.status !== "rolled-out" && draft.status !== "discarded";

/** Run one workflow call at a time, with its failure shown and the fresher draft it returns kept. */
export function useRun(onUpdate: (draft: DraftView) => void): { busy: Busy; failure: WorkflowRequestError | null; run: Run } {
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<WorkflowRequestError | null>(null);
  const run = useCallback(
    async (kind: Exclude<Busy, null>, action: () => Promise<DraftView>): Promise<void> => {
      setBusy(kind);
      setFailure(null);
      try {
        onUpdate(await action());
      } catch (error: unknown) {
        setFailure(asRequestError(error));
      } finally {
        setBusy(null);
      }
    },
    [onUpdate],
  );
  return { busy, failure, run };
}

export function DraftEditor({ draft, info, onUpdate }: { draft: DraftView; info: WorkflowInfo; onUpdate: (draft: DraftView) => void }) {
  if (draft.kind === "library") return <LibraryDraftReview draft={draft} info={info} onUpdate={onUpdate} />;
  return draft.kind === "style" ? <StyleDraftReview draft={draft} info={info} onUpdate={onUpdate} /> : <RuleDraftEditor draft={draft} info={info} onUpdate={onUpdate} />;
}

function RuleDraftEditor({ draft, info, onUpdate }: { draft: RuleDraftView; info: WorkflowInfo; onUpdate: (draft: DraftView) => void }) {
  const [content, setContent] = useState(draft.content);
  const { busy, failure, run } = useRun(onUpdate);
  // A new revision from the service (a save here or elsewhere) replaces the form.
  const { id, revision } = draft;
  useEffect(() => setContent(draft.content), [id, revision]);
  const dirty = !same(content, draft.content);
  const open = isOpen(draft);

  const save = useCallback(() => run("save", () => workflowApi.save(id, revision, content)), [run, id, revision, content]);
  // Save first when needed, and record that save even if the preview then fails, so the next save sends the right revision.
  const preview = (): Promise<void> =>
    run("preview", async () => {
      if (dirty) onUpdate(await workflowApi.save(id, revision, content));
      return workflowApi.preview(id);
    });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (dirty && open && !busy) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, open, busy, save]);

  const previewStale = dirty ? ["You have unsaved changes; running the preview saves them first."] : draft.previewStale;
  const rule = draft.content.rule;

  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <DraftHeader draft={draft} title={rule.title || "New rule"} kind={draft.mode === "edit" ? "Edit" : "New rule"} detail={`${draft.ruleId || "new rule"} · revision ${revision} · from ${draft.base.branch}@${draft.base.commit.slice(0, 7)}`} busy={busy} run={run} />
      <DraftBanners draft={draft} busy={busy} run={run} failure={failure} />

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="min-w-0 p-6 pb-0">
          <RuleForm value={content} onChange={setContent} info={info} mode={draft.mode} readOnly={!open || busy !== null} problems={dirty ? [] : draft.problems} />
          {open && (
            <div className="sticky bottom-0 -mx-6 mt-6 flex items-center gap-3 border-t border-line bg-surface px-6 py-3">
              <Button variant={dirty ? "primary" : "outline"} disabled={!dirty || busy !== null} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </Button>
              <span className="flex items-center gap-1.5 text-small text-muted">
                {dirty ? (
                  <>
                    Unsaved changes <Keys keys={["⌘", "S"]} />
                  </>
                ) : (
                  `Saved as revision ${revision}. Saving never publishes anything.`
                )}
              </span>
            </div>
          )}
        </div>

        <ReviewSteps
          draft={draft}
          info={info}
          busy={busy}
          run={run}
          dirty={dirty}
          previewStale={previewStale}
          onPreview={() => void preview()}
          intro={`Runs this draft and today's published rule over one fresh scan of ${info.project.id}.`}
          impact={draft.preview && <ImpactPreview preview={draft.preview} project={info.project.id} stale={previewStale.length > 0} />}
        />
      </div>
    </article>
  );
}

/** The draft's title, status and kind, with Discard while it is open. */
export function DraftHeader({ draft, title, kind, detail, busy, run }: { draft: DraftView; title: string; kind: string; detail: string; busy: Busy; run: Run }) {
  return (
    <header className="border-b border-line px-6 pt-5 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 data-detail-heading tabIndex={-1} className="text-title outline-none">
          {title}
        </h2>
        <DraftStatusBadge draft={draft} />
        <Badge tone="outline">{kind}</Badge>
        {isOpen(draft) && (
          <Button variant="ghost" size="sm" className="ml-auto" disabled={busy !== null} onClick={() => void run("discard", () => workflowApi.discard(draft.id))}>
            <Trash2 /> Discard
          </Button>
        )}
      </div>
      <p className="mt-1 font-mono text-mono-sm text-muted">{detail}</p>
    </header>
  );
}

/** A base that moved (with Rebase) and the last call's failure. */
export function DraftBanners({ draft, busy, run, failure }: { draft: DraftView; busy: Busy; run: Run; failure: WorkflowRequestError | null }) {
  return (
    <>
      {draft.baseStale.length > 0 && isOpen(draft) && (
        <Banner
          tone="warning"
          action={
            draft.needsRebase ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void run("rebase", () => workflowApi.rebase(draft.id))}>
                Rebase
              </Button>
            ) : null
          }
        >
          {draft.baseStale.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </Banner>
      )}
      {failure && (
        <Banner tone="danger">
          <p className="font-medium">{failure.message}</p>
          {failure.problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </Banner>
      )}
    </>
  );
}

interface ReviewStepsProps {
  draft: DraftView;
  info: WorkflowInfo;
  busy: Busy;
  run: Run;
  /** Unsaved edits in the form: the preview saves them first; approving waits for a save. */
  dirty: boolean;
  previewStale: readonly string[];
  onPreview: () => void;
  intro: string;
  impact: ReactNode;
}

/** Impact preview, approval, review branch and history: the same three steps for every kind of draft. */
export function ReviewSteps({ draft, info, busy, run, dirty, previewStale, onPreview, intro, impact }: ReviewStepsProps) {
  const open = isOpen(draft);
  const { id, revision } = draft;
  const [confirming, setConfirming] = useState(false);
  // A style draft's new WCAG AA failures need one confirmation naming them; ones it did not introduce are only noted.
  const contrast = draft.kind === "style" && draft.preview ? draft.preview.contrast : [];
  const failing = contrast.filter((c) => c.change === "new");
  const kept = new Set(contrast.filter((c) => c.change === "kept").map((c) => c.key)).size;
  const approve = (acknowledge?: readonly string[]): void => void run("approve", () => workflowApi.approve(id, revision, draft.preview!.id, acknowledge));
  return (
    <aside className="min-w-0 space-y-8 border-line p-6 lg:border-l">
      <Step n={1} title="Impact preview" done={draft.preview !== null && previewStale.length === 0}>
        <p className="text-small text-muted">{intro}</p>
        {draft.problems.length > 0 && !dirty && (
          <ul className="space-y-1 text-small text-danger">
            {draft.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {draft.preview && previewStale.length > 0 && <StaleNote reasons={previewStale} />}
        {open && (
          <Button variant={draft.preview && previewStale.length === 0 ? "outline" : "primary"} disabled={busy !== null || (!dirty && draft.problems.length > 0)} onClick={onPreview}>
            <RotateCw className={clsx(busy === "preview" && "animate-spin")} /> {busy === "preview" ? "Scanning…" : draft.preview ? "Run again" : "Run preview"}
          </Button>
        )}
        {impact}
      </Step>

      <Step n={2} title="Approve" done={draft.approval !== null}>
        {draft.approval ? (
          <p className="flex items-center gap-2 text-body text-ink-2">
            <ShieldCheck className="size-4 shrink-0 text-success" /> Approved by {draft.approval.by.name}, {new Date(draft.approval.at).toLocaleString()}, revision {draft.approval.draftRevision}.
          </p>
        ) : (
          <p className="text-small text-muted">
            You approve exactly revision {revision} and the preview above. Saving again, a new commit on {draft.base.branch}, or a change in {info.project.id} withdraws the approval.
          </p>
        )}
        {open && !draft.approval && failing.length > 0 && (
          <p className="flex items-start gap-2 text-small text-ink-2">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            This draft puts {failing.length} colour pair(s) below WCAG AA. Approving asks you to confirm them by name.
          </p>
        )}
        {open && !draft.approval && kept > 0 && (
          <p className="text-small text-muted">
            {kept} pair(s) this draft touches were already below WCAG AA before it; they are listed in the preview and need no confirmation.
          </p>
        )}
        {draft.approval?.contrastAcknowledged && draft.approval.contrastAcknowledged.length > 0 && (
          <p className="text-small text-muted">Confirmed {draft.approval.contrastAcknowledged.length} colour pair(s) this draft puts below WCAG AA.</p>
        )}
        {open && !draft.approval && (
          <Button variant="primary" disabled={!draft.canApprove || dirty || busy !== null} onClick={() => (failing.length > 0 ? setConfirming(true) : approve())}>
            <ShieldCheck /> Approve revision {revision}
          </Button>
        )}
        {confirming && (
          <ContrastConfirm
            failing={failing}
            revision={revision}
            onClose={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              approve(failing.map((c) => c.key));
            }}
          />
        )}
      </Step>

      <Step n={3} title="Send for review" done={draft.handoff !== null}>
        {draft.handoff ? (
          <Handoff draft={draft} />
        ) : (
          <>
            <p className="text-small text-muted">Creates a branch in the design repository holding only this change. Nothing is pushed or merged, and {draft.base.branch} is never touched.</p>
            {open && (
              <Button variant="primary" disabled={!draft.canHandoff || dirty || busy !== null} onClick={() => void run("handoff", () => workflowApi.handoff(id))}>
                <GitBranch /> Create review branch
              </Button>
            )}
          </>
        )}
      </Step>

      <History draft={draft} />
    </aside>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <header className="flex items-center gap-2">
        <span className={clsx("grid size-5 place-items-center rounded-full text-caption tabular", done ? "bg-success-soft text-success" : "bg-raised text-muted")}>{n}</span>
        <h3 className="text-heading">{title}</h3>
      </header>
      {children}
    </section>
  );
}

function Banner({ tone, action, children }: { tone: "warning" | "danger"; action?: ReactNode; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={clsx("flex items-start gap-3 border-b border-line px-6 py-3 text-small text-ink-2", tone === "danger" ? "bg-danger-soft" : "bg-warning-soft")}>
      <CircleAlert className={clsx("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-danger" : "text-warning")} />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
      {action}
    </div>
  );
}

function StaleNote({ reasons }: { reasons: readonly string[] }) {
  return (
    <div className="rounded-md bg-warning-soft px-3 py-2 text-small text-ink-2">
      <p className="font-medium">This preview is out of date. Run it again before approving.</p>
      {reasons.map((r) => (
        <p key={r}>{r}</p>
      ))}
    </div>
  );
}

function Handoff({ draft }: { draft: DraftView }) {
  const handoff = draft.handoff!;
  return (
    <div className="space-y-3">
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-mono-sm text-ink">
        <GitBranch className="size-3.5 shrink-0 text-muted" />
        <span className="truncate">{handoff.branch}</span>
        <CopyButton value={handoff.branch} label="Copy branch name" />
        <span className="text-muted">{handoff.commit.slice(0, 7)}</span>
      </div>
      <p className="text-small text-muted">Take it to review from the design repository:</p>
      <div className="space-y-1.5">
        {handoff.next.map((command) => (
          <div key={command} className="flex min-w-0 items-center gap-1 rounded-md bg-sunken px-2 py-1">
            <code className="min-w-0 flex-1 truncate font-mono text-mono-sm text-ink-2">{command}</code>
            <CopyButton value={command} label="Copy command" />
          </div>
        ))}
      </div>
      {draft.kind === "rule" ? (
        <>
          <p className="text-small text-muted">
            Once merged into the design checkout agents use, they get it on their next lookup: <code className="font-mono text-mono-sm">system_get_rules</code> and <code className="font-mono text-mono-sm">youi check</code> read that checkout, and{" "}
            <code className="font-mono text-mono-sm">youi sync</code> refreshes the project's AGENTS.md block. Agents will read:
          </p>
          <blockquote className="rounded-md border-l-2 border-line-strong bg-sunken px-3 py-2 text-body text-ink-2">{draft.content.rule.agent}</blockquote>
        </>
      ) : draft.kind === "library" ? (
        <p className="text-small text-muted">Once merged, the item is in the Library{draft.content.request === "adopt" ? " as a candidate, for a person to adopt into the System" : " as a reference: not in the System, and not built with"}. Nothing was installed in any project.</p>
      ) : (
        <p className="text-small text-muted">
          Once merged, <code className="font-mono text-mono-sm">youi sync</code> in each project writes the new values into its tokens (CSS variables, Tailwind theme, TS and React Native), and the hub shows them after the next snapshot.
        </p>
      )}
      <CodeBlock code={handoff.diff} title={`${handoff.files.length} file(s) changed`} maxHeight="sm" />
    </div>
  );
}

function History({ draft }: { draft: DraftView }) {
  return (
    <section className="space-y-2.5">
      <header className="flex items-center gap-2">
        <HistoryIcon className="size-3.5 text-muted" />
        <h3 className="text-heading">History</h3>
      </header>
      <ol className="space-y-1.5">
        {[...draft.events].reverse().map((event, i) => (
          <li key={`${event.at}:${i}`} className="text-small">
            <span className="tabular text-muted">{new Date(event.at).toLocaleString()}</span> <span className="font-medium text-ink-2">{event.type.replace("-", " ")}</span>
            {event.note && <span className="text-muted"> · {event.note}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
