/**
 * Behaviour probes as the hub, MCP and requests use them (docs/plans/behaviour-rules.md, "UI",
 * "Change requests", "CLI, MCP, agents"). One path runs a probe for every caller (runBehaviour):
 * the System's behaviour rules that are on, consent read from screens.json now, the app's
 * fingerprint, then probeBehaviour (which reads consent again before every click and keeps the run).
 * A caller names a route and, optionally, which of its popups (a target filter): never a URL, a
 * path or a file. One run at a time per product in this process; a second is told one is going.
 *
 * Stored results are read back through readBehaviourRun (the checked file, Zod-validated, its
 * display strings cleaned) and held to now: a result counts only while every part of its key
 * matches what a result made now would carry, and it stands on its own in its run (its target
 * found once, one result for it, a decided check that applies to its pattern).
 *
 * Change requests use the same reading (behaviourEvidence): a request is filed only from a
 * stored, fresh, failed result, and moved to addressed only with a stored, fresh, passed result
 * for the same rule, check and target from a run newer than the request.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BEHAVIOUR_CHECKS, BehaviourConsent, BehaviourPattern, cleanText, decidesBehaviour, pageText, targetIdentityKey, type BehaviourCheckId, type BehaviourResult, type BehaviourRouteRun, type BehaviourTargetIdentity, type RequestBehaviour, type RequestTarget, type RuleSpec } from "@youiyoux/core";
import { appFingerprint, behaviourConfigDigest, behaviourConsent, bindingsDigest, contractBindings, CONSENT_WORDS, freshnessNow, POPUP_NOUN, probeOrigin, readScreensSpec, ruleDigest, screenSlug, staleParts, type AppFingerprint, type FreshnessNow, type ProbeBudgets, type probeRoute, type Project, type ScreensSpec } from "@youiyoux/scanner";
import { claimRoute, probeBehaviour, readBehaviourRun, type ProbeBehaviourOptions, type RouteClaim, type ProbeBehaviourResult } from "./behaviour.ts";
import { WorkflowError } from "./policy.ts";

/** What running probes needs beyond the project: this youiyoux's version (as results record it) and a browser. */
export interface BehaviourSetup {
  /** What a behaviour result records as the youiyoux that made it (the CLI's behaviourTool()). */
  readonly tool: string;
  /** Opens a browser for one run; it is closed when the run ends. */
  readonly browser: () => Promise<ProbeBehaviourOptions["browser"]>;
  readonly budgets?: Partial<ProbeBudgets>;
  /** Tests only: the probe to run instead of probeRoute. */
  readonly probe?: typeof probeRoute;
}

/** What behaviour reads of a project: where it is, what it scans (the fingerprint), its rules and contracts. */
export type BehaviourProject = Pick<Project, "root" | "config" | "system">;

/**
 * Which of a route's popups to test: one component's (by the name React knows it by, or null for
 * plain markup), narrowed by pattern, accessible name and ordinal when given. Identity fields only.
 */
export const BehaviourTargetFilter = z
  .object({
    component: z.string().min(1).max(200).nullable(),
    pattern: BehaviourPattern.optional(),
    accessibleName: z.string().max(500).optional(),
    ordinal: z.number().int().nonnegative().max(1000).optional(),
  })
  .strict();
export type BehaviourTargetFilter = z.infer<typeof BehaviourTargetFilter>;

/** A route as a caller names it: screens.json's route, never an address. */
export const BehaviourRoute = z.string().min(1).max(500).regex(/^\/(?!\/)/, "expected a route as screens.json lists it, starting with a single /");

/** A run going now. */
export interface ActiveBehaviourRun {
  readonly route: string;
  readonly target: BehaviourTargetFilter | null;
  readonly startedAt: string;
  /** How many popups it tests, once it has found them. */
  readonly popups: number | null;
  readonly by: "person" | "agent";
}

/** How the last run of this process ended, per product: what it stored, or why it stored nothing. */
export interface LastBehaviourRun {
  readonly route: string;
  readonly target: BehaviourTargetFilter | null;
  readonly at: string;
  readonly runId: string | null;
  readonly problem: string | null;
}

