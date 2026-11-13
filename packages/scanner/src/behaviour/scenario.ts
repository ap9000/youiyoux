/**
 * One probe scenario, from a fresh load: open the screen, find the target again by its identity,
 * click its trigger (only it), and positively identify the popup that opened, or say why not.
 * Written against `ProbePage`, so the decisions here don't depend on how the page is driven
 * (probe.ts drives a real headless Chromium behind its guards).
 */
import { cleanText, pageText, type BehaviourCheckId, type BehaviourPattern, type PartRef } from "@youiyoux/core";
import { describeUrl, SIGN_IN_FIX, SIGN_IN_PATH, SIGN_IN_WORDS } from "./guards.ts";
import { ambiguousWords, matchTarget, type TargetKey } from "./identity.ts";
import type { FocusFacts, FocusPlaced, FoundTarget, PopupFound, TriggerFacts } from "./in-page.ts";

/** What the guards refused (or, for sockets, blocked) while a page was open, and when. */
export interface GuardEvent {
  /** data: a data request after the click, blocked; the scenario goes on, tested with its data blocked. */
  readonly kind: "write" | "origin" | "socket" | "navigation" | "window" | "dialog" | "service-worker" | "busy" | "data";
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
  /** The trigger's own ARIA state now (read in the probe's isolated world), against the popup identified last, if any. */
  triggerFacts(index: number): Promise<TriggerFacts>;
  /** From now on, what the guards see happened because of the click. */
  acting(): void;
  /** Click the trigger `findTargets()` returned at `index`: a real mouse click, on it only. */
  click(index: number, timeoutMs: number): Promise<void>;
  identify(index: number, pattern: BehaviourPattern, popup: PartRef | null): Promise<PopupFound>;
  /** Where effective focus is now, against the trigger and the popup `identify` found last; nothing is moved. */
  focus(index: number): Promise<FocusFacts>;
  /** Effective focus inside the popup `identify` found last (or on the combobox), moved there with focus() if it isn't. */
  placeFocus(index: number, pattern: BehaviourPattern): Promise<FocusPlaced>;
  /** The very popup identified is still connected and showing, with effective focus inside it (or on the combobox). */
  ready(index: number, pattern: BehaviourPattern): Promise<boolean>;
  /** The identified popup's state, judged on that element (a removed one reconciled by identity); unknown is never closed. */
  popupState(index: number, pattern: BehaviourPattern, popup: PartRef | null): Promise<"open" | "closed" | "unknown">;
  /**
   * One safe key (SAFE_KEYS), as real keyboard input. Refused before anything is sent: any key that
   * isn't a safe key, and any the page's check doesn't send (CHECK_KEYS; none for a control run).
   */
  press(key: SafeKey): Promise<void>;
  /** Every key sent to this page, in order. */
  keys(): readonly string[];
  events(): readonly GuardEvent[];
  wait(ms: number): Promise<void>;
}

/**
 * The only keys a probe may send, in this youiyoux: Escape (dismiss-escape). The plan's other safe
 * keys (Tab, Shift+Tab, arrows, Home, End) are added with the checks that need them; Enter, Space
 * and typing never are.
 */
export const SAFE_KEYS = ["Escape"] as const;
export type SafeKey = (typeof SAFE_KEYS)[number];

/**
 * The keys each check sends, and no others: a page opened for a check refuses every other key
 * before anything is sent, so a check never widens what is pressed by accident. A control run
 * sends none. A check that needs no key (trigger-state, focus-into) has none.
 */
export const CHECK_KEYS: Readonly<Record<BehaviourCheckId, readonly SafeKey[]>> = {
  "trigger-state": [],
  "dismiss-escape": ["Escape"],
  "focus-into": [],
  "focus-return": [],
  "focus-trap": [],
  "arrow-keys": [],
};

/** Refuses any key that isn't a safe key, or (with `allowed`) one the page's check doesn't send, before anything is sent. */
export function assertSafeKey(key: string, allowed: readonly string[] = SAFE_KEYS): asserts key is SafeKey {
  if (!(SAFE_KEYS as readonly string[]).includes(key)) throw new Error(`the probe sends only ${SAFE_KEYS.join(", ")}; ${JSON.stringify(key)} was refused and nothing was sent`);
  if (!allowed.includes(key)) throw new Error(`this check sends ${allowed.length ? `only ${allowed.join(", ")}` : "no keys"}; ${JSON.stringify(key)} was refused and nothing was sent`);
}

