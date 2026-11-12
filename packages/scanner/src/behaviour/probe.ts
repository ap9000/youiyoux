/**
 * The guarded behaviour probe for one route, in a real headless Chromium (docs/plans/behaviour-rules.md,
 * "Where a probe runs" and "Probe safety"). One throwaway browser context with no cookies or storage;
 * before anything loads, its guards are in place:
 *
 * - a network fence (fence.ts) every request goes through, loopback included: reads to the one
 *   consented origin pass, writes, other origins, every WebSocket and every tunnel are refused;
 * - context routing: requests from pages the probe didn't open, to other origins, or with a method
 *   that writes are aborted, and so is every main-frame navigation but the scenario's own load;
 * - service workers blocked; `window.open` and peer connections removed by an init script; pages
 *   the app opens are closed; browser dialogs dismissed.
 *
 * Each (target, check) is its own scenario in a new page: load, find the target again by identity,
 * click its trigger only, identify the popup (scenario.ts). Bounded: targets per route, time per
 * scenario and per route; anything over budget is `incomplete` and named.
 */
import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, CDPSession, Page, Request, Route } from "playwright-core";
import { BEHAVIOUR_CHECKS, type BehaviourCheckId, type BehaviourPattern, type PartRef } from "@youiyoux/core";
import { startFence, type Fence, type FenceRefusal } from "./fence.ts";
import { dataWords, describeUrl, requestVerdict, screenUrl, STATIC_RESOURCE_TYPES } from "./guards.ts";
import { ambiguousWords, withOrdinals, type TargetKey } from "./identity.ts";
import type { Frame } from "../screens/locate.ts";
import { contractPopupsInPage, isolatedLibrary, labelsInPage, nominateContractTriggersInPage, PROBE_INIT_SCRIPT, type ClickPoint, type ContractBinding, type FoundTarget, type IsolatedTarget, type PopupFound } from "./in-page.ts";
import { dataBlockedIn, infoFromEvents, openAndIdentify, openScreen, SWITCHED_OFF, type GuardEvent, type ProbePage, type ScenarioOutcome, type Stop } from "./scenario.ts";

export interface ProbeBudgets {
  /** Targets tested per route; the rest are named as untested. */
  readonly targets: number;
  /** One scenario, from the end of its load to the popup identified. */
  readonly scenarioMs: number;
  /** The whole route, discovery included. */
  readonly routeMs: number;
  /** Waiting for the popup after the click. */
  readonly openMs: number;
  /** A screen's load. */
  readonly loadMs: number;
  /** After load, waiting for the network to go quiet. */
  readonly settleMs: number;
}

export const PROBE_BUDGETS: ProbeBudgets = { targets: 20, scenarioMs: 5_000, routeMs: 90_000, openMs: 2_000, loadMs: 15_000, settleMs: 2_000 };
/** Triggers looked for per route: past the budget, only to name them as untested. */
const MAX_FOUND = 200;
const POLL_MS = 50;
/** After the popup is identified, watched this long for anything else the click set off. */
const GRACE_MS = 250;

export interface ProbeRouteOptions {
  readonly browser: Browser;
  /** The consented origin (behaviourConsent): every request is held to it. */
  readonly origin: string;
  readonly route: string;
  /** The screen's path as screens.json lists it. */
  readonly path: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /** One scenario per target and check, where the check applies to the target's pattern. */
  readonly checks: readonly BehaviourCheckId[];
  readonly bindings?: readonly ContractBinding[];
  readonly budgets?: Partial<ProbeBudgets>;
  /** Asked before every scenario and immediately before every click: null while probing is still allowed, else why it isn't. */
  readonly stillAllowed?: () => Promise<Stop | null>;
  /** Aborted when probing is switched off: the scenario running now is closed, and the rest are not run. */
  readonly signal?: AbortSignal;
}

export type TargetScenario = { readonly check: BehaviourCheckId } & (ScenarioOutcome | { readonly state: "not-applicable"; readonly why: string; readonly fix: string; readonly info: readonly string[] });

