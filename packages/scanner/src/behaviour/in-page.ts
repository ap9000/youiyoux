/**
 * What a behaviour probe runs inside the page, in two worlds (probe.ts drives both over CDP):
 *
 * - **The probe's own isolated world** (`isolatedLibrary`, installed once per page): the page's
 *   scripts can't see it or change what it calls (a page that patches getAttribute,
 *   querySelectorAll or Element.prototype patches only its own world). Everything that decides
 *   what may be clicked runs here: which elements are triggers (launchers only), their names and
 *   patterns, the check of the exact element just before the click, where to click, whether the
 *   click landed on it, and which popup opened.
 * - **The page's main world**, only for what exists only there: React's fibers, which name the
 *   component holding a trigger, its source frames (display only), and the elements a contract
 *   binding points at. What the main world says is a label or a nomination; every element it
 *   nominates is checked again in the isolated world before it can be clicked.
 *
 * Each function is self-contained (it is sent as source); none of them changes the page.
 */
import type { BehaviourBinding, BehaviourPattern, PartRef } from "@youiyoux/core";
import type { Frame } from "../screens/locate.ts";

export interface ContractBinding {
  /** The component's name as React knows it (its function's name or displayName). */
  readonly component: string;
  readonly binding: BehaviourBinding;
}

/** A trigger found on the page, before its frames are mapped to a file and line. */
export interface FoundTarget {
  readonly pattern: BehaviourPattern;
  /** The nearest named React component holding the trigger (a contract's own), or null for plain markup. */
  readonly component: string | null;
  readonly accessibleName: string;
  /** How it was found: a contract binding (its index in the bindings given) or the DOM's own claims. */
  readonly via: { readonly contract: number } | "dom";
  /** The JSX call's frames, nearest first (the trigger's own, else its component's). */
  readonly frames: readonly Frame[];
  readonly domPath: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** What isolated-world discovery returns: everything but the main world's labels. */
export type IsolatedTarget = Omit<FoundTarget, "component" | "frames">;

export type PopupFound =
  | { readonly state: "open"; readonly how: "aria-controls" | "popovertarget" | "contract" | "role"; readonly role: string; readonly domPath: string }
  | { readonly state: "none" }
  | { readonly state: "several"; readonly count: number }
  | { readonly state: "was-open"; readonly how: "aria-controls" | "popovertarget" | "contract" };

export type ClickPoint = { readonly ok: true; readonly x: number; readonly y: number } | { readonly ok: false; readonly why: string };

/** Whether effective focus is where a key is sent from: already there, moved there by the probe (focus(), never a click or a key), or not placeable. */
export type FocusPlaced = { readonly ok: true; readonly moved: boolean } | { readonly ok: false };

/**
 * The probe's library, installed in its isolated world as `globalThis.__youiyoux`. Only DOM
 * standard APIs, in that world's own copies.
 *
 * A **launcher** (the only kind of element ever clicked): a `<button>` that does nothing in a form
 * (type="button", or no type and no form), an `<input type="button">`, an element with role
 * `button` or `combobox` that isn't a link with an href or a form control that submits; never one
 * inside a link, never one inside a popup that is open (a menu, listbox, dialog, tooltip, open
 * native dialog or popover), never disabled, hidden, inert or aria-hidden. Menu items, options,
 * tabs, links, summaries, submit and reset buttons are never launchers.
 */
export function isolatedLibrary(): void {
  type Pattern = "menu-button" | "combobox-listbox" | "modal-dialog" | "popover";
  const ROLE: Record<Pattern, string> = { "menu-button": '[role="menu"]', "combobox-listbox": '[role="listbox"]', "modal-dialog": 'dialog,[role="dialog"],[role="alertdialog"]', popover: "[popover]" };
  const POPUP = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tooltip"],dialog,[popover]';
  const state = { elements: [] as Element[], before: [] as Element[], clicked: null as EventTarget | null, watching: false, popup: null as Element | null, popupId: null as string | null, popupRole: null as string | null, atKey: [] as Element[] };
  const all = (): Element[] => {
    const out: Element[] = [];
    const collect = (root: Document | ShadowRoot): void => {
      for (const element of root.querySelectorAll("*")) {
        out.push(element);
        if (element.shadowRoot) collect(element.shadowRoot);
      }
    };
    collect(document);
    return out;
  };
  /** The element's ancestors, across shadow roots. */
  const ancestors = (element: Element): Element[] => {
    const out: Element[] = [];
    for (let node: Node | null = element.parentNode; node; node = node instanceof ShadowRoot ? node.host : node.parentNode) if (node instanceof Element) out.push(node);
    return out;
  };
  const shown = (element: Element): boolean =>
    element.isConnected &&
    (element as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false &&
    ![element, ...ancestors(element)].some((e) => e.hasAttribute("inert") || e.getAttribute("aria-hidden") === "true" || e.hasAttribute("hidden")) &&
    (element.localName !== "dialog" || (element as HTMLDialogElement).open) &&
    (!element.hasAttribute("popover") || element.matches(":popover-open"));
  const enabled = (element: Element): boolean => !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true" && !ancestors(element).some((e) => e.getAttribute("aria-disabled") === "true");
  const insideOpenPopup = (element: Element): boolean => ancestors(element).some((e) => e.matches(POPUP) && shown(e));
  const launcher = (element: Element): boolean => {
    const tag = element.localName;
    const role = element.getAttribute("role");
    if (ancestors(element).some((e) => (e.localName === "a" || e.localName === "area") && e.hasAttribute("href"))) return false;
    if ((tag === "a" || tag === "area") && element.hasAttribute("href")) return false;
    if (tag === "summary" || tag === "label" || tag === "option" || tag === "select" || tag === "textarea") return false;
    if (tag === "button") {
      const button = element as HTMLButtonElement;
      if (role !== null && role !== "button") return false;
      // A submit button submits only in a form: outside one, a button without a type does nothing by itself.
      return button.type === "button" || (button.type === "submit" && !element.hasAttribute("type") && button.form === null);
    }
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "button") return role === null || role === "button";
      // A text field that is a combobox: clicking it focuses it.
      return role === "combobox" && /^(?:text|search|email|url|tel)$/.test(type);
    }
    return role === "button" || role === "combobox";
  };
  const usable = (element: Element): boolean => launcher(element) && shown(element) && enabled(element) && !insideOpenPopup(element);
  const text = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const byId = (element: Element, id: string): Element | null => ((element.getRootNode() as Document | ShadowRoot).getElementById?.(id) as Element | null) ?? document.getElementById(id);
  const accessibleName = (element: Element): string => {
    const labelledby = element.getAttribute("aria-labelledby");
    if (labelledby) {
      const named = text(labelledby.split(/\s+/).map((id) => byId(element, id)?.textContent ?? "").join(" "));
      if (named) return named.slice(0, 200);
    }
    const label = text(element.getAttribute("aria-label"));
    if (label) return label.slice(0, 200);
    if (element.localName === "input") {
      const input = element as HTMLInputElement;
      if (input.type === "button") return text(input.value).slice(0, 200);
      const fromLabel = text(input.labels ? [...input.labels].map((l) => l.textContent).join(" ") : "");
      if (fromLabel) return fromLabel.slice(0, 200);
      return text(element.getAttribute("title") || element.getAttribute("placeholder")).slice(0, 200);
    }
    return text(element.textContent || element.getAttribute("title")).slice(0, 200);
  };
  const isModal = (element: Element | null): boolean =>
    !!element && (element.localName === "dialog" || element.getAttribute("role") === "alertdialog" || (element.getAttribute("role") === "dialog" && element.getAttribute("aria-modal") === "true"));
  /** The pattern a launcher's own markup claims, or null. */
  const claimed = (element: Element): Pattern | null => {
    if (element.getAttribute("role") === "combobox") return "combobox-listbox";
    const popup = element.getAttribute("aria-haspopup");
    const controls = element.getAttribute("aria-controls");
    const controlled = controls ? byId(element, controls.split(/\s+/)[0]!) : null;
    if (popup === "menu" || popup === "true") return "menu-button";
    if (popup === "dialog" || (element.getAttribute("command") === "show-modal" && element.hasAttribute("commandfor")) || isModal(controlled)) return "modal-dialog";
    if (element.hasAttribute("popovertarget")) return "popover";
    if (element.hasAttribute("aria-expanded") && controls) return "popover";
    return null;
  };
  const domPath = (element: Element): string => {
    const steps: string[] = [];
    for (let node: Element | null = element; node && node !== document.documentElement && steps.length < 6; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.localName === node!.localName) : [];
      steps.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
    }
    return steps.join(" > ");
  };
  const roleOf = (element: Element): string => element.getAttribute("role") ?? (element.localName === "dialog" ? "dialog" : element.hasAttribute("popover") ? "popover" : element.localName);
  const describe = (element: Element, pattern: Pattern, via: IsolatedTarget["via"]): IsolatedTarget => {
    const rect = element.getBoundingClientRect();
    return { pattern, accessibleName: accessibleName(element), via, domPath: domPath(element), box: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) } };
  };
  /** Why the exact element found can't be clicked now, or null when it still can. */
  const recheck = (element: Element | undefined, wanted: { readonly pattern: Pattern; readonly accessibleName: string; readonly dom: boolean }): string | null => {
    if (!element || !element.isConnected) return "the button is no longer on the screen";
    if (!launcher(element)) return "the element is no longer a button that only opens something";
    if (!shown(element) || !enabled(element)) return "the button is hidden or disabled now";
    if (insideOpenPopup(element)) return "the button is inside a popup that is open";
    if (accessibleName(element) !== wanted.accessibleName || (wanted.dom && claimed(element) !== wanted.pattern)) return "the button changed (its name or what it opens) before it could be clicked";
    return null;
  };
  /** The point hits the element (or something inside it), shadow roots included. */
  const hits = (element: Element, x: number, y: number): boolean => {
    let hit: Element | null = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return !!hit && (hit === element || element.contains(hit) || !!element.shadowRoot?.contains(hit));
  };
  /** document.activeElement, through open shadow roots. */
  const deepActive = (): Element | null => {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  /**
   * Effective focus (docs/plans/behaviour-rules.md): the focused element, except that a combobox or
   * listbox with aria-activedescendant means the element it names, which must exist, belong to the
   * widget (inside it, or inside what its aria-controls names) and not be aria-disabled; else none.
   */
  const effectiveFocus = (): Element | null => {
    const active = deepActive();
    if (!active) return null;
    const role = active.getAttribute("role");
    const id = active.getAttribute("aria-activedescendant");
    if ((role !== "combobox" && role !== "listbox") || !id) return active;
    const named = byId(active, id);
    const controls = active.getAttribute("aria-controls");
    const owned = controls ? byId(active, controls.split(/\s+/)[0]!) : null;
    const belongs = !!named && (named === active || ancestors(named).includes(active) || (!!owned && (named === owned || ancestors(named).includes(owned))));
    return belongs && named!.getAttribute("aria-disabled") !== "true" ? named : null;
  };
  /** Elements inside `root` (shadow roots included) that focus() can move focus to, in document order. */
  const focusablesIn = (root: Element): Element[] => {
    const FOCUSABLE = "a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]:not([contenteditable=false])";
    const out: Element[] = [];
    const collect = (node: Element | ShadowRoot): void => {
      for (const element of node.querySelectorAll("*")) {
        if (element.matches(FOCUSABLE) && !(element as HTMLButtonElement).disabled && !(element.localName === "input" && (element as HTMLInputElement).type === "hidden") && shown(element)) out.push(element);
        if (element.shadowRoot) collect(element.shadowRoot);
      }
    };
    collect(root);
    if (root.shadowRoot) collect(root.shadowRoot);
    return out;
  };
  /** The popup identified: the element itself, its id and its role, to judge it (and anything replacing it) later. */
  const remember = (popup: Element): void => {
    state.popup = popup;
    state.popupId = popup.id || null;
    state.popupRole = roleOf(popup);
  };
  /** An element of the popup's kind: the pattern's role, or the identified popup's own role. */
  const ofKind = (element: Element, pattern: Pattern): boolean => element.matches(ROLE[pattern]) || (element.getAttribute("role") !== null && roleOf(element) === state.popupRole);
  /** Effective focus inside `popup`, or (combobox) DOM focus on the combobox. */
  const focusPlaced = (trigger: Element, popup: Element, pattern: Pattern): boolean => {
    if (pattern === "combobox-listbox" && deepActive() === trigger) return true;
    const at = effectiveFocus();
    return !!at && (at === popup || ancestors(at).includes(popup));
  };
  const library = {
    /**
     * Every usable trigger: those contract bindings nominated (each checked here; `nominated[i]`
     * is bound by `bindings[i]`), then those the markup claims. At most `limit`.
     */
    discover(spec: { readonly limit: number; readonly nominated: ReadonlyArray<{ readonly binding: number; readonly pattern: Pattern }> }, nominated: Element[]): { found: IsolatedTarget[]; refused: number } {
      const found: IsolatedTarget[] = [];
      const elements: Element[] = [];
      let refused = 0;
      spec.nominated.forEach(({ binding, pattern }, i) => {
        const element = nominated[i];
        if (!element || elements.includes(element) || found.length >= spec.limit) return;
        if (!usable(element)) return void refused++;
        elements.push(element);
        found.push(describe(element, pattern, { contract: binding }));
      });
      for (const element of all()) {
        if (found.length >= spec.limit) break;
        if (elements.includes(element) || !usable(element)) continue;
        const pattern = claimed(element);
        if (!pattern) continue;
        elements.push(element);
        found.push(describe(element, pattern, "dom"));
      }
      state.elements = elements;
      return { found, refused };
    },
    element(index: number): Element | null {
      return state.elements[index] ?? null;
    },
    markShowing(pattern: Pattern): void {
      state.before = all().filter((element) => element.matches(ROLE[pattern]) && shown(element));
      state.atKey = state.before;
    },
    /**
     * The exact element found, checked again now: still connected, still a usable launcher, still
     * the same name and pattern, not inside an open popup. Brought into view; its centre is where to
     * click, and only if that point hits it (or something inside it). A click listener of this world
     * then notes where the click lands.
     */
    prepareClick(wanted: { readonly index: number; readonly pattern: Pattern; readonly accessibleName: string; readonly dom: boolean }): ClickPoint {
      const element = state.elements[wanted.index];
      const refused = recheck(element, wanted);
      if (refused || !element) return { ok: false, why: refused ?? "the button is no longer on the screen" };
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (!hits(element, x, y)) return { ok: false, why: "something else covers the button, so it wasn't clicked" };
      return { ok: true, x, y };
    },
    /**
     * With the pointer already at (x, y) (hover handlers have run): the same element, still a usable
     * launcher, the same name and pattern, and still what that point hits. Only then is it pressed.
     * Nothing is scrolled here, so the point stays where the pointer is.
     */
    confirmAt(wanted: { readonly index: number; readonly pattern: Pattern; readonly accessibleName: string; readonly dom: boolean; readonly x: number; readonly y: number }): ClickPoint {
      const element = state.elements[wanted.index];
      const refused = recheck(element, wanted);
      if (refused || !element) return { ok: false, why: `${refused ?? "the button is no longer on the screen"} once the pointer reached it` };
      if (!hits(element, wanted.x, wanted.y)) return { ok: false, why: "something else was under the pointer once it reached the button, so it wasn't clicked" };
      state.clicked = null;
      if (!state.watching) {
        state.watching = true;
        addEventListener("click", (event) => void (state.clicked = event.composedPath()[0] ?? event.target), { capture: true });
      }
      return { ok: true, x: wanted.x, y: wanted.y };
    },
    /** Where the click landed: on the button (or inside it), elsewhere, or not seen at all. */
    clicked(index: number): "on" | "elsewhere" | "unseen" {
      const element = state.elements[index];
      const at = state.clicked;
      if (!at) return "unseen";
      return element && at instanceof Node && (at === element || element.contains(at) || !!element.shadowRoot?.contains(at)) ? "on" : "elsewhere";
    },
    /**
     * The popup the click opened, positively identified: the element its relationship names
     * (aria-controls, popovertarget), or the contract's popup part (`parts`, nominated in the
     * component's own instance); without either, the single element of the pattern's role that
     * shows now and didn't before. Never by position.
     */
    identify(wanted: { readonly index: number; readonly pattern: Pattern; readonly contract: boolean }, parts: Element[]): PopupFound {
      const trigger = state.elements[wanted.index];
      if (!trigger) return { state: "none" };
      const settle = (candidates: Element[], how: "aria-controls" | "popovertarget" | "contract"): PopupFound => {
        const open = candidates.filter(shown);
        if (open.length === 0) return { state: "none" };
        if (open.length > 1) return { state: "several", count: open.length };
        if (state.before.includes(open[0]!)) return { state: "was-open", how };
        remember(open[0]!);
        return { state: "open", how, role: roleOf(open[0]!), domPath: domPath(open[0]!) };
      };
      if (wanted.contract) return settle(parts, "contract");
      const controls = trigger.getAttribute("aria-controls");
      if (controls) return settle(controls.split(/\s+/).filter(Boolean).map((id) => byId(trigger, id)).filter((e): e is Element => e !== null), "aria-controls");
      const target = trigger.getAttribute("popovertarget");
      if (target) {
        const element = byId(trigger, target);
        return settle(element ? [element] : [], "popovertarget");
      }
      const fresh = all().filter((element) => element.matches(ROLE[wanted.pattern]) && shown(element) && !state.before.includes(element));
      if (fresh.length === 0) return { state: "none" };
      if (fresh.length > 1) return { state: "several", count: fresh.length };
      remember(fresh[0]!);
      return { state: "open", how: "role", role: roleOf(fresh[0]!), domPath: domPath(fresh[0]!) };
    },
    /**
     * Effective focus inside the popup identified last (or, for a combobox, on the combobox), so a
     * key can be sent from there. Where the app put it is kept; else the probe calls focus() on the
     * combobox, or on the first focusable element inside the popup, then on the popup itself, and
     * checks again after each. Nothing is clicked and no key is sent here.
     */
    placeFocus(wanted: { readonly index: number; readonly pattern: Pattern }): FocusPlaced {
      const trigger = state.elements[wanted.index];
      const popup = state.popup;
      if (!trigger || !popup || !popup.isConnected) return { ok: false };
      if (focusPlaced(trigger, popup, wanted.pattern)) return { ok: true, moved: false };
      const candidates = wanted.pattern === "combobox-listbox" ? [trigger] : [...focusablesIn(popup).slice(0, 50), popup];
      for (const candidate of candidates) {
        (candidate as HTMLElement).focus?.({ preventScroll: true });
        if (focusPlaced(trigger, popup, wanted.pattern)) return { ok: true, moved: true };
      }
      return { ok: false };
    },
    /**
     * Immediately before a key: the very popup identified (the same element, never one found again)
     * is still connected and showing, and effective focus is still inside it (or on the combobox).
     */
    ready(wanted: { readonly index: number; readonly pattern: Pattern }): boolean {
      const trigger = state.elements[wanted.index];
      const popup = state.popup;
      const ok = !!trigger && !!popup && popup.isConnected && shown(popup) && focusPlaced(trigger, popup, wanted.pattern);
      // What of its kind shows at the moment the key goes (or would go): anything showing later is new.
      if (ok) state.atKey = all().filter((element) => ofKind(element, wanted.pattern) && shown(element));
      return ok;
    },
    /**
     * Whether the popup identified is open now, judged on that element itself: never by the
     * trigger's relationship, which an app can drop while the popup stays open. Hidden or removed:
     * "check", and the caller reconciles (a replacement with its identity may be showing).
     */
    popupState(): "open" | "check" | "unknown" {
      const popup = state.popup;
      if (!popup) return "unknown";
      // Hidden or removed: never closed before what may have replaced it is looked for (reconcile).
      return popup.isConnected && shown(popup) ? "open" : "check";
    },
    /**
     * The popup identified is hidden or removed: does something with its identity show in its place?
     * Its id (the relationship's target), or the contract's popup part (`parts`, nominated again),
     * with the same role. One showing: that is the popup now, open. Several: can't tell. None:
     * closed, but only if nothing new of its kind shows since the key; otherwise can't tell.
     */
    reconcile(wanted: { readonly pattern: Pattern }, parts: Element[]): "open" | "closed" | "unknown" {
      const sameRole = (element: Element): boolean => roleOf(element) === state.popupRole;
      const byIdNow = state.popupId ? all().filter((element) => element.id === state.popupId && sameRole(element)) : [];
      const showing = [...new Set([...byIdNow, ...parts.filter((element) => element.isConnected && sameRole(element))])].filter(shown);
      if (showing.length > 1) return "unknown";
      if (showing.length === 1) {
        remember(showing[0]!);
        return "open";
      }
      // Nothing with its identity shows: closed only if nothing new of its kind shows since the key.
      const fresh = all().filter((element) => element !== state.popup && ofKind(element, wanted.pattern) && shown(element) && !state.atKey.includes(element));
      return fresh.length === 0 ? "closed" : "unknown";
    },
    /** A sign-in form shows: a visible password field. */
    signInForm(): boolean {
      return all().some((element) => element.localName === "input" && (element as HTMLInputElement).type === "password" && shown(element));
    },
  };
  (globalThis as unknown as { __youiyoux: typeof library }).__youiyoux = library;
}

