/**
 * What a behaviour probe runs inside the page (Playwright serialises each function, so each is
 * self-contained and may use nothing from this module): the popups' triggers the DOM and the
 * component contracts claim, the popups showing before a click, and the one that opened after it.
 * The functions read the page and change nothing in it; only PROBE_INIT_SCRIPT, which runs before
 * the app, takes away what a probed page must not use.
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
  /** The nearest named React component holding the trigger, or null for plain markup. */
  readonly component: string | null;
  readonly accessibleName: string;
  /** How it was found: a contract binding (its index in the bindings given) or the DOM's own claims. */
  readonly via: { readonly contract: number } | "dom";
  /** The JSX call's frames, nearest first (the trigger's own, else its component's). */
  readonly frames: readonly Frame[];
  readonly domPath: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** The triggers, page-side, beside what was found: `elements[i]` is `found[i]`'s trigger. */
export interface TargetsInPage {
  readonly elements: Element[];
  /** For a contract target, the component's fiber, so its popup part is looked for in that instance only. */
  readonly scopes: unknown[];
  readonly found: FoundTarget[];
}

/**
 * Every visible, enabled trigger: first those contract bindings place (in the bound component's own
 * elements, portals included), then those the DOM claims by the pattern table
 * (docs/plans/behaviour-rules.md). `limit` caps how many are returned (the rest aren't looked at).
 */