export interface Stop {
  readonly why: string;
  readonly fix: string;
}

export type ScenarioOutcome =
  /** Internal only: the popup opened and was identified. Never a pass by itself. */
  | {
      readonly state: "opened";
      readonly popup: Extract<PopupFound, { state: "open" }>;
      readonly info: readonly string[];
      readonly dataBlocked?: boolean;
      /** The trigger's index on this page (findTargets). */
      readonly index: number;
      /** The trigger's ARIA state just before it was clicked (closed). */
      readonly closed: TriggerFacts;
    }
  /** A decided check (DECIDED_BEHAVIOUR_CHECKS only): it ran and passed or failed. */
  | ({ readonly state: "passed" | "failed"; readonly popup: Extract<PopupFound, { state: "open" }>; readonly info: readonly string[]; readonly dataBlocked?: boolean } & Stop)
  | ({ readonly state: "incomplete"; readonly info: readonly string[]; readonly dataBlocked?: boolean } & Stop)
  /** The probe itself failed (not the app). */
  | ({ readonly state: "error"; readonly info: readonly string[]; readonly dataBlocked?: boolean } & Stop);

const NOTHING_SENT = "Nothing was sent, and nothing was decided.";

/** An error's first line for a result's words: cleaned and capped (a browser's message can carry page text). */
export const errorWords = (error: unknown): string => cleanText((error instanceof Error ? error.message : String(error)).split("\n")[0], 160);
/** How long a refusal the page set off is waited for, when the page stopped answering. */
const LATE_MS = 150;
/** After focus is placed, how long the page's focus handlers get before the popup is checked again. */
const FOCUS_SETTLE_MS = 100;

/** Why a probe stops when its consent goes away (or changes) during the run. */
export const SWITCHED_OFF: Stop = { why: "probing was switched off, or the app moved, during the run, so probing stopped", fix: "Next: switch probing on again if you meant to, and run the probe again." };

/** Why the guards' events stop a scenario, if they do: anything refused but a socket, and other origins only once the trigger was clicked. */
export function stopFromEvents(events: readonly GuardEvent[]): Stop | null {
  const stop = events.find((e) => e.kind !== "socket" && e.kind !== "data" && (e.kind !== "origin" || e.phase === "act"));
  if (!stop) return null;
  const fix: Record<GuardEvent["kind"], string> = {
    write: stop.phase === "load" ? `Next: this screen sends data as it loads, so it can't be probed safely; probe a screen that doesn't. ${NOTHING_SENT}` : `Next: a popup that sends data as it opens can't be probed safely. ${NOTHING_SENT}`,
    origin: `Next: probes reach only the app's own address. ${NOTHING_SENT}`,
    navigation: "Next: probes stay on the screen they opened; a button that goes to another page isn't a popup to probe.",
    window: "Next: probes open no other windows; a button that opens one isn't a popup to probe.",
    dialog: "Next: a browser dialog (alert, confirm) isn't a popup a probe can check; use an in-page dialog.",
    "service-worker": "Next: service workers are blocked while probing; run the probe again.",
    data: "",
    busy: "Next: a screen that keeps many requests open at once can't be probed reliably; run the probe again when the dev server is idle.",
    socket: "",
  };
  return { why: stop.words, fix: fix[stop.kind] };
}

/** Facts worth saying that don't stop anything: blocked sockets, other addresses refused while loading, data blocked after the click. */
export function infoFromEvents(events: readonly GuardEvent[]): string[] {
  return [...new Set(events.filter((e) => e.kind === "socket" || e.kind === "data" || (e.kind === "origin" && e.phase === "load")).map((e) => e.words))];
}

