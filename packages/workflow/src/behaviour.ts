/**
 * Behaviour probes, the service's side (docs/plans/behaviour-rules.md): consent read from the
 * product's `.youi/screens/screens.json` at the moment of probing, the guarded probe (scanner's
 * probeRoute) on one route, its triggers' frames mapped to file and line by the live resolver
 * (display only), and the run kept as `.youi/behaviour/<route-hash>.json`.
 *
 * Writes are files, never folders: the route's run file, evidence under the real `.youi/` (each
 * path resolved, links refused), and screens.json's `behaviour` block only through
 * `setBehaviourConsent` (the service's authenticated write). Nothing here is ever a pass yet: the
 * popup opening and being identified is reported as `incomplete` until the checks themselves run.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { BEHAVIOUR_ROUTE_SCHEMA, BehaviourRouteRun, EVIDENCE_PATH, writeFileAtomic, type BehaviourCheckId, type BehaviourResult, type BehaviourTarget } from "@youiyoux/core";
import { behaviourConsent, probeOrigin, probeRoute, readScreensSpec, screenUrl, type ContractBinding, type ProbeBudgets, type ProbeRouteOptions, type RouteProbe, type ScreensSpec } from "@youiyoux/scanner";
import { LiveApp } from "./live.ts";
import { WorkflowError } from "./policy.ts";

/** One behaviour rule's check to probe, with the digest of its rule file and options (freshness). */
export interface BehaviourCheckRequest {
  readonly rule: string;
  readonly check: BehaviourCheckId;
  readonly digest: string;
}

export interface ProbeBehaviourOptions {
  /** The product's root (its `.youi/` is beside its code). */
  readonly root: string;
  readonly route: string;
  readonly browser: ProbeRouteOptions["browser"];
  readonly checks: readonly BehaviourCheckRequest[];
  readonly bindings?: readonly ContractBinding[];
  /** What the run is made against, beyond what the probe knows: the app's source fingerprint and this youiyoux's version. */
  readonly fingerprint: { readonly app: string; readonly tool: string };
  readonly budgets?: Partial<ProbeBudgets>;
  readonly now?: () => Date;
}

export interface ProbeBehaviourResult {
  readonly run: BehaviourRouteRun;
  /** The run file, under the product's real `.youi/behaviour/`. */
  readonly file: string;
  /** The probe as it happened, the internal "opened" outcomes included (never stored as passes). */
  readonly probe: RouteProbe;
}

const SCREENS = ".youi/screens";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A route's run file name: a hash, so a route never reaches a path raw. */
export const behaviourFile = (route: string): string => `.youi/behaviour/${digest(route).slice(0, 16)}.json`;

/**
 * A project-relative path under `.youi/` (EVIDENCE_PATH), resolved against the real `.youi/`: every
 * folder on the way a real folder (never a link), the file itself not a link, and the result inside
 * the real `.youi/`, which is inside the real root. `write` creates missing folders on the way.
 */
export async function youiPath(root: string, path: string, mode: "read" | "write"): Promise<string> {
  if (!EVIDENCE_PATH.test(path)) throw new WorkflowError("bad-request", `${path} isn't a path under .youi/`);
  const realRoot = await realpath(root);
  const youi = join(realRoot, ".youi");
  const youiStat = await lstat(youi).catch(() => null);
  if (!youiStat) {
    if (mode === "read") throw new WorkflowError("not-found", `${path} doesn't exist`);
    await mkdir(youi);
  } else if (!youiStat.isDirectory()) throw new WorkflowError("forbidden", ".youi is a link or not a folder: youiyoux writes only inside the project's own .youi/");
  const realYoui = await realpath(youi);
  const inside = (p: string): boolean => {
    const r = relative(realYoui, p);
    return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
  };
  const segments = path.split("/").slice(1);
  let at = realYoui;
  for (const segment of segments.slice(0, -1)) {
    at = join(at, segment);
    const stat = await lstat(at).catch(() => null);
    if (!stat) {
      if (mode === "read") throw new WorkflowError("not-found", `${path} doesn't exist`);
      await mkdir(at);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkflowError("forbidden", `${path} goes through a link or a file: youiyoux reads and writes only inside the project's own .youi/`);
  }
  const file = join(at, segments.at(-1)!);
  const stat = await lstat(file).catch(() => null);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new WorkflowError("forbidden", `${path} is a link or not a file: youiyoux reads and writes only files inside the project's own .youi/`);
  if (!stat && mode === "read") throw new WorkflowError("not-found", `${path} doesn't exist`);
  // Belt and braces: the folder it ends in really is inside the real .youi/.
  if (!inside(join(await realpath(at), segments.at(-1)!))) throw new WorkflowError("forbidden", `${path} leads outside the project's .youi/`);
  return file;
}

/** Evidence (a screenshot) written under the real `.youi/`; the path is refused if it leads anywhere else. */
export async function writeEvidence(root: string, path: string, bytes: Buffer): Promise<void> {
  const file = await youiPath(root, path, "write");
  // writeFileAtomic takes text; evidence is binary, so it is written the same atomic way, byte for byte.
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, bytes, { flag: "wx" });
  await rename(temp, file);
}

