/**
 * Where behaviour rules stand from stored probe runs, for `youiyoux check` and `check --diff`
 * (docs/plans/behaviour-rules.md, "Execution semantics"). Nothing is probed here: each route's run
 * is read back from `.youi/behaviour/` (readBehaviourRun: the checked file, Zod-validated), and
 * every part of its freshness key is computed again now and compared. A rule has run (`ran`) only
 * when every route in the denominator (screens.json's routes, or `behaviour.routes`) has a fresh,
 * complete result set for it; otherwise it is `incomplete`, naming the routes and why. Fresh failed
 * results count as findings whatever else is missing. Stale results never count, as passes or as
 * failures, and a stored pass or fail for a check this youiyoux doesn't decide isn't counted at all.
 */
import { join } from "node:path";
import { BEHAVIOUR_CHECKS, decidesBehaviour, ruleSlug, targetIdentityKey, type BehaviourResult, type BehaviourRouteRun, type RuleRun, type RuleSpec } from "@youiyoux/core";
import { appFingerprint, behaviourConfigDigest, behaviourRoutes, freshnessNow, readScreensSpec, ruleDigest, staleParts, type FreshnessNow, type Project, type ScreensSpec } from "@youiyoux/scanner";
import { readBehaviourRun } from "./behaviour.ts";

/** A fresh failed result of a behaviour rule: a finding, counted by the rule's severity. */
export interface BehaviourFailure {
  readonly rule: string;
  readonly severity: "error" | "warn";
  readonly result: BehaviourResult;
}

export interface BehaviourStanding {
  /** One per behaviour rule asked about: `ran` (findings = its fresh failures) or `incomplete` with why. */
  readonly runs: readonly RuleRun[];
  readonly failures: readonly BehaviourFailure[];
}

/** One route's standing for one rule. */
type RouteState = { readonly route: string; readonly fresh: boolean; readonly why: string | null; readonly failures: readonly BehaviourResult[] };

const SCREENS = ".youi/screens";
const MAX_NAMED = 5;

/**
 * The standing of `rules` (behaviour rules that are on) from what is stored under the project's
 * `.youi/behaviour/`. `tool` is this youiyoux's version, as `youiyoux behave` stores it.
 */
export async function behaviourStanding(project: Pick<Project, "root" | "config">, rules: readonly RuleSpec[], tool: string): Promise<BehaviourStanding> {
  const probed = rules.filter((r) => r.severity !== "off" && r.check.engine === "behaviour");
  if (probed.length === 0) return { runs: [], failures: [] };
  let spec: ScreensSpec;
  try {
    spec = readScreensSpec(join(project.root, SCREENS));
  } catch (error: unknown) {
    const missing = /ENOENT/.test(error instanceof Error ? error.message : String(error));
    const why = missing ? "no screens are captured yet (.youi/screens/screens.json), so there are no routes to probe: capture them with youiyoux screens capture --base <url>, switch probing on, then run youiyoux behave" : `.youi/screens/screens.json couldn't be read (${(error instanceof Error ? error.message : String(error)).split("\n")[0]}), so no behaviour result can be checked; fix it, then run youiyoux behave`;
    return { runs: probed.map((r) => ({ rule: r.id, state: "incomplete", reason: why })), failures: [] };
  }
  const { routes, unknown } = behaviourRoutes(spec);
  if (routes.length === 0) return { runs: probed.map((r) => ({ rule: r.id, state: "incomplete", reason: "screens.json lists no routes to probe, so no behaviour rule can be checked: add the app's screens to it, then run youiyoux behave" })), failures: [] };
  // Each route's run, read once; a run that can't be read counts as none, with why.
  const stored = new Map<string, { run: BehaviourRouteRun | null; problem: string | null }>();
  for (const route of routes) {
    if (unknown.includes(route)) {
      stored.set(route, { run: null, problem: "isn't a screen in screens.json" });
      continue;
    }
    try {
      stored.set(route, { run: await readBehaviourRun(project.root, route), problem: null });
    } catch (error: unknown) {
      stored.set(route, { run: null, problem: `has a stored run that couldn't be used (${(error instanceof Error ? error.message : String(error)).split("\n")[0]})` });
    }
  }
  // The app's fingerprint only when there is something to compare it with: reading every source file costs.
  let now: FreshnessNow | null = null;
  const current = async (): Promise<FreshnessNow> => (now ??= freshnessNow(spec, await appFingerprint(project), tool));
  const runs: RuleRun[] = [];
  const failures: BehaviourFailure[] = [];
  for (const rule of probed) {
    const states: RouteState[] = [];
    for (const route of routes) {
      const { run, problem } = stored.get(route)!;
      states.push(problem ? { route, fresh: false, why: problem, failures: [] } : await routeState(rule, route, run, spec, current));
    }
    const fresh = states.flatMap((s) => s.failures);
    for (const result of fresh) failures.push({ rule: rule.id, severity: rule.severity === "error" ? "error" : "warn", result });
    const gaps = states.filter((s) => !s.fresh);
    if (gaps.length === 0) runs.push({ rule: rule.id, state: "ran", findings: fresh.length });
    else {
      const named = gaps.slice(0, MAX_NAMED).map((s) => `${s.route} ${s.why}`);
      const more = gaps.length > MAX_NAMED ? `; and ${gaps.length - MAX_NAMED} more` : "";
      runs.push({ rule: rule.id, state: "incomplete", reason: `no fresh, complete probe results on ${gaps.length} of ${routes.length} route${routes.length === 1 ? "" : "s"}: ${named.join("; ")}${more}. Run youiyoux behave${gaps.length === 1 ? ` --route ${gaps[0]!.route}` : ""} (for ${ruleSlug(rule.id)}), then youiyoux check again` });
    }
  }
  return { runs, failures };
}

