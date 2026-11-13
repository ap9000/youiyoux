/**
 * The behaviour checks beyond dismiss-escape (docs/plans/behaviour-rules.md, "Checks (v1)"), each
 * run on a popup `openAndIdentify` opened, in its own fresh scenario. What each one reads is read in
 * the probe's own isolated world (in-page.ts); what it decides is decided here, from those facts,
 * against the pattern table. A check sends only its own keys (CHECK_KEYS), each one only after
 * consent is read again and the very popup is checked again (checkContext.beforeKey). Nothing here
 * passes without positive evidence: anything that can't be told is incomplete, with why.
 */
import { ariaToken, pageText, roleWord, type BehaviourPattern, type PartRef } from "@youiyoux/core";
import type { FocusFacts, ItemFacts, TrapFacts, TriggerFacts } from "./in-page.ts";
import { checkContext, escapeUntilClosed, POPUP_NOUN, type CheckArgs, type ProbePage, type ScenarioOutcome, type Stop } from "./scenario.ts";

type Opened = Extract<ScenarioOutcome, { state: "opened" }>;

/** How long the trigger's state may take to follow the popup, once it is identified (an app that sets aria-expanded a moment later). */
const STATE_SETTLE_MS = 500;

/** The role each pattern's popup has, where the pattern table names one (a popover's popup may be anything). */
const POPUP_ROLE: Partial<Record<BehaviourPattern, string>> = { "menu-button": "menu", "combobox-listbox": "listbox" };

const TRIGGER_FIX: Record<BehaviourPattern, string> = {
  "menu-button": 'Give the menu button aria-haspopup="menu" and aria-expanded ("true" while the menu is open; "false", or left off, while it is closed); if it has aria-controls, point it at the element with role="menu".',
  "combobox-listbox": 'Give the combobox aria-expanded ("false" while its listbox is closed, "true" while it is open) and aria-controls naming the element with role="listbox"; leave aria-haspopup off or set it to "listbox".',
  // Not applicable: a dialog's launcher has no state to keep (the pattern table).
  "modal-dialog": "Nothing to do: a dialog's button needs no aria-expanded.",
  popover: 'Point the button at its popover with popovertarget (the browser then says whether it is open), or give it aria-controls naming the popover and aria-expanded ("true" while it is open, "false" while it is closed).',
};

export type TriggerVerdict = { readonly ok: true; readonly why: string; readonly info: readonly string[] } | { readonly ok: false; readonly why: string };

/**
 * trigger-state against the pattern table, from the trigger's state just before the click (closed)
 * and once its popup is identified (open). menu-button: aria-haspopup "menu" (or "true") both
 * times; aria-expanded "true" open and not "true" closed (left off is allowed, as APG recommends);
 * aria-controls optional, but if there it names the menu itself. combobox-listbox: aria-expanded
 * "false" → "true"; aria-controls names the listbox itself; aria-haspopup off or "listbox". popover:
 * popovertarget naming it (the browser keeps its state; a hand-set aria-expanded must agree), or
 * aria-expanded "false"/off → "true" with aria-controls naming it. A dialog's launcher is not checked.
 */
export function judgeTriggerState(pattern: BehaviourPattern, closed: TriggerFacts, open: TriggerFacts): TriggerVerdict {
  const noun = POPUP_NOUN[pattern];
  const bad = (why: string): TriggerVerdict => ({ ok: false, why });
  if (pattern === "popover" && open.popovertarget) {
    if (open.popovertargetPopup !== true) return bad("popovertarget doesn't name the popover that opened");
    // A hand-set aria-expanded must agree in both states: "false" (or off) while closed, "true" (or off) while open.
    if (closed.expanded !== null && closed.expanded !== "false") return bad(`aria-expanded is set by hand and says ${ariaToken(closed.expanded)} before the popover opened; popovertarget already says whether it is open`);
    if (open.expanded !== null && open.expanded !== "true") return bad(`aria-expanded is set by hand and says ${ariaToken(open.expanded)} while the popover is open; popovertarget already says whether it is open`);
    return { ok: true, why: "the button names its popover with popovertarget, so the browser says whether it is open", info: [] };
  }
  const info: string[] = [];
  const closedOk = pattern === "combobox-listbox" ? closed.expanded === "false" : closed.expanded === null || closed.expanded === "false";
  if (!closedOk) return bad(closed.expanded === null ? `aria-expanded isn't set while the ${noun} is closed (a combobox says "false")` : closed.expanded === "true" ? `aria-expanded already said "true" before the ${noun} opened` : `aria-expanded is ${ariaToken(closed.expanded)} while the ${noun} is closed, not "false"`);
  if (open.expanded !== "true") return bad(open.expanded === null ? `aria-expanded isn't set while the ${noun} is open` : open.expanded === "false" ? `aria-expanded stayed "false" while the ${noun} was open` : `aria-expanded is ${ariaToken(open.expanded)} while the ${noun} is open, not "true"`);
  if (closed.expanded === null) info.push(`aria-expanded is left off while the ${noun} is closed (allowed: APG recommends that for a menu button)`);
  for (const [when, facts] of [["closed", closed], ["open", open]] as const) {
    if (pattern === "menu-button" && facts.haspopup !== "menu" && facts.haspopup !== "true") return bad(facts.haspopup === null ? `aria-haspopup is missing while the menu is ${when}` : `aria-haspopup is ${ariaToken(facts.haspopup)} while the menu is ${when}, not "menu"`);
    if (pattern === "combobox-listbox" && facts.haspopup !== null && facts.haspopup !== "listbox") return bad(`aria-haspopup is ${ariaToken(facts.haspopup)} on a combobox whose popup is a listbox; leave it off or set it to "listbox"`);
  }
  if (!open.controls) {
    if (pattern === "combobox-listbox") return bad("aria-controls is missing: the combobox doesn't name its listbox");
    if (pattern === "popover") return bad("the button doesn't name its popover: it has neither popovertarget nor aria-controls");
    return { ok: true, why: `aria-expanded went to "true" when the menu opened, and aria-haspopup says it opens a menu`, info };
  }
  if (open.controlsPopup !== true) return bad(`aria-controls doesn't name the ${noun} that opened`);
  const role = POPUP_ROLE[pattern];
  if (role && open.popupRole !== role) return bad(`aria-controls names ${open.popupRole === null ? "an element" : `a ${roleWord(open.popupRole)} element`}, not the ${noun} itself (role="${role}")`);
  const said = pattern === "menu-button" ? ", aria-haspopup says it opens a menu," : "";
  return { ok: true, why: `aria-expanded went to "true" when the ${noun} opened${said} and aria-controls names the ${noun}`, info };
}