export function findTargetsInPage(args: { readonly bindings: readonly ContractBinding[]; readonly limit: number; readonly maxFrames: number }): TargetsInPage {
  type Fiber = { tag: number; type: unknown; child: Fiber | null; sibling: Fiber | null; return: Fiber | null; stateNode: unknown; alternate: Fiber | null; _debugStack?: { stack?: string } | Error | null };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const nameOf = (type: unknown): string | null => {
    const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | null;
    return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || t?.type?.displayName || t?.type?.name || null;
  };
  const fiberOf = (element: Element): Fiber | null => {
    const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
    return key ? ((element as unknown as Record<string, Fiber>)[key] ?? null) : null;
  };
  const INTERNAL = /\/node_modules\/|\/\.vite\/deps\/|\/_next\/static\/chunks\/(?:framework|main|webpack)|react-dom|jsx-dev-runtime|jsx-runtime/;
  const framesOf = (fiber: Fiber | null): Frame[] => {
    const stack = fiber?._debugStack && "stack" in fiber._debugStack ? fiber._debugStack.stack : undefined;
    const frames: Frame[] = [];
    for (const text of (stack ?? "").split("\n").slice(1)) {
      if (/react[-_]stack[-_]bottom[-_]frame/.test(text)) break;
      const match = /((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(text);
      if (!match || INTERNAL.test(match[1]!)) continue;
      frames.push({ url: match[1]!, line: Number(match[2]), column: Number(match[3]) });
      if (frames.length >= args.maxFrames) break;
    }
    return frames;
  };
  const ownerOf = (element: Element): Fiber | null => {
    for (let node = fiberOf(element)?.return ?? null; node; node = node.return) if (COMPONENT.has(node.tag) && nameOf(node.type)) return node;
    return null;
  };
  const shown = (element: Element): boolean =>
    element.isConnected && (element as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false && !element.closest("[inert]") && !element.closest('[aria-hidden="true"]') && !element.closest("[hidden]");
  const enabled = (element: Element): boolean => !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true";
  const text = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const byId = (element: Element, id: string): Element | null => {
    const root = element.getRootNode() as Document | ShadowRoot;
    return (root.getElementById?.(id) as Element | null) ?? document.getElementById(id);
  };
  const accessibleName = (element: Element): string => {
    const labelledby = element.getAttribute("aria-labelledby");
    if (labelledby) {
      const named = text(labelledby.split(/\s+/).map((id) => byId(element, id)?.textContent ?? "").join(" "));
      if (named) return named.slice(0, 200);
    }
    const label = text(element.getAttribute("aria-label"));
    if (label) return label.slice(0, 200);
    if (/^(?:input|select|textarea)$/.test(element.localName)) {
      const labels = (element as HTMLInputElement).labels;
      const fromLabel = text(labels ? [...labels].map((l) => l.textContent).join(" ") : "");
      if (fromLabel) return fromLabel.slice(0, 200);
      return text(element.getAttribute("title") || element.getAttribute("placeholder")).slice(0, 200);
    }
    return text(element.textContent || element.getAttribute("title")).slice(0, 200);
  };
  const isButton = (element: Element): boolean => element.localName === "button" || element.getAttribute("role") === "button" || (element.localName === "input" && /^(?:button|submit|reset|image)$/i.test(element.getAttribute("type") ?? ""));
  const isModal = (element: Element | null): boolean =>
    !!element && (element.localName === "dialog" || element.getAttribute("role") === "alertdialog" || (element.getAttribute("role") === "dialog" && element.getAttribute("aria-modal") === "true"));
  /** The pattern the DOM claims for an element, or null when it claims none. */
  const claimed = (element: Element): BehaviourPattern | null => {
    if (element.getAttribute("role") === "combobox") return "combobox-listbox";
    const popup = element.getAttribute("aria-haspopup");
    const controls = element.getAttribute("aria-controls");
    const controlled = controls ? byId(element, controls.split(/\s+/)[0]!) : null;
    if (isButton(element)) {
      if (popup === "menu" || popup === "true") return "menu-button";
      if (popup === "dialog" || (element.getAttribute("command") === "show-modal" && element.hasAttribute("commandfor")) || isModal(controlled)) return "modal-dialog";
    }
    if (element.hasAttribute("popovertarget")) return "popover";
    if (element.hasAttribute("aria-expanded") && controls) return "popover";
    return null;
  };
  const matchesPart = (element: Element, part: PartRef): boolean =>
    "part" in part ? element.getAttribute("data-part") === part.part || element.getAttribute("data-slot") === part.part : element.getAttribute("role") === part.role || (part.role === "button" && element.localName === "button") || (part.role === "dialog" && element.localName === "dialog");
  const domPath = (element: Element): string => {
    const steps: string[] = [];
    for (let node: Element | null = element; node && node !== document.documentElement && steps.length < 6; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.localName === node!.localName) : [];
      steps.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
    }
    return steps.join(" > ");
  };
  const elements: Element[] = [];
  const scopes: unknown[] = [];
  const found: FoundTarget[] = [];
  const add = (element: Element, pattern: BehaviourPattern, via: FoundTarget["via"], scope: Fiber | null): void => {
    if (elements.includes(element) || found.length >= args.limit) return;
    // A contract target belongs to the bound component; anything else to the nearest named one.
    const owner = scope ?? ownerOf(element);
    const own = framesOf(fiberOf(element));
    const rect = element.getBoundingClientRect();
    elements.push(element);
    scopes.push(scope);
    found.push({ pattern, component: owner ? nameOf(owner.type) : null, accessibleName: accessibleName(element), via, frames: own.length ? own : framesOf(owner), domPath: domPath(element), box: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) } });
  };
  const all: Element[] = [];
  const collect = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll("*")) {
      all.push(element);
      if (element.shadowRoot) collect(element.shadowRoot);
    }
  };
  collect(document);
  // Contract bindings: the trigger part (or, without one, what the DOM claims) inside each bound
  // component, in its own elements (portals included), never a component it merely contains.
  const bound = new Map(args.bindings.map((b, i) => [b.component, i]));
  const boundOwner = (element: Element): { fiber: Fiber; index: number } | null => {
    for (let node = fiberOf(element); node; node = node.return) {
      const index = COMPONENT.has(node.tag) ? bound.get(nameOf(node.type) ?? "") : undefined;
      if (index !== undefined) return { fiber: node, index };
    }
    return null;
  };
  if (bound.size)
    for (const element of all) {
      const owner = boundOwner(element);
      if (!owner) continue;
      const { binding } = args.bindings[owner.index]!;
      const isTrigger = binding.trigger ? matchesPart(element, binding.trigger) : claimed(element) !== null;
      if (isTrigger && shown(element) && enabled(element)) add(element, binding.pattern, { contract: owner.index }, owner.fiber);
    }
  for (const element of all) {
    if (elements.includes(element) || !shown(element) || !enabled(element)) continue;
    const pattern = claimed(element);
    if (pattern) add(element, pattern, "dom", null);
  }
  return { elements, scopes, found };
}

/** The popups of a pattern's role that show now: what was already open before a click. */
export function showingPopupsInPage(args: { readonly pattern: BehaviourPattern }): Element[] {
  const ROLE: Record<BehaviourPattern, string> = { "menu-button": '[role="menu"]', "combobox-listbox": '[role="listbox"]', "modal-dialog": 'dialog,[role="dialog"],[role="alertdialog"]', popover: "[popover]" };
  const shown = (element: Element): boolean =>
    element.isConnected && (element as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false && !element.closest("[inert]") && !element.closest('[aria-hidden="true"]') && !element.closest("[hidden]") &&
    (element.localName !== "dialog" || (element as HTMLDialogElement).open) && (!element.hasAttribute("popover") || element.matches(":popover-open"));
  const all: Element[] = [];
  const collect = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll("*")) {
      all.push(element);
      if (element.shadowRoot) collect(element.shadowRoot);
    }
  };
  collect(document);
  return all.filter((element) => element.matches(ROLE[args.pattern]) && shown(element));
}

