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
import type { Browser, BrowserContext, JSHandle, Page, Request, Route } from "playwright-core";
import { BEHAVIOUR_CHECKS, type BehaviourCheckId, type BehaviourPattern, type PartRef } from "@youiyoux/core";
import { startFence, type FenceRefusal } from "./fence.ts";
import { describeUrl, requestVerdict, screenUrl } from "./guards.ts";
import { ambiguousWords, withOrdinals, type TargetKey } from "./identity.ts";
import { findTargetsInPage, identifyPopupInPage, PROBE_INIT_SCRIPT, showingPopupsInPage, signInFormInPage, type ContractBinding, type FoundTarget, type PopupFound, type TargetsInPage } from "./in-page.ts";
import { infoFromEvents, openAndIdentify, openScreen, type GuardEvent, type ProbePage, type ScenarioOutcome, type Stop } from "./scenario.ts";

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
  /** Asked before every scenario: null while probing is still allowed, else why it isn't. */
  readonly stillAllowed?: () => Promise<Stop | null>;
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

  private readonly context: BrowserContext;
  private readonly origin: string;

  constructor(context: BrowserContext, origin: string) {
    this.context = context;
    this.origin = origin;
  }

  static async open(browser: Browser, origin: string, viewport: ProbeRouteOptions["viewport"]): Promise<{ guarded: GuardedContext; close: () => Promise<void> }> {
    let guarded: GuardedContext | null = null;
    const fence = await startFence(origin, (refusal: FenceRefusal) => guarded?.record(null, { kind: refusal.kind, words: refusal.words }));
    let context: BrowserContext | null = null;
    try {
      // No storage state, no permissions, no downloads; every request through the fence, loopback included.
      context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false, permissions: [], proxy: { server: fence.server, bypass: "<-loopback>" } });
      guarded = new GuardedContext(context, origin);
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
    page.on("dialog", (dialog) => {
      this.record(log, { kind: "dialog", words: `the page showed a browser dialog (${dialog.type()}); it was dismissed` });
      void dialog.dismiss().catch(() => undefined);
    });
    return new PlaywrightProbePage(page, log, options, () => {
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
}

/** ProbePage on a Playwright page, every call bounded by the scenario's deadline. */
class PlaywrightProbePage implements ProbePage {
  private targets: JSHandle<TargetsInPage> | null = null;
  private before: JSHandle<Element[]> | null = null;

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
    return this.bound(this.page.evaluate(() => location.href)).catch((error: unknown) => {
      if (error instanceof TimeUp) throw error;
      return this.page.url();
    });
  }

  signInForm(): Promise<boolean> {
    return this.bound(this.page.evaluate(signInFormInPage));
  }

  async findTargets(): Promise<readonly FoundTarget[]> {
    this.targets = await this.bound(this.page.evaluateHandle(findTargetsInPage, { bindings: [...this.options.bindings], limit: MAX_FOUND, maxFrames: 6 }));
    return this.bound(this.targets.evaluate((t) => t.found));
  }

  async markShowing(pattern: BehaviourPattern): Promise<void> {
    this.before = await this.bound(this.page.evaluateHandle(showingPopupsInPage, { pattern }));
  }

  acting(): void {
    this.log.phase = "act";
  }

  async click(index: number, timeoutMs: number): Promise<void> {
    if (!this.targets) throw new Error("no targets were found on this page");
    const trigger = (await this.bound(this.targets.evaluateHandle((t, i) => t.elements[i]!, index))).asElement();
    if (!trigger) throw new Error("the button is gone");
    // A real click on the trigger only: Playwright refuses to click when anything else would get it.
    await this.bound(trigger.click({ timeout: Math.max(1, timeoutMs) }));
  }

  identify(index: number, pattern: BehaviourPattern, popup: PartRef | null): Promise<PopupFound> {
    if (!this.targets || !this.before) return Promise.resolve({ state: "none" });
    // The handles stand for the page-side objects identifyPopupInPage reads.
    const identify = identifyPopupInPage as unknown as (args: unknown) => PopupFound;
    return this.bound(this.page.evaluate(identify, { targets: this.targets, index, before: this.before, pattern, popup }));
  }

  events(): readonly GuardEvent[] {
    return this.log.events;
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    this.forget();
    await this.page.close({ runBeforeUnload: false }).catch(() => undefined);
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
  try {
    return await openAndIdentify(page, { start, origin: options.origin, wanted: key, popup, deadline, budgets: { openMs: budgets.openMs, pollMs: POLL_MS, graceMs: GRACE_MS } });
  } catch (error: unknown) {
    const info = infoFromEvents(page.events());
    if (error instanceof TimeUp) return { state: "incomplete", why: Date.now() >= routeDeadline ? untestedWords("time", budgets).why.replace("not tested: ", "stopped: ") : `ran out of time: a scenario has ${Math.round(budgets.scenarioMs / 1000)} s once the screen is open`, fix: "Next: make sure the dev server is idle, then run the probe again.", info };
    return { state: "error", why: `the probe failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`, fix: "Next: run the probe again; if it fails again, report it with the screen's route.", info };
  } finally {
    await page.close();
  }
}
