/**
 * Behaviour: how a screen's popups behave (docs/plans/behaviour-rules.md, "UI"). On a picked
 * component it is the canvas's Behaviour tab (Run on this component tests only that component's
 * popups); on a screen's page it is the screen's section (Run on this screen tests them all), so the
 * two scopes are never confused.
 *
 * Without consent it shows the words and the switch, nothing else. With it, one row per check: the
 * result as text and a small sage or clay dot (never a fill), why and the fix always visible on a
 * failure, can't tell with its why, a plain note when the popup's data was blocked, evidence behind a
 * button. A stale result says so and is not counted. A failed one is filed as a change request whose
 * acceptance the service builds.
 */
import { clsx } from "clsx";
import { useState } from "react";
import type { BehaviourCheckId, BehaviourPattern, RequestDoc } from "@youiyoux/core";
import { behaviourApi, useBehaviour, type BehaviourActive, type BehaviourResultView, type BehaviourTargetFilter, type BehaviourView } from "../../data/behaviour.ts";
import { asRequestError, type WorkflowRequestError } from "../../data/workflow.ts";
import { plural } from "../../lib/plural.ts";
import { when } from "../../lib/when.ts";
import { Button } from "../../ui/Button.tsx";

/** Each check in a few plain words, beside its id. */
const CHECK_WORDS: Record<BehaviourCheckId, string> = {
  "trigger-state": "the button says when it is open",
  "dismiss-escape": "Esc closes it",
  "focus-into": "opening puts focus inside",
  "focus-return": "focus goes back to the button",
  "focus-trap": "Tab stays inside the dialog",
  "arrow-keys": "arrow keys move through the items",
};
const NOUN: Record<BehaviourPattern, string> = { "menu-button": "Menu", "combobox-listbox": "Listbox", "modal-dialog": "Dialog", popover: "Popover" };
/** Popups shown before the rest fold. */
const SHOWN = 5;

/** What a row says its result is, and its dot: sage for passed, clay for failed, none otherwise. */
function verdict(r: BehaviourResultView): { label: string; dot: "pass" | "fail" | null } {
  if (r.stale.length > 0) return { label: "Stale", dot: null };
  if (!r.counts && (r.state === "passed" || r.state === "failed")) return { label: "Doesn't count", dot: null };
  if (r.state === "passed") return { label: "Passed", dot: "pass" };
  if (r.state === "failed") return { label: "Failed", dot: "fail" };
  if (r.state === "error") return { label: "Probe error", dot: null };
  return { label: "Can't tell", dot: null };
}

const popupKey = (r: BehaviourResultView): string => JSON.stringify([r.target.pattern, r.target.component, r.target.accessibleName, r.target.ordinal ?? null]);

