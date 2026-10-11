/** What Rules and Changes show when the local rule-editor service is not answering. */
import { PlugZap, RotateCw } from "lucide-react";
import type { WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";

export const START_EDITOR = "pnpm youi editor --project <project> --design <design repo> [--config <youi.project.json>]";

export function StartEditor() {
  return (
    <p className="flex items-center gap-1 rounded-md bg-sunken px-2 py-1">
      <code className="min-w-0 truncate font-mono text-mono-sm text-ink-2">{START_EDITOR}</code>
      <CopyButton value={START_EDITOR} label="Copy command" />
    </p>
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