/**
 * trigger-state: no key. The trigger's state from just before the click (closed) is compared with
 * its state once the popup is identified, polled a moment (STATE_SETTLE_MS) for an app that sets it
 * just after; the popup must still be open when it is judged.
 */
export async function triggerState(page: ProbePage, opened: Opened, args: CheckArgs): Promise<ScenarioOutcome> {
  const { pattern, deadline, budgets } = args;
  const noun = POPUP_NOUN[pattern];
  const ctx = checkContext(page, opened, args);
  const until = Date.now() + STATE_SETTLE_MS;
  for (;;) {
    const stop = await ctx.stopped();
    if (stop) return ctx.incomplete(stop);
    const asked = Date.now();
    const now = await page.triggerFacts(opened.index);
    if (!now.connected) return ctx.incomplete({ why: `the button was removed when the ${noun} opened, so what it says can't be read`, fix: `Next: keep the button on the screen while its ${noun} is open, then run youiyoux behave again.` });
    if ((await page.popupState(opened.index, pattern, args.popup)) !== "open") return ctx.incomplete({ why: `the ${noun} closed before the button's state could be read`, fix: `Next: keep the ${noun} open until it is dismissed, then run youiyoux behave again.` });
    const verdict = judgeTriggerState(pattern, opened.closed, now);
    if (verdict.ok) {
      ctx.extra.push(...verdict.info);
      return ctx.decided("passed", { why: verdict.why, fix: "Nothing to do: the button says when its popup is open." });
    }
    if (asked >= until) return ctx.decided("failed", { why: verdict.why, fix: TRIGGER_FIX[pattern] });
    if (deadline() <= asked) return ctx.incomplete({ why: "ran out of time before the button's state could be read", fix: "Next: make sure the dev server is idle, then run youiyoux behave again." });
    await page.wait(Math.max(1, Math.min(budgets.pollMs, until - asked, deadline() - asked)));
  }
}

/** How long the app has to move focus into its popup, once the popup is identified (a focus() in a timer or the next frame). */
const FOCUS_INTO_MS = 1_000;

const FOCUS_INTO_FIX: Partial<Record<BehaviourPattern, string>> = {
  "menu-button": 'When the menu opens, move focus to its first item (tabindex="-1" on each menuitem, then focus() the first); focus on the menu container alone doesn\'t put arrow keys or a screen reader on an item.',
  "modal-dialog": 'When the dialog opens, move focus inside it: to its first focusable element, or to the dialog itself with tabindex="-1" (a native <dialog> opened with showModal() does this by itself).',
};

/** Words for where focus is, in a sentence: "the menu item 'Rename'", "the page's body". The page's role and name are never echoed raw (roleWord, pageText). */
export function focusWords(facts: Pick<FocusFacts, "at" | "role" | "name">, noun: string): string {
  const named = facts.name ? ` ${pageText(facts.name)}` : "";
  const role = roleWord(facts.role);
  switch (facts.at) {
    case "trigger":
      return `the button that opened the ${noun}`;
    case "popup":
      return `the ${noun} itself`;
    case "item":
    case "inside":
      return `${facts.role === "menuitem" || facts.role === "menuitemradio" || facts.role === "menuitemcheckbox" ? "the menu item" : facts.role === "option" ? "the option" : `a ${role}`}${named} inside the ${noun}`;
    case "body":
      return "the page's body (nothing)";
    case "away":
      return "outside the page (the browser's own toolbar)";
    case "outside":
      return `a ${role}${named} outside the ${noun}`;
  }
}

/**
 * focus-into: no key, and the probe places no focus: judged on where the app itself puts focus once
 * the popup is identified, polled for FOCUS_INTO_MS. A menu passes only with effective focus on one
 * of its menu items (the menu container alone fails); a modal dialog passes with focus anywhere
 * inside it, the dialog itself included (APG allows both). Focus left on the button, on the body or
 * elsewhere fails once the whole budget has passed; a popup that closes first is incomplete.
 */