export interface ProbedTarget {
  readonly key: TargetKey & { readonly ordinal?: number };
  readonly found: FoundTarget;
  readonly scenarios: readonly TargetScenario[];
}

export interface RouteProbe {
  /** The screen's address, as opened. */
  readonly url: string;
  /** incomplete: the route couldn't be probed at all (`why`, `fix`); its targets are unknown. */
  readonly state: "probed" | "incomplete";
  readonly why: string | null;
  readonly fix: string | null;
  readonly coverage: string;
  readonly targets: readonly ProbedTarget[];
}

class TimeUp extends Error {}

/** `promise`, or TimeUp at `deadline`: a page whose main thread hangs can't hold the probe. */
function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const left = deadline - Date.now();
  // Whatever the page call does after the deadline is no longer anyone's business.
  promise.catch(() => undefined);
  if (left <= 0) return Promise.reject(new TimeUp());
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimeUp()), left)))]).finally(() => clearTimeout(timer));
}

interface PageLog {
  readonly start: string;
  readonly events: GuardEvent[];
  phase: "load" | "act";
  /** The scenario's own load has gone out: every later main-frame navigation is refused. */
  committed: boolean;
}

/** The guarded context: its pages, what its guards saw, and how to open a page of the probe's own. */
class GuardedContext {
  private readonly logs = new Map<Page, PageLog>();
  private creating = 0;
  /** The page being probed now: where refusals with no page of their own (workers, the fence) are told. */
  private current: PageLog | null = null;
  /**
   * A trigger has been clicked and no new page has opened since: requests with no page of the
   * probe's own (a worker's, one still in flight from a page closing) get after-click rules.
   */
  private afterClick = false;

  private readonly context: BrowserContext;
  private readonly origin: string;
  private readonly fence: Fence;

  constructor(context: BrowserContext, origin: string, fence: Fence) {
    this.context = context;
    this.origin = origin;
    this.fence = fence;
  }