/** Whether the scenario ran with its data blocked (a data request after the click was refused). */
export const dataBlockedIn = (events: readonly GuardEvent[]): boolean => events.some((e) => e.kind === "data");

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
  return { why: `the page's address changed to ${describeUrl(b.href, origin)}${b.hash && b.hash !== a.hash ? ` (${pageText(b.hash, 40)})` : ""}; probes stay on the screen they opened`, fix: "Next: probes stay on one screen; a popup whose opening changes the address (history or hash) isn't probed yet." };
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
  const incomplete = (stop: Stop): ScenarioOutcome => ({ state: "incomplete", ...stop, info: infoFromEvents(page.events()), dataBlocked: dataBlockedIn(page.events()) });
  const cancelled = (): Stop | null => (args.signal?.aborted ? SWITCHED_OFF : null);
  const opened = await openScreen(page, start, origin);
  if (opened) return incomplete(opened);
  const found = await page.findTargets();
  const match = matchTarget(wanted, found.map((f) => ({ ...f, route: wanted.route })));
  if (match.state === "ambiguous") return incomplete(ambiguousWords(wanted, match.count));
  if (match.state === "missing") return incomplete({ why: `the button ${pageText(wanted.accessibleName)} wasn't on the screen when it was opened again`, fix: "Next: run the probe again; a button that shows only after something else happens isn't probed yet." });
  await page.markShowing(wanted.pattern);
  const closed = await page.triggerFacts(match.index);
  // Consent is read again at the last moment: switched off, moved or switched again since the run
  // began (another generation), and nothing is clicked.
  const refused = cancelled() ?? (await args.beforeClick?.()) ?? cancelled();
  if (refused) return incomplete(refused);
  page.acting();
  try {
    await page.click(match.index, Math.max(1, deadline() - Date.now()));
  } catch (error: unknown) {
    // A refusal the click set off may still be on its way to the guards: give it a moment.
    await page.wait(LATE_MS);
    const stopped = stopFromEvents(page.events());
    if (stopped) return incomplete(stopped);
    return incomplete({ why: `the button ${pageText(wanted.accessibleName)} couldn't be clicked: ${errorWords(error)}`, fix: "Next: make sure nothing covers the button and it stays on the screen, then run the probe again." });
  }
  const clicked = Date.now();
  const end = deadline();
  const until = Math.min(end, clicked + budgets.openMs);
  for (;;) {
    const stopped = cancelled() ?? stopFromEvents(page.events()) ?? moved(start, await page.location(), origin);
    if (stopped) return incomplete(stopped);
    let popup: PopupFound;
    try {
      popup = await page.identify(match.index, wanted.pattern, args.popup);
    } catch (error: unknown) {
      // The document the probe was watching went away (a blocked form submission or navigation can
      // replace it with an error page): say what the guards saw, else that.
      await page.wait(LATE_MS);
      return incomplete(cancelled() ?? stopFromEvents(page.events()) ?? moved(start, await page.location().catch(() => start), origin) ?? { why: `the page changed under the probe: ${errorWords(error)}`, fix: "Next: run the probe again; a popup whose opening replaces the page can't be probed." });
    }
    if (popup.state === "open") {
      // Watch a moment longer: a page that leaves, sends or opens a window just after opening is still stopped.
      await page.wait(Math.max(0, Math.min(budgets.graceMs, deadline() - Date.now())));
      const after = stopFromEvents(page.events()) ?? moved(start, await page.location(), origin);
      return after ? incomplete(after) : { state: "opened", popup, info: infoFromEvents(page.events()), dataBlocked: dataBlockedIn(page.events()), index: match.index, closed };
    }
    if (popup.state === "several") return incomplete({ why: `couldn't tell which of ${popup.count} ${wanted.pattern === "modal-dialog" ? "dialogs" : "popups"} this button opened`, fix: "Next: point the button at its popup with aria-controls (or popovertarget), or declare the contract's popup part." });
    if (popup.state === "was-open") return incomplete({ why: `the popup the button names (${popup.how}) was already showing before the click, so we couldn't tell the click opened it`, fix: "Next: keep the popup closed until its button is clicked, then run the probe again." });
    if (Date.now() + budgets.pollMs > until) {
      const late = end < clicked + budgets.openMs;
      const blocked = page.events().filter((e) => e.kind === "data").map((e) => /\((\S+ [^)]+)\)/.exec(e.words)?.[1]).filter(Boolean);
      return incomplete(late ? { why: "ran out of time before the popup could be identified", fix: "Next: make sure the dev server is idle, then run the probe again." } : { why: `clicking the button didn't open anything we could identify${blocked.length ? ` (its data was blocked: ${[...new Set(blocked)].join(", ")})` : ""}`, fix: "Next: give the button aria-controls naming its popup (or popovertarget), or declare the contract's popup part; a popup must show (not hidden, inert or aria-hidden) within 2 s." });
    }
    await page.wait(budgets.pollMs);
  }
}