export async function focusInto(page: ProbePage, opened: Opened, args: CheckArgs): Promise<ScenarioOutcome> {
  const { pattern, deadline, budgets } = args;
  const noun = POPUP_NOUN[pattern];
  const ctx = checkContext(page, opened, args);
  const fix = FOCUS_INTO_FIX[pattern] ?? "";
  const until = Date.now() + FOCUS_INTO_MS;
  for (;;) {
    const stop = await ctx.stopped();
    if (stop) return ctx.incomplete(stop);
    const asked = Date.now();
    const now = await page.focus(opened.index);
    if (!now.open) return ctx.incomplete({ why: `the ${noun} closed before where focus went could be judged`, fix: `Next: keep the ${noun} open until it is dismissed, then run youiyoux behave again.` });
    const inside = pattern === "menu-button" ? now.at === "item" && now.role !== "option" : now.at === "item" || now.at === "inside" || now.at === "popup";
    if (inside) return ctx.decided("passed", { why: `focus moved to ${focusWords(now, noun)} when it opened`, fix: "Nothing to do: opening moves focus in." });
    if (now.at === "away") return ctx.incomplete({ why: "the page lost focus to the browser itself, so where the app put it can't be judged", fix: "Next: run youiyoux behave again." });
    if (asked >= until) {
      const where = now.at === "trigger" ? `focus stayed on the button that opened the ${noun}` : now.at === "popup" ? `focus went to the ${noun} itself, not to one of its items` : `focus went to ${focusWords(now, noun)}, not ${pattern === "menu-button" ? "to one of the menu's items" : "inside the dialog"}`;
      return ctx.decided("failed", { why: `${where} (${FOCUS_INTO_MS / 1000} s after it opened)`, fix });
    }
    if (deadline() <= asked) return ctx.incomplete({ why: "ran out of time before where focus went could be judged", fix: "Next: make sure the dev server is idle, then run youiyoux behave again." });
    await page.wait(Math.max(1, Math.min(budgets.pollMs, until - asked, deadline() - asked)));
  }
}

/** After the popup closes, how long focus has at least to arrive (beyond the close budget from Esc): a focus() in a timer or the next frame. */
const RETURN_AFTER_CLOSE_MS = 300;

const RETURN_FIX: Partial<Record<BehaviourPattern, string>> = {
  "menu-button": "When the menu closes with Esc, move focus back to the button that opened it.",
  "modal-dialog": "When the dialog closes, move focus back to the button that opened it (a native <dialog> opened with showModal() does this by itself).",
  popover: "When the popover closes, move focus back to its button (a native popover opened through popovertarget does this by itself).",
};

/** A contract's part, as a sentence names it (contract names are the design system's, never the page's). */
const partWords = (part: PartRef): string => ("part" in part ? `the part "${part.part}"` : `the ${part.role}`);

/**
 * focus-return: dismiss-escape's steps (focus placed inside, consent and the very popup checked
 * again, one Escape); Esc that doesn't close it within the close budget is incomplete, never a
 * verdict on focus. Once closed, effective focus is polled until it is on the trigger (the very
 * element clicked) or the contract's returnFocusTo part, for the close budget from Esc and at least
 * RETURN_AFTER_CLOSE_MS after the close. Elsewhere after that fails; the trigger gone with no
 * returnFocusTo declared is incomplete (the plan's words). The verdict stands only when the
 * control run saw the popup stay open without Esc (probe.ts), so the closing was Esc's.
 */
export async function focusReturn(page: ProbePage, opened: Opened, args: CheckArgs): Promise<ScenarioOutcome> {
  const { pattern, deadline, budgets } = args;
  const part = args.returnFocusTo ?? null;
  const noun = POPUP_NOUN[pattern];
  const ctx = checkContext(page, opened, args);
  // The returnFocusTo part (if declared) was found and held before the click, from the page's structure (openAndIdentify).
  const escaped = await escapeUntilClosed(page, opened, args, ctx);
  if (escaped.kind === "stop") return escaped.outcome;
  if (escaped.kind === "open") return ctx.incomplete({ why: `Esc didn't close the ${noun}, so where focus returns can't be judged`, fix: `Next: make Esc close the ${noun} (dismiss-escape), then run youiyoux behave again.` });
  const until = Math.max(escaped.pressed + budgets.closeMs, escaped.closedAt + RETURN_AFTER_CLOSE_MS);
  for (;;) {
    const stop = await ctx.stopped();
    if (stop) return ctx.incomplete(stop);
    const asked = Date.now();
    const now = await page.returnFocus(opened.index);
    if (now.at === "trigger" || now.at === "part") {
      // Watch a moment longer: a page that leaves or sends something now is stopped, not passed;
      // and focus must still be there (and the popup still closed) at the end of that moment.
      await ctx.settle(budgets.graceMs);
      const after = await ctx.stopped();
      if (after) return ctx.incomplete(after);
      const again = await page.returnFocus(opened.index);
      const reopened = (await page.popupState(opened.index, pattern, args.popup)) === "open";
      if ((again.at === "trigger" || again.at === "part") && !reopened) return ctx.decided("passed", { why: again.at === "trigger" ? `when Esc closed the ${noun}, focus went back to the button that opened it` : `when Esc closed the ${noun}, focus went to ${partWords(part!)} the component contract names (returnFocusTo)`, fix: "Nothing to do: closing returns focus." });
      // It moved on (or the popup opened again): keep watching until the budget, and judge where it ends.
      if (deadline() <= Date.now()) return ctx.incomplete({ why: "ran out of time before where focus returned could be judged", fix: "Next: make sure the dev server is idle, then run youiyoux behave again." });
      continue;
    }
    if (asked >= until) {
      if (part && now.part !== "one") return ctx.incomplete({ why: "couldn't tell which element focus should return to", fix: `Next: give the component exactly one element with ${partWords(part)} near its button (it must be there before the popup opens), then run youiyoux behave again.` });
      if (now.trigger === "gone" && !part) return ctx.incomplete({ why: "the button that opened it is gone; declare where focus should go", fix: "Next: declare where focus goes in the component's contract (a11y.behaviour.returnFocusTo), or keep the button on the screen, then run youiyoux behave again." });
      if (now.at === "away") return ctx.incomplete({ why: "the page lost focus to the browser itself, so where focus returned can't be judged", fix: "Next: run youiyoux behave again." });
      const where = focusWords({ at: now.at, role: now.role, name: now.name }, noun);
      const wanted = now.trigger === "gone" ? `${partWords(part!)} the component contract names (the button that opened it is gone)` : part ? `the button that opened it or ${partWords(part)} the component contract names` : "the button that opened it";
      return ctx.decided("failed", { why: `when Esc closed the ${noun}, focus went to ${where}, not to ${wanted}`, fix: part ? `When the ${noun} closes, move focus to ${partWords(part)} its contract names as returnFocusTo, or back to the button that opened it.` : (RETURN_FIX[pattern] ?? "") });
    }
    if (deadline() <= asked) return ctx.incomplete({ why: "ran out of time before where focus returned could be judged", fix: "Next: make sure the dev server is idle, then run youiyoux behave again." });
    await page.wait(Math.max(1, Math.min(budgets.pollMs, until - asked, deadline() - asked)));
  }
}