export type PopupFound =
  | { readonly state: "open"; readonly how: "aria-controls" | "popovertarget" | "contract" | "role"; readonly role: string; readonly domPath: string }
  | { readonly state: "none" }
  | { readonly state: "several"; readonly count: number }
  | { readonly state: "was-open"; readonly how: "aria-controls" | "popovertarget" | "contract" };

/**
 * The popup a click on `targets.elements[index]` opened, positively identified: the element its
 * relationship names (aria-controls, popovertarget) or the contract's popup part in the same
 * component; without either, the single element of the pattern's role that shows now and didn't
 * before. Never by position.
 */
export function identifyPopupInPage(args: { readonly targets: TargetsInPage; readonly index: number; readonly before: Element[]; readonly pattern: BehaviourPattern; readonly popup: PartRef | null }): PopupFound {
  type Fiber = { tag: number; return: Fiber | null; alternate: Fiber | null };
  const ROLE: Record<BehaviourPattern, string> = { "menu-button": '[role="menu"]', "combobox-listbox": '[role="listbox"]', "modal-dialog": 'dialog,[role="dialog"],[role="alertdialog"]', popover: "[popover]" };
  const trigger = args.targets.elements[args.index]!;
  const scope = args.targets.scopes[args.index] as Fiber | null;
  const shown = (element: Element): boolean =>
    element.isConnected && (element as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false && !element.closest("[inert]") && !element.closest('[aria-hidden="true"]') && !element.closest("[hidden]") &&
    (element.localName !== "dialog" || (element as HTMLDialogElement).open) && (!element.hasAttribute("popover") || element.matches(":popover-open"));
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
  const all: Element[] = [];
  const collect = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll("*")) {
      all.push(element);
      if (element.shadowRoot) collect(element.shadowRoot);
    }
  };
  const byId = (id: string): Element | null => ((trigger.getRootNode() as Document | ShadowRoot).getElementById?.(id) as Element | null) ?? document.getElementById(id);
  const settle = (candidates: Element[], how: "aria-controls" | "popovertarget" | "contract"): PopupFound => {
    const open = candidates.filter(shown);
    if (open.length === 0) return { state: "none" };
    if (open.length > 1) return { state: "several", count: open.length };
    if (args.before.includes(open[0]!)) return { state: "was-open", how };
    return { state: "open", how, role: roleOf(open[0]!), domPath: domPath(open[0]!) };
  };
  if (args.popup && scope) {
    const part = args.popup;
    const fiberOf = (element: Element): Fiber | null => {
      const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
      return key ? ((element as unknown as Record<string, Fiber>)[key] ?? null) : null;
    };
    const inScope = (element: Element): boolean => {
      for (let node = fiberOf(element); node; node = node.return) if (node === scope || node === scope.alternate) return true;
      return false;
    };
    collect(document);
    const matches = all.filter((element) => ("part" in part ? element.getAttribute("data-part") === part.part || element.getAttribute("data-slot") === part.part : element.getAttribute("role") === part.role || (part.role === "dialog" && element.localName === "dialog")));
    return settle(matches.filter(inScope), "contract");
  }
  const controls = trigger.getAttribute("aria-controls");
  if (controls) return settle(controls.split(/\s+/).filter(Boolean).map(byId).filter((e): e is Element => e !== null), "aria-controls");
  const target = trigger.getAttribute("popovertarget");
  if (target) {
    const element = (trigger as HTMLButtonElement & { popoverTargetElement?: Element | null }).popoverTargetElement ?? byId(target);
    return settle(element ? [element] : [], "popovertarget");
  }
  collect(document);
  const fresh = all.filter((element) => element.matches(ROLE[args.pattern]) && shown(element) && !args.before.includes(element));
  if (fresh.length === 0) return { state: "none" };
  if (fresh.length > 1) return { state: "several", count: fresh.length };
  return { state: "open", how: "role", role: roleOf(fresh[0]!), domPath: domPath(fresh[0]!) };
}

/** A sign-in form shows: a visible password field. */
export function signInFormInPage(): boolean {
  return [...document.querySelectorAll('input[type="password"]')].some((input) => (input as HTMLElement).checkVisibility?.({ visibilityProperty: true }) !== false);
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
