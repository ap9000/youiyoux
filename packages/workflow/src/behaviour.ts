/**
 * Behaviour probes, the service's side (docs/plans/behaviour-rules.md): consent read from the
 * product's `.youi/screens/screens.json` at the moment of probing, the guarded probe (scanner's
 * probeRoute) on one route, its triggers' frames mapped to file and line by the live resolver
 * (display only), and the run kept as `.youi/behaviour/<route-hash>.json`.
 *
 * Writes are files, never folders: the route's run file, evidence under the real `.youi/` (each
 * path resolved, links refused), and screens.json's `behaviour` block only through
 * `setBehaviourConsent` (the service's authenticated write). Only a check this youiyoux decides
 * (DECIDED_BEHAVIOUR_CHECKS) is ever stored passed or failed; for any other check the popup opening
 * and being identified is stored `incomplete`. A scenario that sent a key its check doesn't send
 * (CHECK_KEYS) is a bug: nothing is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { acquireFileLock, BEHAVIOUR_ROUTE_SCHEMA, BehaviourRouteRun, cleanText, FileLockBusy, type HeldLock, decidesBehaviour, EVIDENCE_PATH, type BehaviourCheckId, type BehaviourResult, type BehaviourTarget, type Freshness } from "@youiyoux/core";
import { behaviourConfigDigest, behaviourConsent, bindingsDigest, CHECK_KEYS, probeOrigin, probeRoute, readScreensSpec, screenUrl, switchedConsent, SWITCHED_OFF, updateScreensSpec, type ContractBinding, type ProbeBudgets, type ProbeRouteOptions, type RouteProbe, type ScreensSpec, WrapperIndex, type WrapperSources } from "@youiyoux/scanner";
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
  /** Test only these targets (one component's); the rest are listed, not tested (probeRoute's `only`). */
  readonly only?: ProbeRouteOptions["only"];
  /**
   * The product's own components folder (youi.project.json's componentsDir): a button's file:line is
   * where the app renders it, the first frame outside this folder, not the component's own line.
   */
  readonly componentsDir?: string;
  /**
   * The product's sources (youi.project.json's include, exclude and tsconfig): when a button's line
   * is inside a component the code uses in more than one place, file:line is where this one is used
   * and that line is kept as `renderedBy` (scanner's WrapperIndex). Without it, the line as found.
   */
  readonly sources?: Omit<WrapperSources, "root">;
  /** Told how many popups this run tests, once they are found. */
  readonly onFound?: (count: number) => void;
  readonly now?: () => Date;
  /** The route's claim the caller holds (runBehaviour); without it, probeBehaviour takes one itself. */
  readonly claim?: RouteClaim;
  /** Tests only: the probe to run instead of probeRoute (to show the storage guards are active). */
  readonly probe?: typeof probeRoute;
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

/** Tests only: what happens between the path's check and its use (a race, staged). */
export interface YouiFileHooks {
  /** After the path is checked, before the file (or, writing, its temp file) is opened. */
  readonly beforeOpen?: (path: string) => Promise<void>;
  /** Writing: after the temp file is renamed into place, before the result is checked. */
  readonly afterRename?: (file: string) => Promise<void>;
}

/**
 * A file under the real `.youi/` read safely: the path checked (youiPath), then opened without
 * following a link (O_NOFOLLOW), and the handle's file must be the very file that was checked
 * (same device and inode), else refused.
 *
 * Residual, accepted: a process on the same account that swaps a parent folder between the check
 * and the open is out of scope; it could already change the files themselves.
 */