/** focus-trap judges dialogs with up to this many tabbable elements (2 presses each, plus a wrap through the browser's toolbar). */
export const MAX_TRAP_TABBABLES = 20;
/** After a key, how long focus has to land (a trap that moves it in a focusin handler or the next frame). */
const KEY_LAND_MS = 200;
/** After a key, the first look: at once (the key's own handlers have run by the time it resolves), then polled. */
const KEY_FIRST_LOOK_MS = 0;
/** After focus is placed, how long the page's focus handlers get before the first key. */
const PLACE_SETTLE_MS = 100;

const TRAP_FIX = "Keep focus inside the dialog while it is open: open a native <dialog> with showModal() (the browser keeps focus in), or on Tab from the last focusable element move focus to the first and on Shift+Tab from the first to the last; never stop Tab from moving between them.";

/** One of the dialog's tabbable elements, in words: its role and its (cleaned, quoted) name. */
const tabbableWords = (t: { readonly role: string; readonly name: string } | undefined): string => (t ? `${roleWord(t.role) === "element" ? "the element" : `the ${roleWord(t.role)}`} ${pageText(t.name)}` : "an element");

/**
 * focus-trap (modal dialogs only): with N tabbable elements inside, N Tabs visit each once in
 * order and come back round, then N Shift+Tabs the reverse. A dialog with none keeps focus on
 * itself; with one, keeps it there. A native <dialog> shown with showModal() keeps focus in by
 * itself (at the ends Chrome passes through its own toolbar, which is accepted there and only
 * there); the order is still checked. Focus leaving the dialog, Tab that doesn't move it, or a
 * wrong next element fails. Each key goes only after consent is read again and the very dialog
 * (still showing, focus inside) is checked again. Not modal, a popup open inside it, a frame, a
 * Tab order it doesn't model (positive tabindex, a shadow root, radio buttons), more than MAX_TRAP_TABBABLES elements, or focus landing on
 * something not counted as tabbable: incomplete, never guessed.
 */
