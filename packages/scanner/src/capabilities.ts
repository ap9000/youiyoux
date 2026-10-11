/**
 * What youi can check, and what a rule would find: the capability API the rule
 * editor, the CLI and the MCP server share.
 *
 *   ruleCapability(rule)        enforced / advisory / off / unsupported, with ast-grep bodies compiled
 *   checkCapabilities()         every check this youi runs, for an editor's check picker
 *   evaluateRule(p, scan, d)    a draft rule run against an existing scan snapshot, compared with the published rule
 *
 * A draft that does not validate or cannot run never comes back as zero findings.
 */
import { Lang, parse } from "@ast-grep/napi";
import { AST_GREP_LANGUAGES, BUILT_IN_CHECKS, RuleSpec, ruleExecution, type AstGrepLanguage, type RuleExecution, type Violation } from "@youiyoux/core";
import { runChecks, type CheckInput } from "./checks.ts";
import type { ModuleInfo } from "./parse.ts";
import type { Project } from "./project.ts";
import { SCANNER_VERSION, type ScanResult } from "./scan.ts";

/** The module kind each ast-grep language runs on. */
export const AST_GREP_FILE_LANG: Readonly<Record<AstGrepLanguage, ModuleInfo["lang"]>> = { tsx: "tsx", typescript: "ts", css: "css" };
const NAPI_LANG: Readonly<Record<AstGrepLanguage, Lang>> = { tsx: Lang.Tsx, typescript: Lang.TypeScript, css: Lang.Css };
const PROBE_SOURCE: Readonly<Record<AstGrepLanguage, string>> = { tsx: "<a />", typescript: "a;", css: "a {}" };

const compiled = new Map<string, string | null>();

/** Why an ast-grep rule body cannot run (it does not compile for its language), or null. */
export function astGrepProblem(language: AstGrepLanguage, rule: Record<string, unknown>): string | null {
  const cacheKey = `${language}\u0000${JSON.stringify(rule)}`;
  if (!compiled.has(cacheKey)) {
    try {
      parse(NAPI_LANG[language], PROBE_SOURCE[language]).root().findAll({ rule });
      compiled.set(cacheKey, null);
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s*\|->\s*/g, ": ").replace(/\s+/g, " ").trim();
      compiled.set(cacheKey, `ast-grep rule does not compile for ${language}: ${message}`);
    }
  }
  return compiled.get(cacheKey)!;
}

/** How this rule executes in this youi: the declared model, with ast-grep bodies compiled. */
export function ruleCapability(rule: Pick<RuleSpec, "severity" | "check">): RuleExecution {
  const problem = rule.severity !== "off" && rule.check.engine === "ast-grep" ? astGrepProblem(rule.check.language, rule.check.rule) : null;
  return ruleExecution(rule, problem);
}

export interface CheckCapabilities {
  readonly scanner: string;
  readonly builtIn: ReadonlyArray<{ readonly id: string; readonly finds: string }>;
  readonly astGrep: ReadonlyArray<{ readonly language: string; readonly runsOn: string }>;
  readonly notes: readonly string[];
}

export function checkCapabilities(): CheckCapabilities {
  return {
    scanner: SCANNER_VERSION,
    builtIn: Object.entries(BUILT_IN_CHECKS).map(([id, finds]) => ({ id, finds })),
    astGrep: Object.entries(AST_GREP_LANGUAGES).map(([language, runsOn]) => ({ language, runsOn })),
    notes: [
      "`check.engine: advisory` rules are prose: shown to people and agents, never checked.",
      "`severity: off` rules are not checked and not shown to agents.",
      "An ast-grep body that does not compile is unsupported: never enforced, and a scan that meets it is partial.",
      "Rules apply to the files their `files` globs match; generated token outputs are never checked.",
    ],
  };
}

export function checkInputFor(project: Project, scan: Pick<ScanResult, "modules" | "analyses" | "elements" | "tokens">, rules: readonly RuleSpec[]): CheckInput {
  return {
    modules: scan.modules,
    analyses: scan.analyses,
    elements: scan.elements,
    tokens: scan.tokens,
    rules,
    componentsDir: project.config.componentsDir,
    tokenSources: project.config.tokenSources,
    generatedDir: project.config.outputs.dir,
  };
}

