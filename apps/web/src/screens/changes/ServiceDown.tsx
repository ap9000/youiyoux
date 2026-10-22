/** What Rules and Changes show when the local rule-editor service is not answering. */
import { PlugZap, RotateCw } from "lucide-react";
import type { WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";

export const START_EDITOR = "pnpm youiyoux ui --project <project> [--design <design repo>] [--config <youi.project.json>]";

/** The start command, wrapping inside its box (at spaces, else anywhere) so a phone row never scrolls sideways. */
export function StartEditor() {
  return (
    <p className="flex min-w-0 max-w-full items-start gap-1 rounded-md bg-sunken px-2 py-1">
      <code className="min-w-0 flex-1 self-center font-mono text-mono-sm text-ink-2 [overflow-wrap:anywhere]">{START_EDITOR}</code>
      <CopyButton value={START_EDITOR} label="Copy command" />
    </p>
  );
}

/** The same notice as a panel at the top of a screen that keeps its frame, instead of centred in an empty pane. */
export function ServiceDownPanel({ error, onRetry }: { error: WorkflowRequestError; onRetry: () => void }) {
  return (
    <section data-service-down aria-labelledby="service-down" className="space-y-3 rounded-md border border-line px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <PlugZap aria-hidden className="size-4 shrink-0 text-muted" />
        <h2 id="service-down" className="text-heading">
          {error.offline ? "Start the rule editor to see changes" : "The rule editor had a problem"}
        </h2>
        <Button size="sm" onClick={onRetry} className="ml-auto">
          <RotateCw /> Try again
        </Button>
      </div>
      {error.offline ? (
        <>
          <p className="max-w-2xl text-body text-ink-2">Drafts, previews and approvals live in the local workflow service. From the YouIyouX checkout, run this and open the link it prints:</p>
          <StartEditor />
        </>
      ) : (
        <p className="text-body text-ink-2">{error.message}</p>
      )}
    </section>
  );
}

export function ServiceDown({ error, onRetry }: { error: WorkflowRequestError; onRetry: () => void }) {
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
          <p>Drafts, previews and approvals live in the local workflow service. From the YouIyouX checkout, run this and open the link it prints:</p>
          <div className="mt-2">
            <StartEditor />
          </div>
        </>
      ) : (
        <p>{error.message}</p>
      )}
    </EmptyState>
  );
}
