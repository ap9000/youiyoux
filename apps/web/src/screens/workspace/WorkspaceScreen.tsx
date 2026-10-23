/**
 * Work > Workspace: every product of the workspace `youiyoux ui` runs on, where each stands with
 * its System (youi.status/v1, as `youiyoux status` prints it, read live from /api/workspace), and
 * which one this hub shows. Open snapshots another product into this hub, which then reloads.
 * Without a workspace service (one product, or a static host) it says how to open one.
 */
import type { ProjectStatus, ProjectStatusFailure } from "@youiyoux/core";
import { FolderTree, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { WorkflowRequestError, workspaceApi, type WorkspaceView } from "../../data/workflow.ts";
import { plural } from "../../lib/plural.ts";
import { Badge, type BadgeTone } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, PaneSkeleton } from "../../ui/Pane.tsx";

type Load = { state: "loading" } | { state: "offline" } | { state: "failed"; message: string } | { state: "ready"; view: WorkspaceView };

const SYNC: Record<ProjectStatus["sync"]["state"], { label: (s: ProjectStatus) => string; tone: BadgeTone }> = {
  current: { label: () => "Up to date", tone: "success" },
  behind: { label: (s) => `Behind: ${plural(s.sync.changes.length, "file")}`, tone: "warning" },
  conflict: { label: () => "Conflict", tone: "danger" },
  never: { label: () => "Never synced", tone: "warning" },
};

const failed = (p: ProjectStatus | ProjectStatusFailure): p is ProjectStatusFailure => "error" in p;
const mono = "font-mono text-mono-sm";

/** `youiyoux sync: 2 files would change`: the command in mono, why in words. */
export function Next({ next }: { next: string }) {
  const at = next.indexOf(": ");
  const [command, why] = next.startsWith("youiyoux ") && at > 0 ? [next.slice(0, at), next.slice(at + 2)] : [null, next];
  return (
    <p className="text-small text-muted">
      Next: {command && <span className={`${mono} text-ink`}>{command}</span>}
      {command ? `: ${why}` : <span className="text-ink-2">{why}</span>}
    </p>
  );
}

export function Facts({ status }: { status: ProjectStatus }) {
  const { check, components, requests, drift } = status;
  const sync = SYNC[status.sync.state];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small text-ink-2">
      <span>
        {status.system.name} v{status.system.version} <span className="text-muted">· {status.system.source}{status.system.linked ? ", linked" : ""}</span>
      </span>
      <Badge tone={sync.tone}>{sync.label(status)}</Badge>
      {drift.length > 0 && <Badge tone={drift.some((d) => d.severity === "error") ? "danger" : "warning"}>{plural(drift.length, "file")} drifting</Badge>}
      <span className="tabular">
        <span className={check.errors > 0 ? "text-danger" : undefined}>{plural(check.errors, "error")}</span> · {plural(check.warnings, "warning")}
        {check.baseline && <span className="text-muted"> beyond the baseline</span>}
        {check.incomplete && <Badge tone="warning" className="ml-2">Incomplete</Badge>}
      </span>
      <span className="tabular">
        {components.used} of {plural(components.system, "component")} used
      </span>
      {requests.open > 0 && <span className="tabular">{plural(requests.open, "open request")}</span>}
    </div>
  );
}

function Row({ entry, index, current, opening, onOpen }: { entry: ProjectStatus | ProjectStatusFailure; index: number; current: number; opening: number | null; onOpen: (index: number) => void }) {
  const unreadable = failed(entry);
  return (
    <li className="space-y-2 px-4 py-3" data-product={entry.root} aria-current={index === current ? "true" : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-body font-medium text-ink">{unreadable ? entry.root : entry.id}</span>
        {!unreadable && entry.root !== entry.id && <span className={`${mono} text-muted`}>{entry.root}</span>}
        <span className="ml-auto max-sm:ml-0">
          {index === current ? (
            <Badge tone="accent">Showing</Badge>
          ) : unreadable ? (
            <Badge tone="danger">Cannot be read</Badge>
          ) : (
            <Button size="sm" onClick={() => onOpen(index)} disabled={opening !== null}>
              {opening === index ? "Opening…" : "Open"}
            </Button>
          )}
        </span>
      </div>
      {unreadable ? <p className="text-small text-ink-2">{entry.error}</p> : <Facts status={entry} />}
      <Next next={entry.next} />
    </li>
  );
}

export function WorkspaceEmpty() {
  return (
    <EmptyState icon={FolderTree} title="No workspace here">
      <p>
        A workspace lists the products you manage together. Write a <span className={`${mono} text-ink`}>youi.workspace.json</span> naming their folders, then run <span className={`${mono} text-ink`}>youiyoux ui</span> beside it: this page shows where each one stands and opens any of them here. <span className={`${mono} text-ink`}>youiyoux status</span> shows the same in the terminal.
      </p>
    </EmptyState>
  );
}

export function WorkspaceScreen() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [opening, setOpening] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = (call: Promise<WorkspaceView>): Promise<void> =>
    call.then(
      (view) => setLoad({ state: "ready", view }),
      (error: unknown) => {
        if (error instanceof WorkflowRequestError && (error.offline || error.status === 404 || error.status === 502)) setLoad({ state: "offline" });
        else setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  useEffect(() => {
    void settle(workspaceApi.get());
  }, []);
  const open = (index: number): void => {
    setOpening(index);
    setProblem(null);
    // The hub reloads its data on its own once the new snapshot is written; this keeps the list's marker right.
    void settle(workspaceApi.open(index)).finally(() => setOpening(null));
  };
  const view = load.state === "ready" ? load.view : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader title="Workspace" count={view?.report.projects.length}>
        {view && (
          <Button size="sm" variant="ghost" onClick={() => void settle(workspaceApi.refresh())} disabled={opening !== null}>
            <RefreshCw /> Read again
          </Button>
        )}
      </PaneHeader>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {load.state === "loading" ? (
          <PaneSkeleton />
        ) : load.state === "offline" ? (
          <WorkspaceEmpty />
        ) : load.state === "failed" ? (
          <p className="px-8 py-8 text-small text-danger">{load.message}</p>
        ) : (
          <div className="mx-auto w-full max-w-5xl min-w-0 space-y-4 px-8 py-8 animate-enter max-sm:px-4">
            <p className="max-w-2xl text-small text-ink-2">
              Where each product stands with its System, as <span className={`${mono} text-ink`}>youiyoux status</span> reads it{load.view.report.workspace ? <> from <span className={`${mono} text-ink`}>{load.view.report.workspace}</span></> : null}. Open one to see its usage, screens and inventory here.
            </p>
            {problem && (
              <p role="alert" className="rounded-md border border-line px-3 py-2 text-small text-ink-2">
                {problem}
              </p>
            )}
            <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Products">
              {load.view.report.projects.map((entry, index) => (
                <Row key={entry.root} entry={entry} index={index} current={load.view.current} opening={opening} onOpen={open} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