/** What a pattern's popup is called in a sentence. */
export const POPUP_NOUN: Record<BehaviourPattern, string> = { "menu-button": "menu", "combobox-listbox": "listbox", "modal-dialog": "dialog", popover: "popover" };

/** The pattern-aware fix for a popup Esc doesn't close. */
const ESCAPE_FIX: Record<BehaviourPattern, string> = {
  "menu-button": "Close the menu when Esc is pressed while focus is in it (a keydown handler on the menu), then move focus back to the button that opened it.",
  "combobox-listbox": "Close the listbox when Esc is pressed in the combobox (a keydown handler on the combobox), keeping focus on the combobox.",
  "modal-dialog": "Close the dialog when Esc is pressed (a keydown handler on the dialog, or a native <dialog> opened with showModal(), which closes on Esc by itself), then move focus back to the button that opened it.",
  popover: "Close the popover when Esc is pressed (a native popover=\"auto\" does this by itself, else a keydown handler), then move focus back to its button.",
};

const FOCUS_FIX: Record<BehaviourPattern, string> = {
  "menu-button": "Next: make the menu's items focusable (tabindex=\"-1\" on each menuitem) and move focus to the first when the menu opens, then run youiyoux behave again.",
  "combobox-listbox": "Next: keep focus on the combobox while its listbox is open (don't move it, or blur it, on open), then run youiyoux behave again.",
  "modal-dialog": "Next: give the dialog something focusable (a button, or tabindex=\"-1\" on the dialog) and move focus into it when it opens, then run youiyoux behave again.",
  popover: "Next: give the popover something focusable (or tabindex=\"-1\" on it), then run youiyoux behave again.",
};

export interface CloseBudgets {
  /** After Esc, how long the popup has to close (exit animations included): the plan's close budget. */
  readonly closeMs: number;
  readonly pollMs: number;
  /** Once closed, how long the page is watched for anything else Esc set off (leaving, a request). */
  readonly graceMs: number;
}

/** What a check gets, once its popup is open: where the scenario is, its budgets, and consent to ask before every key. */
export interface CheckArgs {
  readonly start: string;
  readonly origin: string;
  readonly pattern: BehaviourPattern;
  /** The contract's popup part, when a binding located the target. */
  readonly popup: PartRef | null;
  /** The contract's returnFocusTo part, when its binding declares one. */
  readonly returnFocusTo?: PartRef | null;
  readonly deadline: () => number;
  readonly budgets: CloseBudgets;
  /** Asked immediately before every key: null while probing is still allowed, else why not (nothing is sent). */
  readonly beforeInput?: () => Promise<Stop | null>;
  readonly signal?: AbortSignal;
}

/** What every check needs around its popup: its info and data-blocked flag, its stops, and its results. */
export function checkContext(page: ProbePage, opened: Extract<ScenarioOutcome, { state: "opened" }>, args: CheckArgs) {
  const extra: string[] = [];
  const info = (): string[] => [...new Set([...opened.info, ...infoFromEvents(page.events()), ...extra])];
  const dataBlocked = (): boolean => opened.dataBlocked === true || dataBlockedIn(page.events());
  const cancelled = (): Stop | null => (args.signal?.aborted ? SWITCHED_OFF : null);
  const stopped = async (): Promise<Stop | null> => cancelled() ?? stopFromEvents(page.events()) ?? moved(args.start, await page.location(), args.origin);
  return {
    /** Info lines this check adds. */
    extra,
    info,
    dataBlocked,
    cancelled,
    /** Probing switched off, the guards refused something, or the page moved: why, else null. */
    stopped,
    incomplete: (stop: Stop): ScenarioOutcome => ({ state: "incomplete", ...stop, info: info(), dataBlocked: dataBlocked() }),
    decided: (state: "passed" | "failed", stop: Stop): ScenarioOutcome => ({ state, popup: opened.popup, ...stop, info: info(), dataBlocked: dataBlocked() }),
    /** Wait `ms`, never past the scenario's deadline. */
    settle: (ms: number): Promise<void> => page.wait(Math.max(0, Math.min(ms, args.deadline() - Date.now()))),
    /**
     * Immediately before a key: consent read again, the guards' stops, then `recheck` (the very
     * popup still showing, focus where the key is sent from). Null when the key may go; else why
     * not, and nothing is sent.
     */
    async beforeKey(recheck: () => Promise<boolean>, changed: Stop): Promise<Stop | null> {
      const refused = cancelled() ?? (await args.beforeInput?.()) ?? cancelled();
      if (refused) return refused;
      const before = await stopped();
      if (before) return before;
      return (await recheck()) ? null : changed;
    },
  };
}

