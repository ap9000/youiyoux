/**
 * `youiyoux behave [--route /x]`: probe the consented app's routes for the System's behaviour rules
 * and keep each route's run under `.youi/behaviour/` (docs/plans/behaviour-rules.md, "CLI, MCP,
 * agents"). Consent, the guards and storage are the service's own (workflow's probeBehaviour): this
 * only chooses the routes and rules, computes what each result is made against (the rule digests,
 * this youiyoux's version and the app's source fingerprint), and prints what came back.
 *
 * Refused, before any browser opens, without consent (the plan's words). Exit: 1 when a rule of
 * error severity failed or anything couldn't be decided (an incomplete or errored result, a route
 * that couldn't be probed), else 0. `youiyoux check` then reads the stored runs.
 */
import { join } from "node:path";
import { pageText, ruleSlug, type BehaviourResult, type BehaviourRouteRun, type RuleSpec } from "@youiyoux/core";
import { appFingerprint, behaviourConsent, behaviourRoutes, POPUP_NOUN, readScreensSpec, type Project, type ScreensSpec } from "@youiyoux/scanner";
import { BehaviourConsent } from "@youiyoux/core";
import { behaviourTool } from "./version.ts";
import { plural, style } from "./ui.ts";

type Browser = Parameters<typeof import("@youiyoux/workflow").probeBehaviour>[0]["browser"];

/** One route: its stored run, or why it couldn't be probed at all. */
export type BehaveRoute = { readonly route: string; readonly run: BehaviourRouteRun; readonly problem: null } | { readonly route: string; readonly run: null; readonly problem: string };

export interface BehaveResult {
  /** The behaviour rules that are on (none: nothing to probe). */
  readonly rules: readonly RuleSpec[];
  readonly routes: readonly BehaveRoute[];
  /** Failed results of error-severity rules. */
  readonly errors: number;
  readonly warnings: number;
  /** Something couldn't be decided: a route not probed, a result incomplete or errored. */
  readonly incomplete: boolean;
}

/** The System's behaviour rules that are on. */
export const behaviourRules = (project: Pick<Project, "system">): RuleSpec[] => project.system.rules.filter((r) => r.severity !== "off" && r.check.engine === "behaviour");

const SCREENS = ".youi/screens";

/**
 * Probe and store. `browser` opens a browser for each route, only once consent and routes have
 * been checked; each is closed when its route's run ends (the caller may close the last again).
 */