/**
 * Main world, `this` the document: the elements contract bindings point at as triggers, each with
 * its binding's index. Only a nomination: the isolated world decides whether each may be clicked.
 */
export function nominateContractTriggersInPage(this: Document, bindings: ReadonlyArray<{ readonly component: string; readonly trigger: PartRef | null }>): Array<[Element, number]> {
  type Fiber = { tag: number; type: unknown; return: Fiber | null };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const nameOf = (type: unknown): string | null => {
    const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | null;
    return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || t?.type?.displayName || t?.type?.name || null;
  };
  const fiberOf = (element: Element): Fiber | null => {
    const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
    return key ? ((element as unknown as Record<string, Fiber>)[key] ?? null) : null;
  };
  const bound = new Map(bindings.map((b, i) => [b.component, i]));
  const matches = (element: Element, part: PartRef | null): boolean =>
    part === null ? element.hasAttribute("aria-haspopup") || element.getAttribute("role") === "combobox" || element.hasAttribute("popovertarget") || (element.hasAttribute("aria-expanded") && element.hasAttribute("aria-controls"))
    : "part" in part ? element.getAttribute("data-part") === part.part || element.getAttribute("data-slot") === part.part
    : element.getAttribute("role") === part.role || (part.role === "button" && element.localName === "button");
  const out: Array<[Element, number]> = [];
  if (bound.size === 0) return out;
  for (const element of this.querySelectorAll("*")) {
    for (let node = fiberOf(element); node; node = node.return) {
      const index = COMPONENT.has(node.tag) ? bound.get(nameOf(node.type) ?? "") : undefined;
      if (index === undefined) continue;
      if (matches(element, bindings[index]!.trigger)) out.push([element, index]);
      break;
    }
  }
  return out;
}

