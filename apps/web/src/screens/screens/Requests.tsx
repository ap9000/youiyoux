/**
 * Requests on a screen: a comment or a change request pinned to what is picked out on the
 * picture, filed in the product's `.youi/requests` through the workflow service, where agents
 * read them (`requests_list`) and answer them (`request_reply`, `request_addressed`). A person
 * closes a request once the work is right, or reopens it; the thread keeps who said what.
 */
import { clsx } from "clsx";
import { Bot, MessageSquare, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RequestDoc, RequestStatus, RequestTarget } from "@youiyoux/core";
import { asRequestError, workflowApi, type WorkflowRequestError } from "../../data/workflow.ts";
import { when } from "../../lib/when.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { TextArea } from "../../ui/Field.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { StartEditor } from "../changes/ServiceDown.tsx";
import { BeforeAfter } from "./BeforeAfter.tsx";

const STATUS_TONE: Record<RequestStatus, "warning" | "accent" | "outline"> = { open: "warning", addressed: "accent", closed: "outline" };
const STATUS_LABEL: Record<RequestStatus, string> = { open: "Open", addressed: "Addressed", closed: "Closed" };


/** What failed, in words, with the command when the service is not running. */
function Failure({ error }: { error: WorkflowRequestError }) {
  return (
    <div role="alert" className="space-y-1.5 text-small text-danger" data-request-error>
      <p>{error.offline ? "Requests are filed through the local service: start the hub on your project." : error.message}</p>
      {error.offline && <StartEditor />}
      {error.problems.length > 0 && (
        <ul className="list-disc pl-4">
          {error.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A new comment or change request on what is picked out. */
export function RequestComposer({ target, elementName, onFiled, onCancel }: { target: RequestTarget; elementName: string | null; onFiled: (request: RequestDoc) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<RequestDoc["kind"]>("change");
  const [scope, setScope] = useState<RequestTarget["scope"]>("here");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    workflowApi.fileRequest(kind, body.trim(), { ...target, scope }).then(
      (request) => {
        setBody("");
        onFiled(request);
      },
      (e: unknown) => setError(asRequestError(e)),
    ).finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-lg border border-line bg-surface p-3" data-request-composer aria-label="New request">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<RequestDoc["kind"]> label="Kind" value={kind} onChange={setKind} options={[{ value: "change", label: "Change request" }, { value: "comment", label: "Comment" }]} />
        {elementName && <Segmented<RequestTarget["scope"]> label="Applies to" value={scope} onChange={setScope} options={[{ value: "here", label: "This one" }, { value: "element", label: `Every ${elementName}` }]} />}
      </div>
      <TextArea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        maxLength={4000}
        placeholder={kind === "change" ? "What should change? An agent reads this with the component's file and line." : "What do you notice?"}
        aria-label={kind === "change" ? "What should change" : "Your comment"}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
        }}
      />
      {error && <Failure error={error} />}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy || !body.trim()} aria-busy={busy || undefined}>
          {kind === "change" ? "File change request" : "Add comment"}
        </Button>
      </div>
    </form>
  );
}

function Who({ author }: { author: RequestDoc["author"] }) {
  const Icon = author.kind === "agent" ? Bot : User;
  return (
    <span className="inline-flex items-center gap-1 text-small font-medium text-ink-2">
      <Icon aria-hidden className="size-3.5 text-muted" />
      {author.name}
    </span>
  );
}

/** One request with its thread, a reply box, and the person's close or reopen. */
export function RequestThread({ request, number, active, onChange, onPick }: { request: RequestDoc; number: number; active: boolean; onChange: (request: RequestDoc) => void; onPick: () => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  const run = (work: () => Promise<RequestDoc>): void => {
    setBusy(true);
    setError(null);
    work().then(
      (next) => {
        setReply("");
        onChange(next);
      },
      (e: unknown) => setError(asRequestError(e)),
    ).finally(() => setBusy(false));
  };
  const { target } = request;
  return (
    <li className={clsx("space-y-2 rounded-md border px-3 py-2.5", active ? "border-accent bg-accent-soft/40" : "border-line")} data-request={request.id} data-status={request.status}>
      <button type="button" onClick={onPick} className="flex w-full min-w-0 items-start gap-2 text-left" aria-label={`Show request ${number} on the screenshot`}>
        <span className={clsx("grid size-5 shrink-0 place-items-center rounded-full text-caption font-medium tabular", request.status === "closed" ? "bg-neutral-soft text-muted" : request.status === "addressed" ? "bg-success text-on-accent" : "bg-accent text-on-accent")}>{number}</span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[request.status]}>{STATUS_LABEL[request.status]}</Badge>
            <span className="text-caption text-muted">{request.kind === "change" ? "Change request" : "Comment"}</span>
            <span className="text-caption text-faint">· {target.scope === "element" ? `every ${target.name}` : target.name}</span>
          </span>
          <span className="block text-small text-ink">{request.body}</span>
          <span className="block truncate font-mono text-mono-sm text-faint">{target.file && target.line ? `${target.file}:${target.line}` : target.route}</span>
        </span>
      </button>
      {(request.before || request.status !== "open") && <BeforeAfter key={request.updatedAt} id={request.id} route={target.route} worked={request.status !== "open"} />}
      <ol className="space-y-1.5 border-l border-line pl-3" aria-label="Thread">
        <li className="flex flex-wrap items-baseline gap-x-2 text-caption text-faint">
          <Who author={request.author} /> filed it {when(request.createdAt)}
        </li>
        {request.thread.map((entry, i) => (
          <li key={i} className="space-y-0.5" data-entry={entry.author.kind}>
            <p className="flex flex-wrap items-baseline gap-x-2 text-caption text-faint">
              <Who author={entry.author} />
              {entry.status && <span>marked it {entry.status}</span>}
              <span>{when(entry.at)}</span>
            </p>
            {entry.body && <p className="text-small text-ink-2 [overflow-wrap:anywhere]">{entry.body}</p>}
          </li>
        ))}
      </ol>
      <div className="space-y-2">
        <TextArea value={reply} onChange={(event) => setReply(event.target.value)} rows={2} maxLength={4000} placeholder="Reply" aria-label={`Reply to request ${number}`} />
        {error && <Failure error={error} />}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {request.status === "closed" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => workflowApi.moveRequest(request.id, "open", reply))}>
              Reopen
            </Button>
          ) : (
            <Button size="sm" variant={request.status === "addressed" ? "primary" : "ghost"} disabled={busy} onClick={() => run(() => workflowApi.moveRequest(request.id, "closed", reply))}>
              {request.status === "addressed" ? "Looks right: close" : "Close"}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy || !reply.trim()} onClick={() => run(() => workflowApi.replyRequest(request.id, reply))}>
            <MessageSquare /> Reply
          </Button>
        </div>
      </div>
    </li>
  );
}