  static async open(browser: Browser, origin: string, viewport: ProbeRouteOptions["viewport"]): Promise<{ guarded: GuardedContext; close: () => Promise<void> }> {
    let guarded: GuardedContext | null = null;
    const fence = await startFence(origin, (refusal: FenceRefusal) => guarded?.record(null, { kind: refusal.kind, words: refusal.words }));
    let context: BrowserContext | null = null;
    try {
      // No storage state, no permissions, no downloads; every request through the fence, loopback included.
      context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false, permissions: [], proxy: { server: fence.server, username: fence.username, password: fence.password, bypass: "<-loopback>" } });
      guarded = new GuardedContext(context, origin, fence);
      await guarded.install();
    } catch (error: unknown) {
      await context?.close().catch(() => undefined);
      await fence.close();
      throw error;
    }
    return { guarded, close: async () => {
      await context!.close().catch(() => undefined);
      await fence.close();
    } };
  }

  private async install(): Promise<void> {
    await this.context.addInitScript(PROBE_INIT_SCRIPT);
    // A page the probe didn't open (window.open survivors, target=_blank) is closed at once.
    this.context.on("page", (page) => {
      if (this.creating > 0) return;
      this.record(null, { kind: "window", words: "the page tried to open a new window; none was opened" });
      void page.close().catch(() => undefined);
    });
    await this.context.route(() => true, (route, request) => this.guard(route, request));
  }

  private record(log: PageLog | null, event: Omit<GuardEvent, "phase">): void {
    const to = log ?? this.current;
    to?.events.push({ ...event, phase: to.phase });
  }

  private async guard(route: Route, request: Request): Promise<void> {
    let page: Page | null = null;
    let main = false;
    let framed = true;
    try {
      const frame = request.frame();
      page = frame.page();
      main = frame.parentFrame() === null;
    } catch {
      // A worker's request has no frame: it is held to the same origin and methods below. So does
      // a new window's first navigation, before its page exists: that is refused below.
      framed = false;
    }
    const log = page ? (this.logs.get(page) ?? null) : null;
    const refuse = async (event: Omit<GuardEvent, "phase">): Promise<void> => {
      this.record(log, event);
      await route.abort("blockedbyclient").catch(() => undefined);
    };
    if (request.serviceWorker()) return refuse({ kind: "service-worker", words: "a service worker tried to make a request; it was refused" });
    if ((page && !log) || (!framed && request.isNavigationRequest())) return refuse({ kind: "window", words: "the page tried to open a new window; none was opened" });
    const verdict = requestVerdict(request.url(), request.method(), this.origin);
    if (!verdict.allow) return refuse({ kind: verdict.kind, words: verdict.words });
    if (log && main && request.isNavigationRequest()) {
      if (log.committed || request.url() !== log.start) return refuse({ kind: "navigation", words: `the page tried to leave for ${describeUrl(request.url(), this.origin)}; it was stopped before it left` });
      log.committed = true;
    }
    // From the click on, the page (and its workers) may load only its own static files; every data
    // request is refused, and the scenario goes on, tested with its data blocked.
    if ((log ?? this.current)?.phase === "act" || (!log && this.afterClick)) {
      const method = request.method().toUpperCase();
      if (!STATIC_RESOURCE_TYPES.has(request.resourceType()) || !(method === "GET" || method === "HEAD")) return refuse({ kind: "data", words: dataWords(method, request.url(), this.origin) });
    }
    await route.continue().catch(() => undefined);
  }

  /** A new page of the probe's own, for one scenario, opened on `start` by `load()`. */
  async page(start: string, options: PageOptions): Promise<PlaywrightProbePage> {
    this.creating++;
    let page: Page;
    try {
      page = await this.context.newPage();
    } finally {
      this.creating--;
    }
    const log: PageLog = { start, events: [], phase: "load", committed: false };
    this.logs.set(page, log);
    this.current = log;
    // The page before this one has closed (its workers with it): only now does after-click end.
    this.afterClick = false;
    this.fence.setAfterClick(false);
    page.on("dialog", (dialog) => {
      this.record(log, { kind: "dialog", words: `the page showed a browser dialog (${dialog.type()}); it was dismissed` });
      void dialog.dismiss().catch(() => undefined);
    });
    const acting = (): void => {
      this.afterClick = true;
      this.fence.setAfterClick(true);
    };
    // Forgotten only once the page (and its workers) have closed; after-click stays on until the next page.
    return new PlaywrightProbePage(page, log, { ...options, acting }, () => {
      this.logs.delete(page);
      if (this.current === log) this.current = null;
    });
  }
}

interface PageOptions {
  readonly bindings: readonly ContractBinding[];
  readonly budgets: ProbeBudgets;
  /** Every call on the page ends by then. */
  readonly deadline: () => number;
  /** Told once the screen has loaded (a scenario's own budget starts then). */
  readonly loaded?: () => void;
  /** Told when the trigger is about to be clicked (the fence turns to static files only). */
  readonly acting?: () => void;
}

