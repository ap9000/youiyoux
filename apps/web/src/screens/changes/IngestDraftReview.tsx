/**
 * An ingest draft in the changes queue: everything one link held (`youiyoux library ingest`), read
 * by the service. A person keeps or drops each item (the only thing a save changes), then the
 * same three steps as every draft; approving writes the kept items to the Library as references.
 * What the reader could not read, and what it says about the source, are shown beside them.
 */
import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { type DraftView, type IngestDraftView, type WorkflowInfo, workflowApi } from "../../data/workflow.ts";
import { plural } from "../../lib/plural.ts";
import { when } from "../../lib/when.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Disclosure } from "../../ui/Disclosure.tsx";
import { CONTROL } from "../../ui/Field.tsx";
import { Section } from "../../ui/Section.tsx";
import { DraftBanners, DraftHeader, isOpen, ReviewSteps, useRun } from "./DraftEditor.tsx";

const KINDS = [
  { kind: "component", label: "Components" },
  { kind: "pattern", label: "Patterns" },
  { kind: "token", label: "Tokens" },
] as const;
const SKIPPED_SHOWN = 50;

/** Only an https link is followed: anything else a source served (a `javascript:` URL) is shown as text, never a link. */
const httpsOnly = (url: string | null | undefined): string | null => (url && /^https:\/\//i.test(url) ? url : null);
const mono = "font-mono text-mono-sm";

export function describeIngestDraft(draft: IngestDraftView): string {
  return `Ingest ${draft.content.reading.source.name}`;
}

export function ingestSummary(draft: IngestDraftView): string {
  const all = draft.content.reading.entries.length;
  const kept = draft.content.keep.length;
  return `${kept === all ? plural(all, "item") : `${kept} of ${plural(all, "item")}`} kept`;
}

export function IngestDraftReview({ draft, info, onUpdate }: { draft: IngestDraftView; info: WorkflowInfo; onUpdate: (draft: DraftView) => void }) {
  const { busy, failure, run } = useRun(onUpdate);
  const { reading } = draft.content;
  const [keep, setKeep] = useState<ReadonlySet<string>>(() => new Set(draft.content.keep));
  const [filter, setFilter] = useState("");
  const open = isOpen(draft) && busy === null;
  const saved = new Set(draft.content.keep);
  const dirty = keep.size !== saved.size || [...keep].some((id) => !saved.has(id));
  const words = filter.trim().toLowerCase();
  const shown = useMemo(() => (words ? reading.entries.filter((e) => `${e.name} ${e.title ?? ""} ${e.categories.join(" ")}`.toLowerCase().includes(words)) : reading.entries), [reading.entries, words]);
  const licence = reading.license === "unknown" ? null : reading.license;
  const evidence = httpsOnly(licence?.evidenceUrl);
  const set = (ids: readonly string[], on: boolean): void => setKeep((current) => {
    const next = new Set(current);
    for (const id of ids) (on ? next.add(id) : next.delete(id));
    return next;
  });
  const preview = draft.preview;
  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <DraftHeader draft={draft} title={describeIngestDraft(draft)} kind="Ingest" detail={`${draft.id} · revision ${draft.revision} · from ${draft.base.branch}@${draft.base.commit.slice(0, 7)}`} busy={busy} run={run} />
      <DraftBanners draft={draft} busy={busy} run={run} failure={failure} />
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
        <div className="min-w-0 space-y-6 p-6 max-sm:p-4">
          <Section title="From the link">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-small">
              <dt className="text-muted">Source</dt>
              <dd className="min-w-0 text-ink">
                {reading.source.name} <span className="text-muted">· {reading.source.kind}</span>
              </dd>
              <dt className="text-muted">Link</dt>
              <dd className={`${mono} min-w-0 truncate text-ink-2`}>{reading.link}</dd>
              <dt className="text-muted">Licence</dt>
              <dd>
                {licence && !evidence ? (
                  <span className="text-ink">{licence.spdx}</span>
                ) : licence ? (
                  <a href={evidence!} target="_blank" rel="noreferrer noopener" className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                    {licence.spdx}
                  </a>
                ) : (
                  <Badge tone="warning">licence unknown</Badge>
                )}
              </dd>
              <dt className="text-muted">Read</dt>
              <dd className="text-ink-2">{when(reading.fetchedAt)}</dd>
            </dl>
            {reading.notes.length > 0 && (
              <ul className="mt-3 space-y-1 text-small text-muted">
                {reading.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Items">
            <div className="flex flex-wrap items-center gap-2">
              <p className="tabular text-small text-ink-2">
                {keep.size} of {plural(reading.entries.length, "item")} kept
              </p>
              <input type="search" aria-label="Filter items" placeholder="Filter by name or role" value={filter} onChange={(e) => setFilter(e.target.value)} className={`${CONTROL} h-7 w-56 max-sm:w-full`} />
              <span className="ml-auto flex gap-1.5 max-sm:ml-0">
                <Button size="sm" variant="ghost" disabled={!open} onClick={() => set(shown.map((e) => e.id), true)}>
                  Keep {words ? "these" : "all"}
                </Button>
                <Button size="sm" variant="ghost" disabled={!open} onClick={() => set(shown.map((e) => e.id), false)}>
                  Drop {words ? "these" : "all"}
                </Button>
              </span>
            </div>
            {KINDS.map(({ kind, label }) => {
              const items = shown.filter((e) => e.kind === kind);
              if (items.length === 0) return null;
              return (
                <div key={kind} className="mt-4 space-y-1.5">
                  <h4 className="text-small font-medium text-ink-2">
                    {label} <span className="tabular text-muted">{items.length}</span>
                  </h4>
                  <ul className="divide-y divide-line rounded-md border border-line" aria-label={label}>
                    {items.map((entry) => (
                      <li key={entry.id} className="flex items-start gap-3 px-3 py-2" data-kept={keep.has(entry.id) ? "true" : "false"}>
                        <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-accent" aria-label={`Keep ${entry.title ?? entry.name}`} checked={keep.has(entry.id)} disabled={!open} onChange={(e) => set([entry.id], e.target.checked)} />
                        <div className={`min-w-0 flex-1 space-y-0.5 ${keep.has(entry.id) ? "" : "opacity-60"}`}>
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-body text-ink">{entry.title ?? entry.name}</span>
                            {entry.categories.length > 0 && <span className="text-small text-muted">{entry.categories.join(", ")}</span>}
                            {httpsOnly(entry.source.url) && (
                              <a href={httpsOnly(entry.source.url)!} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-small text-muted hover:text-ink" aria-label={`Open ${entry.name} at its source`}>
                                <ExternalLink className="size-3" /> Source
                              </a>
                            )}
                          </div>
                          <p className="text-small text-ink-2">{entry.summary}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {shown.length === 0 && <p className="mt-3 text-small text-muted">No item matches “{filter}”.</p>}
            {dirty && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" disabled={!open} onClick={() => void run("save", () => workflowApi.saveKept(draft.id, draft.revision, [...keep]))}>
                  {busy === "save" ? "Saving…" : "Save which items are kept"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setKeep(new Set(draft.content.keep))}>
                  Undo
                </Button>
              </div>
            )}
          </Section>

          {reading.skipped.length > 0 && (
            <Disclosure summary={`Not read (${reading.skipped.length})`}>
              <ul className="space-y-1 text-small">
                {reading.skipped.slice(0, SKIPPED_SHOWN).map((s) => (
                  <li key={`${s.name}:${s.reason}`}>
                    <span className={`${mono} text-ink-2`}>{s.name}</span> <span className="text-muted">· {s.reason}</span>
                  </li>
                ))}
                {reading.skipped.length > SKIPPED_SHOWN && <li className="text-muted">… {reading.skipped.length - SKIPPED_SHOWN} more</li>}
              </ul>
            </Disclosure>
          )}
        </div>
        <ReviewSteps
          draft={draft}
          info={info}
          busy={busy}
          run={run}
          dirty={dirty}
          previewStale={draft.previewStale}
          onPreview={() => void run("preview", () => workflowApi.preview(draft.id))}
          intro="Checks each kept item is a valid youi.library/v1 entry and where it is written: a new Library file, or an edit of one already there."
          impact={
            preview && (
              <div className="space-y-2 text-small" data-testid="ingest-preview">
                <p className="text-ink-2">
                  Writes {plural(preview.files.length, "Library item")}
                  {preview.files.some((f) => f.exists) ? ` (${preview.files.filter((f) => f.exists).length} already there, edited)` : ""}
                  {preview.dropped > 0 ? `; ${preview.dropped} dropped` : ""}; licence {preview.license}.
                </p>
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