const SCREENS = ".youi/screens";
const active = new Map<string, ActiveBehaviourRun>();
const last = new Map<string, LastBehaviourRun>();

/** The System's behaviour rules that are on. */
export const behaviourRulesOn = (project: Pick<Project, "system">): RuleSpec[] => project.system.rules.filter((r) => r.severity !== "off" && r.check.engine === "behaviour");

export const behaviourRunning = (root: string): ActiveBehaviourRun | null => active.get(resolve(root)) ?? null;
export const lastBehaviourRun = (root: string): LastBehaviourRun | null => last.get(resolve(root)) ?? null;

/** A target filter in words: "'Menu''s popups", "the menu 'More' in 'Menu'". Quoted, cleaned: a component name can come from the page. */
export function filterWords(filter: BehaviourTargetFilter): string {
  const owner = filter.component === null ? "plain markup (no component)" : pageText(filter.component, 80);
  if (filter.accessibleName !== undefined) return `the ${filter.pattern ? POPUP_NOUN[filter.pattern] : "popup"} ${pageText(filter.accessibleName)}${filter.ordinal !== undefined ? ` #${filter.ordinal + 1}` : ""} in ${owner}`;
  return `the ${filter.pattern ? `${POPUP_NOUN[filter.pattern]}s` : "popups"} of ${owner}`;
}

const matches = (filter: BehaviourTargetFilter) => (key: { readonly pattern: string; readonly component: string | null; readonly accessibleName: string; readonly ordinal?: number }): boolean =>
  key.component === filter.component && (filter.pattern === undefined || key.pattern === filter.pattern) && (filter.accessibleName === undefined || key.accessibleName === filter.accessibleName) && (filter.ordinal === undefined || key.ordinal === filter.ordinal);

function readSpec(root: string): ScreensSpec {
  try {
    return readScreensSpec(join(root, SCREENS));
  } catch (error: unknown) {
    if (/ENOENT/.test(error instanceof Error ? error.message : String(error))) throw new WorkflowError("conflict", "no screens are captured yet: youiyoux screens capture --base <url of the app in development> lists them and records where the app runs");
    throw new WorkflowError("invalid", error instanceof Error ? error.message.split("\n")[0]! : String(error));
  }
}

/**
 * Start a probe of one route (or of the popups `target` picks on it). Everything that refuses
 * does so here, before it resolves and before any browser opens: no behaviour rules, no screens,
 * no consent (the plan's words), a route screens.json doesn't list, a run already going for this
 * product in this process, or for this route in any process (the route's claim). `done` settles
 * with the stored run, or with why nothing was stored; the claim is held until then.
 */