const MAX_LISTED = 50;

type Finding = Omit<Violation, "rule" | "severity">;

export interface PublishedComparison {
  /** How the published rule with this id ran in the snapshot. */
  readonly execution: RuleExecution["state"];
  /** Its findings in the snapshot; null when it did not run, so there is nothing to compare. */
  readonly findings: number | null;
  readonly added: number | null;
  readonly removed: number | null;
}

export type RuleEvaluation =
  /** The draft is not a valid youi.rule/v1. */
  | { readonly ok: false; readonly errors: readonly string[] }
  | {
      readonly ok: true;
      readonly rule: string;
      /** What publishing this draft would mean. */
      readonly execution: RuleExecution;
      /**
       * What the check finds on the snapshot (an `off` rule is run as if on, to preview turning it on).
       * null when nothing can run: advisory, or unsupported (see `execution.reason`). Never 0 for "could not tell".
       */
      readonly findings: null | {
        readonly total: number;
        readonly files: number;
        readonly suppressed: number;
        readonly sites: readonly Finding[];
        /** The published rule with the same id, in the same snapshot; null for a new rule. */
        readonly versusPublished: PublishedComparison | null;
      };
      /** The snapshot evaluated: the same files and content as the baseline scan. */
      readonly snapshot: { readonly status: string; readonly files: number; readonly failed: number; readonly configDigest: string; readonly content: string | null; readonly commit: string | null };
    };

const siteKey = (f: Finding): string => `${f.file}:${f.line}:${f.column}:${f.text}`;

function compareWithPublished(project: Project, scan: ScanResult, id: string, sites: readonly Finding[]): PublishedComparison | null {
  const published = project.system.rules.find((r) => r.id === id);
  if (!published) return null;
  const run = scan.report.checks.find((c) => c.rule === id);
  const execution = ruleCapability(published).state;
  if (run?.state !== "ran") return { execution, findings: null, added: null, removed: null };
  const before = new Set(scan.report.violations.filter((v) => v.rule === id).map(siteKey));
  const after = new Set(sites.map(siteKey));
  return { execution, findings: before.size, added: [...after].filter((k) => !before.has(k)).length, removed: [...before].filter((k) => !after.has(k)).length };
}

/**
 * Run a draft rule (any JSON/YAML-parsed object) against an existing scan snapshot, without
 * rescanning, so its findings compare one-to-one with the published rule's.
 */
export function evaluateRule(project: Project, scan: ScanResult, draft: unknown): RuleEvaluation {
  const parsed = RuleSpec.safeParse(draft);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(rule)"}: ${i.message}`) };
  const rule = parsed.data;
  const snapshot = {
    status: scan.report.status,
    files: scan.report.coverage.filesScanned,
    failed: scan.report.coverage.failed.length,
    configDigest: scan.report.configDigest,
    content: scan.report.content?.digest ?? null,
    commit: scan.report.commit,
  };
  // Preview an `off` rule as if it were on; report what publishing it as written means.
  const asOn: RuleSpec = { ...rule, severity: rule.severity === "off" ? "warn" : rule.severity };
  const runnable = ruleCapability(asOn);
  if (runnable.state !== "enforced") return { ok: true, rule: rule.id, execution: runnable, findings: null, snapshot };

  const result = runChecks(checkInputFor(project, scan, [asOn]));
  const run = result.checks[0];
  if (run?.state !== "ran") return { ok: true, rule: rule.id, execution: { state: "unsupported", reason: run?.reason ?? "the check did not run" }, findings: null, snapshot };
  const sites = result.violations.map(({ rule: _rule, severity: _severity, ...finding }) => finding).sort((a, b) => siteKey(a).localeCompare(siteKey(b)));
  return {
    ok: true,
    rule: rule.id,
    execution: ruleCapability(rule),
    findings: {
      total: sites.length,
      files: new Set(sites.map((s) => s.file)).size,
      suppressed: result.suppressed,
      sites: sites.slice(0, MAX_LISTED),
      versusPublished: compareWithPublished(project, scan, rule.id, sites),
    },
    snapshot,
  };
}
