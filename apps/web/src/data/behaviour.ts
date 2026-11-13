/**
 * Behaviour probes through the local service (docs/plans/behaviour-rules.md, "UI"): whether probing
 * is switched on for the app, a route's stored results held to now, a run started for the route or
 * for one component's popups (and polled until it ends), and a failed result filed as a change
 * request whose acceptance the service builds. The service refuses anything else; nothing here
 * decides what counts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BehaviourCheckId, BehaviourPattern, BehaviourResult, BehaviourRouteRun, RequestDoc } from "@youiyoux/core";
import { asRequestError, workflowCall, type WorkflowRequestError } from "./workflow.ts";

/** Which of a route's popups a run tests: one component's (null: plain markup), narrowed when more is given. */
export interface BehaviourTargetFilter {
  readonly component: string | null;
  readonly pattern?: BehaviourPattern;
  readonly accessibleName?: string;
  readonly ordinal?: number;
}

export interface BehaviourConsentView {
  readonly screens: boolean;
  readonly on: boolean;
  /** base's origin now: what switching on binds consent to (null: base can't be probed). */
  readonly origin: string | null;
  readonly allowedOrigin: string | null;
  readonly matches: boolean;
  /** Why it is off, and what to do. */
  readonly why: string | null;
  /** The words shown beside the switch. */
  readonly words: string;
}

export interface BehaviourActive {
  readonly route: string;
  readonly target: BehaviourTargetFilter | null;
  readonly startedAt: string;
  readonly popups: number | null;
  readonly by: "person" | "agent";
}

export interface BehaviourLast {
  readonly route: string;
  readonly target: BehaviourTargetFilter | null;
  readonly at: string;
  readonly runId: string | null;
  readonly problem: string | null;
}

/** A stored result held to now: its place in its run, why it is stale, and whether it counts. */
export type BehaviourResultView = BehaviourResult & { readonly index: number; readonly stale: readonly string[]; readonly counts: boolean };

export interface BehaviourView {
  readonly route: string;
  readonly rules: ReadonlyArray<{ readonly id: string; readonly title: string; readonly severity: string; readonly check: BehaviourCheckId }>;
  readonly run: Omit<BehaviourRouteRun, "results"> | null;
  readonly results: readonly BehaviourResultView[];
  readonly problem: string | null;
  readonly consent: BehaviourConsentView;
  readonly running: BehaviourActive | null;
  readonly last: BehaviourLast | null;
}

export const behaviourApi = {
  view: (route: string) => workflowCall<BehaviourView>("GET", `/behaviour?route=${encodeURIComponent(route)}`),
  consent: () => workflowCall<BehaviourConsentView>("GET", "/screens/behaviour"),
  /** The authenticated switch: consent bound by the service to the origin of screens.json's base. */
  switchOn: () => workflowCall<{ allowedOrigin: string | null }>("POST", "/screens/behaviour", { allow: true }),
  run: (route: string, target: BehaviourTargetFilter | null) => workflowCall<{ running: BehaviourActive }>("POST", "/behaviour/run", { route, ...(target ? { target } : {}) }),
  status: () => workflowCall<{ running: BehaviourActive | null; last: BehaviourLast | null }>("GET", "/behaviour/run"),
  /** A failed result as a change request: named by its route, run and place; the service builds the rest. */
  file: (result: BehaviourResultView) => workflowCall<RequestDoc>("POST", "/requests", { kind: "change", behaviour: { route: result.route, runId: result.runId, index: result.index } }),
};

/** How often a running probe is asked how it goes. */
export const POLL_MS = 1000;

export type BehaviourState = { status: "loading" } | { status: "ready"; view: BehaviourView } | { status: "error"; error: WorkflowRequestError };

/**
 * A route's behaviour, kept current: loaded, polled while any run of this app is going, and loaded
 * again once it ends. `run` starts one (refusals come back as `failure`), `switchOn` asks the service
 * to switch probing on.
 */
export function useBehaviour(route: string): {
  state: BehaviourState;
  running: BehaviourActive | null;
  last: BehaviourLast | null;
  failure: WorkflowRequestError | null;
  busy: boolean;
  run: (target: BehaviourTargetFilter | null) => void;
  switchOn: () => void;
} {
  const [state, setState] = useState<BehaviourState>({ status: "loading" });
  const [running, setRunning] = useState<BehaviourActive | null>(null);
  const [last, setLast] = useState<BehaviourLast | null>(null);
  const [failure, setFailure] = useState<WorkflowRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const mine = ++generation.current;
    behaviourApi.view(route).then(
      (view) => {
        if (mine !== generation.current) return;
        setState({ status: "ready", view });
        setRunning(view.running);
        setLast(view.last);
      },
      (error: unknown) => mine === generation.current && setState({ status: "error", error: asRequestError(error) }),
    );
  }, [route]);
  useEffect(() => {
    setState({ status: "loading" });
    setFailure(null);
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  // While a run is going, ask how it goes; when it ends, read the results again.
  const going = running ? `${running.route} ${running.startedAt}` : null;
  useEffect(() => {
    if (!going) return;
    let stopped = false;
    const timer = setInterval(() => {
      behaviourApi.status().then(
        (now) => {
          if (stopped) return;
          setLast(now.last);
          if (now.running) setRunning(now.running);
          else {
            setRunning(null);
            load();
          }
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [going, load]);
  const act = (work: () => Promise<void>): void => {
    setBusy(true);
    setFailure(null);
    work()
      .catch((e: unknown) => setFailure(asRequestError(e)))
      .finally(() => setBusy(false));
  };
  return {
    state,
    running,
    last,
    failure,
    busy,
    run: (target) => act(async () => setRunning((await behaviourApi.run(route, target)).running)),
    switchOn: () => act(async () => {
      await behaviourApi.switchOn();
      load();
    }),
  };
}
