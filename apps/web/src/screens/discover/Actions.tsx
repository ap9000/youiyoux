/**
 * What a person can do with an opened candidate, both as drafts for approval in the changes
 * queue, never as an install: Save to Library keeps it as a reference (stage `library`); Add to my
 * project shows the exact install command, to copy, and drafts an adoption request (stage
 * `candidate`, MCP's library_request) for a person to decide. An item whose licence is unknown is
 * never put up for adoption: the button stays off and says why, and the service refuses it too.
 * Without the workflow service (`youiyoux ui --project`), both say so.
 */
import type { LibraryEntry } from "@youiyoux/core";
import { BookmarkPlus, PackagePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { asRequestError, workflowApi, type WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { TextArea } from "../../ui/Field.tsx";

export const NEEDS_SERVICE = "Saving and adopting are drafts for approval: they need the workflow service (open the hub with youiyoux ui --project).";

/** Why this item cannot be adopted, or null when it can. */
export function adoptRefusal(licence: string, name: string): string | null {
  return licence === "unknown" ? `${name}'s licence is unknown: nothing backs one, so it cannot be adopted. Save it to the Library as a reference instead, or find its licence first.` : null;
}

type Service = "checking" | "up" | "down";

/** Whether the workflow service answers (asked once, when an item is opened). */
function useService(): Service {
  const [state, setState] = useState<Service>("checking");
  useEffect(() => {
    let cancelled = false;
    workflowApi.info().then(
      () => !cancelled && setState("up"),
      (error: unknown) => !cancelled && setState(asRequestError(error).offline ? "down" : "up"),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function CandidateActions({ entry, licence, install, family }: { entry: LibraryEntry | null; licence: string; install: string | null; family: string | null }) {
  const service = useService();
  const [adopting, setAdopting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"save" | "adopt" | null>(null);
  const [failure, setFailure] = useState<WorkflowRequestError | null>(null);
  const [drafted, setDrafted] = useState<{ id: string; request: "save" | "adopt" } | null>(null);
  const name = entry?.title ?? entry?.name ?? "This item";
  const refusal = adoptRefusal(licence, name);
  const unavailable = service === "down" ? NEEDS_SERVICE : entry === null ? "Drafting needs the full listing, which comes with its preview from the hub's own server." : null;

  const draft = async (request: "save" | "adopt"): Promise<void> => {
    if (!entry) return;
    setBusy(request);
    setFailure(null);
    try {
      const created = await workflowApi.createLibrary({ entry, request, reason: request === "adopt" ? reason.trim() : "", swapsWith: family ? [family] : [] });
      setDrafted({ id: created.id, request });
      setAdopting(false);
    } catch (error: unknown) {
      setFailure(asRequestError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="candidate-actions" className="space-y-3" data-testid="candidate-actions">
      <h3 id="candidate-actions" className="text-heading">
        Keep it, or ask for it
      </h3>
      {install && (
        <div className="space-y-1">
          <p className="text-small text-muted">Install command, for after adoption: copy it, the hub never runs it.</p>
          <div className="flex min-w-0 items-center gap-1 rounded-md bg-sunken px-2 py-1">
            <code className="min-w-0 flex-1 truncate font-mono text-mono-sm text-ink-2" data-install>
              {install}
            </code>
            <CopyButton value={install} label="Copy install command" className="max-md:size-11" />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={unavailable !== null || busy !== null || service === "checking"} onClick={() => void draft("save")} className="max-md:h-11" data-action="save">
          <BookmarkPlus /> {busy === "save" ? "Saving…" : "Save to Library"}
        </Button>
        <Button variant="primary" disabled={unavailable !== null || refusal !== null || busy !== null || service === "checking"} aria-describedby={refusal ? "adopt-refusal" : undefined} onClick={() => setAdopting(true)} className="max-md:h-11" data-action="adopt">
          <PackagePlus /> Add to my project
        </Button>
      </div>
      {refusal && (
        <p id="adopt-refusal" className="text-small text-warning" data-refusal>
          {refusal}
        </p>
      )}
      {unavailable && <p className="text-small text-muted">{unavailable}</p>}
      {adopting && !refusal && (
        <form
          className="space-y-2 rounded-md border border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void draft("adopt");
          }}
        >
          <p className="text-small text-ink-2">This drafts an adoption request for a person to approve in Changes. Nothing is installed; after adoption, the command above adds it.</p>
          <label className="block space-y-1">
            <span className="text-small text-muted">Why does the system need it?</span>
            <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required />
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!reason.trim() || busy !== null}>
              {busy === "adopt" ? "Drafting…" : "Draft adoption request"}
            </Button>
            <Button variant="ghost" onClick={() => setAdopting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {drafted && (
        <p role="status" className="text-small text-success">
          {drafted.request === "adopt" ? "Adoption request drafted" : "Saved to the Library as a draft"} for approval:{" "}
          <Link href={`/changes/${drafted.id}`} className="underline">
            open it in Changes
          </Link>
          .
        </p>
      )}
      {failure && (
        <div role="alert" className="text-small text-danger">
          <p>{failure.offline ? NEEDS_SERVICE : failure.message}</p>
          {failure.problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
    </section>
  );
}
