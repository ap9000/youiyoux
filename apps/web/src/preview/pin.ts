/**
 * Pin an interaction state on every element in the frame, so a reviewer sees hover, pressed,
 * focus or disabled without chasing a pointer. The frame's own stylesheets are walked
 * (through @layer, @media and native nesting, as Tailwind v4 writes them); every rule whose
 * selector carries the state's pseudo-class is copied without it, scoped to
 * `[data-pin-state="<state>"]` on the system's root.
 */

export type PinnedState = "hover" | "active" | "focus" | "disabled";

export const PINNED_STATES: readonly PinnedState[] = ["hover", "active", "focus", "disabled"];

const PSEUDO: Readonly<Record<PinnedState, RegExp>> = {
  hover: /:hover\b/g,
  active: /:active\b/g,
  focus: /:focus-visible\b|:focus-within\b|:focus\b/g,
  disabled: /:disabled\b/g,
};

/** A nested selector in the context of its parent (`&:hover` under `.btn` → `.btn:hover`). */
export function resolveNesting(selector: string, parent: string | null): string {
  if (!parent) return selector;
  const outer = parent.includes(",") ? `:is(${parent})` : parent;
  return selector
    .split(",")
    .map((part) => (part.includes("&") ? part.replaceAll("&", outer) : `${outer} ${part.trim()}`))
    .join(", ");
}

/** The pinned copy of one rule, or null when its selector does not use the state. */
export function pinnedRule(selector: string, declarations: string, state: PinnedState): string | null {
  const pseudo = PSEUDO[state];
  pseudo.lastIndex = 0;
  if (!declarations.trim() || !pseudo.test(selector)) return null;
  const parts = selector.split(",").filter((part) => {
    pseudo.lastIndex = 0;
    return pseudo.test(part);
  });
  const stripped = parts.map((part) => part.replace(pseudo, "").trim() || "*").join(", ");
  return `[data-pin-state="${state}"] :is(${stripped}) { ${declarations} }`;
}

interface RuleLike {
  readonly selectorText?: string;
  readonly style?: { readonly cssText: string };
  readonly cssRules?: ArrayLike<RuleLike>;
}

/** Every pinned rule for `state` in these rules, depth first. */
export function collectPinned(rules: ArrayLike<RuleLike>, state: PinnedState, parent: string | null = null, out: string[] = []): string[] {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (typeof rule.selectorText === "string") {
      const selector = resolveNesting(rule.selectorText, parent);
      const pinned = pinnedRule(selector, rule.style?.cssText ?? "", state);
      if (pinned) out.push(pinned);
      if (rule.cssRules?.length) collectPinned(rule.cssRules, state, selector, out);
    } else if (rule.cssRules?.length) {
      // @layer, @media, @supports: their conditions do not matter for a pinned preview.
      collectPinned(rule.cssRules, state, parent, out);
    }
  }
  return out;
}

/** Inject the stylesheet that pins `state` (once; it applies only under `[data-pin-state]`). */
export function ensurePinned(state: PinnedState): void {
  const id = `yx-pin-${state}`;
  if (document.getElementById(id)) return;
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if ((sheet.ownerNode as HTMLElement | null)?.id?.startsWith("yx-pin-")) continue;
    try {
      collectPinned(sheet.cssRules as unknown as ArrayLike<RuleLike>, state, null, out);
    } catch {
      // A sheet from another origin cannot be read; the frame's own sheets always can.
    }
  }
  const style = document.createElement("style");
  style.id = id;
  style.textContent = out.join("\n");
  document.head.append(style);
}

/** Pin `state` on everything inside `root`, or clear it with null. */
export function pinState(root: HTMLElement, state: PinnedState | null): void {
  if (state) {
    ensurePinned(state);
    root.setAttribute("data-pin-state", state);
  } else root.removeAttribute("data-pin-state");
}
