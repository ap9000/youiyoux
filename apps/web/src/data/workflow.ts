/**
 * The design-change workflow service (rule, style and library drafts, and requests on captured screens), reached at /api: `youiyoux ui --project` starts it beside
 * the dev server, which proxies /api to it (same origin when the service serves a built hub). Unlike the snapshot, this is live
 * state, so nothing here is cached.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, DraftContent, DraftView, LibraryDraftContent, LibraryDraftView, PublishedRules, StyleDraftContent, StyleDraftView, WorkflowInfo } from "@youiyoux/workflow/api";
import type { RequestDoc, RequestStatus, RequestTarget, StatusReport } from "@youiyoux/core";
import { sessionKey } from "./session-key.ts";

export type { CheckCapability, DraftContent, DraftView, LibraryDraftContent, LibraryDraftView, Preview, PreviewFinding, PublishedRules, RuleDraftView, RuleFields, StyleContrast, StyleDraftContent, StyleDraftView, StylePreview, StyleSite, WorkflowInfo } from "@youiyoux/workflow/api";

const API = `${import.meta.env.BASE_URL}api`;

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
    if (response.status === 401) throw new WorkflowRequestError("This tab cannot make changes: open the hub from the link `youiyoux ui` printed in its terminal (it carries this run's key).", 401);
    throw new WorkflowRequestError(error.error ?? `HTTP ${response.status}`, response.status, error.problems ?? []);
  }
  return data as T;
}

/** The workspace hub's service (`youiyoux ui` in a workspace): every product's status, and opening another in this hub. */
export const workspaceApi = {
  get: () => call<WorkspaceView>("GET", "/workspace"),
  open: (index: number) => call<WorkspaceView>("POST", "/workspace/open", { index }),
  refresh: () => call<WorkspaceView>("POST", "/workspace/refresh"),
};

export interface WorkspaceView {
  readonly report: StatusReport;
  /** The product this hub shows: its place in report.projects. */
  readonly current: number;
}

export const workflowApi = {
  info: () => call<WorkflowInfo>("GET", "/info"),
  rules: () => call<PublishedRules>("GET", "/rules"),
  drafts: () => call<{ drafts: DraftView[]; unreadable: Array<{ file: string; reason: string }> }>("GET", "/drafts"),
  draft: (id: string) => call<DraftView>("GET", `/drafts/${id}`),
  edit: (ruleId: string) => call<DraftView>("POST", "/drafts", { mode: "edit", ruleId }),
  create: () => call<DraftView>("POST", "/drafts", { mode: "create" }),
  createStyle: (content: StyleDraftContent) => call<StyleDraftView>("POST", "/drafts", { kind: "style", content }),
  /** Discover's Save to Library (`save`) and Add to my project (`adopt`): a draft for a person to approve, never an install. */
  createLibrary: (content: LibraryDraftContent) => call<LibraryDraftView>("POST", "/drafts", { kind: "library", content }),
  save: (id: string, revision: number, content: DraftContent | StyleDraftContent) => call<DraftView>("PUT", `/drafts/${id}`, { revision, content }),
  preview: (id: string) => call<DraftView>("POST", `/drafts/${id}/preview`),
  /** `acknowledgeContrast`: a style draft's new WCAG AA failures (their keys), confirmed in the approval dialog. */
  approve: (id: string, revision: number, previewId: string, acknowledgeContrast?: readonly string[]) => call<DraftView>("POST", `/drafts/${id}/approve`, { revision, previewId, ...(acknowledgeContrast ? { acknowledgeContrast } : {}) }),
  rebase: (id: string) => call<DraftView>("POST", `/drafts/${id}/rebase`),
  handoff: (id: string) => call<DraftView>("POST", `/drafts/${id}/handoff`),
  discard: (id: string) => call<DraftView>("DELETE", `/drafts/${id}`),
  /** Comments and change requests on captured screens, in the product's .youi/requests. */
  requests: () => call<{ requests: RequestDoc[]; unreadable: Array<{ file: string; reason: string }> }>("GET", "/requests"),
  fileRequest: (kind: RequestDoc["kind"], body: string, target: RequestTarget) => call<RequestDoc>("POST", "/requests", { kind, body, target }),
  replyRequest: (id: string, body: string) => call<RequestDoc>("POST", `/requests/${id}/replies`, { body }),
  /** The screen when it was filed, and now with the component found again by its line. */
  compareRequest: (id: string) => call<RequestComparison>("GET", `/requests/${id}/compare`),
  /** Closing and reopening are a person's: the service refuses them from an agent. */
  moveRequest: (id: string, status: RequestStatus, body = "") => call<RequestDoc>("POST", `/requests/${id}/status`, { status, body }),
};

/** A picture of a request's screen, by the service's URL, and where its component is on it. */
export interface RequestPictureView {
  readonly url: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  readonly page: { readonly width: number; readonly height: number } | null;
  readonly at: string;
}

export interface RequestComparison {
  readonly before: RequestPictureView | null;
  readonly after: (RequestPictureView & { readonly sinceFiled: boolean; readonly found: boolean }) | null;
}

/** A URL the service gave (`/api/…`), under the hub's base. */
export const serviceUrl = (url: string): string => `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

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
