/** "Edit rule" on a rule page. Its own module, so the element page does not load the editor. */
import { PencilLine } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { asRequestError, workflowApi, type WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";

const OPEN = new Set(["draft", "previewed", "approved"]);

/** "Edit rule" on a rule page: opens (or reuses) a draft when the rule editor is running; says how to start it when not. */
export function EditRuleButton({ ruleId }: { ruleId: string }) {
  const [, navigate] = useLocation();
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  const edit = async (): Promise<void> => {
    setError(null);
    try {
      const { drafts } = await workflowApi.drafts();
      const existing = drafts.find((d) => d.ruleId === ruleId && OPEN.has(d.status));
      navigate(`/rules/draft/${(existing ?? (await workflowApi.edit(ruleId))).id}`);
    } catch (failure: unknown) {
      setError(asRequestError(failure));
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" onClick={() => void edit()}>
        <PencilLine /> Edit rule
      </Button>
      {error && <span className="text-small text-muted">{error.offline ? "Start the rule editor first; Rules shows how." : error.message}</span>}
    </span>
  );
}