/**
 * dismiss-escape, on a popup `openAndIdentify` opened: effective focus placed inside it (or on the
 * combobox); once the page's focus handlers have run, consent read again and the very popup checked
 * again (still showing, focus still inside) immediately before Escape is pressed once by real
 * keyboard input; then that popup element polled until it is closed (removed, hidden, inert,
 * aria-hidden, a closed popover or dialog) within the close budget. A removed popup is reconciled
 * by identity; losing a relationship never makes it closed. passed: closed in time. failed: still open after the whole budget. Anything else
 * (focus couldn't be placed, the page left or sent something, the scenario's own time ran out
 * first, couldn't tell which popup) is incomplete, never a pass or a fail.
 */
export async function dismissEscape(page: ProbePage, opened: Extract<ScenarioOutcome, { state: "opened" }>, args: CheckArgs): Promise<ScenarioOutcome> {
  const { start, origin, deadline, budgets, pattern } = args;
  const noun = POPUP_NOUN[pattern];
  const extra: string[] = [];
  const info = (): string[] => [...new Set([...opened.info, ...infoFromEvents(page.events()), ...extra])];
  const incomplete = (stop: Stop): ScenarioOutcome => ({ state: "incomplete", ...stop, info: info(), dataBlocked: opened.dataBlocked === true || dataBlockedIn(page.events()) });
  const cancelled = (): Stop | null => (args.signal?.aborted ? SWITCHED_OFF : null);
  const stopped = async (): Promise<Stop | null> => cancelled() ?? stopFromEvents(page.events()) ?? moved(start, await page.location(), origin);
  if (cancelled()) return incomplete(SWITCHED_OFF);
  const focus = await page.placeFocus(opened.index, pattern);
  if (!focus.ok) return incomplete({ why: pattern === "combobox-listbox" ? "focus couldn't be kept on the combobox, so Esc wasn't pressed" : `focus couldn't be placed inside the ${noun}, so Esc wasn't pressed`, fix: FOCUS_FIX[pattern] });
  if (focus.moved) extra.push(pattern === "combobox-listbox" ? "focus had left the combobox when the listbox opened; the probe put it back before pressing Esc" : `focus wasn't inside the ${noun} after it opened; the probe moved it there before pressing Esc`);
  // The page's focus handlers run, then: consent read again, and the very popup checked again
  // (still showing, focus still inside), immediately before the key. Anything changed: not tested.
  await page.wait(Math.max(0, Math.min(FOCUS_SETTLE_MS, deadline() - Date.now())));
  const refused = cancelled() ?? (await args.beforeInput?.()) ?? cancelled();
  if (refused) return incomplete(refused);
  const before = await stopped();
  if (before) return incomplete(before);
  if (!(await page.ready(opened.index, pattern))) return incomplete({ why: `placing focus changed the ${noun} (it closed, was replaced, or focus left it), so Esc wasn't pressed; not tested`, fix: `Next: keep the ${noun} open while focus moves inside it, then run youiyoux behave again.` });
  await page.press("Escape");
  const pressed = Date.now();
  const until = pressed + budgets.closeMs;
  for (;;) {
    const stop = await stopped();
    if (stop) return incomplete(stop);
    let now: "open" | "closed" | "unknown";
    // When this look began: a fail needs one that began after the whole close budget.
    const asked = Date.now();
    try {
      now = await page.popupState(opened.index, pattern, args.popup);
    } catch (error: unknown) {
      await page.wait(LATE_MS);
      return incomplete((await stopped().catch(() => null)) ?? { why: `the page changed under the probe after Esc: ${errorWords(error)}`, fix: "Next: run youiyoux behave again; a popup whose closing replaces the page can't be probed." });
    }
    if (now === "closed") {
      // Watch a moment longer: Esc that leaves the page or sends something is stopped, not passed.
      await page.wait(Math.max(0, Math.min(budgets.graceMs, deadline() - Date.now())));
      const after = await stopped();
      if (after) return incomplete(after);
      return { state: "passed", popup: opened.popup, why: `Esc closed the ${noun}`, fix: "Nothing to do: Esc closes it.", info: info(), dataBlocked: opened.dataBlocked === true || dataBlockedIn(page.events()) };
    }
    const at = Date.now();
    if (asked >= until) {
      if (now === "open") return { state: "failed", popup: opened.popup, why: `Esc did nothing: the ${noun} was still open after ${budgets.closeMs / 1000} s`, fix: ESCAPE_FIX[pattern], info: info(), dataBlocked: opened.dataBlocked === true || dataBlockedIn(page.events()) };
      return incomplete({ why: `after Esc, couldn't tell whether the ${noun} closed: it was removed, and something like it shows that can't be told apart from it`, fix: "Next: keep the popup's id when it re-renders (or declare the contract's popup part), then run youiyoux behave again." });
    }
    // The scenario's own time runs out before the close budget: that is no fail.
    if (deadline() <= at) return incomplete({ why: `ran out of time before the ${budgets.closeMs / 1000} s after Esc were up`, fix: "Next: make sure the dev server is idle, then run youiyoux behave again." });
    await page.wait(Math.max(1, Math.min(budgets.pollMs, until - at, deadline() - at)));
  }
}