export async function runBehave(project: Project, options: { readonly route?: string; readonly browser: () => Promise<Browser> }): Promise<BehaveResult> {
  const rules = behaviourRules(project);
  if (rules.length === 0) return { rules, routes: [], errors: 0, warnings: 0, incomplete: false };
  let spec: ScreensSpec;
  try {
    spec = readScreensSpec(join(project.root, SCREENS));
  } catch (error: unknown) {
    if (/ENOENT/.test(error instanceof Error ? error.message : String(error))) throw new Error("no screens are captured yet (.youi/screens/screens.json): youiyoux screens capture --base <url of the app in development> lists them and records where the app runs; then switch probing on and run youiyoux behave");
    throw error;
  }
  // Refused with the plan's words before anything opens; probeBehaviour checks again per route.
  const consent = behaviourConsent(spec);
  if (!consent.ok) throw new Error(`${consent.why} ${consent.fix}`);
  const { routes: held, unknown } = behaviourRoutes(spec);
  const listed = spec.screens.map((s) => s.route);
  if (options.route !== undefined && !listed.includes(options.route)) throw new Error(`screens.json has no route ${options.route}: it lists ${listed.join(", ")}`);
  const wanted = options.route !== undefined ? [options.route] : held;
  // No routes is nothing checked, never "0 checks passed".
  if (wanted.length === 0) throw new Error("screens.json lists no screens, so there is nothing to probe: add the app's screens to .youi/screens/screens.json as \"screens\": [{ \"route\": \"/\", \"path\": \"/\" }] (youiyoux screens capture --base <url> then records them), then run youiyoux behave");
  const declared = BehaviourConsent.safeParse(spec.behaviour ?? {});
  const app = await appFingerprint(project, { inputs: declared.success ? (declared.data.inputs ?? []) : [] });
  // Results that could never be shown fresh aren't worth a probe: refused, with why, before anything opens.
  if (app.incomplete) throw new Error(`behaviour results couldn't be kept fresh, so nothing was probed: ${app.incomplete}`);
  // Every route through the service's own path (runBehaviour): the same checks, the route's run
  // claim across processes, and a run started earlier never replacing one started later.
  const { runBehaviour } = await import("@youiyoux/workflow");
  const setup = { tool: behaviourTool(), browser: options.browser };
  const routes: BehaveRoute[] = [];
  for (const route of wanted) {
    if (unknown.includes(route)) {
      routes.push({ route, run: null, problem: "screens.json's behaviour.routes names it, but it isn't one of the screens listed; nothing was probed" });
      continue;
    }
    try {
      const { run } = await (await runBehaviour(project, setup, { route, by: "person" })).done;
      routes.push({ route, run, problem: null });
    } catch (error: unknown) {
      routes.push({ route, run: null, problem: (error instanceof Error ? error.message : String(error)).split("\n")[0]! });
    }
  }
  const severity = new Map(rules.map((r) => [r.id, r.severity]));
  const results = routes.flatMap((r) => r.run?.results ?? []);
  const failed = results.filter((r) => r.state === "failed");
  const errors = failed.filter((r) => severity.get(r.rule) === "error").length;
  return {
    rules,
    routes,
    errors,
    warnings: failed.length - errors,
    incomplete: routes.some((r) => r.run === null || r.run.state === "incomplete") || results.some((r) => r.state === "incomplete" || r.state === "error"),
  };
}

export const behaveExitCode = (result: BehaveResult): number => (result.errors > 0 || result.incomplete ? 1 : 0);

const MARK: Record<BehaviourResult["state"], string> = { passed: "✓ passed", failed: "✖ failed", "not-applicable": "- n/a", incomplete: "! incomplete", error: "! error" };

/** Which popup: its pattern's noun, its name, and file:line when locating found it. */
const popupOf = (r: BehaviourResult): string => `${POPUP_NOUN[r.pattern]} ${pageText(r.target.accessibleName)}${r.target.ordinal !== undefined ? ` #${r.target.ordinal + 1}` : ""}${r.target.file && r.target.line ? ` (${r.target.file}:${r.target.line})` : ""}`;

function mark(r: BehaviourResult, severity: string | undefined): string {
  const text = MARK[r.state];
  if (r.state === "passed") return style.ok(text);
  if (r.state === "failed") return severity === "error" ? style.error(text) : style.warn(`${text} (warning)`);
  if (r.state === "not-applicable") return style.dim(text);
  return style.warn(text);
}