/** Whether `route`'s stored run is a fresh, complete result set for `rule`; its fresh failures either way. */
async function routeState(rule: RuleSpec, route: string, run: BehaviourRouteRun | null, spec: ScreensSpec, current: () => Promise<FreshnessNow>): Promise<RouteState> {
  const no = (why: string, failures: readonly BehaviourResult[] = []): RouteState => ({ route, fresh: false, why, failures });
  if (!run) return no("was never probed");
  const entry = run.rules.find((r) => r.rule === rule.id);
  if (!entry) return no("was probed, but not for this rule");
  if (rule.check.engine !== "behaviour" || entry.check !== rule.check.id) return no("was probed for another check under this rule's id");
  const now = { ...(await current()), rule: ruleDigest(rule), config: behaviourConfigDigest(spec, route) };
  const stale = staleParts({ freshness: entry.freshness, viewport: run.viewport }, now);
  if (stale.length > 0) return no(`is stale (${stale.join(", ")} since its run)`);
  if (run.state === "incomplete") return no(`couldn't be probed (${run.why})`);
  const mine = run.results.filter((r) => r.rule === rule.id);
  // Each result is held to the same key (the schema ties it to its rule's entry) and to now.
  if (mine.some((r) => staleParts(r, now).length > 0 || r.route !== route)) return no("is stale (a result was made against something else)");
  // Integrity (the freshness key proves what a result was made against, not that the file is
  // whole): exactly one result per target the run found, and not-applicable only where the
  // check doesn't apply to the target's pattern.
  const expected = new Set(run.targets.map(targetIdentityKey));
  const seen = new Map<string, number>();
  for (const r of mine) seen.set(targetIdentityKey(r.target), (seen.get(targetIdentityKey(r.target)) ?? 0) + 1);
  const missing = [...expected].filter((k) => !seen.has(k)).length;
  const extra = [...seen].filter(([k, n]) => !expected.has(k) || n > 1).length;
  if (missing > 0 || extra > 0) return no(`has a stored run whose results don't match the popups it found (${missing} missing, ${extra} extra or repeated); run youiyoux behave again`);
  const wrongNa = mine.filter((r) => (r.state === "not-applicable") === BEHAVIOUR_CHECKS[r.check].patterns.includes(r.pattern));
  if (wrongNa.length > 0) return no(`has a stored run that says ${wrongNa[0]!.check} ${wrongNa[0]!.state === "not-applicable" ? "doesn't apply to" : "applies to"} a ${wrongNa[0]!.pattern}, which it ${wrongNa[0]!.state === "not-applicable" ? "does" : "doesn't"}; run youiyoux behave again`);
  const counted = mine.filter((r) => decidesBehaviour(r.check) && r.state === "failed");
  const undecided = mine.filter((r) => r.state === "incomplete" || r.state === "error" || ((r.state === "passed" || r.state === "failed") && !decidesBehaviour(r.check)));
  if (undecided.length > 0) return no(`has ${undecided.length} popup${undecided.length === 1 ? "" : "s"} that couldn't be decided (${undecided[0]!.why})`, counted);
  return { route, fresh: true, why: null, failures: counted };
}
