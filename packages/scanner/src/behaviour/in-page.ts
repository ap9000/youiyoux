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

/**
 * A trigger's ARIA state as read in the probe's own world (trigger-state): its attributes as written,
 * and whether its relationships name the popup identified last (null before one is, or when the
 * relationship isn't there).
 */
export interface TriggerFacts {
  readonly connected: boolean;
  readonly expanded: string | null;
  readonly haspopup: string | null;
  /** aria-controls is there (and names at least one id). */
  readonly controls: boolean;
  /** One of the ids aria-controls names is the identified popup. */
  readonly controlsPopup: boolean | null;
  readonly popovertarget: boolean;
  /** popovertarget names the identified popup. */
  readonly popovertargetPopup: boolean | null;
  /** The identified popup's role (its role attribute, else dialog, popover or its tag), or null. */
  readonly popupRole: string | null;
}

/**
 * Where effective focus is, against the trigger and the popup identified last: on the trigger, the
 * popup itself, an item of it (a menu item for a menu, an option for a listbox), something else
 * inside it, the page's body, outside the page altogether (the browser's own toolbar), or
 * elsewhere on the page. `open`: that popup is still connected and showing.
 */
export interface FocusFacts {
  readonly open: boolean;
  readonly at: "trigger" | "popup" | "item" | "inside" | "body" | "away" | "outside";
  /** The focused element's role (its role attribute, else its tag) and accessible name, for the words. */
  readonly role: string;
  readonly name: string;
}

/**
 * Where focus went once the popup closed (focus-return): FocusFacts, with "part" when it is on (or
 * inside) the contract's returnFocusTo part, and whether the trigger is still on the page.
 */
export interface ReturnFacts {
  readonly trigger: "connected" | "gone";
  /**
   * The contract's returnFocusTo part, as found before the click (holdReturnTarget): exactly one
   * element ("one"), none, or several (can't tell which); null when no part was declared.
   */
  readonly part: "one" | "none" | "several" | null;
  readonly at: FocusFacts["at"] | "part";
  readonly role: string;
  readonly name: string;
}

/** Where effective focus is against a dialog's tabbable elements (focus-trap). */
export type TrapAt = { readonly kind: "tabbable"; readonly i: number } | { readonly kind: "popup" | "inside" | "body" | "away" | "outside"; readonly role: string; readonly name: string };

/**
 * A modal dialog's focus facts (focus-trap): whether it is modal (a native <dialog> shown with
 * showModal(), or role dialog/alertdialog with aria-modal="true"), what would stop the check (a
 * popup open inside it, a frame, a Tab order it doesn't model), its tabbable elements in Tab
 * order (role and name, for the words), where focus is, and whether that list changed since the
 * first look.
 */
export interface TrapFacts {
  readonly open: boolean;
  readonly modal: "native" | "aria" | null;
  readonly nested: string | null;
  readonly frame: boolean;
  /** What makes the dialog's Tab order something youiyoux doesn't model yet, if anything. */
  readonly unmodelled: "positive tabindex" | "a shadow root" | "radio buttons" | null;
  readonly tabbables: ReadonlyArray<{ readonly role: string; readonly name: string }>;
  readonly at: TrapAt;
  readonly stale: boolean;
}

/** Where effective focus is against a menu's or listbox's items (arrow-keys). */
export type ItemAt =
  | { readonly kind: "item"; readonly i: number }
  /** DOM focus on the combobox with no active option. */
  | { readonly kind: "combobox" }
  /** aria-activedescendant names an id that isn't on the page, or an element outside the widget. */
  | { readonly kind: "dangling"; readonly why: "missing" | "outside" }
  | { readonly kind: "popup" | "inside" | "body" | "away" | "outside"; readonly role: string; readonly name: string };

/**
 * A menu's or listbox's arrow-key facts: its orientation, its top-level items in document order
 * (menu items for a menu, options for a listbox; each enabled or not, with its name for the words),
 * where effective focus is (aria-activedescendant resolved), and whether the items changed since
 * the first look.
 */
