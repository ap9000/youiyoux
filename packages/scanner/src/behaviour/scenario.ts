/**
 * One probe scenario, from a fresh load: open the screen, find the target again by its identity,
 * click its trigger (only it), and positively identify the popup that opened, or say why not.
 * Written against `ProbePage`, so the decisions here don't depend on how the page is driven
 * (probe.ts drives a real headless Chromium behind its guards).
 */
import type { BehaviourPattern, PartRef } from "@youiyoux/core";
import { describeUrl, SIGN_IN_FIX, SIGN_IN_PATH, SIGN_IN_WORDS } from "./guards.ts";
import { ambiguousWords, matchTarget, type TargetKey } from "./identity.ts";
import type { FoundTarget, PopupFound } from "./in-page.ts";

/** What the guards refused (or, for sockets, blocked) while a page was open, and when. */
export interface GuardEvent {
  readonly kind: "write" | "origin" | "socket" | "navigation" | "window" | "dialog" | "service-worker" | "busy";
  readonly words: string;
  /** Before the trigger was clicked (load), or after (act). */
  readonly phase: "load" | "act";
}

/** A page a scenario drives. Every method is bounded by the caller's deadline. */
export interface ProbePage {
  /** Open the scenario's screen; the document's HTTP status, or null when it never answered. */
  load(): Promise<{ readonly status: number | null }>;
  /** The page's own address now (`location.href`). */
  location(): Promise<string>;
  signInForm(): Promise<boolean>;
  findTargets(): Promise<readonly FoundTarget[]>;
  /** Remember which popups of the pattern show before the click. */
  markShowing(pattern: BehaviourPattern): Promise<void>;
  /** From now on, what the guards see happened because of the click. */
  acting(): void;
  /** Click the trigger `findTargets()` returned at `index`: a real mouse click, on it only. */
  click(index: number, timeoutMs: number): Promise<void>;
  identify(index: number, pattern: BehaviourPattern, popup: PartRef | null): Promise<PopupFound>;
  events(): readonly GuardEvent[];
  wait(ms: number): Promise<void>;
}

export interface Stop {
  readonly why: string;
  readonly fix: string;
}

export type ScenarioOutcome =
  /** Internal only: the popup opened and was identified. Never a pass by itself. */
  | { readonly state: "opened"; readonly popup: Extract<PopupFound, { state: "open" }>; readonly info: readonly string[] }
  | ({ readonly state: "incomplete"; readonly info: readonly string[] } & Stop)
  /** The probe itself failed (not the app). */
  | ({ readonly state: "error"; readonly info: readonly string[] } & Stop);

const NOTHING_SENT = "Nothing was sent, and nothing was decided.";

/** Why a probe stops when its consent goes away (or changes) during the run. */
export const SWITCHED_OFF: Stop = { why: "probing was switched off, or the app moved, during the run, so probing stopped", fix: "Next: switch probing on again if you meant to, and run the probe again." };

/** Why the guards' events stop a scenario, if they do: anything refused but a socket, and other origins only once the trigger was clicked. */
export function stopFromEvents(events: readonly GuardEvent[]): Stop | null {
  const stop = events.find((e) => e.kind !== "socket" && (e.kind !== "origin" || e.phase === "act"));
  if (!stop) return null;
  const fix: Record<GuardEvent["kind"], string> = {
    write: stop.phase === "load" ? `Next: this screen sends data as it loads, so it can't be probed safely; probe a screen that doesn't. ${NOTHING_SENT}` : `Next: a popup that sends data as it opens can't be probed safely. ${NOTHING_SENT}`,
    origin: `Next: probes reach only the app's own address. ${NOTHING_SENT}`,
    navigation: "Next: probes stay on the screen they opened; a button that goes to another page isn't a popup to probe.",
    window: "Next: probes open no other windows; a button that opens one isn't a popup to probe.",
    dialog: "Next: a browser dialog (alert, confirm) isn't a popup a probe can check; use an in-page dialog.",
    "service-worker": "Next: service workers are blocked while probing; run the probe again.",
    busy: "Next: a screen that keeps many requests open at once can't be probed reliably; run the probe again when the dev server is idle.",
    socket: "",
  };
  return { why: stop.words, fix: fix[stop.kind] };
}

/** Facts worth saying that don't stop anything: blocked sockets, other addresses refused while loading. */
export function infoFromEvents(events: readonly GuardEvent[]): string[] {
  return [...new Set(events.filter((e) => e.kind === "socket" || (e.kind === "origin" && e.phase === "load")).map((e) => e.words))];
}

/** Where the page is, compared with where the scenario opened it: null while it hasn't moved. */
export function moved(start: string, now: string, origin: string): Stop | null {
  let a: URL;
  let b: URL;
  try {
    a = new URL(start);
    b = new URL(now);
  } catch {
    return { why: "the page's address couldn't be read", fix: "Next: run the probe again." };
  }
  if (a.href === b.href) return null;
  if (b.origin !== origin) return { why: `the screen went to another address (${b.protocol === "http:" || b.protocol === "https:" ? describeUrl(b.href, origin) : "an error page"}); nothing was loaded from it`, fix: "Next: probe a screen that stays on the app's own address." };
  if (SIGN_IN_PATH.test(b.pathname)) return { why: SIGN_IN_WORDS, fix: SIGN_IN_FIX };
  return { why: `the page's address changed to ${describeUrl(b.href, origin)}${b.hash && b.hash !== a.hash ? ` (${b.hash.length > 40 ? "a new hash" : b.hash})` : ""}; probes stay on the screen they opened`, fix: "Next: probes stay on one screen; a popup whose opening changes the address (history or hash) isn't probed yet." };
}