export async function focusTrap(page: ProbePage, opened: Opened, args: CheckArgs): Promise<ScenarioOutcome> {
  const { pattern } = args;
  const ctx = checkContext(page, opened, args);
  const first = await page.trap(true);
  if (!first.open) return ctx.incomplete({ why: "the dialog closed before Tab could be pressed", fix: "Next: keep the dialog open until it is dismissed, then run youiyoux behave again." });
  if (!first.modal) return ctx.incomplete({ why: 'the dialog it opened isn\'t modal (a <dialog> shown with show() or the open attribute, or role="dialog" without aria-modal="true"), so focus isn\'t held inside it', fix: 'Next: if it should be modal, open it with showModal(), or give it aria-modal="true" and keep focus inside; a dialog that isn\'t modal isn\'t checked for a focus trap.' });
  if (first.nested) return ctx.incomplete({ why: `a ${roleWord(first.nested)} is open inside the dialog, so the focus trap can't be judged`, fix: "Next: open the dialog with nothing else open inside it, then run youiyoux behave again." });
  if (first.frame) return ctx.incomplete({ why: "the dialog holds a frame; Tab order through frames isn't checked yet", fix: "Next: check Tab and Shift+Tab in this dialog by hand." });
  if (first.unmodelled) return ctx.incomplete({ why: `this dialog's tab order uses ${first.unmodelled}, which youiyoux doesn't model yet`, fix: "Next: check Tab and Shift+Tab in this dialog by hand." });
  const n = first.tabbables.length;
  if (n > MAX_TRAP_TABBABLES) return ctx.incomplete({ why: `the dialog has ${n} focusable elements; focus-trap checks dialogs with up to ${MAX_TRAP_TABBABLES}`, fix: "Next: check Tab and Shift+Tab in this dialog by hand." });
  const placed = await page.trapPlace();
  if (!placed.ok) return ctx.incomplete({ why: "focus couldn't be placed inside the dialog, so Tab wasn't pressed", fix: 'Next: give the dialog something focusable (a button, or tabindex="-1" on the dialog), then run youiyoux behave again.' });
  if (placed.moved) ctx.extra.push(n > 0 ? "focus wasn't on a focusable element of the dialog after it opened; the probe moved it to the first before pressing Tab" : "focus wasn't inside the dialog after it opened; the probe moved it to the dialog before pressing Tab");
  await ctx.settle(PLACE_SETTLE_MS);
  const native = first.modal === "native";
  const changed = { why: "focus left the dialog, or the dialog closed or was replaced, before the next Tab; not tested", fix: "Next: keep the dialog open, with focus inside, while Tab is pressed, then run youiyoux behave again." };
  /** One key, with consent read and the dialog checked again just before it; why not, or null once sent. */
  const press = async (key: "Tab" | "Shift+Tab", away: boolean) => {
    const refused = await ctx.beforeKey(() => page.ready(opened.index, pattern, away), changed);
    if (refused) return refused;
    await page.press(key);
    return null;
  };
  /** Where focus is after a key: looked at until `want` holds, or KEY_LAND_MS after the press. */
  const look = async (want: (facts: Awaited<ReturnType<ProbePage["trap"]>>) => boolean) => {
    const pressed = Date.now();
    await ctx.settle(KEY_FIRST_LOOK_MS);
    for (;;) {
      const facts = await page.trap(false);
      if (want(facts) || Date.now() - pressed >= KEY_LAND_MS || args.deadline() <= Date.now()) return facts;
      await ctx.settle(25);
    }
  };
  const closedStop = { why: "the dialog closed while Tab was pressed, so the focus trap can't be judged", fix: "Next: keep the dialog open while Tab moves through it, then run youiyoux behave again." };
  const staleStop = { why: "the dialog's focusable elements changed while Tab was pressed, so the order can't be judged", fix: "Next: keep the dialog's contents steady while Tab moves through it, then run youiyoux behave again." };
  const uncounted = (key: string): Stop => ({ why: `${key} moved focus to something inside the dialog that isn't counted as focusable (a scrolling area, say), so the order can't be judged`, fix: "Next: check Tab and Shift+Tab in this dialog by hand." });
  const start = await page.trap(false);
  if (start.stale) return ctx.incomplete(staleStop);
  if (n === 0) {
    if (start.at.kind !== "popup" && start.at.kind !== "inside") return ctx.incomplete(changed);
    let away = false;
    for (const key of ["Tab", "Shift+Tab"] as const) {
      const refused = await press(key, away);
      if (refused) return ctx.incomplete(refused);
      const now = await look((f) => f.at.kind === "popup" || f.at.kind === "inside");
      // After every key, before anything is decided from it: what the guards refused, and where the page is.
      const stop = await ctx.stopped();
      if (stop) return ctx.incomplete(stop);
      if (!now.open) return ctx.incomplete(closedStop);
      if (now.at.kind === "popup" || now.at.kind === "inside") continue;
      if (native && now.at.kind === "away") {
        away = true;
        continue;
      }
      if (now.at.kind === "tabbable") return ctx.incomplete(staleStop);
      return ctx.decided("failed", { why: `${key} moved focus out of the dialog (to ${focusWords({ at: now.at.kind, role: now.at.role, name: now.at.name }, "dialog")}); with nothing focusable inside, the dialog itself should keep focus`, fix: TRAP_FIX });
    }
    if (native) ctx.extra.push("a native <dialog> shown with showModal(): the browser keeps focus inside it (Tab passes through its own toolbar)");
    return ctx.pass({ why: "with nothing focusable inside, the dialog kept focus on Tab and Shift+Tab", fix: "Nothing to do: focus stays inside the dialog." });
  }
  if (start.at.kind !== "tabbable") return ctx.incomplete(changed);
  let k = start.at.i;
  const name = (i: number): string => tabbableWords(first.tabbables[i]);
  for (const key of ["Tab", "Shift+Tab"] as const) {
    for (let step = 0; step < n; step++) {
      const next = key === "Tab" ? (k + 1) % n : (k - 1 + n) % n;
      const wraps = key === "Tab" ? k === n - 1 : k === 0;
      const arrived = (f: TrapFacts): boolean => f.at.kind === "tabbable" && f.at.i === next;
      let refused = await press(key, false);
      if (refused) return ctx.incomplete(refused);
      let now = await look(arrived);
      if (native && wraps && now.open && now.at.kind === "away") {
        // A native modal at its end: Chrome passes focus through its own toolbar; one more press comes back in.
        refused = await press(key, true);
        if (refused) return ctx.incomplete(refused);
        now = await look(arrived);
      }
      // After every key, before anything is decided from it: what the guards refused, and where the page is.
      const stop = await ctx.stopped();
      if (stop) return ctx.incomplete(stop);
      if (!now.open) return ctx.incomplete(closedStop);
      if (now.stale) return ctx.incomplete(staleStop);
      if (arrived(now)) {
        k = next;
        continue;
      }
      const at = now.at;
      if (at.kind === "popup" || at.kind === "inside") return ctx.incomplete(uncounted(key));
      if (at.kind === "tabbable" && at.i === k) return ctx.decided("failed", { why: `${key} didn't move focus: it stayed on ${name(k)}`, fix: TRAP_FIX });
      if (at.kind === "tabbable") return ctx.decided("failed", { why: `${key} from ${name(k)} went to ${name(at.i)}, not to ${name(next)} (the ${key === "Tab" ? "next" : "previous"} focusable element${wraps ? ", round the end" : ""})`, fix: TRAP_FIX });
      if (at.kind === "away") return ctx.decided("failed", { why: `${key} from ${name(k)} left the page instead of ${wraps ? "wrapping round to" : "moving to"} ${name(next)}`, fix: TRAP_FIX });
      return ctx.decided("failed", { why: `${key} from ${name(k)} moved focus out of the dialog (to ${focusWords({ at: at.kind, role: at.role, name: at.name }, "dialog")})`, fix: TRAP_FIX });
    }
  }
  if (native) ctx.extra.push("a native <dialog> shown with showModal(): the browser keeps focus inside it (at the ends Tab passes through its own toolbar); the order was checked");
  return ctx.pass({ why: n === 1 ? "Tab and Shift+Tab kept focus on the dialog's only focusable element" : `Tab and Shift+Tab stayed inside the dialog, visiting its ${n} focusable elements in order and wrapping round`, fix: "Nothing to do: focus stays inside the dialog." });
}

