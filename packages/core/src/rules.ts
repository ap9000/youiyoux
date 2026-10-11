/**
 * Whether a rule is checked: the one answer the CLI, the MCP server, the generated
 * agent guidance and the hub all give. Browser-safe (type imports only), so the hub
 * imports it as `@youiyoux/core/rules`.
 *
 * `off` is off everywhere: not checked, not shown to agents, not emitted as ast-grep.
 * A rule is only ever `enforced` when `youi check` actually runs it; a check this
 * youi cannot run is `unsupported`, never reported as enforced or as clean.
 */
import type { RuleSpec } from "./schemas.ts";

export type BuiltInCheckId = Extract<RuleSpec["check"], { engine: "youi" }>["id"];
export type AstGrepLanguage = Extract<RuleSpec["check"], { engine: "ast-grep" }>["language"];

export type RuleExecution =
  /** `youi check` runs it on every file its globs match and fails on its errors. */
  | { readonly state: "enforced"; readonly by: string }
  /** Prose for people and agents; nothing checks it. */
  | { readonly state: "advisory" }
  /** severity: off. Not checked and not shown to agents. */
  | { readonly state: "off" }
  /** It declares a check this youi cannot run (e.g. a malformed ast-grep rule). */
  | { readonly state: "unsupported"; readonly reason: string };

/** The built-in checks, with what each one finds. */
export const BUILT_IN_CHECKS: Readonly<Record<BuiltInCheckId, string>> = {
  "raw-color": "Hex, rgb() and hsl() colours in code and stylesheets outside the token sources.",
  "native-element": "Native elements (options.elements: tag → component id) rendered where a component exists; options.allowInputTypes exempts <input> types.",
  "lookalike-component": "Same-named components that resolve somewhere other than the owned implementation.",
  "arbitrary-value": "Tailwind arbitrary values (rounded-[10px], text-[13px], bg-[var(--x)]) that copy a token.",
  "prop-values": "Enum props given a literal value the component contract does not list.",
};

/** Languages an `ast-grep` rule may target, and the files each runs on (as plain ast-grep does). */
export const AST_GREP_LANGUAGES: Readonly<Record<AstGrepLanguage, string>> = {
  tsx: ".tsx and .jsx files",
  typescript: ".ts, .mts, .cts and .js files",
  css: ".css files",
};

/**
 * How a rule is executed. `problem` is why its check cannot run, when the caller can tell
 * (the scanner compiles ast-grep rules; the browser cannot, so it passes nothing).
 */
export function ruleExecution(rule: Pick<RuleSpec, "severity" | "check">, problem?: string | null): RuleExecution {
  if (rule.severity === "off") return { state: "off" };
  if (rule.check.engine === "advisory") return { state: "advisory" };
  if (problem) return { state: "unsupported", reason: problem };
  return { state: "enforced", by: rule.check.engine === "youi" ? `youi:${rule.check.id}` : `ast-grep:${rule.check.language}` };
}

/** One line for people: what checks this rule, or why nothing does. */
export function executionLabel(execution: RuleExecution): string {
  switch (execution.state) {
    case "enforced":
      return execution.by.startsWith("youi:") ? `Checked by youi check (${execution.by.slice(5)})` : `Checked by youi check (ast-grep, ${execution.by.slice(9)})`;
    case "advisory":
      return "Advisory: shown to people and agents, not checked";
    case "off":
      return "Off: not checked and not shown to agents";
    case "unsupported":
      return `Not checked: ${execution.reason}`;
  }
}