export async function readYouiFile(root: string, path: string, hooks: YouiFileHooks = {}): Promise<Buffer> {
  const file = await youiPath(root, path, "read");
  const checked = await lstat(file);
  await hooks.beforeOpen?.(file);
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new WorkflowError("forbidden", `${path} is a link: youiyoux reads only files inside the project's own .youi/`);
    if (code === "ENOENT") throw new WorkflowError("not-found", `${path} doesn't exist`);
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) throw new WorkflowError("forbidden", `${path} changed between its check and its reading; nothing was read`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * A file under the real `.youi/` written safely: the path checked (youiPath), the bytes written to
 * a new temp file in that checked folder (created exclusively, never through a link), renamed into
 * place, and the result checked again: still a file, really inside the real `.youi/`. If not, what
 * was written is removed where possible and the write refused. Same residual as readYouiFile.
 */
export async function writeYouiFile(root: string, path: string, bytes: Buffer | string, hooks: YouiFileHooks = {}): Promise<string> {
  // A route's run file is published only by a run holding the route's claim (probeBehaviour).
  if (RUN_FILE.test(path)) throw new WorkflowError("forbidden", `${path} is a behaviour run: it is written only by a run holding its route's claim (youiyoux behave, the hub or ui_behave)`);
  return writeChecked(root, path, bytes, hooks);
}

/** A route's run file (behaviourFile). */
const RUN_FILE = /^\.youi\/behaviour\/[0-9a-f]{16}\.json$/;

async function writeChecked(root: string, path: string, bytes: Buffer | string, hooks: YouiFileHooks = {}): Promise<string> {
  const file = await youiPath(root, path, "write");
  const realYoui = await realpath(join(await realpath(root), ".youi"));
  const temp = join(dirname(file), `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await hooks.beforeOpen?.(temp);
  let handle: FileHandle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o644);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") throw new WorkflowError("forbidden", `${path} couldn't be written safely (something was put in its place); nothing was written`);
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  await hooks.afterRename?.(file);
  const written = await lstat(file).catch(() => null);
  const real = await realpath(file).catch(() => null);
  const r = real ? relative(realYoui, real) : "..";
  if (!written?.isFile() || r === "" || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) {
    if (written && !written.isDirectory()) await unlink(file).catch(() => undefined);
    throw new WorkflowError("forbidden", `${path} didn't end up inside the project's own .youi/; what was written was removed`);
  }
  return file;
}

/** Evidence (a screenshot) written under the real `.youi/`; the path is refused if it leads anywhere else. */
export async function writeEvidence(root: string, path: string, bytes: Buffer): Promise<void> {
  await writeYouiFile(root, path, bytes);
}

export async function readEvidence(root: string, path: string): Promise<Buffer> {
  return readYouiFile(root, path);
}

/**
 * Every string of a run that is shown to people or agents, made safe (cleanText: no control,
 * format or default-ignorable character, whitespace collapsed, capped): the run's why, fix and
 * coverage and notes, each result's why, fix and info, and every target's name, component, file and DOM path.
 * Applied when a run is written and again whenever one is read, so a run kept by an older youiyoux
 * (or edited by hand) never reaches standing, behave or check with raw page text. Idempotent.
 */
export function cleanBehaviourRun(run: BehaviourRouteRun): BehaviourRouteRun {
  const words = (text: string, fallback: string): string => cleanText(text, 1000) || fallback;
  const identity = <T extends { accessibleName: string; component: string | null }>(t: T): T => ({ ...t, accessibleName: cleanText(t.accessibleName, 200), component: t.component === null ? null : cleanText(t.component, 200) || null });
  return {
    ...run,
    why: run.why === null ? null : words(run.why, "it couldn't be probed"),
    fix: run.fix === null ? null : words(run.fix, "Next: run youiyoux behave again."),
    coverage: words(run.coverage, "Coverage wasn't recorded."),
    notes: run.notes.map((line) => cleanText(line, 1000)).filter(Boolean),
    targets: run.targets.map(identity),
    results: run.results.map((r) => ({
      ...r,
      why: words(r.why, "no reason was given"),
      fix: words(r.fix, "Next: run youiyoux behave again."),
      info: r.info.map((line) => cleanText(line, 1000)).filter(Boolean),
      target: { ...identity(r.target), ...(r.target.file !== undefined ? { file: cleanText(r.target.file, 500) || "unknown" } : {}), ...(r.target.renderedBy !== undefined ? { renderedBy: { file: cleanText(r.target.renderedBy.file, 500) || "unknown", line: r.target.renderedBy.line } } : {}), ...(r.target.domPath !== undefined ? { domPath: cleanText(r.target.domPath, 300) || "body" } : {}) },
    })),
  };
}

/** A route's last run, if there is one, its display strings made safe (cleanBehaviourRun); its evidence paths are each proved to stay in the real `.youi/`. */
export async function readBehaviourRun(root: string, route: string): Promise<BehaviourRouteRun | null> {
  let text: string;
  try {
    text = (await readYouiFile(root, behaviourFile(route))).toString("utf8");
  } catch (error: unknown) {
    if (error instanceof WorkflowError && error.code === "not-found") return null;
    throw error;
  }
  const parsed = BehaviourRouteRun.safeParse(JSON.parse(text));
  if (!parsed.success || parsed.data.route !== route) throw new WorkflowError("invalid", `${behaviourFile(route)} isn't a behaviour run for ${route}: run the probe again`);
  for (const result of parsed.data.results) for (const path of result.evidence) await youiPath(root, path, "read");
  // Made safe on every read, whatever wrote it and however fresh it is.
  return cleanBehaviourRun(parsed.data);
}

function readSpec(root: string): ScreensSpec {
  try {
    return readScreensSpec(join(root, SCREENS));
  } catch (error: unknown) {
    throw new WorkflowError("invalid", error instanceof Error ? error.message : String(error));
  }
}

/** Probes running in this process, by the real root of the product they probe: switching consent cancels them. */
const running = new Map<string, Set<AbortController>>();

/**
 * Switch behaviour probes on (consent bound to the origin of screens.json's current `base`, never
 * one a caller names) or off. The service's authenticated write: under screens.json's lock, on the
 * file as it is now, only the `behaviour` block changed (one generation on), replaced atomically.
 * Any probe of this product running in this process stops at once; one in another process stops
 * before its next click, when it reads the new generation.
 */
export async function setBehaviourConsent(root: string, allow: boolean): Promise<{ readonly allowedOrigin: string | null }> {
  await youiPath(root, `${SCREENS}/screens.json`, "read").catch((error: unknown) => {
    if (error instanceof WorkflowError && error.code === "not-found") throw new WorkflowError("conflict", "no screens are captured yet: youiyoux screens capture --base <url> takes them and records where the app runs");
    throw error;
  });
  let allowedOrigin: string | null = null;
  try {
    await updateScreensSpec(join(await realpath(root), SCREENS), (now) => {
      if (!allow) return { ...now, behaviour: switchedConsent(now.behaviour, null) };
      const at = probeOrigin(now.base);
      if (!at.ok) throw new WorkflowError("conflict", `${at.why}. ${at.fix}`);
      allowedOrigin = at.origin;
      return { ...now, behaviour: switchedConsent(now.behaviour, at.origin) };
    });
  } catch (error: unknown) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("invalid", error instanceof Error ? error.message : String(error));
  }
  for (const probe of running.get(await realpath(root)) ?? []) probe.abort();
  return { allowedOrigin };
}

/** Words for a result whose popup opened and was identified, before any check decides anything. */
const notRunYet = (check: BehaviourCheckId, how: string): { why: string; fix: string } => ({
  why: `the popup opened and was identified (by ${how}), but this youiyoux doesn't decide ${check} yet`,
  fix: "Next: update youiyoux; nothing was decided, so this isn't a pass.",
});

/**
 * A route's run claim, across processes: `.youi/behaviour/<route-hash>.json.lock` (core's
 * acquireFileLock: link-created owner token, a live holder never broken, a dead one only by one
 * contender, an unreadable one refused). Taken without waiting. A run is published only while its
 * claim is held, and `startedAt` is when it was taken: before the app is hashed or a browser opens,
 * so a request filed or reopened after it is newer than the run.
 */
export interface RouteClaim {
  /** The product's real root. */
  readonly root: string;
  readonly route: string;
  readonly startedAt: string;
  holds(): Promise<boolean>;
  release(): Promise<void>;
}

/** The claims claimRoute gave out: only these may publish (an object shaped like one is not one). */
const issued = new WeakSet<RouteClaim>();

export async function claimRoute(root: string, route: string, now: () => Date = () => new Date()): Promise<RouteClaim> {
  const file = await youiPath(root, behaviourFile(route), "write");
  let lock: HeldLock;
  try {
    lock = await acquireFileLock(`${file}.lock`, { waitMs: 0 });
  } catch (error: unknown) {
    if (error instanceof FileLockBusy) throw new WorkflowError("conflict", `a behaviour run is already going for this app (${route}, in another youiyoux: ${error.who}): wait for it to finish, then run again; if no youiyoux is running, delete ${behaviourFile(route)}.lock`);
    throw error;
  }
  const claim: RouteClaim = { root: await realpath(root), route, startedAt: now().toISOString(), holds: lock.holds, release: lock.release };
  issued.add(claim);
  return claim;
}

/** What a run may start from: consent for base's origin now, and the route's screen on it; refused with the plan's words. */
function preflight(root: string, route: string): { spec: ScreensSpec; consent: Extract<ReturnType<typeof behaviourConsent>, { ok: true }>; screen: ScreensSpec["screens"][number] } {
  const spec = readSpec(root);
  const consent = behaviourConsent(spec);
  if (!consent.ok) throw new WorkflowError("forbidden", `${consent.why} ${consent.fix}`);
  const screen = spec.screens.find((s) => s.route === route);
  if (!screen) throw new WorkflowError("not-found", `screens.json has no route ${route}: it lists ${spec.screens.map((s) => s.route).join(", ")}`);
  try {
    screenUrl(consent.origin, screen.path);
  } catch (error: unknown) {
    throw new WorkflowError("forbidden", error instanceof Error ? error.message : String(error));
  }
  return { spec, consent, screen };
}

/**
 * Probe one route of the product's app, with consent checked now against the live `base` (and again
 * before every scenario), and keep the run. Refused, with the plan's words, when there is no consent.
 * The run is published only under the route's claim: `options.claim` (runBehaviour's, taken before
 * it hashed the app or opened a browser), or one taken here, after consent and before probing.
 */
export async function probeBehaviour(options: ProbeBehaviourOptions): Promise<ProbeBehaviourResult> {
  if (options.claim) return probeUnderClaim(options, options.claim);
  preflight(options.root, options.route);
  const claim = await claimRoute(options.root, options.route, options.now);
  try {
    return await probeUnderClaim(options, claim);
  } finally {
    await claim.release();
  }
}

async function probeUnderClaim(options: ProbeBehaviourOptions, claim: RouteClaim): Promise<ProbeBehaviourResult> {
  if (!issued.has(claim) || claim.route !== options.route || claim.root !== (await realpath(options.root))) throw new WorkflowError("internal", "a behaviour run is published only under its own route's claim; nothing was probed");
  const now = options.now ?? (() => new Date());
  // When the claim was taken, never later: a request filed or reopened after it is newer than this run.
  const startedAt = claim.startedAt;
  const { spec, consent, screen } = preflight(options.root, options.route);
  const config = behaviourConfigDigest(spec, options.route);
  // Asked before every scenario and immediately before every click: the same origin and the same
  // generation as when the run began, or the rest stops (switched off, moved, or switched again).
  const stillAllowed = async () => {
    let now: Pick<ScreensSpec, "base" | "behaviour">;
    try {
      now = readScreensSpec(join(options.root, SCREENS));
    } catch {
      return { why: "screens.json couldn't be read during the run, so probing stopped", fix: "Next: fix screens.json and run the probe again." };
    }
    const still = behaviourConsent(now);
    return still.ok && still.origin === consent.origin && still.generation === consent.generation ? null : SWITCHED_OFF;
  };
  const key = await realpath(options.root);
  const controller = new AbortController();
  if (!running.has(key)) running.set(key, new Set());
  running.get(key)!.add(controller);
  const checks = [...new Set(options.checks.map((c) => c.check))];
  let probe: RouteProbe;
  try {
    probe = await (options.probe ?? probeRoute)({ browser: options.browser, origin: consent.origin, route: options.route, path: screen.path, viewport: spec.viewport, checks, ...(options.bindings ? { bindings: options.bindings } : {}), ...(options.budgets ? { budgets: options.budgets } : {}), ...(options.only ? { only: options.only } : {}), ...(options.onFound ? { onFound: options.onFound } : {}), stillAllowed, signal: controller.signal });
  } finally {
    running.get(key)?.delete(controller);
    if (running.get(key)?.size === 0) running.delete(key);
  }
  const folder = options.componentsDir ? posix.normalize(options.componentsDir.replace(/\\/g, "/")).replace(/\/+$/, "") : null;
  const ownComponents = folder && folder !== "." && !folder.startsWith("..") ? (file: string): boolean => file === folder || file.startsWith(`${folder}/`) : null;
  // File and line, for display: fetched only from the consented origin (never a base that moved
  // since, never another origin a frame names), no redirects, bounded in size and time. A line
  // inside a component the code uses in more than one place moves one hop, to where this one is
  // used, read from the source once per run (never from other triggers on the screen).
  const wrappers = options.sources ? new WrapperIndex({ root: options.root, ...options.sources }) : null;
  const lines = await new LiveApp(options.root, spec.project)
    .resolve(probe.targets.map((t) => ({ name: t.key.component ?? t.found.domPath, owner: null, frames: t.found.frames, box: t.found.box, depth: 0 })), { origin: consent.origin, ...(ownComponents ? { skip: ownComponents } : {}), ...(wrappers ? { promote: (first, rest) => wrappers.usage(first, rest) } : {}) })
    .catch(() => probe.targets.map(() => ({ file: null, line: null })));
  const runId = randomBytes(8).toString("hex");
  const at = now().toISOString();
  const results: BehaviourResult[] = [];
  // The bindings this probe actually located targets by.
  const bindings = bindingsDigest(options.bindings ?? []);
  const freshness = (request: BehaviourCheckRequest): Freshness => ({ rule: request.digest, tool: options.fingerprint.tool, origin: consent.origin, config, app: options.fingerprint.app, bindings });
  for (const [i, t] of probe.targets.entries()) {
    const place = lines[i];
    const target: BehaviourTarget = {
      route: options.route,
      pattern: t.key.pattern,
      component: t.key.component,
      accessibleName: t.key.accessibleName,
      ...(t.key.ordinal !== undefined ? { ordinal: t.key.ordinal } : {}),
      ...(place?.file && place.line ? { file: place.file, line: place.line, ...(place.own ? { lineIs: "component" as const } : {}), ...(place.renderedBy && !place.own ? { renderedBy: place.renderedBy } : {}) } : {}),
      domPath: t.found.domPath || "body",
      box: { x: t.found.box.x, y: t.found.box.y, width: Math.max(0, t.found.box.width), height: Math.max(0, t.found.box.height) },
    };
    for (const request of options.checks) {
      const scenario = t.scenarios.find((s) => s.check === request.check)!;
      const words = scenario.state === "opened" ? notRunYet(request.check, scenario.popup.how) : { why: scenario.why, fix: scenario.fix };
      // Decided only for a check this youiyoux decides; anything else that came back decided is a bug, and nothing is stored.
      if ((scenario.state === "passed" || scenario.state === "failed") && !decidesBehaviour(request.check)) throw new WorkflowError("internal", `the probe decided ${request.check}, which this youiyoux doesn't decide; nothing was stored`);
      // Only the check's own keys: a scenario that sent any other is a bug, and nothing is stored.
      const allowed: readonly string[] = CHECK_KEYS[request.check];
      const stray = (scenario.keys ?? []).filter((k) => !allowed.includes(k));
      if (stray.length > 0) throw new WorkflowError("internal", `the probe sent ${stray.join(", ")} for ${request.check}, which sends ${allowed.length ? `only ${allowed.join(", ")}` : "no keys"}; nothing was stored`);
      results.push({
        runId,
        at,
        viewport: spec.viewport,
        route: options.route,
        rule: request.rule,
        target,
        pattern: t.key.pattern,
        check: request.check,
        // Opened and identified, but not decided: never a pass.
        state: scenario.state === "opened" ? "incomplete" : scenario.state,
        // Belt and braces: the words are built from cleaned page text already; none may still carry a control character or a line break.
        why: cleanText(words.why, 1000) || "no reason was given",
        fix: cleanText(words.fix, 1000) || "Next: run youiyoux behave again.",
        info: scenario.info.map((line) => cleanText(line, 1000)).filter(Boolean),
        // Tested with the popup's data requests blocked (after the click): said on every result of the scenario.
        dataBlocked: "dataBlocked" in scenario ? scenario.dataBlocked === true : false,
        evidence: [],
        freshness: freshness(request),
      });
    }
  }
  // Belt and braces: only a decided check is ever stored passed or failed.
  if (results.some((r) => (r.state === "passed" || r.state === "failed") && !decidesBehaviour(r.check))) throw new WorkflowError("internal", "the probe made a result it can't make yet; nothing was stored");
  const rules = [...new Map(options.checks.map((c) => [c.rule, { rule: c.rule, check: c.check, freshness: freshness(c) }])).values()];
  const run = cleanBehaviourRun(BehaviourRouteRun.parse({ schema: BEHAVIOUR_ROUTE_SCHEMA, route: options.route, runId, at, startedAt, origin: consent.origin, viewport: spec.viewport, state: probe.state, why: probe.why === null ? null : cleanText(probe.why, 1000) || "it couldn't be probed", fix: probe.fix === null ? null : cleanText(probe.fix, 1000) || "Next: run youiyoux behave again.", coverage: probe.coverage, notes: (probe.notes ?? []).slice(0, 20), rules, targets: probe.targets.map((t) => ({ route: options.route, pattern: t.key.pattern, component: t.key.component, accessibleName: t.key.accessibleName, ...(t.key.ordinal !== undefined ? { ordinal: t.key.ordinal } : {}) })), results }));
  // A run started later than this one is already kept (another process published first): this
  // one is obsolete, and never replaces newer evidence with older.
  // Published only while the claim is still ours (checked, then written, under it).
  if (!(await claim.holds())) throw new WorkflowError("conflict", `the claim on ${options.route} was lost during the run, so nothing was written; run it again`);
  const stored = await readBehaviourRun(options.root, options.route).catch(() => null);
  if (stored?.startedAt && Date.parse(stored.startedAt) > Date.parse(startedAt)) throw new WorkflowError("conflict", `a newer run of ${options.route} (started ${stored.startedAt}) is already kept, so this one (started ${startedAt}) was discarded; nothing was written`);
  const file = await writeChecked(options.root, behaviourFile(options.route), `${JSON.stringify(run, null, 2)}\n`);
  return { run, file, probe };
}