export async function readEvidence(root: string, path: string): Promise<Buffer> {
  return readFile(await youiPath(root, path, "read"));
}

/** A route's last run, if there is one; its evidence paths are each proved to stay in the real `.youi/`. */
export async function readBehaviourRun(root: string, route: string): Promise<BehaviourRouteRun | null> {
  let file: string;
  try {
    file = await youiPath(root, behaviourFile(route), "read");
  } catch (error: unknown) {
    if (error instanceof WorkflowError && error.code === "not-found") return null;
    throw error;
  }
  const parsed = BehaviourRouteRun.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success || parsed.data.route !== route) throw new WorkflowError("invalid", `${behaviourFile(route)} isn't a behaviour run for ${route}: run the probe again`);
  for (const result of parsed.data.results) for (const path of result.evidence) await youiPath(root, path, "read");
  return parsed.data;
}

function readSpec(root: string): ScreensSpec {
  try {
    return readScreensSpec(join(root, SCREENS));
  } catch (error: unknown) {
    throw new WorkflowError("invalid", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Switch behaviour probes on (consent bound to the origin of screens.json's current `base`, never
 * one a caller names) or off. The service's authenticated write; the file is replaced atomically.
 */
export async function setBehaviourConsent(root: string, allow: boolean): Promise<{ readonly allowedOrigin: string | null }> {
  const file = await youiPath(root, `${SCREENS}/screens.json`, "read").catch((error: unknown) => {
    if (error instanceof WorkflowError && error.code === "not-found") throw new WorkflowError("conflict", "no screens are captured yet: youiyoux screens capture --base <url> takes them and records where the app runs");
    throw error;
  });
  readSpec(root);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (!allow) {
    delete raw.behaviour;
    await writeFileAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
    return { allowedOrigin: null };
  }
  const at = probeOrigin(raw.base);
  if (!at.ok) throw new WorkflowError("conflict", `${at.why}. ${at.fix}`);
  raw.behaviour = { allowedOrigin: at.origin };
  await writeFileAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
  return { allowedOrigin: at.origin };
}

/** Words for a result whose popup opened and was identified, before any check decides anything. */
const notRunYet = (check: BehaviourCheckId, how: string): { why: string; fix: string } => ({
  why: `the popup opened and was identified (by ${how}), but this youiyoux doesn't decide ${check} yet`,
  fix: "Next: update youiyoux; nothing was decided, so this isn't a pass.",
});

/**
 * Probe one route of the product's app, with consent checked now against the live `base` (and again
 * before every scenario), and keep the run. Refused, with the plan's words, when there is no consent.
 */
export async function probeBehaviour(options: ProbeBehaviourOptions): Promise<ProbeBehaviourResult> {
  const spec = readSpec(options.root);
  const consent = behaviourConsent(spec);
  if (!consent.ok) throw new WorkflowError("forbidden", `${consent.why} ${consent.fix}`);
  const screen = spec.screens.find((s) => s.route === options.route);
  if (!screen) throw new WorkflowError("not-found", `screens.json has no route ${options.route}: it lists ${spec.screens.map((s) => s.route).join(", ")}`);
  try {
    screenUrl(consent.origin, screen.path);
  } catch (error: unknown) {
    throw new WorkflowError("forbidden", error instanceof Error ? error.message : String(error));
  }
  const config = digest(JSON.stringify(spec.behaviour)).slice(0, 16);
  const stillAllowed = async () => {
    let now: Pick<ScreensSpec, "base" | "behaviour">;
    try {
      now = readScreensSpec(join(options.root, SCREENS));
    } catch {
      return { why: "screens.json couldn't be read during the run, so probing stopped", fix: "Next: fix screens.json and run the probe again." };
    }
    const still = behaviourConsent(now);
    if (still.ok && still.origin === consent.origin && digest(JSON.stringify(now.behaviour)).slice(0, 16) === config) return null;
    return { why: "probing was switched off, or the app moved, during the run, so probing stopped", fix: still.ok ? "Next: run the probe again." : still.fix };
  };
  const checks = [...new Set(options.checks.map((c) => c.check))];
  const probe = await probeRoute({ browser: options.browser, origin: consent.origin, route: options.route, path: screen.path, viewport: spec.viewport, checks, ...(options.bindings ? { bindings: options.bindings } : {}), ...(options.budgets ? { budgets: options.budgets } : {}), stillAllowed });
  // File and line, for display: fetched only from the consented origin (never a base that moved
  // since, never another origin a frame names), no redirects, bounded in size and time.
  const lines = await new LiveApp(options.root, spec.project)
    .resolve(probe.targets.map((t) => ({ name: t.key.component ?? t.found.domPath, owner: null, frames: t.found.frames, box: t.found.box, depth: 0 })), { origin: consent.origin })
    .catch(() => probe.targets.map(() => ({ file: null, line: null })));
  const runId = randomBytes(8).toString("hex");
  const at = (options.now ?? (() => new Date()))().toISOString();
  const results: BehaviourResult[] = [];
  for (const [i, t] of probe.targets.entries()) {
    const place = lines[i];
    const target: BehaviourTarget = {
      route: options.route,
      pattern: t.key.pattern,
      component: t.key.component,
      accessibleName: t.key.accessibleName,
      ...(t.key.ordinal !== undefined ? { ordinal: t.key.ordinal } : {}),
      ...(place?.file && place.line ? { file: place.file, line: place.line } : {}),
      domPath: t.found.domPath || "body",
      box: { x: t.found.box.x, y: t.found.box.y, width: Math.max(0, t.found.box.width), height: Math.max(0, t.found.box.height) },
    };
    for (const request of options.checks) {
      const scenario = t.scenarios.find((s) => s.check === request.check)!;
      const words = scenario.state === "opened" ? notRunYet(request.check, scenario.popup.how) : { why: scenario.why, fix: scenario.fix };
      results.push({
        runId,
        at,
        viewport: spec.viewport,
        route: options.route,
        rule: request.rule,
        target,
        pattern: t.key.pattern,
        check: request.check,
        // The only states this probe ever stores: never passed, never failed.
        state: scenario.state === "opened" ? "incomplete" : scenario.state,
        why: words.why,
        fix: words.fix,
        info: [...scenario.info],
        evidence: [],
        freshness: { rule: request.digest, tool: options.fingerprint.tool, origin: consent.origin, config, app: options.fingerprint.app },
      });
    }
  }
  // This probe decides nothing: a passed or failed result here would be a bug, never stored.
  if (results.some((r) => r.state === "passed" || r.state === "failed")) throw new WorkflowError("internal", "the probe made a result it can't make yet; nothing was stored");
  const run = BehaviourRouteRun.parse({ schema: BEHAVIOUR_ROUTE_SCHEMA, route: options.route, runId, at, origin: consent.origin, viewport: spec.viewport, state: probe.state, why: probe.why, fix: probe.fix, coverage: probe.coverage, results });
  const file = await youiPath(options.root, behaviourFile(options.route), "write");
  await writeFileAtomic(file, `${JSON.stringify(run, null, 2)}\n`);
  return { run, file, probe };
}
