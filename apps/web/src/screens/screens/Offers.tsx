/**
 * Options an agent put on the Screens canvas for one component (`youi.proposal/v1`, offered with the
 * MCP tool screens_offer): what was asked, and each option's label, why and changes. On a live
 * screen an option is previewed in the running app (LiveHandle); Use this writes it into the code,
 * or files it as an exact change request (WriteToCode), and records the pick; Dismiss turns them
 * all down. Only a person decides: the service refuses an agent.
 */
import { clsx } from "clsx";
import { Eye, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentContract, RequestDoc, RequestTarget } from "@youiyoux/core";
import type { LiveHandle, LiveValue } from "../../data/live.ts";
import { asRequestError, workflowApi, type ProposalView, type WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { WriteToCode } from "./WriteToCode.tsx";

type Option = ProposalView["options"][number];

/** An option's changes in words: `variant="ghost"`, `text "Create flow"`. */
export function changesOf(option: Pick<Option, "set" | "text">): string {
  return [...option.set.map(({ prop, value }) => (value === true ? prop : `${prop}=${JSON.stringify(value)}`)), ...(option.text === null ? [] : [`text ${JSON.stringify(option.text)}`])].join(", ");
}

/** The proposal's component as a request names it, for the request an option is filed as. */
export function offerTarget(proposal: ProposalView): RequestTarget {
  const t = proposal.target;
  return { route: proposal.route, scope: "here", name: t.name, ...(t.element ? { element: t.element } : {}), ...(t.file ? { file: t.file } : {}), ...(t.line ? { line: t.line } : {}), box: t.box, ...(t.page ? { page: t.page } : {}) };
}

/** A pin for an agent's options, where the component is: a spark and how many there are. */
export function OfferPin({ proposal, onOpen, style }: { proposal: ProposalView; onOpen: (at: { clientX: number; clientY: number }) => void; style: { left: string; top: string } }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(event);
      }}
      aria-label={`${proposal.options.length} options for ${proposal.target.name} from ${proposal.author.name}: ${proposal.ask}`}
      title={proposal.ask}
      data-canvas-offer={proposal.id}
      className="absolute z-20 inline-flex h-6 -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-md border border-accent bg-surface px-1 text-caption font-semibold text-accent tabular shadow-raise"
      style={style}
    >
      <Sparkles className="size-3.5" aria-hidden />
      {proposal.options.length}
    </button>
  );
}

interface Props {
  proposal: ProposalView;
  /** The component on the live screen, to preview options in; null on a picture. */
  live: LiveHandle | null;
  contract: ComponentContract | null;
  onChange: (proposal: ProposalView) => void;
  /** A request filed for an option, or the options request closed once decided, as the service returned it. */
  onRequest: (request: RequestDoc) => void;
  onDone: () => void;
}

