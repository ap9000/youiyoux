/**
 * A style draft in the changes queue: its edits (token values per scheme and state bindings),
 * a way back to the style editor while it is open, and the same three steps as a rule draft.
 */
import { Paintbrush } from "lucide-react";
import { Link } from "wouter";
import { cssValue } from "@youiyoux/tokens/values";
import { useModelState } from "../../data/store.ts";
import { type DraftView, type StyleDraftView, type WorkflowInfo, workflowApi } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { Section } from "../../ui/Section.tsx";
import { DraftBanners, DraftHeader, isOpen, ReviewSteps, useRun } from "./DraftEditor.tsx";
import { StyleImpactPreview } from "./StyleImpactPreview.tsx";

/** A value as written: an alias as `{path}`, anything else as the CSS it becomes. */
function written(type: string | undefined, value: unknown): string {
  if (value === null) return "follows light";
  if (typeof value === "string" && /^\{[^{}]+\}$/.test(value)) return value;
  if (type === "spring") {
    const { stiffness, damping, mass, velocity } = value as { stiffness: number; damping: number; mass: number; velocity?: number };
    return `stiffness ${stiffness}, damping ${damping}, mass ${mass}${velocity !== undefined ? `, velocity ${velocity}` : ""}`;
  }
  try {
    return type ? cssValue(type, value, (path) => `{${path}}`) : JSON.stringify(value);
  } catch {
    return JSON.stringify(value);
  }
}

export function describeStyleDraft(draft: StyleDraftView): string {
  const { tokens, states } = draft.content;
  return draft.content.title.trim() || [tokens.length && `${tokens.length} token(s)`, states.length && `${states.length} state binding(s)`].filter(Boolean).join(", ") || "Empty style change";
}

export function StyleDraftReview({ draft, info, onUpdate }: { draft: StyleDraftView; info: WorkflowInfo; onUpdate: (draft: DraftView) => void }) {
  const { busy, failure, run } = useRun(onUpdate);
  const state = useModelState();
  const tokensByPath = new Map(state.status === "ready" ? [...state.value.tokens.values()].map((t) => [t.path, t]) : []);
  const types = new Map([...tokensByPath].map(([path, t]) => [path, t.type]));
  const { tokens, states } = draft.content;
  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <DraftHeader draft={draft} title={describeStyleDraft(draft)} kind="Style" detail={`${draft.id} · revision ${draft.revision} · from ${draft.base.branch}@${draft.base.commit.slice(0, 7)}`} busy={busy} run={run} />
      <DraftBanners draft={draft} busy={busy} run={run} failure={failure} />
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
        <div className="min-w-0 space-y-6 p-6">
          <Section
            title="Edits"
            count={tokens.length + states.length}
            aside={
              isOpen(draft) && (
                <Button size="sm" asChild>
                  <Link href={`/style/draft/${draft.id}`}>
                    <Paintbrush /> Edit in Style
                  </Link>
                </Button>
              )
            }
          >
            {tokens.length + states.length === 0 ? (
              <p className="text-small text-muted">Nothing yet. Open it in Style to change tokens and states with a live preview.</p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
                {tokens.map((edit) => (
                  <li key={edit.path} className="space-y-0.5 px-3 py-2">
                    <p className="font-mono text-mono text-ink">{edit.path}</p>
                    {edit.light !== undefined && (
                      <p className="truncate text-small text-muted">
                        light{edit.dark === undefined && !tokensByPath.get(edit.path)?.darkOwn ? " (and dark, which follows it)" : ""}: <code className="font-mono text-mono-sm text-ink-2">{written(types.get(edit.path), edit.light)}</code>
                      </p>
                    )}
                    {edit.dark !== undefined && (
                      <p className="truncate text-small text-muted">
                        dark: <code className="font-mono text-mono-sm text-ink-2">{written(types.get(edit.path), edit.dark)}</code>
                      </p>
                    )}
                  </li>
                ))}
                {states.map((edit) => (
                  <li key={`${edit.component}|${edit.state}|${edit.role}`} className="px-3 py-2 text-small text-ink-2">
                    <span className="font-medium">{edit.component.split("/").at(-1)}</span> {edit.state} <code className="font-mono text-mono-sm">{edit.role}</code> → <code className="font-mono text-mono-sm">{edit.token.split("/token/")[1]}</code>
                  </li>
                ))}
              </ul>
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
          intro={`Builds the tokens as published and as drafted, then traces every changed value through one fresh scan of ${info.project.id}.`}
          impact={draft.preview && <StyleImpactPreview preview={draft.preview} project={info.project.id} stale={draft.previewStale.length > 0} />}
        />
      </div>
    </article>
  );
}