type CallResult = { result: { value?: unknown; objectId?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

/**
 * The page's two worlds over CDP: the probe's own isolated world (isolatedLibrary, which decides
 * everything about clicking) and the page's main world (React's labels and contract nominations).
 * Elements cross between them by their backend node id, never by anything the page can forge.
 */
class Worlds {
  private readonly cdp: CDPSession;
  private readonly isolated: number;

  private constructor(cdp: CDPSession, isolated: number) {
    this.cdp = cdp;
    this.isolated = isolated;
  }

  static async open(page: Page): Promise<Worlds> {
    const cdp = await page.context().newCDPSession(page);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: `youiyoux-probe-${randomBytes(6).toString("hex")}`, grantUniveralAccess: false });
    const worlds = new Worlds(cdp, executionContextId);
    worlds.check((await cdp.send("Runtime.callFunctionOn", { functionDeclaration: isolatedLibrary.toString(), executionContextId })) as CallResult);
    return worlds;
  }

  private check(answer: CallResult): CallResult {
    if (answer.exceptionDetails) throw new Error(`the probe's own script failed: ${(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "").split("\n")[0]}`);
    return answer;
  }

  /** `__youiyoux[method](arg, elements)` in the isolated world; `elements` are isolated-world object ids. */
  async call<T>(method: "discover" | "markShowing" | "prepareClick" | "clicked" | "identify" | "signInForm", arg: unknown, elements: readonly string[] = []): Promise<T> {
    const answer = this.check((await this.cdp.send("Runtime.callFunctionOn", { functionDeclaration: `function (arg, ...elements) { return globalThis.__youiyoux.${method}(arg, elements); }`, executionContextId: this.isolated, arguments: [{ value: arg }, ...elements.map((objectId) => ({ objectId }))], returnByValue: true })) as CallResult);
    return answer.result.value as T;
  }

  /** The isolated world's element `index` of the last discovery, as an object id there. */
  async element(index: number): Promise<string | null> {
    const answer = this.check((await this.cdp.send("Runtime.callFunctionOn", { functionDeclaration: "function (i) { return globalThis.__youiyoux.element(i); }", executionContextId: this.isolated, arguments: [{ value: index }], returnByValue: false })) as CallResult);
    return answer.result.objectId ?? null;
  }

  /** The same DOM nodes, as object ids in the other world (main, or the probe's isolated one). */
  async into(world: "main" | "isolated", objectIds: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const objectId of objectIds) {
      const { node } = await this.cdp.send("DOM.describeNode", { objectId });
      const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId, ...(world === "isolated" ? { executionContextId: this.isolated } : {}) });
      if (object.objectId) out.push(object.objectId);
    }
    return out;
  }

  /** The main world's document, by way of the isolated world's (the page can't stand in for it). */
  async mainDocument(): Promise<string> {
    const answer = this.check((await this.cdp.send("Runtime.callFunctionOn", { functionDeclaration: "function () { return document; }", executionContextId: this.isolated, returnByValue: false })) as CallResult);
    const [document] = await this.into("main", [answer.result.objectId!]);
    return document!;
  }

  /** `fn.call(this = objectId, arg)` in the main world: by value, or as object ids of the array it returns. */
  async main<T>(objectId: string, fn: (...args: never[]) => unknown, arg: unknown): Promise<T> {
    return this.check((await this.cdp.send("Runtime.callFunctionOn", { functionDeclaration: fn.toString(), objectId, arguments: [{ value: arg }], returnByValue: true })) as CallResult).result.value as T;
  }

  async mainList(objectId: string, fn: (...args: never[]) => unknown, arg: unknown): Promise<string[]> {
    const answer = this.check((await this.cdp.send("Runtime.callFunctionOn", { functionDeclaration: fn.toString(), objectId, arguments: [{ value: arg }], returnByValue: false })) as CallResult);
    return answer.result.objectId ? this.items(answer.result.objectId) : [];
  }

  /** An array's items (by index), as object ids; numbers come back as their value in `values`. */
  async items(objectId: string): Promise<string[]> {
    const { result } = await this.cdp.send("Runtime.getProperties", { objectId, ownProperties: true });
    return result.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name)).map((p) => p.value?.objectId ?? "");
  }

  async values(objectId: string): Promise<unknown[]> {
    const { result } = await this.cdp.send("Runtime.getProperties", { objectId, ownProperties: true });
    return result.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name)).map((p) => p.value?.value);
  }

  async detach(): Promise<void> {
    await this.cdp.detach().catch(() => undefined);
  }
}

/** ProbePage on a Playwright page, every call bounded by the scenario's deadline. */
class PlaywrightProbePage implements ProbePage {
  private worldsOpened: Worlds | null = null;
  private found: readonly FoundTarget[] = [];

  private readonly page: Page;
  private readonly log: PageLog;
  private readonly options: PageOptions;
  private readonly forget: () => void;

  constructor(page: Page, log: PageLog, options: PageOptions, forget: () => void) {
    this.page = page;
    this.log = log;
    this.options = options;
    this.forget = forget;
  }

  private bound<T>(promise: Promise<T>): Promise<T> {
    return within(promise, this.options.deadline());
  }