export function OfferPanel({ proposal, live, contract, onChange, onRequest, onDone }: Props) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  const kept = useRef(false);
  // Closed without writing, the page is put back as it was.
  useEffect(() => () => void (live && !kept.current && live.reset()), [live]);

  const target = offerTarget(proposal);
  const decided = proposal.status !== "open";
  const preview = (option: Option): void => {
    if (!live) return;
    setPreviewing(option.id);
    live.reset();
    const set: Record<string, LiveValue> = Object.fromEntries(option.set.map(({ prop, value }) => [prop, value]));
    void live.edit(set, option.text).then((done) => setProblem(done.ok ? null : done.why));
  };
  // The pick is recorded for the agent; an options request it answers is closed with it (a person's act).
  const decide = (decision: { choice: string; request?: string } | { dismiss: true }): Promise<void> =>
    workflowApi
      .decideProposal(proposal, decision)
      .then(async (decided) => {
        onChange(decided);
        if (!proposal.for) return;
        const chosen = "choice" in decision ? proposal.options.find((o) => o.id === decision.choice) : null;
        onRequest(await workflowApi.moveRequest(proposal.for, "closed", chosen ? `Picked ${chosen.id}: ${chosen.label}${"request" in decision && decision.request ? `, filed as ${decision.request}` : ""}.` : "Dismissed every option."));
      })
      .catch((e: unknown) => setError(asRequestError(e)));
  const editFor = (option: Option) =>
    target.file && target.line
      ? {
          file: target.file,
          line: target.line,
          column: proposal.target.column ?? null,
          component: proposal.target.name,
          set: option.set.map(({ prop, value }) => {
            const spec = contract?.props[prop];
            return { prop, value, ...(spec && "default" in spec && spec.default !== undefined ? { default: spec.default } : {}) };
          }),
          text: option.text,
        }
      : null;

  if (written)
    return (
      <div className="space-y-2" data-offer="written">
        <p className="text-small text-ink-2">
          Written to <span className="font-mono text-mono-sm">{written}</span>. The app&rsquo;s dev server reloads it; the agent sees which option you picked.
        </p>
        {error && (
          <p className="text-small text-danger" role="alert">
            Written, but the pick wasn&rsquo;t recorded for the agent: {error.message}
          </p>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-3" data-offer={proposal.status}>
      <p className="text-small text-ink-2">
        <span className="text-muted">{proposal.author.name} offers, for </span>&ldquo;{proposal.ask}&rdquo;
      </p>
      <ol className="space-y-2" aria-label="Options">
        {proposal.options.map((option) => {
          const chosen = proposal.choice === option.id;
          return (
            <li key={option.id} className={clsx("space-y-1.5 rounded-md border px-3 py-2", previewing === option.id || chosen ? "border-accent bg-accent-soft/40" : "border-line")} data-option={option.id}>
              <p className="flex items-baseline gap-2">
                <span className="font-mono text-mono-sm text-faint">{option.id}</span>
                <span className="text-body font-medium text-ink">{option.label}</span>
                {chosen && <span className="text-caption text-accent">picked</span>}
              </p>
              <p className="text-small text-ink-2">{option.why}</p>
              <p className="font-mono text-mono-sm break-words text-muted">{changesOf(option)}</p>
              {!decided && using !== option.id && (
                <div className="flex flex-wrap justify-end gap-2">
                  {live && (
                    <Button size="sm" variant="ghost" onClick={() => preview(option)} aria-pressed={previewing === option.id}>
                      <Eye /> Preview
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => (setUsing(option.id), live && preview(option))}>
                    Use this
                  </Button>
                </div>
              )}
              {!decided && using === option.id && (
                <WriteToCode
                  edit={editFor(option)}
                  name={proposal.target.name}
                  target={target}
                  words={`Set ${changesOf(option)} on ${proposal.target.name}${target.file && target.line ? ` at ${target.file}:${target.line}` : ""}, as ${proposal.author.name} offered for "${proposal.ask}" on ${proposal.route}.`}
                  empty={false}
                  onWritten={(at) => {
                    kept.current = true;
                    live?.forget();
                    void decide({ choice: option.id }).then(() => setWritten(at));
                  }}
                  onFiled={(request) => {
                    onRequest(request);
                    void decide({ choice: option.id, request: request.id });
                  }}
                  before={
                    <Button size="sm" variant="ghost" onClick={() => setUsing(null)}>
                      Back
                    </Button>
                  }
                />
              )}
            </li>
          );
        })}
      </ol>
      {!live && !decided && <p className="text-caption text-muted">Run this screen live to preview each option in the app.</p>}
      {problem && (
        <p className="text-small text-danger" role="alert">
          {problem}
        </p>
      )}
      {error && (
        <p className="text-small text-danger" role="alert">
          {error.message}
        </p>
      )}
      {!decided && (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => void decide({ dismiss: true }).then(onDone)}>
            Dismiss all
          </Button>
        </div>
      )}
      {decided && proposal.status === "dismissed" && <p className="text-small text-muted">Dismissed by {proposal.decidedBy?.name}.</p>}
    </div>
  );
}
