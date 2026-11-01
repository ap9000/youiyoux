/**
 * Connect your agent: the coding agents this machine has, which already start the youiyoux MCP
 * server in this project, and one button that sets the ones picked up as `youiyoux agents install`
 * does (the project files it writes are listed after), then starts each server as its agent would
 * to show it answers. Without the service (a static hub, or no `--project`), the terminal command.
 */
import { Check, Plug, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { asRequestError, workflowApi, type AgentKind, type AgentsConnected, type AgentsView, type WorkflowRequestError } from "../data/workflow.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { CodeBlock } from "../ui/CodeBlock.tsx";
import { Modal } from "../ui/Modal.tsx";

const COMMAND = "youiyoux agents install";

/** What each agent asks the first time it starts a project's server. */
const FIRST_START: Record<AgentKind, string> = {
  claude: "Claude Code asks once before it trusts the project's servers.",
  codex: "Codex reads the project's settings once you trust the project.",
  cursor: "Cursor may ask you to turn the server on in its MCP settings.",
};

/** At first, every agent here that is not connected yet; one not on this machine can still be picked. */
const firstPicks = (view: AgentsView): Set<AgentKind> => new Set(view.agents.filter((a) => a.found && !a.connected).map((a) => a.kind));

export function ConnectAgents({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<AgentsView | null>(null);
  const [failed, setFailed] = useState<WorkflowRequestError | null>(null);
  const [picked, setPicked] = useState<Set<AgentKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AgentsConnected | null>(null);

  useEffect(() => {
    workflowApi.agents().then(
      (next) => {
        setView(next);
        setPicked(firstPicks(next));
      },
      (e: unknown) => setFailed(asRequestError(e)),
    );
  }, []);

  const connect = (): void => {
    setBusy(true);
    setFailed(null);
    workflowApi
      .connectAgents([...picked])
      .then(
        (result) => {
          setDone(result);
          setView(result.view);
          setPicked(new Set());
        },
        (e: unknown) => setFailed(asRequestError(e)),
      )
      .finally(() => setBusy(false));
  };

  const toggle = (kind: AgentKind, on: boolean): void => setPicked((now) => (on ? new Set([...now, kind]) : new Set([...now].filter((k) => k !== kind))));
  // Read failed: no service here, so the terminal does it.
  const offline = failed !== null && view === null;
  const count = picked.size;

  return (
    <Modal
      title="Connect your agent"
      icon={Plug}
      description="Your coding agent gets YouIyouX's tools: it finds your components before making new ones, reads requests from the Screens, and answers them."
      onClose={onClose}
      footer={
        done || offline ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || count === 0 || view === null} onClick={connect}>
              {busy ? "Connecting…" : count > 1 ? `Connect ${count} agents` : "Connect"}
            </Button>
          </>
        )
      }
    >
      {offline ? (
        <div className="space-y-2 text-small text-muted" data-agents-offline>
          <p>{failed.offline || failed.status === 404 ? "Connecting from the hub needs the hub started on your project (youiyoux ui --project). In the project's folder, this does the same:" : failed.message}</p>
          <CodeBlock code={COMMAND} title="command" />
        </div>
      ) : view === null ? (
        <p className="text-small text-muted">Looking for your agents…</p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-md border border-line" aria-label="Agents">
            {view.agents.map((agent) => (
              <li key={agent.kind} className="flex min-h-11 items-center gap-3 px-3 py-2" data-agent={agent.kind}>
                {agent.connected ? (
                  <Check className="size-3.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <input type="checkbox" className="size-3.5 shrink-0 accent-accent" aria-label={`Connect ${agent.name}`} checked={picked.has(agent.kind)} disabled={busy || done !== null} onChange={(e) => toggle(agent.kind, e.target.checked)} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-ink">{agent.name}</span>
                  <span className="block truncate font-mono text-mono-sm text-faint">{agent.file}</span>
                </span>
                {agent.connected ? <Badge tone="success">Connected</Badge> : !agent.found && <span className="text-caption text-faint">Not found on this machine</span>}
              </li>
            ))}
          </ul>
          {done && (
            <div className="space-y-3" data-agents-done>
              <ul className="space-y-1.5" aria-label="Checks">
                {done.checks.map((check) => (
                  <li key={check.kind} className="flex items-start gap-2 text-small" data-check={check.ok ? "ok" : "failed"}>
                    {check.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />}
                    <span className={check.ok ? "text-ink-2" : "text-danger"}>{check.ok ? `${check.name}: the server answers, with ${check.tools} tools.` : `${check.name}: ${check.problem}`}</span>
                  </li>
                ))}
              </ul>
              <p className="text-small text-muted">
                Restart {done.checks.map((c) => c.name).join(" and ")} so {done.checks.length > 1 ? "they load" : "it loads"} the server. {done.checks.map((c) => FIRST_START[c.kind]).join(" ")}
              </p>
              <details className="text-small text-muted">
                <summary className="cursor-pointer select-none">What changed in your project</summary>
                <ul className="mt-2 space-y-1">
                  {done.results.map((r) => (
                    <li key={`${r.kind}:${r.file}`}>
                      <span className="font-mono text-mono-sm text-ink-2">{r.file}</span> <span className="text-faint">{r.action}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  <span className="font-mono text-mono-sm">youiyoux agents remove</span> takes out only youiyoux's parts.
                </p>
              </details>
            </div>
          )}
          {failed && (
            <p role="alert" className="text-small text-danger">
              {failed.message}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