  private async worlds(): Promise<Worlds> {
    this.worldsOpened ??= await this.bound(Worlds.open(this.page));
    return this.worldsOpened;
  }

  async load(): Promise<{ status: number | null }> {
    const { loadMs, settleMs } = this.options.budgets;
    const timeout = Math.max(1, Math.min(loadMs, this.options.deadline() - Date.now()));
    const response = await this.bound(this.page.goto(this.log.start, { waitUntil: "load", timeout })).catch((error: unknown) => {
      if (error instanceof TimeUp) throw error;
      return null;
    });
    await this.bound(this.page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(settleMs, this.options.deadline() - Date.now())) })).catch((error: unknown) => {
      if (error instanceof TimeUp) throw error;
    });
    this.options.loaded?.();
    return { status: response?.status() ?? null };
  }

  async location(): Promise<string> {
    // location.href can't be redefined by the page (it is unforgeable).
    return this.bound(this.page.evaluate(() => location.href)).catch((error: unknown) => {
      if (error instanceof TimeUp) throw error;
      return this.page.url();
    });
  }

  async signInForm(): Promise<boolean> {
    return this.bound((await this.worlds()).call<boolean>("signInForm", null));
  }

  async findTargets(): Promise<readonly FoundTarget[]> {
    const worlds = await this.worlds();
    const { bindings } = this.options;
    // Contract nominations come from the main world (React's fibers live there); each is checked in the isolated world.
    const nominated: Array<{ objectId: string; binding: number }> = [];
    if (bindings.length) {
      const pairs = await this.bound(worlds.mainList(await this.bound(worlds.mainDocument()), nominateContractTriggersInPage, bindings.map((b) => ({ component: b.component, trigger: b.binding.trigger ?? null }))));
      for (const pair of pairs) {
        const [element] = await this.bound(worlds.items(pair));
        const [, binding] = await this.bound(worlds.values(pair));
        if (element && typeof binding === "number" && bindings[binding]) nominated.push({ objectId: element, binding });
      }
    }
    const isolated = await this.bound(worlds.into("isolated", nominated.map((n) => n.objectId)));
    const { found } = await this.bound(worlds.call<{ found: IsolatedTarget[] }>("discover", { limit: MAX_FOUND, nominated: nominated.map((n) => ({ binding: n.binding, pattern: bindings[n.binding]!.binding.pattern })) }, isolated));
    const labelled: FoundTarget[] = [];
    for (const [index, target] of found.entries()) {
      const contract = typeof target.via === "object" ? (bindings[target.via.contract]?.component ?? null) : null;
      let labels: { component: string | null; frames: Frame[] } = { component: contract, frames: [] };
      try {
        const element = await this.bound(worlds.element(index));
        const [main] = element ? await this.bound(worlds.into("main", [element])) : [];
        if (main) labels = await this.bound(worlds.main(main, labelsInPage, { component: contract, maxFrames: 6 }));
      } catch (error: unknown) {
        if (error instanceof TimeUp) throw error;
      }
      labelled.push({ ...target, component: typeof labels.component === "string" ? labels.component : contract, frames: Array.isArray(labels.frames) ? labels.frames : [] });
    }
    this.found = labelled;
    return labelled;
  }

  async markShowing(pattern: BehaviourPattern): Promise<void> {
    await this.bound((await this.worlds()).call("markShowing", pattern));
  }

  acting(): void {
    this.log.phase = "act";
    this.options.acting?.();
  }

  async click(index: number, timeoutMs: number): Promise<void> {
    const target = this.found[index];
    if (!target) throw new Error("no such button was found on this page");
    const worlds = await this.worlds();
    // The exact element, checked again in the probe's own world, and the point that hits it.
    const point = await this.bound(worlds.call<ClickPoint>("prepareClick", { index, pattern: target.pattern, accessibleName: target.accessibleName, dom: target.via === "dom" }));
    if (!point.ok) throw new Error(point.why);
    await within(this.page.mouse.click(point.x, point.y), Math.min(this.options.deadline(), Date.now() + Math.max(1, timeoutMs)));
    const landed = await this.bound(worlds.call<"on" | "elsewhere" | "unseen">("clicked", index));
    if (landed === "elsewhere") throw new Error("the click landed on something other than the button; nothing more was done");
    if (landed === "unseen") throw new Error("the page kept the click from being seen, so it can't be told what was clicked; nothing more was done");
  }

  async identify(index: number, pattern: BehaviourPattern, popup: PartRef | null): Promise<PopupFound> {
    const target = this.found[index];
    if (!target) return { state: "none" };
    const worlds = await this.worlds();
    const contract = typeof target.via === "object" ? (this.options.bindings[target.via.contract] ?? null) : null;
    if (contract && popup) {
      const element = await this.bound(worlds.element(index));
      const [main] = element ? await this.bound(worlds.into("main", [element])) : [];
      const nominated = main ? await this.bound(worlds.mainList(main, contractPopupsInPage, { component: contract.component, part: popup })) : [];
      const parts = await this.bound(worlds.into("isolated", nominated.filter(Boolean)));
      return this.bound(worlds.call<PopupFound>("identify", { index, pattern, contract: true }, parts));
    }
    return this.bound(worlds.call<PopupFound>("identify", { index, pattern, contract: false }));
  }

  events(): readonly GuardEvent[] {
    return this.log.events;
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The page closes first (its workers end with it), and only then is it forgotten: until then its requests are still its own. */
  async close(): Promise<void> {
    await this.page.close({ runBeforeUnload: false }).catch(() => undefined);
    await this.worldsOpened?.detach();
    this.forget();
  }
}