/** Open the screen and check it can be probed: it stayed put, answered, and isn't asking for a sign-in. */
export async function openScreen(page: ProbePage, start: string, origin: string): Promise<Stop | null> {
  const { status } = await page.load();
  const at = await page.location();
  const away = moved(start, at, origin);
  if (away) return away;
  const stopped = stopFromEvents(page.events());
  if (stopped) return stopped;
  if (status === 401 || status === 403) return { why: SIGN_IN_WORDS, fix: SIGN_IN_FIX };
  if (status === null) return { why: "the screen didn't load", fix: "Next: check the dev server is running at the app's address, and run the probe again." };
  if (status >= 400) return { why: `the screen answered HTTP ${status}`, fix: "Next: check the screen opens in a browser, and run the probe again." };
  if (await page.signInForm()) return { why: SIGN_IN_WORDS, fix: SIGN_IN_FIX };
  return null;
}

export interface Budgets {
  /** Polling for the popup after the click (the plan's open budget). */
  readonly openMs: number;
  readonly pollMs: number;
  /** Once identified, how long the page is watched for anything else the click set off (a window, a request). */
  readonly graceMs: number;
}

/**
 * Open the screen fresh, find `wanted` again, click its trigger, identify the popup. Every stop is
 * `incomplete` with its reason; nothing here ever passes a check.
 */
export async function openAndIdentify(
  page: ProbePage,
  args: {
    readonly start: string;
    readonly origin: string;
    readonly wanted: TargetKey;
    readonly popup: PartRef | null;
    readonly deadline: () => number;
    readonly budgets: Budgets;
    /** Asked immediately before the click: null while probing is still allowed, else why not (nothing is clicked). */
    readonly beforeClick?: () => Promise<Stop | null>;
    /** Aborted when probing is switched off while the scenario runs. */
    readonly signal?: AbortSignal;
  },
): Promise<ScenarioOutcome> {
  const { start, origin, wanted, deadline, budgets } = args;
  const incomplete = (stop: Stop): ScenarioOutcome => ({ state: "incomplete", ...stop, info: infoFromEvents(page.events()) });
  const cancelled = (): Stop | null => (args.signal?.aborted ? SWITCHED_OFF : null);
  const opened = await openScreen(page, start, origin);
  if (opened) return incomplete(opened);
  const found = await page.findTargets();
  const match = matchTarget(wanted, found.map((f) => ({ ...f, route: wanted.route })));
  if (match.state === "ambiguous") return incomplete(ambiguousWords(wanted, match.count));
  if (match.state === "missing") return incomplete({ why: `the button '${wanted.accessibleName || "(no name)"}' wasn't on the screen when it was opened again`, fix: "Next: run the probe again; a button that shows only after something else happens isn't probed yet." });
  await page.markShowing(wanted.pattern);
  // Consent is read again at the last moment: switched off, moved or switched again since the run
  // began (another generation), and nothing is clicked.
  const refused = cancelled() ?? (await args.beforeClick?.()) ?? cancelled();
  if (refused) return incomplete(refused);
  page.acting();
  try {
    await page.click(match.index, Math.max(1, deadline() - Date.now()));
  } catch (error: unknown) {
    const stopped = stopFromEvents(page.events());
    if (stopped) return incomplete(stopped);
    return incomplete({ why: `the button '${wanted.accessibleName || "(no name)"}' couldn't be clicked: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`, fix: "Next: make sure nothing covers the button and it stays on the screen, then run the probe again." });
  }
  const clicked = Date.now();
  const end = deadline();
  const until = Math.min(end, clicked + budgets.openMs);
  for (;;) {
    const stopped = cancelled() ?? stopFromEvents(page.events()) ?? moved(start, await page.location(), origin);
    if (stopped) return incomplete(stopped);
    const popup = await page.identify(match.index, wanted.pattern, args.popup);
    if (popup.state === "open") {
      // Watch a moment longer: a page that leaves, sends or opens a window just after opening is still stopped.
      await page.wait(Math.max(0, Math.min(budgets.graceMs, deadline() - Date.now())));
      const after = stopFromEvents(page.events()) ?? moved(start, await page.location(), origin);
      return after ? incomplete(after) : { state: "opened", popup, info: infoFromEvents(page.events()) };
    }
    if (popup.state === "several") return incomplete({ why: `couldn't tell which of ${popup.count} ${wanted.pattern === "modal-dialog" ? "dialogs" : "popups"} this button opened`, fix: "Next: point the button at its popup with aria-controls (or popovertarget), or declare the contract's popup part." });
    if (popup.state === "was-open") return incomplete({ why: `the popup the button names (${popup.how}) was already showing before the click, so we couldn't tell the click opened it`, fix: "Next: keep the popup closed until its button is clicked, then run the probe again." });
    if (Date.now() + budgets.pollMs > until) {
      const late = end < clicked + budgets.openMs;
      return incomplete(late ? { why: "ran out of time before the popup could be identified", fix: "Next: make sure the dev server is idle, then run the probe again." } : { why: "clicking the button didn't open anything we could identify", fix: "Next: give the button aria-controls naming its popup (or popovertarget), or declare the contract's popup part; a popup must show (not hidden, inert or aria-hidden) within 2 s." });
    }
    await page.wait(budgets.pollMs);
  }
}