/**
 * Main world, `this` the trigger: the component holding it (the bound one, when `component` is
 * given) and the JSX frames for its file and line. Labels for display and identity only.
 */
export function labelsInPage(this: Element, args: { readonly component: string | null; readonly maxFrames: number }): { component: string | null; frames: Frame[] } {
  type Fiber = { tag: number; type: unknown; return: Fiber | null; _debugStack?: { stack?: string } | Error | null };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const nameOf = (type: unknown): string | null => {
    const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | null;
    const name = t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || t?.type?.displayName || t?.type?.name || null;
    return typeof name === "string" ? name.slice(0, 200) : null;
  };
  const key = Object.keys(this).find((k) => k.startsWith("__reactFiber$"));
  const own = key ? ((this as unknown as Record<string, Fiber>)[key] ?? null) : null;
  let owner: Fiber | null = null;
  for (let node = own?.return ?? null; node; node = node.return) if (COMPONENT.has(node.tag) && (args.component ? nameOf(node.type) === args.component : nameOf(node.type))) {
    owner = node;
    break;
  }
  const INTERNAL = /\/node_modules\/|\/\.vite\/deps\/|\/_next\/static\/chunks\/(?:framework|main|webpack)|react-dom|jsx-dev-runtime|jsx-runtime/;
  const framesOf = (fiber: Fiber | null): Frame[] => {
    const stack = fiber?._debugStack && typeof fiber._debugStack === "object" && "stack" in fiber._debugStack ? fiber._debugStack.stack : undefined;
    const frames: Frame[] = [];
    for (const text of String(stack ?? "").split("\n").slice(1)) {
      if (/react[-_]stack[-_]bottom[-_]frame/.test(text)) break;
      const match = /((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(text);
      if (!match || INTERNAL.test(match[1]!)) continue;
      frames.push({ url: match[1]!.slice(0, 2000), line: Number(match[2]), column: Number(match[3]) });
      if (frames.length >= args.maxFrames) break;
    }
    return frames;
  };
  const frames = framesOf(own);
  return { component: args.component ?? (owner ? nameOf(owner.type) : null), frames: frames.length ? frames : framesOf(owner) };
}

/**
 * Main world, `this` the trigger: the elements in its bound component's own instance (portals
 * included) that match the contract's popup part. Only a nomination: the isolated world decides
 * whether one is the popup that opened.
 */
export function contractPopupsInPage(this: Element, args: { readonly component: string; readonly part: PartRef }): Element[] {
  type Fiber = { tag: number; type: unknown; return: Fiber | null; alternate: Fiber | null };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const nameOf = (type: unknown): string | null => {
    const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | null;
    return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || t?.type?.displayName || t?.type?.name || null;
  };
  const fiberOf = (element: Element): Fiber | null => {
    const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
    return key ? ((element as unknown as Record<string, Fiber>)[key] ?? null) : null;
  };
  let scope: Fiber | null = null;
  for (let node = fiberOf(this); node; node = node.return) if (COMPONENT.has(node.tag) && nameOf(node.type) === args.component) {
    scope = node;
    break;
  }
  if (!scope) return [];
  const inScope = (element: Element): boolean => {
    for (let node = fiberOf(element); node; node = node.return) if (node === scope || node === scope!.alternate) return true;
    return false;
  };
  const part = args.part;
  return [...document.querySelectorAll("*")].filter((element) => ("part" in part ? element.getAttribute("data-part") === part.part || element.getAttribute("data-slot") === part.part : element.getAttribute("role") === part.role || (part.role === "dialog" && element.localName === "dialog")) && inScope(element));
}

/**
 * Run before any of the app's scripts, in every frame: `window.open` opens nothing, a service worker
 * can't register (Playwright's own block covers only `navigator.serviceWorker.register`, not the
 * prototype's), and peer connections (which could leave without the fence) don't exist. A string,
 * so it runs as written.
 */
export const PROBE_INIT_SCRIPT = `(() => {
  const nothing = function () { return null; };
  try { Object.defineProperty(window, "open", { value: nothing, writable: false, configurable: false }); } catch {}
  try {
    const refuse = function () { return Promise.reject(new DOMException("service workers are blocked while probing", "SecurityError")); };
    Object.defineProperty(ServiceWorkerContainer.prototype, "register", { value: refuse, writable: false, configurable: false });
  } catch {}
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport"]) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
})();`;