export async function runBehaviour(project: BehaviourProject, setup: BehaviourSetup, input: { readonly route: string; readonly target?: BehaviourTargetFilter | null; readonly by: "person" | "agent" }): Promise<{ readonly run: ActiveBehaviourRun; readonly done: Promise<ProbeBehaviourResult> }> {
  const key = resolve(project.root);
  const going = active.get(key);
  if (going) throw new WorkflowError("conflict", `a behaviour run is already going for this app (${going.route}${going.target ? `, ${filterWords(going.target)}` : ""}, started ${going.startedAt}): wait for it to finish, then run again`);
  const rules = behaviourRulesOn(project);
  if (rules.length === 0) throw new WorkflowError("conflict", "no behaviour rules are on in this System, so there is nothing to probe: add a rule with check: { engine: behaviour, id: dismiss-escape } (or another check) first");
  const spec = readSpec(project.root);
  // Refused with the plan's words; probeBehaviour reads consent again, and before every click.
  const consent = behaviourConsent(spec);
  if (!consent.ok) throw new WorkflowError("forbidden", `${consent.why} ${consent.fix}`);
  if (!spec.screens.some((s) => s.route === input.route)) throw new WorkflowError("not-found", `screens.json has no route ${input.route}: it lists ${spec.screens.map((s) => s.route).join(", ") || "none"}`);
  const target = input.target ?? null;
  const run: { -readonly [K in keyof ActiveBehaviourRun]: ActiveBehaviourRun[K] } = { route: input.route, target, startedAt: new Date().toISOString(), popups: null, by: input.by };
  // Claimed before anything is awaited: a second caller in this process sees it at once.
  active.set(key, run);
  let claim: RouteClaim;
  try {
    // Taken before the app is hashed or a browser opens: the run's start, as stored.
    claim = await claimRoute(project.root, input.route);
  } catch (error: unknown) {
    if (active.get(key) === run) active.delete(key);
    throw error;
  }
  const probe = async (): Promise<ProbeBehaviourResult> => {
    const declared = BehaviourConsent.safeParse(spec.behaviour ?? {});
    const app = await appFingerprint(project, { inputs: declared.success ? (declared.data.inputs ?? []) : [] });
    if (app.incomplete) throw new WorkflowError("conflict", `behaviour results couldn't be kept fresh, so nothing was probed: ${app.incomplete}`);
    const browser = await setup.browser();
    try {
      return await probeBehaviour({
        root: project.root,
        route: input.route,
        claim,
        browser,
        checks: rules.map((r) => ({ rule: r.id, check: (r.check as { id: BehaviourCheckId }).id, digest: ruleDigest(r) })),
        bindings: contractBindings(project.system),
        fingerprint: { app: app.digest, tool: setup.tool },
        ...(setup.budgets ? { budgets: setup.budgets } : {}),
        ...(setup.probe ? { probe: setup.probe } : {}),
        ...(target ? { only: { test: matches(target), words: filterWords(target) } } : {}),
        onFound: (count) => void (run.popups = count),
      });
    } finally {
      await browser.close().catch(() => undefined);
    }
  };
  // The claim is let go, and the outcome recorded, before `done` settles: whoever awaits it may start the next run at once.
  const done = (async (): Promise<ProbeBehaviourResult> => {
    try {
      const result = await probe();
      last.set(key, { route: input.route, target, at: new Date().toISOString(), runId: result.run.runId, problem: null });
      return result;
    } catch (error: unknown) {
      last.set(key, { route: input.route, target, at: new Date().toISOString(), runId: null, problem: cleanText(error instanceof Error ? error.message : String(error), 1000) || "the run failed" });
      throw error;
    } finally {
      await claim.release();
      if (active.get(key) === run) active.delete(key);
    }
  })();
  return { run, done };
}

/** Whether probing is switched on for this app, for the hub's switch. */
export interface BehaviourConsentView {
  /** screens.json exists (the switch writes into it). */
  readonly screens: boolean;
  readonly on: boolean;
  /** The origin of screens.json's base now (what switching on binds to), or null when it can't be probed. */
  readonly origin: string | null;
  /** The origin consent was given for, when there is one (it may no longer be base's). */
  readonly allowedOrigin: string | null;
  /** Consent was given for base's origin now. */
  readonly matches: boolean;
  /** Why it is off, and what to do; null when on. */
  readonly why: string | null;
  /** The words the hub shows beside the switch. */
  readonly words: string;
}

export function behaviourConsentView(root: string): BehaviourConsentView {
  const off = (why: string, fields: Partial<BehaviourConsentView> = {}): BehaviourConsentView => ({ screens: true, on: false, origin: null, allowedOrigin: null, matches: false, why, words: CONSENT_WORDS, ...fields });
  if (!existsSync(join(root, SCREENS, "screens.json"))) return off("no screens are captured yet: youiyoux screens capture --base <url of the app in development> lists them and records where the app runs", { screens: false });
  let spec: ScreensSpec;
  try {
    spec = readScreensSpec(join(root, SCREENS));
  } catch (error: unknown) {
    return off(cleanText(error instanceof Error ? error.message : String(error), 500));
  }
  const at = probeOrigin(spec.base);
  const declared = BehaviourConsent.safeParse(spec.behaviour ?? {});
  const allowedOrigin = declared.success ? (declared.data.allowedOrigin ?? null) : null;
  const origin = at.ok ? at.origin : null;
  const consent = behaviourConsent(spec);
  if (consent.ok) return { screens: true, on: true, origin, allowedOrigin, matches: true, why: null, words: CONSENT_WORDS };
  return off(`${consent.why} ${consent.fix}`, { origin, allowedOrigin, matches: origin !== null && allowedOrigin === origin });
}