/** arrow-keys checks lists of up to this many items: every move both ways and both ends are pressed, about two presses an item. */
export const MAX_ARROW_ITEMS = 50;

const ARROW_FIX: Partial<Record<BehaviourPattern, string>> = {
  "menu-button": 'Move focus with ArrowDown and ArrowUp to the next and previous menu item in order (tabindex="-1" on each item, focus() the next; or aria-activedescendant on the menu); disabled items may take focus or be skipped; at the ends, wrap round or stay.',
  "combobox-listbox": "On ArrowDown and ArrowUp, set aria-activedescendant on the combobox to the id of the next or previous option inside its listbox; disabled options may take it or be skipped; at the ends, wrap round or stay.",
};

/**
 * arrow-keys (a vertical menu, a combobox's listbox), for lists of up to MAX_ARROW_ITEMS items.
 * Effective focus (aria-activedescendant resolved, for a menu that manages its own focus too: it
 * must name an element that exists and belongs to the widget) starts on an item, or on the
 * combobox with no option active. Arrows are then pressed until every item reached has been left
 * both ways (ArrowDown and ArrowUp), the two ends included, navigating by moves already seen: a
 * pass needs every one of those moves observed, never a sample. Each move must go to the next
 * (previous) item in document order: a disabled item may take focus or be skipped (both accepted
 * by APG; info says which); at the ends, wrapping round or staying are both accepted (info says
 * which). Not moving, going to any other item, to nothing (a dangling aria-activedescendant), to
 * the menu container or out of the widget fails. Home and End are then tried for information only.
 * Horizontal (aria-orientation) or longer lists: incomplete. Each key goes only after consent is
 * read again and the very popup is checked again; after each, the guards decide first.
 */
