/**
 * The behaviour checks beyond dismiss-escape (docs/plans/behaviour-rules.md, "Checks (v1)"), each
 * run on a popup `openAndIdentify` opened, in its own fresh scenario. What each one reads is read in
 * the probe's own isolated world (in-page.ts); what it decides is decided here, from those facts,
 * against the pattern table. A check sends only its own keys (CHECK_KEYS), each one only after
 * consent is read again and the very popup is checked again (checkContext.beforeKey). Nothing here
 * passes without positive evidence: anything that can't be told is incomplete, with why.
 */
import type { BehaviourPattern } from "@youiyoux/core";
import type { FocusFacts, TriggerFacts } from "./in-page.ts";
import { checkContext, POPUP_NOUN, type CheckArgs, type ProbePage, type ScenarioOutcome } from "./scenario.ts";

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
    if (open.expanded !== null && open.expanded !== "true") return bad(`aria-expanded is set by hand and says "${open.expanded}" while the popover is open; popovertarget already says whether it is open`);
    return { ok: true, why: "the button names its popover with popovertarget, so the browser says whether it is open", info: [] };
  }
  const info: string[] = [];
  const closedOk = pattern === "combobox-listbox" ? closed.expanded === "false" : closed.expanded === null || closed.expanded === "false";
  if (!closedOk) return bad(closed.expanded === null ? `aria-expanded isn't set while the ${noun} is closed (a combobox says "false")` : closed.expanded === "true" ? `aria-expanded already said "true" before the ${noun} opened` : `aria-expanded is "${closed.expanded}" while the ${noun} is closed, not "false"`);
  if (open.expanded !== "true") return bad(open.expanded === null ? `aria-expanded isn't set while the ${noun} is open` : open.expanded === "false" ? `aria-expanded stayed "false" while the ${noun} was open` : `aria-expanded is "${open.expanded}" while the ${noun} is open, not "true"`);
  if (closed.expanded === null) info.push(`aria-expanded is left off while the ${noun} is closed (allowed: APG recommends that for a menu button)`);
  for (const [when, facts] of [["closed", closed], ["open", open]] as const) {
    if (pattern === "menu-button" && facts.haspopup !== "menu" && facts.haspopup !== "true") return bad(facts.haspopup === null ? `aria-haspopup is missing while the menu is ${when}` : `aria-haspopup is "${facts.haspopup}" while the menu is ${when}, not "menu"`);
    if (pattern === "combobox-listbox" && facts.haspopup !== null && facts.haspopup !== "listbox") return bad(`aria-haspopup is "${facts.haspopup}" on a combobox whose popup is a listbox; leave it off or set it to "listbox"`);
  }
  if (!open.controls) {
    if (pattern === "combobox-listbox") return bad("aria-controls is missing: the combobox doesn't name its listbox");
    if (pattern === "popover") return bad("the button doesn't name its popover: it has neither popovertarget nor aria-controls");
    return { ok: true, why: `aria-expanded went to "true" when the menu opened, and aria-haspopup says it opens a menu`, info };
  }
  if (open.controlsPopup !== true) return bad(`aria-controls doesn't name the ${noun} that opened`);
  const role = POPUP_ROLE[pattern];
  if (role && open.popupRole !== role) return bad(`aria-controls names ${open.popupRole === null ? "an element" : `a ${open.popupRole} element`}, not the ${noun} itself (role="${role}")`);
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

/** Words for where focus is, in a sentence: "the menu item 'Rename'", "the page's body". */
export function focusWords(facts: Pick<FocusFacts, "at" | "role" | "name">, noun: string): string {
  const named = facts.name ? ` '${facts.name}'` : "";
  const role = facts.role;
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