/** `youiyoux behave` in a terminal: each route's coverage, each result with why and what to do, then the verdict. */
export function behaveText(result: BehaveResult): string {
  if (result.rules.length === 0) return style.dim("No behaviour rules are on in this System, so there is nothing to probe. Add a rule with check: { engine: behaviour, id: dismiss-escape } to probe popups.");
  const severity = new Map(result.rules.map((r) => [r.id, r.severity]));
  const lines: string[] = [];
  for (const r of result.routes) {
    lines.push(style.bold(r.route));
    if (r.run === null) {
      lines.push(`  ${style.warn("! not probed")}  ${r.problem}`);
      continue;
    }
    lines.push(style.dim(`  ${r.run.coverage}`));
    if (r.run.why) lines.push(`  ${style.warn("! incomplete")}  ${r.run.why}`, `      ${style.ok("→")} ${r.run.fix}`);
    for (const x of r.run.results) {
      if (x.state === "not-applicable") continue;
      lines.push(`  ${mark(x, severity.get(x.rule))}  ${popupOf(x)}  ${style.dim(`${x.check} (${ruleSlug(x.rule)})`)}  ${x.why}`);
      if (x.state !== "passed") lines.push(`      ${style.ok("→")} ${x.fix}`);
      for (const info of x.info) lines.push(style.dim(`      ${info}`));
    }
  }
  const results = result.routes.flatMap((r) => r.run?.results ?? []);
  const passed = results.filter((r) => r.state === "passed").length;
  lines.push("");
  if (result.errors > 0) lines.push(style.error(`✖ ${plural(result.errors, "error")} · ${plural(result.warnings, "warning")}: fix each (→), then run youiyoux behave again`));
  else if (result.incomplete) lines.push(style.warn(`! Incomplete: ${plural(passed, "check")} passed, ${plural(result.warnings, "warning")}; some couldn't be decided (above), so this is not a pass`));
  else lines.push(result.warnings > 0 ? style.warn(`✓ 0 errors · ${plural(result.warnings, "warning")}`) : style.ok(`✓ ${plural(passed, "check")} passed on ${plural(result.routes.length, "route")}`));
  lines.push(style.dim("runs kept in .youi/behaviour/; youiyoux check reads them while the code, rules and screens stay as they are"));
  return lines.join("\n");
}

const escapeData = (text: string): string => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text: string): string => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
const command = (kind: "error" | "warning", message: string, props: Record<string, string | number>): string =>
  `::${kind} ${Object.entries(props).map(([k, v]) => `${k}=${escapeProperty(String(v))}`).join(",")}::${escapeData(message)}`;

/** GitHub annotations: a failure on its trigger's line when known; what couldn't be decided, on the run. */
export function behaveAnnotations(result: BehaveResult, prefix: string): string[] {
  const severity = new Map(result.rules.map((r) => [r.id, r.severity]));
  const lines: string[] = [];
  for (const r of result.routes) {
    if (r.run === null) {
      lines.push(command("error", `${r.route} wasn't probed: ${r.problem}`, { title: "youi incomplete" }));
      continue;
    }
    if (r.run.why) lines.push(command("error", `${r.route} couldn't be probed: ${r.run.why}`, { title: "youi incomplete" }));
    for (const x of r.run.results) {
      const where: Record<string, string | number> = x.target.file && x.target.line ? { file: `${prefix}${x.target.file}`, line: x.target.line } : {};
      if (x.state === "failed") lines.push(command(severity.get(x.rule) === "error" ? "error" : "warning", `${r.route} ${popupOf(x)} ${x.check}: ${x.why} → ${x.fix}`, { ...where, title: `youi ${ruleSlug(x.rule)}` }));
      if (x.state === "incomplete" || x.state === "error") lines.push(command("error", `${r.route} ${popupOf(x)} ${x.check} couldn't be decided: ${x.why}`, { ...where, title: "youi incomplete" }));
    }
  }
  return lines;
}

/** Markdown for $GITHUB_STEP_SUMMARY: the verdict and each route's counts. */
export function behaveSummary(result: BehaveResult): string {
  const verdict = result.errors > 0 ? `❌ ${plural(result.errors, "error")}` : result.incomplete ? "⚠️ incomplete" : "✅ passed";
  const rows = result.routes.map((r) => {
    if (r.run === null) return `| ${r.route} | not probed | | | |`;
    const count = (state: string) => r.run!.results.filter((x) => x.state === state).length;
    return `| ${r.route} | ${count("passed")} | ${count("failed")} | ${count("incomplete") + count("error")} | ${r.run.why ? "incomplete" : r.run.coverage.split(";")[0]} |`;
  });
  return [`### youiyoux behave: ${verdict}`, "", "| Route | Passed | Failed | Undecided | |", "|---|---|---|---|---|", ...rows, ""].join("\n");
}