const untestedWords = (reason: "targets" | "time", budgets: ProbeBudgets): Stop =>
  reason === "targets"
    ? { why: `not tested: this screen has more than ${budgets.targets} popup triggers, and a probe tests the first ${budgets.targets}`, fix: "Next: probe fewer popups per screen (split the screen's routes in screens.json), or run the probe on this component alone once the hub's Behaviour tab can." }
    : { why: `not tested: the screen's time budget (${Math.round(budgets.routeMs / 1000)} s) ran out first`, fix: "Next: make sure the dev server is idle, then run the probe again." };

/**
 * Probe one route: find its popup triggers, then for each (target, check) a fresh scenario that
 * opens and identifies the popup. The caller has checked consent; `stillAllowed` is asked again
 * before every scenario. No result here is ever a pass.
 */
export async function probeRoute(options: ProbeRouteOptions): Promise<RouteProbe> {
  const budgets: ProbeBudgets = { ...PROBE_BUDGETS, ...options.budgets };
  const start = screenUrl(options.origin, options.path);
  const routeDeadline = Date.now() + budgets.routeMs;
  const bindings = options.bindings ?? [];
  const { guarded, close } = await GuardedContext.open(options.browser, options.origin, options.viewport);
  try {
    // Discovery: what the screen claims, from its own fresh load.
    let found: readonly FoundTarget[];
    const discovery = await guarded.page(start, { bindings, budgets, deadline: () => routeDeadline });
    try {
      const stop = await openScreen(discovery, start, options.origin);
      if (stop) return { url: start, state: "incomplete", why: stop.why, fix: stop.fix, coverage: "Nothing on this screen was probed.", targets: [] };
      found = await discovery.findTargets();
    } catch (error: unknown) {
      const stop = error instanceof TimeUp ? { why: "the screen took longer to load than the probe's time budget", fix: "Next: make sure the dev server is idle, then run the probe again." } : { why: `the probe couldn't open the screen: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`, fix: "Next: check the dev server is running, and run the probe again." };
      return { url: start, state: "incomplete", ...stop, coverage: "Nothing on this screen was probed.", targets: [] };
    } finally {
      await discovery.close();
    }
    const keyed = withOrdinals(found.map((f) => ({ route: options.route, pattern: f.pattern, component: f.component, accessibleName: f.accessibleName, found: f })));
    const targets: ProbedTarget[] = [];
    let refusedFrom: Stop | null = null;
    for (const [n, { found: f, ambiguous, ...key }] of keyed.entries()) {
      const scenarios: TargetScenario[] = [];
      for (const check of options.checks) {
        if (!BEHAVIOUR_CHECKS[check].patterns.includes(f.pattern)) {
          scenarios.push({ check, state: "not-applicable", why: `${check} doesn't apply to a ${f.pattern}`, fix: "Nothing to do: this check isn't part of this pattern.", info: [] });
          continue;
        }
        const skip = (stop: Stop): void => void scenarios.push({ check, state: "incomplete", ...stop, info: [] });
        if (n >= budgets.targets) skip(untestedWords("targets", budgets));
        else if (ambiguous) skip(ambiguousWords(key, keyed.filter((k) => k.ambiguous && k.pattern === key.pattern && k.component === key.component && k.accessibleName === key.accessibleName).length));
        else if (options.signal?.aborted) skip((refusedFrom = SWITCHED_OFF));
        else if (refusedFrom) skip(refusedFrom);
        else if (Date.now() >= routeDeadline) skip(untestedWords("time", budgets));
        else if ((refusedFrom = (await options.stillAllowed?.()) ?? null)) skip(refusedFrom);
        else scenarios.push({ check, ...(await scenario(guarded, start, options, key, f, bindings, budgets, routeDeadline)) });
      }
      targets.push({ key, found: f, scenarios });
    }
    const named = found.length >= MAX_FOUND ? `at least ${MAX_FOUND}` : String(found.length);
    const coverage = found.length === 0
      ? "No declared popups found; popups without these markers were not assessed."
      : `${named} popup trigger${found.length === 1 ? "" : "s"} found by ARIA markers${bindings.length ? " and contract bindings" : ""}${found.length > budgets.targets ? `; the first ${budgets.targets} were tested` : ""}. Popups without these markers were not assessed; opening is by mouse click only (keyboard opening isn't verified yet).`;
    return { url: start, state: "probed", why: null, fix: null, coverage, targets };
  } finally {
    await close();
  }
}