/** A stored result as the hub and agents read it: where it is in its run, whether it is fresh, and whether it counts. */
export type BehaviourResultView = BehaviourResult & {
  /** Its place in its run's results: with the run id and route, what a change request names. */
  readonly index: number;
  /** Why it isn't fresh, in words; empty when it is. A stale result never counts. */
  readonly stale: readonly string[];
  /** Fresh, and it stands on its own in its run: only such a result passes or fails anything. */
  readonly counts: boolean;
};

export interface BehaviourRouteView {
  readonly route: string;
  /** The behaviour rules that are on. */
  readonly rules: ReadonlyArray<{ readonly id: string; readonly title: string; readonly severity: string; readonly check: BehaviourCheckId }>;
  /** The route's stored run, without its results (they are below), or null when it was never probed. */
  readonly run: Omit<BehaviourRouteRun, "results"> | null;
  readonly results: readonly BehaviourResultView[];
  /** Why the stored run couldn't be read, when it couldn't (it then counts as none). */
  readonly problem: string | null;
}

/** What a result made now would carry, computed once per reading; why nothing can be fresh, if the fingerprint can't be whole. */
type Now = FreshnessNow & { readonly appIncomplete: string | null };

/** How long a fingerprint made for display is reused: reading every source file costs, and the hub asks often. */
const DISPLAY_MS = 2_000;
/** Fingerprints for display, by product and what it covers: one calculation at a time, reused for DISPLAY_MS after it ends. */
const displayPrints = new Map<string, { done: number | null; value: Promise<AppFingerprint> }>();

/**
 * The app's fingerprint for showing results: calls at the same time share one calculation, and its
 * answer is reused for DISPLAY_MS. Never used to accept anything (`fresh` readings compute anew).
 */
function displayFingerprint(project: BehaviourProject, inputs: readonly string[]): Promise<AppFingerprint> {
  const key = JSON.stringify([resolve(project.root), project.config, inputs]);
  const now = Date.now();
  for (const [k, v] of displayPrints) if (v.done !== null && now - v.done >= DISPLAY_MS) displayPrints.delete(k);
  const hit = displayPrints.get(key);
  if (hit) return hit.value;
  const entry: { done: number | null; value: Promise<AppFingerprint> } = { done: null, value: appFingerprint(project, { inputs }) };
  entry.value.then(
    () => void (entry.done = Date.now()),
    () => void (displayPrints.get(key) === entry && displayPrints.delete(key)),
  );
  displayPrints.set(key, entry);
  return entry.value;
}

/** `fresh`: computed now, for accepting something; otherwise the display reading (displayFingerprint). */
async function nowFor(project: BehaviourProject, tool: string, spec: ScreensSpec, fresh: boolean): Promise<Now> {
  const declared = BehaviourConsent.safeParse(spec.behaviour ?? {});
  const inputs = declared.success ? (declared.data.inputs ?? []) : [];
  const app = fresh ? await appFingerprint(project, { inputs }) : await displayFingerprint(project, inputs);
  return { ...freshnessNow(spec, app.digest, tool, bindingsDigest(contractBindings(project.system))), appIncomplete: app.incomplete };
}

/** Why `result` isn't fresh now (empty when it is): its rule as it is now, the app, the route's config. */
function staleness(result: BehaviourResult, rules: readonly RuleSpec[], spec: ScreensSpec, now: Now): string[] {
  const rule = rules.find((r) => r.id === result.rule);
  if (!rule || rule.check.engine !== "behaviour" || rule.check.id !== result.check) return ["the rule was removed, switched off or now checks something else"];
  if (now.appIncomplete) return [`its freshness can't be shown: ${now.appIncomplete}`];
  return staleParts(result, { ...now, rule: ruleDigest(rule), config: behaviourConfigDigest(spec, result.route) });
}

