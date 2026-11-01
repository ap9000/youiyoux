/**
 * Requests on a screen: a comment or a change request pinned to what is picked out on the
 * picture, filed in the product's `.youi/requests` through the workflow service, where agents
 * read them (`requests_list`) and answer them (`request_reply`, `request_addressed`). A person
 * closes a request once the work is right, or reopens it; the thread keeps who said what.
 */
import { clsx } from "clsx";
import { Bot, ExternalLink, MessageSquare, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RequestDoc, RequestRun, RequestStatus, RequestTarget, RunStatus } from "@youiyoux/core";
import { asRequestError, workflowApi, type RequestView, type WorkflowRequestError } from "../../data/workflow.ts";
import { when } from "../../lib/when.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { TextArea } from "../../ui/Field.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { StartEditor } from "../changes/ServiceDown.tsx";
import { BeforeAfter } from "./BeforeAfter.tsx";

const STATUS_TONE: Record<RequestStatus, "warning" | "accent" | "outline"> = { open: "warning", addressed: "accent", closed: "outline" };
const STATUS_LABEL: Record<RequestStatus, string> = { open: "Open", addressed: "Addressed", closed: "Closed" };
const KIND_LABEL: Record<RequestDoc["kind"], string> = { change: "Change request", options: "Options request", comment: "Comment" };
const RUN_LABEL: Record<RunStatus, string> = { queued: "Queued", "needs-you": "Needs you", building: "Building", ready: "Ready for review", done: "Done", failed: "Failed", stopped: "Stopped" };
const RUN_TONE: Record<RunStatus, "warning" | "accent" | "outline" | "success" | "danger"> = { queued: "outline", "needs-you": "warning", building: "accent", ready: "success", done: "success", failed: "danger", stopped: "outline" };

/** What a person does in the runner at each step: approve the task, review its result, or just look. */
const RUN_ACT: Partial<Record<RunStatus, string>> = { "needs-you": "Approve", ready: "Review" };

/** The way into the runner for a task: the step that waits for a person as the one primary verb. */
function OpenInRunner({ run }: { run: RequestRun }) {
  if (!run.task.url) return null;
  const act = RUN_ACT[run.status];
  return (
    <Button asChild size="sm" variant={act ? "primary" : "outline"}>
      <a href={run.task.url} target="_blank" rel="noreferrer">
        {act ?? "Open"} in {run.runner} <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/** The runner's task for a request (Toolroll, say): how far it has got, and where to see it. */
function RunLine({ run }: { run: RequestRun }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-caption text-muted" data-run={run.status}>
      <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
      <span>
        {run.runner} task {run.detail && run.detail !== RUN_LABEL[run.status] ? <span className="text-faint">· {run.detail}</span> : null}
      </span>
      <span className="ml-auto">
        <OpenInRunner run={run} />
      </span>
    </div>
  );
}

/**
 * What waits for a person in each runner across these requests, as one way in: the runner's own
 * page for its waiting work (`home`), or the task itself when only one waits and there is no such page.
 */
export function WaitingInRunners({ requests }: { requests: readonly RequestView[] }) {
  const runs = requests.flatMap((r) => (r.status !== "closed" && r.run && RUN_ACT[r.run.status] ? [r.run] : []));
  const runners = [...new Set(runs.map((run) => run.runner))];
  return (
    <>
      {runners.map((runner) => {
        const waiting = runs.filter((run) => run.runner === runner);
        const approve = waiting.filter((run) => run.status === "needs-you").length;
        const review = waiting.length - approve;
        const words = [approve > 0 && `${approve} to approve`, review > 0 && `${review} to review`].filter(Boolean).join(", ");
        const href = waiting.find((run) => run.home)?.home ?? (waiting.length === 1 ? waiting[0]!.task.url : null);
        const label = `${words} in ${runner}`;
        return href ? (
          <Button key={runner} asChild size="sm" variant="outline" data-waiting={runner}>
            <a href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>
              <span className="size-1.5 rounded-full bg-warning" aria-hidden /> {words}
              <span className="max-sm:hidden">in {runner}</span> <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : (
          <span key={runner} className="text-small text-muted" data-waiting={runner}>
            {label}
          </span>
        );
      })}
    </>
  );
}

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

/** A new comment or change request on what is picked out; `bare` inside something that already frames it. */
/** What the composer says for each kind of request. */
const WORDS: Record<RequestDoc["kind"], { placeholder: string; label: string; submit: string }> = {
  change: { placeholder: "What should change? An agent reads this with the component's file and line.", label: "What should change", submit: "File change request" },
  options: { placeholder: "What should the options explore? An agent offers two to four from the design system, pinned here to preview and pick.", label: "What the options should explore", submit: "Ask for options" },
  comment: { placeholder: "What do you notice?", label: "Your comment", submit: "Add comment" },
};

export function RequestComposer({ target, elementName, onFiled, onCancel, bare = false }: { target: RequestTarget; elementName: string | null; onFiled: (request: RequestDoc) => void; onCancel: () => void; bare?: boolean }) {
  // Options are pinned where the component is: one React renders, with its place on the screen.
  const optionable = !!target.box && !target.html;
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
    // Options are for this one, where it was picked: they are pinned there.
    workflowApi.fileRequest(kind, body.trim(), { ...target, scope: kind === "options" ? "here" : scope }).then(
      (request) => {
        setBody("");
        onFiled(request);
      },
      (e: unknown) => setError(asRequestError(e)),
    ).finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className={clsx("space-y-2.5", !bare && "rounded-lg border border-line bg-surface p-3")} data-request-composer aria-label="New request">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<RequestDoc["kind"]> label="Kind" value={kind} onChange={setKind} options={[{ value: "change", label: "Change request" }, ...(optionable ? [{ value: "options" as const, label: "Options" }] : []), { value: "comment", label: "Comment" }]} />
        {elementName && kind !== "options" && <Segmented<RequestTarget["scope"]> label="Applies to" value={scope} onChange={setScope} options={[{ value: "here", label: "This one" }, { value: "element", label: `Every ${elementName}` }]} />}
      </div>
      <TextArea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        maxLength={4000}
        placeholder={WORDS[kind].placeholder}
        aria-label={WORDS[kind].label}
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
          {WORDS[kind].submit}
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
export function RequestThread({ request, number, active, onChange, onPick }: { request: RequestView; number: number; active: boolean; onChange: (request: RequestView) => void; onPick: () => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  const act = (work: () => Promise<RequestView>): void => {
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
            <span className="text-caption text-muted">{KIND_LABEL[request.kind]}</span>
            <span className="text-caption text-faint">· {target.scope === "element" ? `every ${target.name}` : target.name}</span>
          </span>
          <span className="block text-small text-ink">{request.body}</span>
          <span className="block truncate font-mono text-mono-sm text-faint">{target.file && target.line ? `${target.file}:${target.line}` : target.route}</span>
        </span>
      </button>
      {request.run && <RunLine run={request.run} />}
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
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => workflowApi.moveRequest(request.id, "open", reply))}>
              Reopen
            </Button>
          ) : (
            <Button size="sm" variant={request.status === "addressed" ? "primary" : "ghost"} disabled={busy} onClick={() => act(() => workflowApi.moveRequest(request.id, "closed", reply))}>
              {request.status === "addressed" ? "Looks right: close" : "Close"}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy || !reply.trim()} onClick={() => act(() => workflowApi.replyRequest(request.id, reply))}>
            <MessageSquare /> Reply
          </Button>
        </div>
      </div>
    </li>
  );
}
