/**
 * The rule-editor workflow service (`youi editor`), reached at /api: same origin when the
 * service serves the built hub, proxied by `pnpm dev`. Unlike the snapshot, this is live
 * state, so nothing here is cached.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, DraftContent, DraftView, PublishedRule, WorkflowInfo } from "@youiyoux/workflow/api";

export type { CheckCapability, DraftContent, DraftView, Preview, PreviewFinding, PublishedRule, RuleFields, WorkflowInfo } from "@youiyoux/workflow/api";

const API = `${import.meta.env.BASE_URL}api`;
const KEY_STORE = "youiyoux.editor-key";

/**
 * This run's session key. `youi editor` prints a link carrying it in the fragment (never
 * sent in a request); the hub keeps it for the tab and takes it out of the address bar.
 */
function sessionKey(): string | null {
  const match = /(?:^#|&)key=([\w-]+)/.exec(location.hash);
  try {
    if (match) {
      sessionStorage.setItem(KEY_STORE, match[1]!);
      history.replaceState(history.state, "", location.pathname + location.search);
    }
    return sessionStorage.getItem(KEY_STORE);
  } catch {
    return match?.[1] ?? null;
  }
}
sessionKey();

/** A failed call, with the service's reasons when it gave any. */
export class WorkflowRequestError extends Error {
  override name = "WorkflowRequestError";
  readonly status: number;
  readonly problems: readonly string[];
  /** True when no workflow service answered at all (not started, or a static build). */
  readonly offline: boolean;
  constructor(message: string, status: number, problems: readonly string[] = [], offline = false) {
    super(message);
    this.status = status;
    this.problems = problems;
    this.offline = offline;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { ...(method === "GET" ? {} : { "x-youi-session": sessionKey() ?? "" }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new WorkflowRequestError("The rule editor service is not reachable.", 0, [], true);
  }
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) throw new WorkflowRequestError("The rule editor service is not running.", response.status, [], true);
  const data = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const error = data as ApiError;
    if (response.status === 401) throw new WorkflowRequestError("This tab cannot make changes: open the hub from the link `youi editor` printed in its terminal (it carries this run's key).", 401);
    throw new WorkflowRequestError(error.error ?? `HTTP ${response.status}`, response.status, error.problems ?? []);
  }
  return data as T;
}

export const workflowApi = {
  info: () => call<WorkflowInfo>("GET", "/info"),
  rules: () => call<{ rules: PublishedRule[] }>("GET", "/rules").then((r) => r.rules),
  drafts: () => call<{ drafts: DraftView[]; unreadable: Array<{ file: string; reason: string }> }>("GET", "/drafts"),
  draft: (id: string) => call<DraftView>("GET", `/drafts/${id}`),
  edit: (ruleId: string) => call<DraftView>("POST", "/drafts", { mode: "edit", ruleId }),
  create: () => call<DraftView>("POST", "/drafts", { mode: "create" }),
  save: (id: string, revision: number, content: DraftContent) => call<DraftView>("PUT", `/drafts/${id}`, { revision, content }),
  preview: (id: string) => call<DraftView>("POST", `/drafts/${id}/preview`),
  approve: (id: string, revision: number, previewId: string) => call<DraftView>("POST", `/drafts/${id}/approve`, { revision, previewId }),
  rebase: (id: string) => call<DraftView>("POST", `/drafts/${id}/rebase`),
  handoff: (id: string) => call<DraftView>("POST", `/drafts/${id}/handoff`),
  discard: (id: string) => call<DraftView>("DELETE", `/drafts/${id}`),
};

export type Remote<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: WorkflowRequestError };

export function asRequestError(error: unknown): WorkflowRequestError {
  return error instanceof WorkflowRequestError ? error : new WorkflowRequestError(error instanceof Error ? error.message : String(error), 0);
}

/** Load once per `key`; `reload` fetches again; `set` replaces the value with a fresher one a write returned. */
export function useRemote<T>(load: () => Promise<T>, key: string): { state: Remote<T>; reload: () => void; set: (value: T) => void } {
  const [state, setState] = useState<Remote<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    loadRef.current().then(
      (value) => mine === generation.current && setState({ status: "ready", value }),
      (error: unknown) => mine === generation.current && setState({ status: "error", error: asRequestError(error) }),
    );
  }, []);
  useEffect(() => {
    setState({ status: "loading" });
    reload();
    return () => {
      generation.current++;
    };
  }, [key, reload]);
  const set = useCallback((value: T) => {
    generation.current++;
    setState({ status: "ready", value });
  }, []);
  return { state, reload, set };
}