/** A result stands on its own in its run: its target found once, one result for it under its rule, a decided check that applies to its pattern. */
function standsAlone(result: BehaviourResult, run: BehaviourRouteRun): boolean {
  const key = targetIdentityKey(result.target);
  return (
    decidesBehaviour(result.check) &&
    BEHAVIOUR_CHECKS[result.check].patterns.includes(result.pattern) &&
    run.targets.filter((t) => targetIdentityKey(t) === key).length === 1 &&
    run.results.filter((r) => r.rule === result.rule && targetIdentityKey(r.target) === key).length === 1
  );
}

/** One route's stored run and its results, each held to now. Probes nothing. */
/**
 * `fresh`: hold each result to a fingerprint computed now (what filing and addressed use); without
 * it, to the display reading, which may be up to DISPLAY_MS old.
 */
export async function behaviourRouteView(project: BehaviourProject, tool: string, route: string, options: { readonly fresh?: boolean } = {}): Promise<BehaviourRouteView> {
  const rules = behaviourRulesOn(project);
  const ruleList = rules.map((r) => ({ id: r.id, title: r.title, severity: r.severity, check: (r.check as { id: BehaviourCheckId }).id }));
  const spec = readSpec(project.root);
  if (!spec.screens.some((s) => s.route === route)) throw new WorkflowError("not-found", `screens.json has no route ${route}`);
  let run: BehaviourRouteRun | null;
  try {
    run = await readBehaviourRun(project.root, route);
  } catch (error: unknown) {
    return { route, rules: ruleList, run: null, results: [], problem: cleanText(error instanceof Error ? error.message : String(error), 500) || "the stored run couldn't be read" };
  }
  if (!run) return { route, rules: ruleList, run: null, results: [], problem: null };
  const now = await nowFor(project, tool, spec, options.fresh === true);
  const { results, ...head } = run;
  return {
    route,
    rules: ruleList,
    run: head,
    results: results.map((result, index) => {
      const stale = staleness(result, rules, spec, now);
      return { ...result, index, stale, counts: stale.length === 0 && standsAlone(result, run) };
    }),
    problem: null,
  };
}

/** A stored result, as a change request names it: its route, its run and its place in it. */
export const BehaviourRef = z.object({ route: BehaviourRoute, runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), index: z.number().int().nonnegative().max(100_000) }).strict();
export type BehaviourRef = z.infer<typeof BehaviourRef>;

/** What a change request reads of behaviour results: the failure it is filed from, and the pass that addresses it. */
export interface BehaviourEvidence {
  /** The stored result `ref` names, when it exists, failed, is fresh and stands on its own; refused with why otherwise. */
  failure(ref: BehaviourRef): Promise<{ readonly result: BehaviourResult; readonly link: RequestBehaviour; readonly target: RequestTarget }>;
  /** Null when a stored, fresh, passed result for the link's rule, check and target comes from a run started after `since`; else why not, in words. */
  passedSince(link: RequestBehaviour, since: string): Promise<string | null>;
}

const identity = (t: BehaviourTargetIdentity): BehaviourTargetIdentity => ({ route: t.route, pattern: t.pattern, component: t.component, accessibleName: t.accessibleName, ...(t.ordinal !== undefined ? { ordinal: t.ordinal } : {}) });

/** A popup in words, for requests: "the menu 'More' (UserMenu)". */
export const popupWords = (t: BehaviourTargetIdentity): string => `the ${POPUP_NOUN[t.pattern]} ${pageText(t.accessibleName)}${t.ordinal !== undefined ? ` #${t.ordinal + 1}` : ""}${t.component ? ` (${cleanText(t.component, 60)})` : ""}`;

/** Where the screen's last capture placed the component, for the request's pin: found again by its file, line and name. */
function placedBox(root: string, route: string, name: string, file: string | undefined, line: number | undefined): Pick<RequestTarget, "box" | "page"> {
  if (!file || !line) return {};
  try {
    const places = JSON.parse(readFileSync(join(root, SCREENS, `${screenSlug(route)}.places.json`), "utf8")) as { size?: RequestTarget["page"]; places?: Array<{ name?: unknown; file?: unknown; line?: unknown; box?: RequestTarget["box"] }> };
    const at = places.places?.find((p) => p.file === file && p.line === line && p.name === name);
    const box = at?.box;
    const page = places.size;
    if (!box || !page || ![box.x, box.y, box.width, box.height, page.width, page.height].every((n) => typeof n === "number" && Number.isFinite(n)) || box.width < 0 || box.height < 0 || page.width <= 0 || page.height <= 0) return {};
    return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, page: { width: page.width, height: page.height } };
  } catch {
    return {};
  }
}