async function scenario(guarded: GuardedContext, start: string, options: ProbeRouteOptions, key: TargetKey, found: FoundTarget, bindings: readonly ContractBinding[], budgets: ProbeBudgets, routeDeadline: number): Promise<ScenarioOutcome> {
  // Loading has its own bound; the scenario's own budget starts once the screen is open.
  const clock = { deadline: Math.min(routeDeadline, Date.now() + budgets.loadMs + budgets.settleMs) };
  const deadline = (): number => clock.deadline;
  const page = await guarded.page(start, { bindings, budgets, deadline, loaded: () => void (clock.deadline = Math.min(routeDeadline, Date.now() + budgets.scenarioMs)) });
  const popup = typeof found.via === "object" ? (bindings[found.via.contract]?.binding.popup ?? null) : null;
  // Switched off while it runs: the page is closed at once, whatever it was doing.
  const cancel = (): void => void page.close();
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await openAndIdentify(page, { start, origin: options.origin, wanted: key, popup, deadline, budgets: { openMs: budgets.openMs, pollMs: POLL_MS, graceMs: GRACE_MS }, ...(options.stillAllowed ? { beforeClick: options.stillAllowed } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error: unknown) {
    const info = infoFromEvents(page.events());
    const dataBlocked = dataBlockedIn(page.events());
    if (options.signal?.aborted) return { state: "incomplete", ...SWITCHED_OFF, info, dataBlocked };
    if (error instanceof TimeUp) return { state: "incomplete", why: Date.now() >= routeDeadline ? untestedWords("time", budgets).why.replace("not tested: ", "stopped: ") : `ran out of time: a scenario has ${Math.round(budgets.scenarioMs / 1000)} s once the screen is open`, fix: "Next: make sure the dev server is idle, then run the probe again.", info, dataBlocked };
    return { state: "error", why: `the probe failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`, fix: "Next: run the probe again; if it fails again, report it with the screen's route.", info, dataBlocked };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await page.close();
  }
}