export async function arrowKeys(page: ProbePage, opened: Opened, args: CheckArgs): Promise<ScenarioOutcome> {
  const { pattern } = args;
  const noun = POPUP_NOUN[pattern];
  const menu = pattern === "menu-button";
  const itemNoun = menu ? "menu item" : "option";
  const ctx = checkContext(page, opened, args);
  const first = await page.items(opened.index, pattern, true);
  if (!first.open) return ctx.incomplete({ why: `the ${noun} closed before arrow keys could be pressed`, fix: `Next: keep the ${noun} open until it is dismissed, then run youiyoux behave again.` });
  if (first.orientation === "horizontal") return ctx.incomplete({ why: menu ? "horizontal menus not checked yet" : "horizontal listboxes not checked yet", fix: "Next: check ArrowLeft and ArrowRight in it by hand; youiyoux checks vertical ones." });
  const total = first.items.length;
  if (total > MAX_ARROW_ITEMS) return ctx.incomplete({ why: `this list has ${total} items; only lists up to ${MAX_ARROW_ITEMS} are checked`, fix: "Next: check ArrowDown and ArrowUp in it by hand." });
  const enabledAt = first.items.flatMap((item, i) => (item.enabled ? [i] : []));
  if (enabledAt.length === 0) return ctx.incomplete({ why: `the ${noun} has no enabled ${itemNoun}s to move through`, fix: `Next: probe it with at least one enabled ${itemNoun}.` });
  const placed = menu ? await page.itemPlace() : await page.placeFocus(opened.index, pattern);
  if (!placed.ok) return ctx.incomplete({ why: menu ? "focus couldn't be placed on a menu item, so no arrow key was pressed" : "focus couldn't be kept on the combobox, so no arrow key was pressed", fix: menu ? 'Next: make the menu items focusable (tabindex="-1" on each), then run youiyoux behave again.' : "Next: keep focus on the combobox while its listbox is open, then run youiyoux behave again." });
  if (placed.moved) ctx.extra.push(menu ? "focus wasn't on a menu item after the menu opened; the probe moved it to the first enabled item before pressing arrow keys" : "focus had left the combobox when the listbox opened; the probe put it back before pressing arrow keys");
  await ctx.settle(PLACE_SETTLE_MS);
  const name = (i: number): string => (i < 0 ? "the combobox (no option active)" : `the ${itemNoun} ${pageText(first.items[i]?.name)}`);
  const changed = { why: `focus left the ${noun}, or it closed or was replaced, before the next arrow key; not tested`, fix: `Next: keep the ${noun} open, with focus in it, while arrow keys move through it, then run youiyoux behave again.` };
  const press = async (key: "ArrowDown" | "ArrowUp" | "Home" | "End") => {
    const refused = await ctx.beforeKey(() => page.ready(opened.index, pattern), changed);
    if (refused) return refused;
    await page.press(key);
    return null;
  };
  const look = async (want: (facts: ItemFacts) => boolean): Promise<ItemFacts> => {
    const pressed = Date.now();
    await ctx.settle(KEY_FIRST_LOOK_MS);
    for (;;) {
      const facts = await page.items(opened.index, pattern, false);
      if (want(facts) || Date.now() - pressed >= KEY_LAND_MS || args.deadline() <= Date.now()) return facts;
      await ctx.settle(20);
    }
  };
  const start = await page.items(opened.index, pattern, false);
  if (start.stale) return ctx.incomplete({ why: `the ${noun}'s ${itemNoun}s changed before arrow keys were pressed`, fix: `Next: keep the ${noun}'s contents steady while it is open, then run youiyoux behave again.` });
  let at: number;
  if (start.at.kind === "item") at = start.at.i;
  else if (start.at.kind === "combobox") at = -1;
  else return ctx.incomplete(changed);
  const firstEnabled = enabledAt[0]!;
  const lastEnabled = enabledAt[enabledAt.length - 1]!;
  /** Where a key from `from` may go: the next (previous) item, or the next enabled one past disabled items; at an end, round or stay. */
  const allowed = (key: "ArrowDown" | "ArrowUp", from: number): { readonly next: number[]; readonly end: number[] } => {
    if (key === "ArrowDown") {
      if (from < 0) return { next: [...new Set([0, firstEnabled])], end: [] };
      const nextEnabled = enabledAt.find((e) => e > from);
      const next = [...new Set([...(from + 1 < total ? [from + 1] : []), ...(nextEnabled !== undefined ? [nextEnabled] : [])])];
      return { next, end: nextEnabled === undefined ? [...new Set([0, firstEnabled, from])] : [] };
    }
    const prevEnabled = [...enabledAt].reverse().find((e) => e < from);
    const next = [...new Set([...(from - 1 >= 0 ? [from - 1] : []), ...(prevEnabled !== undefined ? [prevEnabled] : [])])];
    return { next, end: prevEnabled === undefined ? [...new Set([total - 1, lastEnabled, from])] : [] };
  };
  const down = new Map<number, number>();
  const up = new Map<number, number>();
  const visited = new Set<number>(at >= 0 ? [at] : []);
  const ends: { ArrowDown: "wraps" | "stays" | null; ArrowUp: "wraps" | "stays" | null } = { ArrowDown: null, ArrowUp: null };
  let disabledTaken = false;
  let disabledSkipped = false;
  const closedStop = { why: `the ${noun} closed when an arrow key was pressed, so arrow keys can't be judged`, fix: `Next: keep the ${noun} open while arrow keys move through it, then run youiyoux behave again.` };
  const staleStop = { why: `the ${noun}'s ${itemNoun}s changed while arrow keys were pressed, so the order can't be judged`, fix: `Next: keep the ${noun}'s contents steady while arrow keys move through it, then run youiyoux behave again.` };
  /** Why a key that should have gone where `allowed` says didn't: a failure, or incomplete when it can't be told. */
  const wrong = (key: "ArrowDown" | "ArrowUp", from: number, now: ItemFacts): ScenarioOutcome => {
    const { next } = allowed(key, from);
    const target = next.length ? `to ${name(next[next.length - 1]!)} (the ${key === "ArrowDown" ? "next" : "previous"} ${itemNoun})` : `round to ${name(key === "ArrowDown" ? firstEnabled : lastEnabled)} or staying on ${name(from)}`;
    const landed = now.at;
    if (landed.kind === "inside") return ctx.incomplete({ why: `${key} moved focus to something inside the ${noun} that isn't one of its ${itemNoun}s, so it can't be judged`, fix: `Next: check ${key} in this ${noun} by hand.` });
    const fix = ARROW_FIX[pattern] ?? "";
    if (landed.kind === "item" && landed.i === from) return ctx.decided("failed", { why: `${key} didn't move from ${name(from)}`, fix });
    if (landed.kind === "item") return ctx.decided("failed", { why: `${key} from ${name(from)} went to ${name(landed.i)}, not ${target}`, fix });
    if (landed.kind === "combobox") return ctx.decided("failed", { why: from < 0 ? `${key} didn't make any option active` : `${key} left no option active (aria-activedescendant was cleared)`, fix });
    if (landed.kind === "dangling") return ctx.decided("failed", { why: landed.why === "missing" ? `${key} set aria-activedescendant to an id that isn't on the page` : `${key} set aria-activedescendant to an element outside the ${noun}`, fix });
    if (landed.kind === "popup") return ctx.decided("failed", { why: `${key} moved focus off the ${itemNoun}s, to the ${noun} itself`, fix });
    return ctx.decided("failed", { why: `${key} moved focus out of the ${noun} (to ${focusWords({ at: landed.kind, role: landed.role, name: landed.name }, noun)})`, fix });
  };
  /** One arrow from `from`, judged: where it went, or a result that ends the check. */
  const step = async (key: "ArrowDown" | "ArrowUp", from: number): Promise<{ readonly to: number } | { readonly outcome: ScenarioOutcome }> => {
    const { next, end } = allowed(key, from);
    const refused = await press(key);
    if (refused) return { outcome: ctx.incomplete(refused) };
    const now = await look((f) => f.at.kind === "item" && (next.includes(f.at.i) || end.includes(f.at.i)));
    // After every key, before anything is decided from it: what the guards refused, and where the page is.
    const stop = await ctx.stopped();
    if (stop) return { outcome: ctx.incomplete(stop) };
    if (!now.open) return { outcome: ctx.incomplete(closedStop) };
    if (now.stale) return { outcome: ctx.incomplete(staleStop) };
    if (now.at.kind !== "item" || !(next.includes(now.at.i) || end.includes(now.at.i))) return { outcome: wrong(key, from, now) };
    const to = now.at.i;
    if (!first.items[to]?.enabled) disabledTaken = true;
    if (next.includes(to)) {
      // Past disabled items to the next enabled one: they are skipped.
      if (Math.abs(to - from) > 1 && from >= 0) disabledSkipped = true;
    } else ends[key] ??= to === from ? "stays" : "wraps";
    return { to };
  };
  /** Positions every move must be seen from: each enabled item, and any disabled one focus went to. */
  const unseen = (): number[] => [...new Set([...enabledAt, ...visited])].filter((p) => !down.has(p) || !up.has(p));
  /** The first key on the shortest way, by moves already seen, from `from` to a position still missing a move. */
  const towards = (from: number, goals: readonly number[]): "ArrowDown" | "ArrowUp" | null => {
    const queue: Array<{ readonly p: number; readonly first: "ArrowDown" | "ArrowUp" }> = [];
    const seen = new Set([from]);
    for (const [key, map] of [["ArrowDown", down], ["ArrowUp", up]] as const) if (map.has(from) && !seen.has(map.get(from)!)) (seen.add(map.get(from)!), queue.push({ p: map.get(from)!, first: key }));
    while (queue.length) {
      const { p, first: key } = queue.shift()!;
      if (goals.includes(p)) return key;
      for (const map of [down, up]) if (map.has(p) && !seen.has(map.get(p)!)) (seen.add(map.get(p)!), queue.push({ p: map.get(p)!, first: key }));
    }
    return null;
  };
  const limit = 4 * (total + 2);
  for (let presses = 0; ; presses++) {
    const missing = unseen();
    if (missing.length === 0 && ends.ArrowDown && ends.ArrowUp) break;
    if (presses >= limit) return ctx.incomplete({ why: `arrow keys didn't reach every ${itemNoun} of the ${noun} within ${limit} presses, so not every move could be seen`, fix: `Next: check ArrowDown and ArrowUp in this ${noun} by hand.` });
    const key: "ArrowDown" | "ArrowUp" | null = at < 0 || !down.has(at) ? "ArrowDown" : !up.has(at) ? "ArrowUp" : towards(at, missing.length ? missing : [...visited]);
    if (key === null) return ctx.incomplete({ why: `arrow keys didn't lead back to every ${itemNoun} of the ${noun}, so not every move could be seen`, fix: `Next: check ArrowDown and ArrowUp in this ${noun} by hand.` });
    const moved = await step(key, at);
    if ("outcome" in moved) return moved.outcome;
    if (at >= 0) (key === "ArrowDown" ? down : up).set(at, moved.to);
    at = moved.to;
    visited.add(at);
  }
  const n = total;
  if (enabledAt.length === 1 && n === 1) ctx.extra.push(`with one ${itemNoun}, ArrowDown and ArrowUp keep focus on it`);
  else {
    ctx.extra.push(`at the last ${itemNoun}, ArrowDown ${ends.ArrowDown === "wraps" ? "wraps round to the first" : "stays on it"}`, `at the first ${itemNoun}, ArrowUp ${ends.ArrowUp === "wraps" ? "wraps round to the last" : "stays on it"}`);
    if (disabledTaken) ctx.extra.push(`disabled ${itemNoun}s take focus`);
    if (disabledSkipped) ctx.extra.push(`disabled ${itemNoun}s are skipped`);
  }
  // Home and End: information only (APG makes them optional for a listbox), never a failure.
  if (n >= 2) {
    for (const [key, wanted] of [["End", [n - 1, lastEnabled]], ["Home", [0, firstEnabled]]] as const) {
      const refused = await press(key);
      if (refused === changed) {
        ctx.extra.push(`${key} wasn't tried: the ${noun} closed or focus left it`);
        break;
      }
      if (refused) return ctx.incomplete(refused);
      const now = await look((f) => f.at.kind === "item" && (wanted as readonly number[]).includes(f.at.i));
      const stop = await ctx.stopped();
      if (stop) return ctx.incomplete(stop);
      const yes = now.open && now.at.kind === "item" && (wanted as readonly number[]).includes(now.at.i);
      ctx.extra.push(`${key} moves to the ${key === "End" ? "last" : "first"} ${itemNoun}: ${yes ? "yes" : "no"}`);
    }
  }
  return ctx.pass({ why: `ArrowDown and ArrowUp moved through the ${noun}'s ${n} ${itemNoun}${n === 1 ? "" : "s"} in order, every move both ways and at both ends`, fix: "Nothing to do: arrow keys move through it." });
}