const verify = (route: string): string => `run \`youiyoux behave --route ${route}\` first`;

/**
 * Change requests' reading of behaviour results, as this youiyoux (`tool`) would make them now.
 * `load` gives the design definitions as they are on disk now (rules and contract bindings), read
 * again for every filing and every addressed check, never a copy held for display: a pass made
 * under a rule or binding that has changed since is stale.
 */
export function behaviourEvidence(load: () => Promise<BehaviourProject>, tool: string): BehaviourEvidence {
  return {
    async failure(ref) {
      const project = await load();
      const view = await behaviourRouteView(project, tool, ref.route, { fresh: true });
      if (view.problem) throw new WorkflowError("conflict", `${ref.route}'s stored run couldn't be read (${view.problem}): run it again, then file from the new result`);
      if (!view.run || view.run.runId !== ref.runId) throw new WorkflowError("conflict", `that result is gone: ${ref.route} was ${view.run ? "probed again since" : "never probed, or its run was removed"}; look again and file from the result shown now`);
      const result = view.results[ref.index];
      if (!result) throw new WorkflowError("not-found", `${ref.route}'s run ${ref.runId} has no result ${ref.index}`);
      if (result.state !== "failed") throw new WorkflowError("conflict", `that result is ${result.state}, not failed: only a failed check is filed as a change request`);
      if (result.stale.length > 0) throw new WorkflowError("conflict", `that result is stale (${result.stale.join(", ")} since its run): run it again, then file from a fresh failure`);
      if (!result.counts) throw new WorkflowError("conflict", "that result doesn't stand on its own in its run (its popup was found more than once, or it has more than one result): run it again, then file from the new result");
      const t = result.target;
      const name = t.component ?? POPUP_NOUN[t.pattern];
      const target: RequestTarget = { route: t.route, scope: "here", name: cleanText(name, 200) || "popup", ...(t.file && t.line ? { file: t.file, line: t.line } : {}), ...placedBox(project.root, t.route, name, t.file, t.line) };
      const { index: _i, stale: _s, counts: _c, ...stored } = result;
      return { result: stored, link: { rule: result.rule, check: result.check, target: identity(t), runId: result.runId, failedAt: result.at }, target };
    },
    async passedSince(link, since) {
      const route = link.target.route;
      let view: BehaviourRouteView;
      try {
        view = await behaviourRouteView(await load(), tool, route, { fresh: true });
      } catch (error: unknown) {
        return `${verify(route)}; the stored runs couldn't be read (${cleanText(error instanceof Error ? error.message : String(error), 300)})`;
      }
      if (view.problem) return `${verify(route)}; the last run couldn't be read (${view.problem})`;
      // Newer means started after the request was filed or reopened: a run already going then can't speak for what came after.
      if (!view.run?.startedAt || !(Date.parse(view.run.startedAt) > Date.parse(since))) return `${verify(route)}; this request has no newer run`;
      const key = targetIdentityKey(link.target);
      const mine = view.results.filter((r) => r.rule === link.rule && r.check === link.check && targetIdentityKey(r.target) === key);
      if (mine.length === 0) return `${verify(route)}; the last run didn't test ${popupWords(link.target)} for ${link.check}`;
      const result = mine[0]!;
      if (result.stale.length > 0) return `${verify(route)}; the last run is stale (${result.stale.join(", ")} since it ran)`;
      if (result.state === "failed") return `${verify(route)}; the last run still fails`;
      if (result.state !== "passed") return `${verify(route)}; the last run couldn't decide it (${result.why})`;
      if (!result.counts || mine.length > 1) return `${verify(route)}; the last run's results for this popup don't add up`;
      return null;
    },
  };
}
