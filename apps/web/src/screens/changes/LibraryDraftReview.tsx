/**
 * A library draft in the changes queue: a Discover candidate saved to the Library, or an adoption
 * request for one (Discover's Save to Library and Add to my project). It shows the item as it will
 * be written (source, licence, install command, swaps), then the same three steps as every draft.
 * Nothing here installs anything: the install command is shown to copy, after adoption.
 */
import { type DraftView, type LibraryDraftView, type WorkflowInfo, workflowApi } from "../../data/workflow.ts";
import { Badge } from "../../ui/Badge.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { Section } from "../../ui/Section.tsx";
import { DraftBanners, DraftHeader, ReviewSteps, useRun } from "./DraftEditor.tsx";
import { plural } from "../../lib/plural.ts";

const licenceOf = (draft: LibraryDraftView): string => (draft.content.entry.license && draft.content.entry.license !== "unknown" ? draft.content.entry.license.spdx : "unknown");

export function describeLibraryDraft(draft: LibraryDraftView): string {
  const name = draft.content.entry.source.ref ?? draft.content.entry.name;
  return draft.content.request === "adopt" ? `Adopt ${name}` : `Save ${name} to the Library`;
}

export function LibraryDraftReview({ draft, info, onUpdate }: { draft: LibraryDraftView; info: WorkflowInfo; onUpdate: (draft: DraftView) => void }) {
  const { busy, failure, run } = useRun(onUpdate);
  const { entry, request, reason, swapsWith } = draft.content;
  const licence = licenceOf(draft);
  const preview = draft.preview;
  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <DraftHeader draft={draft} title={describeLibraryDraft(draft)} kind={request === "adopt" ? "Adoption request" : "Library"} detail={`${draft.id} · revision ${draft.revision} · from ${draft.base.branch}@${draft.base.commit.slice(0, 7)}`} busy={busy} run={run} />
      <DraftBanners draft={draft} busy={busy} run={run} failure={failure} />
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
        <div className="min-w-0 space-y-6 p-6">
          <Section title="The item">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-small">
              <dt className="text-muted">Name</dt>
              <dd className="text-ink">{entry.title ?? entry.name}</dd>
              <dt className="text-muted">Source</dt>
              <dd className="font-mono text-mono-sm text-ink-2">{entry.source.ref ?? entry.source.name}</dd>
              <dt className="text-muted">Licence</dt>
              <dd>{licence === "unknown" ? <Badge tone="warning">licence unknown</Badge> : <span className="text-ink">{licence}</span>}</dd>
              <dt className="text-muted">Stage</dt>
              <dd className="font-mono text-mono-sm text-ink-2">{request === "adopt" ? "candidate (a person decides)" : "library (a reference)"}</dd>
              <dt className="text-muted">Swaps with</dt>
              <dd className="text-ink-2">{swapsWith.length ? swapsWith.join(", ") : "nothing named"}</dd>
              {reason && (
                <>
                  <dt className="text-muted">Why</dt>
                  <dd className="text-ink-2">{reason}</dd>
                </>
              )}
            </dl>
            {entry.install && (
              <div className="mt-3 space-y-1">
                <p className="text-small text-muted">Install, after adoption (copy only: the hub never runs it)</p>
                <div className="flex min-w-0 items-center gap-1 rounded-md bg-sunken px-2 py-1">
                  <code className="min-w-0 flex-1 truncate font-mono text-mono-sm text-ink-2">{entry.install.command}</code>
                  <CopyButton value={entry.install.command} label="Copy install command" />
                </div>
              </div>
            )}
          </Section>
        </div>
        <ReviewSteps
          draft={draft}
          info={info}
          busy={busy}
          run={run}
          dirty={false}
          previewStale={draft.previewStale}
          onPreview={() => void run("preview", () => workflowApi.preview(draft.id))}
          intro="Checks the item is a valid youi.library/v1 entry, where it is written, and what swapping it in for each named family touches."
          impact={
            preview && (
              <div className="space-y-2 text-small" data-testid="library-preview">
                <p className="text-ink-2">
                  Writes <code className="font-mono text-mono-sm">{preview.file}</code> ({preview.exists ? "an edit" : "a new file"}), stage {preview.stage}, licence {preview.license}.
                </p>
                {preview.swaps.length > 0 && (
                  <ul className="space-y-0.5">
                    {preview.swaps.map((swap) => (
                      <li key={swap.target} className="text-ink-2">
                        <span className="font-mono text-mono-sm">{swap.target}</span>{" "}
                        {swap.looks === null ? <span className="text-muted">· not counted</span> : <span className="text-muted">· {plural(swap.looks, "look")} in {plural(swap.files ?? 0, "file")} on {plural(swap.routes ?? 0, "route")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {preview.limits.map((limit) => (
                  <p key={limit} className="text-muted">
                    {limit}
                  </p>
                ))}
              </div>
            )
          }
        />
      </div>
    </article>
  );
}