function Row({ result, onFiled }: { result: BehaviourResultView; onFiled?: (request: RequestDoc) => void }) {
  const [open, setOpen] = useState(false);
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState<RequestDoc | null>(null);
  const [error, setError] = useState<WorkflowRequestError | null>(null);
  const { label, dot } = verdict(result);
  const stale = result.stale.length > 0;
  const failed = result.counts && result.state === "failed";
  const decided = result.state === "passed";
  const evidence = result.info.length > 0 || result.evidence.length > 0;
  const file = (): void => {
    setFiling(true);
    setError(null);
    behaviourApi
      .file(result)
      .then((request) => {
        setFiled(request);
        onFiled?.(request);
      })
      .catch((e: unknown) => setError(asRequestError(e)))
      .finally(() => setFiling(false));
  };
  return (
    <li className="space-y-1 px-3 py-2" data-behaviour-row={result.check} data-state={stale ? "stale" : result.state}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <code className="font-mono text-mono-sm text-ink">{result.check}</code>
        <span className="min-w-0 text-small text-muted">{CHECK_WORDS[result.check]}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-small text-ink">
          {dot && <span aria-hidden className={clsx("size-1.5 rounded-full", dot === "pass" ? "bg-success" : "bg-danger")} />}
          {label}
        </span>
      </div>
      {stale ? (
        <p className="text-small text-muted">The code or rule changed since this run ({result.stale.join(", ")}), so it isn&rsquo;t counted. Run it again.</p>
      ) : (
        !decided && (
          <div className="space-y-0.5 text-small">
            <p className="break-words text-ink-2">{result.why}</p>
            <p className="break-words text-muted">{result.fix}</p>
          </div>
        )
      )}
      {!stale && !result.counts && (result.state === "passed" || result.state === "failed") && <p className="text-small text-muted">Its run&rsquo;s results don&rsquo;t add up (this popup was found more than once), so it isn&rsquo;t counted. Run it again.</p>}
      {result.dataBlocked && <p className="text-small text-muted">Tested with its data blocked: the popup asked for data when it opened, and the probe didn&rsquo;t send it.</p>}
      {(evidence || failed) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {evidence && (
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide evidence" : "Show evidence"}
            </Button>
          )}
          {failed && !filed && (
            <Button size="sm" variant="outline" disabled={filing} onClick={file}>
              File as change request
            </Button>
          )}
          {filed && (
            <span className="text-small text-muted" role="status">
              Filed as <code className="font-mono text-mono-sm text-ink-2">{filed.id}</code>: it is addressed once this check passes in a newer run.
            </span>
          )}
        </div>
      )}
      {open && evidence && (
        <ul className="space-y-0.5 rounded-sm bg-sunken px-2 py-1.5 text-small text-ink-2" data-behaviour-evidence>
          {result.info.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
          {result.evidence.map((path) => (
            <li key={path} className="font-mono text-mono-sm break-all">
              {path}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-small text-danger" role="alert">
          {error.message}
        </p>
      )}
    </li>
  );
}

function Popup({ results, onFiled }: { results: readonly BehaviourResultView[]; onFiled?: (request: RequestDoc) => void }) {
  const t = results[0]!.target;
  return (
    <li className="border-b border-line last:border-b-0" data-behaviour-popup>
      <div className="flex flex-wrap items-baseline gap-x-2 bg-raised px-3 py-1.5">
        <span className="text-small font-medium text-ink">
          {NOUN[t.pattern]} &lsquo;{t.accessibleName || "no name"}&rsquo;{t.ordinal !== undefined ? ` #${t.ordinal + 1}` : ""}
        </span>
        {t.component && <code className="font-mono text-mono-sm text-muted">{t.component}</code>}
        {t.file && t.line && (
          <code className="ml-auto truncate font-mono text-mono-sm text-faint" {...(t.lineIs === "component" ? { title: "The component's own line: where the app renders it wasn't found" } : t.renderedBy ? { title: `Where this button is used. The component that renders it, which your code uses in more than one place, is at ${t.renderedBy.file}:${t.renderedBy.line}` } : {})}>
            {t.file}:{t.line}
            {t.lineIs === "component" && " (its own line)"}
            {t.renderedBy && ` (rendered by ${t.renderedBy.file}:${t.renderedBy.line})`}
          </code>
        )}
      </div>
      <ul className="divide-y divide-line">
        {results.map((r) => (
          <Row key={`${r.rule} ${r.index}`} result={r} onFiled={onFiled} />
        ))}
      </ul>
    </li>
  );
}

/** "Testing 2 popups on /flows…", or what else is running. */
function Running({ running, route }: { running: BehaviourActive; route: string }) {
  const what = running.popups === null ? "Finding popups" : `Testing ${plural(running.popups, "popup")}`;
  return (
    <p className="text-small text-ink-2" role="status" aria-live="polite" data-behaviour-running>
      {running.route === route ? `${what} on ${route}…` : `A run on ${running.route} is going; this one waits for it to finish.`}
    </p>
  );
}

interface PanelProps {
  readonly route: string;
  /** A picked component: its popups only (its name as the page renders it). None: the whole screen. */
  readonly component?: { readonly name: string } | null;
  readonly onFiled?: (request: RequestDoc) => void;
}

export function BehaviourPanel({ route, component = null, onFiled }: PanelProps) {
  const { state, running, last, failure, busy, run, switchOn } = useBehaviour(route);
  if (state.status === "loading") return <p className="text-small text-muted">Reading behaviour results…</p>;
  if (state.status === "error") {
    return (
      <p className="text-small text-muted" data-behaviour-offline>
        {state.error.offline ? "Behaviour checks need the local service: open the hub with youiyoux ui --project." : state.error.message}
      </p>
    );
  }
  const view = state.view;
  if (!view.consent.on) return <Consent view={view} busy={busy} failure={failure} onSwitch={switchOn} />;
  const target: BehaviourTargetFilter | null = component ? { component: component.name } : null;
  const shown = view.results.filter((r) => r.state !== "not-applicable" && (!component || r.target.component === component.name));
  const groups = [...new Map(shown.map((r) => [popupKey(r), shown.filter((x) => popupKey(x) === popupKey(r))])).values()];
  const failedNow = shown.filter((r) => r.counts && r.state === "failed").length;
  const lastProblem = last && last.route === route && last.problem ? last.problem : null;
  return (
    <div className="space-y-2.5" data-behaviour-panel={component ? "component" : "screen"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 text-small text-ink-2">
          {component ? (
            <>
              Checks how <code className="font-mono text-mono-sm text-ink">{component.name}</code>&rsquo;s popups behave on {route}.
            </>
          ) : (
            <>Checks how every popup on {route} behaves.</>
          )}
        </p>
        <Button size="sm" variant="primary" disabled={busy || running !== null || view.rules.length === 0} onClick={() => run(target)}>
          {component ? "Run on this component" : "Run on this screen"}
        </Button>
      </div>
      {view.rules.length === 0 && <p className="text-small text-muted">No behaviour rules are on in this System, so there is nothing to check. Add a rule with check: engine behaviour to check popups.</p>}
      {running && <Running running={running} route={route} />}
      {failure && (
        <p className="text-small text-danger" role="alert">
          {failure.message}
        </p>
      )}
      {lastProblem && !running && <p className="text-small text-muted">The last run stored nothing: {lastProblem}</p>}
      {view.problem && <p className="text-small text-muted">The stored run couldn&rsquo;t be read ({view.problem}). Run it again.</p>}
      {view.run && (
        <p className="text-small text-muted" data-behaviour-run>
          Results from {when(view.run.at)}
          {view.run.why ? `: it couldn't be probed. ${view.run.why} ${view.run.fix ?? ""}` : `. ${view.run.coverage}`}
          {failedNow > 0 && ` ${plural(failedNow, "check")} failed.`}
        </p>
      )}
      {view.run && (view.run.notes ?? []).map((note) => (
        <p key={note} className="text-small text-muted" data-behaviour-note>
          Note: {note}
        </p>
      ))}
      {!view.run && !view.problem && !running && <p className="text-small text-muted">Nothing has been probed on {route} yet.</p>}
      {view.run && groups.length === 0 && component && !view.run.why && (
        <p className="text-small text-muted">No popups of {component.name} were found in the last run. A popup belongs to the component that renders its button: pick that one, or run the whole screen from its page.</p>
      )}
      {groups.length > 0 && (
        <ul className="overflow-hidden rounded-md border border-line" aria-label={`Behaviour results on ${route}`}>
          {groups.slice(0, SHOWN).map((g) => (
            <Popup key={popupKey(g[0]!)} results={g} onFiled={onFiled} />
          ))}
        </ul>
      )}
      {groups.length > SHOWN && (
        <details className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-1.5 text-small text-muted hover:text-ink">and {plural(groups.length - SHOWN, "more popup")}</summary>
          <ul className="border-t border-line">
            {groups.slice(SHOWN).map((g) => (
              <Popup key={popupKey(g[0]!)} results={g} onFiled={onFiled} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** No consent yet: the plan's words and the switch, nothing else. */
function Consent({ view, busy, failure, onSwitch }: { view: BehaviourView; busy: boolean; failure: WorkflowRequestError | null; onSwitch: () => void }) {
  const c = view.consent;
  return (
    <div className="space-y-2" data-behaviour-consent>
      <p className="text-small text-ink-2">{c.words}</p>
      {c.origin && c.allowedOrigin && !c.matches && (
        <p className="text-small text-muted">
          Probing was switched on for <code className="font-mono text-mono-sm break-all">{c.allowedOrigin}</code>, but the app now runs at <code className="font-mono text-mono-sm break-all">{c.origin}</code>.
        </p>
      )}
      {c.origin ? (
        <Button size="sm" variant="primary" disabled={busy} onClick={onSwitch}>
          Switch probing on for <span className="font-mono text-mono-sm">{c.origin}</span>
        </Button>
      ) : (
        <p className="text-small text-muted">{c.why}</p>
      )}
      {failure && (
        <p className="text-small text-danger" role="alert">
          {failure.message}
        </p>
      )}
    </div>
  );
}