/**
 * The control for dismiss-escape, in its own fresh scenario: the popup opened and focus placed
 * exactly as the test does, then NO key; the popup watched for the whole close budget. "passed"
 * here means only "it stayed open by itself" (internal, never stored): then an Escape scenario's
 * closing is Esc's doing. If it closes (or can't be told apart) on its own, Esc can't be judged.
 */
export async function staysOpenWithoutKey(
  page: ProbePage,
  opened: Extract<ScenarioOutcome, { state: "opened" }>,
  args: { readonly start: string; readonly origin: string; readonly pattern: BehaviourPattern; readonly popup: PartRef | null; readonly deadline: () => number; readonly budgets: CloseBudgets; readonly signal?: AbortSignal },
): Promise<ScenarioOutcome> {
  const { start, origin, deadline, budgets, pattern } = args;
  const noun = POPUP_NOUN[pattern];
  const incomplete = (stop: Stop): ScenarioOutcome => ({ state: "incomplete", ...stop, info: [...new Set([...opened.info, ...infoFromEvents(page.events())])], dataBlocked: opened.dataBlocked === true || dataBlockedIn(page.events()) });
  const stopped = async (): Promise<Stop | null> => (args.signal?.aborted ? SWITCHED_OFF : null) ?? stopFromEvents(page.events()) ?? moved(start, await page.location(), origin);
  const closesItself: Stop = { why: `the ${noun} closes on its own after focus moves into it (a run without Esc saw it close), so Esc can't be judged`, fix: `Next: keep the ${noun} open until Esc (or a choice) closes it, then run youiyoux behave again.` };
  const focus = await page.placeFocus(opened.index, pattern);
  if (!focus.ok) return incomplete({ why: `the control run (the same steps without Esc) couldn't place focus inside the ${noun}, so Esc can't be judged`, fix: FOCUS_FIX[pattern] });
  await page.wait(Math.max(0, Math.min(FOCUS_SETTLE_MS, deadline() - Date.now())));
  if (!(await page.ready(opened.index, pattern))) return incomplete(closesItself);
  // From where Esc would be pressed, for the whole close budget.
  const until = Date.now() + budgets.closeMs;
  for (;;) {
    const stop = await stopped();
    if (stop) return incomplete(stop);
    const asked = Date.now();
    const now = await page.popupState(opened.index, pattern, args.popup);
    if (now !== "open") return incomplete(closesItself);
    if (asked >= until) return { state: "passed", popup: opened.popup, why: `the ${noun} stayed open for ${budgets.closeMs / 1000} s without Esc`, fix: "Nothing to do.", info: opened.info, dataBlocked: opened.dataBlocked === true || dataBlockedIn(page.events()) };
    if (deadline() <= asked) return incomplete({ why: "the control run (the same steps without Esc) ran out of time, so Esc can't be judged", fix: "Next: make sure the dev server is idle, then run youiyoux behave again." });
    await page.wait(Math.max(1, Math.min(budgets.pollMs, until - asked, deadline() - asked)));
  }
}