export interface ItemFacts {
  readonly open: boolean;
  readonly orientation: "vertical" | "horizontal";
  readonly items: ReadonlyArray<{ readonly enabled: boolean; readonly name: string }>;
  readonly at: ItemAt;
  readonly stale: boolean;
}

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
  const state = { returnTarget: null as Element | null, returnPart: null as "one" | "none" | "several" | null, items: [] as Element[], tabbables: [] as Element[], elements: [] as Element[], before: [] as Element[], clicked: null as EventTarget | null, watching: false, popup: null as Element | null, popupId: null as string | null, popupRole: null as string | null, atKey: [] as Element[] };
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
  // A name as the probe keeps it: control, format and direction characters dropped, whitespace collapsed (the same rule as core's cleanText).
  const text = (value: string | null | undefined): string => (value ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, " ").replace(/\s+/g, " ").trim();
  const byId = (element: Element, id: string): Element | null => ((element.getRootNode() as Document | ShadowRoot).getElementById?.(id) as Element | null) ?? document.getElementById(id);
  /**
   * An element's text as a name, the way a browser joins it: every element that isn't laid out
   * inline (a block, a flex item, a table cell) starts and ends a word, so "Copy sync command" in
   * one block and "youiyoux sync" in the next stay two phrases; an aria-hidden part is left out, a
   * labelled part gives its label, an image its alt. Bounded in depth and length.
   */
  const textOf = (root: Node): string => {
    let out = "";
    const walk = (node: Node, depth: number): void => {
      if (out.length > 400 || depth > 32) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue ?? "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (element !== root && element.getAttribute("aria-hidden") === "true") return;
      const display = element === root ? "inline" : getComputedStyle(element).display;
      const apart = display !== "inline" && display !== "contents";
      if (apart) out += " ";
      const label = element !== root ? element.getAttribute("aria-label") : null;
      if (label) out += label;
      else if (element.localName === "img") out += element.getAttribute("alt") ?? "";
      else for (const child of element.childNodes) walk(child, depth + 1);
      if (apart) out += " ";
    };
    walk(root, 0);
    return out;
  };
  const accessibleName = (element: Element): string => {
    const labelledby = element.getAttribute("aria-labelledby");
    if (labelledby) {
      const named = text(labelledby.split(/\s+/).map((id) => { const by = byId(element, id); return by ? textOf(by) : ""; }).join(" "));
      if (named) return named.slice(0, 200);
    }
    const label = text(element.getAttribute("aria-label"));
    if (label) return label.slice(0, 200);
    if (element.localName === "input") {
      const input = element as HTMLInputElement;
      if (input.type === "button") return text(input.value).slice(0, 200);
      const fromLabel = text(input.labels ? [...input.labels].map((l) => textOf(l)).join(" ") : "");
      if (fromLabel) return fromLabel.slice(0, 200);
      return text(element.getAttribute("title") || element.getAttribute("placeholder")).slice(0, 200);
    }
    return (text(textOf(element)) || text(element.getAttribute("title"))).slice(0, 200);
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
    // aria-expanded with aria-controls is a popover only when what it controls is one (a native
    // popover, or a menu, listbox or dialog); otherwise it is a disclosure (a section that folds
    // open in the page), which v1 doesn't check, so it is not a target. A controlled element that
    // isn't there yet can't be told apart from a disclosure's, so it isn't one either.
    if (element.hasAttribute("aria-expanded") && controlled && (controlled.hasAttribute("popover") || ["menu", "listbox", "dialog", "alertdialog"].includes(controlled.getAttribute("role") ?? ""))) return "popover";
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
  /** Roles whose aria-activedescendant moves effective focus (APG: a combobox, a listbox, a menu that manages its own focus). */
  const ACTIVE_DESCENDANT_ROLES = ["combobox", "listbox", "menu"];
  /**
   * Effective focus (docs/plans/behaviour-rules.md): the focused element, except that a combobox,
   * listbox or menu with aria-activedescendant means the element it names, which must exist and
   * belong to the widget (inside it, or inside what its aria-controls names); else none. A disabled
   * item may hold it (APG lets disabled menu items and options take focus).
   */
  const effectiveFocus = (): Element | null => {
    const active = deepActive();
    if (!active) return null;
    const id = (active.getAttribute("aria-activedescendant") ?? "").trim();
    if (!ACTIVE_DESCENDANT_ROLES.includes(active.getAttribute("role") ?? "") || !id) return active;
    const named = byId(active, id);
    const controls = active.getAttribute("aria-controls");
    const owned = controls ? byId(active, controls.split(/\s+/)[0]!) : null;
    const belongs = !!named && (named === active || ancestors(named).includes(active) || (!!owned && (named === owned || ancestors(named).includes(owned))));
    return belongs ? named : null;
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
  const ITEM_ROLES = ["menuitem", "menuitemradio", "menuitemcheckbox", "option"];
  /** Where effective focus is, against `trigger` and `popup` (FocusFacts). */
  const focusFacts = (trigger: Element | undefined, popup: Element | null): FocusFacts => {
    const open = !!popup && popup.isConnected && shown(popup);
    const active = deepActive();
    const at = effectiveFocus();
    const of = (element: Element | null): { role: string; name: string } => ({ role: element ? (element.getAttribute("role") ?? element.localName) : "none", name: element ? accessibleName(element) : "" });
    if (!document.hasFocus()) return { open, at: "away", ...of(null) };
    if (!active || active === document.body || active === document.documentElement) return { open, at: "body", ...of(active) };
    if (at && trigger && at === trigger) return { open, at: "trigger", ...of(at) };
    if (at && popup && at === popup) return { open, at: "popup", ...of(at) };
    if (at && popup && ancestors(at).includes(popup)) return { open, at: ITEM_ROLES.includes(at.getAttribute("role") ?? "") ? "item" : "inside", ...of(at) };
    return { open, at: "outside", ...of(at ?? active) };
  };
  const TABBABLE = 'a[href],area[href],button,input,select,textarea,summary,iframe,audio[controls],video[controls],[tabindex],[contenteditable]:not([contenteditable="false"])';
  /** Tab can reach it: connected, rendered and visible, not inert. (aria-hidden doesn't take an element out of Tab order.) */
  const reachable = (element: Element): boolean => element.isConnected && (element as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false && ![element, ...ancestors(element)].some((e) => e.hasAttribute("inert"));
  /**
   * The elements inside `root` Tab moves through, in document order. What would make that order a
   * guess is reported instead of modelled (`unmodelled`): a positive tabindex anywhere inside (it
   * reorders Tab across the page), a shadow root holding something focusable (slots and
   * delegatesFocus change the order), radio buttons (a group is one Tab stop, chosen by state and
   * direction). A frame inside is reported too.
   */
  const tabbablesIn = (root: Element): { list: Element[]; frame: boolean; unmodelled: "positive tabindex" | "a shadow root" | "radio buttons" | null } => {
    const list: Element[] = [];
    let positive = false;
    let shadow = false;
    let radio = false;
    const collect = (node: Element | ShadowRoot, inShadow: boolean): void => {
      for (const element of node.querySelectorAll("*")) {
        if (element.hasAttribute("tabindex") && (element as HTMLElement).tabIndex > 0) positive = true;
        if (element.matches(TABBABLE) && !element.matches(":disabled") && !(element.localName === "input" && (element as HTMLInputElement).type === "hidden") && (element as HTMLElement).tabIndex >= 0 && reachable(element)) {
          list.push(element);
          if (inShadow) shadow = true;
          if (element.localName === "input" && (element as HTMLInputElement).type === "radio") radio = true;
        }
        if (element.shadowRoot) collect(element.shadowRoot, true);
      }
    };
    collect(root, false);
    if (root.shadowRoot) collect(root.shadowRoot, true);
    return { list, frame: list.some((element) => element.localName === "iframe"), unmodelled: positive ? "positive tabindex" : shadow ? "a shadow root" : radio ? "radio buttons" : null };
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
    /** The trigger's ARIA state now, and whether its relationships name the popup identified last. */
    triggerFacts(wanted: { readonly index: number }): TriggerFacts {
      const trigger = state.elements[wanted.index];
      const popup = state.popup;
      if (!trigger) return { connected: false, expanded: null, haspopup: null, controls: false, controlsPopup: null, popovertarget: false, popovertargetPopup: null, popupRole: null };
      const ids = (trigger.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);
      const target = trigger.hasAttribute("popovertarget") ? ((trigger as HTMLButtonElement).popoverTargetElement ?? byId(trigger, trigger.getAttribute("popovertarget") ?? "")) : null;
      return {
        connected: trigger.isConnected,
        expanded: trigger.getAttribute("aria-expanded"),
        haspopup: trigger.getAttribute("aria-haspopup"),
        controls: ids.length > 0,
        controlsPopup: ids.length > 0 && popup ? ids.some((id) => byId(trigger, id) === popup) : null,
        popovertarget: trigger.hasAttribute("popovertarget"),
        popovertargetPopup: trigger.hasAttribute("popovertarget") && popup ? target === popup : null,
        popupRole: popup ? roleOf(popup) : null,
      };
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
     * Before the click, while the trigger is there: the contract's returnFocusTo part, found from
     * the page's structure alone (never from what the page's scripts say): the trigger's nearest
     * ancestor that holds an element with that part's name (data-part / data-slot) or role, besides
     * the trigger itself. That ancestor is this instance's only if it holds exactly one such element
     * and no other trigger of the same pattern (`rivals`, by their index in the last discovery):
     * another trigger there means the part may be another instance's. Then the part is held for after
     * the popup closes; otherwise ("several": ambiguous, or "none") focus there can't be judged.
     */
    holdReturnTarget(wanted: { readonly index: number; readonly part: PartRef; readonly rivals: readonly number[] }): "one" | "none" | "several" {
      const trigger = state.elements[wanted.index];
      const part = wanted.part;
      const is = (element: Element): boolean => ("part" in part ? element.getAttribute("data-part") === part.part || element.getAttribute("data-slot") === part.part : element.getAttribute("role") === part.role || (part.role === "button" && element.localName === "button"));
      state.returnTarget = null;
      state.returnPart = "none";
      if (!trigger) return state.returnPart;
      for (const scope of ancestors(trigger)) {
        const found: Element[] = [];
        const collect = (node: Element | ShadowRoot): void => {
          for (const element of node.querySelectorAll("*")) {
            if (element !== trigger && !trigger.contains(element) && is(element)) found.push(element);
            if (element.shadowRoot) collect(element.shadowRoot);
          }
        };
        collect(scope);
        if (found.length === 0) continue;
        // The first level holding a part also holds another trigger like this one: whose part it is can't be told.
        const contested = wanted.rivals.some((i) => {
          const rival = state.elements[i];
          return !!rival && rival !== trigger && ancestors(rival).includes(scope);
        });
        state.returnPart = found.length === 1 && !contested ? "one" : "several";
        state.returnTarget = state.returnPart === "one" ? found[0]! : null;
        break;
      }
      return state.returnPart;
    },
    /**
     * Where focus is once the popup closed: on the trigger (still the very element clicked), on the
     * returnFocusTo part held before the click (or inside it), or elsewhere (FocusFacts).
     */
    returnFocus(wanted: { readonly index: number }): ReturnFacts {
      const trigger = state.elements[wanted.index];
      const facts = focusFacts(trigger, state.popup);
      const connected = !!trigger && trigger.isConnected ? "connected" : "gone";
      const target = state.returnTarget;
      const at = effectiveFocus();
      if (at && target && target.isConnected && (at === target || ancestors(at).includes(target))) return { trigger: connected, part: state.returnPart, at: "part", role: at.getAttribute("role") ?? at.localName, name: accessibleName(at) };
      return { trigger: connected, part: state.returnPart, at: facts.at, role: facts.role, name: facts.name };
    },
    /**
     * The identified dialog's focus-trap facts (TrapFacts). `first`: this look's tabbable list is
     * the one later looks are held to (any change since is `stale`).
     */
    trap(wanted: { readonly first: boolean }): TrapFacts {
      const popup = state.popup;
      const none: TrapFacts = { open: false, modal: null, nested: null, frame: false, unmodelled: null, tabbables: [], at: { kind: "outside", role: "none", name: "" }, stale: false };
      if (!popup) return none;
      const open = popup.isConnected && shown(popup);
      const modal = popup.localName === "dialog" ? (popup.matches(":modal") ? "native" : null) : (popup.getAttribute("role") === "dialog" || popup.getAttribute("role") === "alertdialog") && popup.getAttribute("aria-modal") === "true" ? "aria" : null;
      const nestedEl = [...popup.querySelectorAll(POPUP)].find((element) => element.getAttribute("role") !== "tooltip" && shown(element));
      const { list, frame, unmodelled } = tabbablesIn(popup);
      if (wanted.first) state.tabbables = list;
      const stale = list.length !== state.tabbables.length || list.some((element, i) => element !== state.tabbables[i]);
      const of = (element: Element | null): { role: string; name: string } => ({ role: element ? (element.getAttribute("role") ?? element.localName) : "none", name: element ? accessibleName(element) : "" });
      let at: TrapAt;
      const active = deepActive();
      const focused = effectiveFocus() ?? active;
      if (!document.hasFocus()) at = { kind: "away", ...of(null) };
      else if (!active || active === document.body || active === document.documentElement) at = { kind: "body", ...of(active) };
      else if (focused && state.tabbables.includes(focused)) at = { kind: "tabbable", i: state.tabbables.indexOf(focused) };
      else if (focused === popup) at = { kind: "popup", ...of(focused) };
      else if (focused && ancestors(focused).includes(popup)) at = { kind: "inside", ...of(focused) };
      else at = { kind: "outside", ...of(focused) };
      return { open, modal, nested: nestedEl ? (nestedEl.getAttribute("role") ?? nestedEl.localName) : null, frame, unmodelled, tabbables: state.tabbables.map((element) => of(element)), at, stale };
    },
    /**
     * Focus on one of the dialog's tabbable elements before Tab is pressed: where the app put it is
     * kept; else focus() on the first; with none, on the dialog itself (it must keep focus).
     */
    trapPlace(): FocusPlaced {
      const popup = state.popup;
      if (!popup || !popup.isConnected) return { ok: false };
      const placed = (): boolean => {
        const at = effectiveFocus();
        return state.tabbables.length > 0 ? !!at && state.tabbables.includes(at) : !!at && (at === popup || ancestors(at).includes(popup));
      };
      if (placed()) return { ok: true, moved: false };
      ((state.tabbables[0] ?? popup) as HTMLElement).focus?.({ preventScroll: true });
      return placed() ? { ok: true, moved: true } : { ok: false };
    },
    /**
     * The identified menu's or listbox's arrow-key facts (ItemFacts). `first`: this look's items are
     * the ones later looks are held to (any change since is `stale`).
     */
    items(wanted: { readonly index: number; readonly pattern: Pattern; readonly first: boolean }): ItemFacts {
      const trigger = state.elements[wanted.index];
      const popup = state.popup;
      const none: ItemFacts = { open: false, orientation: "vertical", items: [], at: { kind: "outside", role: "none", name: "" }, stale: false };
      if (!popup || !trigger) return none;
      const open = popup.isConnected && shown(popup);
      const menu = wanted.pattern === "menu-button";
      const roles = menu ? ["menuitem", "menuitemradio", "menuitemcheckbox"] : ["option"];
      const owners = menu ? ["menu", "menubar"] : ["listbox"];
      // Top-level only: an item whose nearest menu (or listbox) is this popup, not a submenu inside it.
      const list = [...popup.querySelectorAll("[role]")].filter((element) => roles.includes(element.getAttribute("role") ?? "") && shown(element) && ancestors(element).find((a) => owners.includes(a.getAttribute("role") ?? "")) === popup);
      if (wanted.first) state.items = list;
      const stale = list.length !== state.items.length || list.some((element, i) => element !== state.items[i]);
      const of = (element: Element | null): { role: string; name: string } => ({ role: element ? (element.getAttribute("role") ?? element.localName) : "none", name: element ? accessibleName(element) : "" });
      const where = (element: Element): ItemAt => {
        if (state.items.includes(element)) return { kind: "item", i: state.items.indexOf(element) };
        if (element === popup) return { kind: "popup", ...of(element) };
        if (ancestors(element).includes(popup)) return { kind: "inside", ...of(element) };
        return { kind: "outside", ...of(element) };
      };
      let at: ItemAt;
      const active = deepActive();
      const id = active?.getAttribute("aria-activedescendant") ?? "";
      if (!document.hasFocus()) at = { kind: "away", ...of(null) };
      else if (!active || active === document.body || active === document.documentElement) at = { kind: "body", ...of(active) };
      else if (ACTIVE_DESCENDANT_ROLES.includes(active.getAttribute("role") ?? "") && id.trim()) {
        const named = byId(active, id.trim());
        const controls = active.getAttribute("aria-controls");
        const owned = controls ? byId(active, controls.split(/\s+/)[0]!) : null;
        const belongs = !!named && (named === active || ancestors(named).includes(active) || (!!owned && (named === owned || ancestors(named).includes(owned))));
        at = !named ? { kind: "dangling", why: "missing" } : !belongs ? { kind: "dangling", why: "outside" } : where(named);
      } else if (active === trigger && !menu) at = { kind: "combobox" };
      else at = where(active);
      return { open, orientation: popup.getAttribute("aria-orientation") === "horizontal" ? "horizontal" : "vertical", items: state.items.map((element) => ({ enabled: enabled(element), name: accessibleName(element) })), at, stale };
    },
    /** A menu's effective focus on one of its items before arrow keys: kept where the app put it, else focus() on the first enabled item. */
    itemPlace(): FocusPlaced {
      const at = effectiveFocus();
      if (at && state.items.includes(at)) return { ok: true, moved: false };
      const first = state.items.find((element) => enabled(element));
      (first as HTMLElement | undefined)?.focus?.({ preventScroll: true });
      const now = effectiveFocus();
      return now && state.items.includes(now) ? { ok: true, moved: true } : { ok: false };
    },
    /** Where effective focus is now, against the trigger and the popup identified last; nothing is moved. */
    focus(wanted: { readonly index: number }): FocusFacts {
      return focusFacts(state.elements[wanted.index], state.popup);
    },
    /**
     * Immediately before a key: the very popup identified (the same element, never one found again)
     * is still connected and showing, and effective focus is still inside it (or on the combobox).
     */
    ready(wanted: { readonly index: number; readonly pattern: Pattern; readonly away?: boolean }): boolean {
      const trigger = state.elements[wanted.index];
      const popup = state.popup;
      // away: the key goes while focus is in the browser's own toolbar (a native modal's Tab wraps through it).
      const ok = !!trigger && !!popup && popup.isConnected && shown(popup) && (focusPlaced(trigger, popup, wanted.pattern) || (wanted.away === true && !document.hasFocus()));
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
