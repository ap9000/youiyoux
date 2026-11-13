/**
 * Whether a rule is checked: the one answer the CLI, the MCP server, the generated
 * agent guidance and the hub all give. Browser-safe (type imports only), so the hub
 * imports it as `@youiyoux/core/rules`.
 *
 * `off` is off everywhere: not checked, not shown to agents, not emitted as ast-grep.
 * A rule is only ever `enforced` when `youiyoux check` actually runs it; a check this
 * youi cannot run is `unsupported`, never reported as enforced or as clean. A behaviour rule is
 * `probe`: checked in the running app, never by the code scan, and never clean without a probe run.
 */
import type { BehaviourPattern } from "./behaviour.ts";
import type { RuleRun, RuleSpec } from "./schemas.ts";

export type BuiltInCheckId = Extract<RuleSpec["check"], { engine: "youi" }>["id"];
export type BehaviourCheck = Extract<RuleSpec["check"], { engine: "behaviour" }>["id"];
export type AstGrepLanguage = Extract<RuleSpec["check"], { engine: "ast-grep" }>["language"];

export type RuleExecution =
  /** `youiyoux check` runs it on every file its globs match and fails on its errors. */
  | { readonly state: "enforced"; readonly by: string }
  /** Prose for people and agents; nothing checks it. */
  | { readonly state: "advisory" }
  /** severity: off. Not checked and not shown to agents. */
  | { readonly state: "off" }
  /** It declares a check this youi cannot run (e.g. a malformed ast-grep rule). */
  | { readonly state: "unsupported"; readonly reason: string }
  /**
   * A behaviour rule: a probe run in the running app checks it, never the code scan. `youiyoux check`
   * reads its stored results and is incomplete without fresh ones; it never counts as clean by itself.
   */
  | { readonly state: "probe"; readonly by: string };

/** The built-in checks, with what each one finds. */
export const BUILT_IN_CHECKS: Readonly<Record<BuiltInCheckId, string>> = {
  "raw-color": "Hex, rgb() and hsl() colours in code and stylesheets outside the token sources.",
  "native-element": "Native elements (options.elements: tag → component id) rendered where a component exists; options.allowInputTypes exempts <input> types.",
  "lookalike-component": "Same-named components that resolve somewhere other than the owned implementation.",
  "arbitrary-value": "Tailwind arbitrary values (rounded-[10px], text-[13px], bg-[var(--x)]) that copy a token.",
  "prop-values": "Enum props given a literal value the component contract does not list.",
};

/**
 * The behaviour checks: what each verifies, after which WAI-ARIA Authoring Practices (APG) pattern,
 * and the patterns it applies to. On any other pattern a check is `not-applicable`, never passed.
 */
export const BEHAVIOUR_CHECKS: Readonly<Record<BehaviourCheck, { readonly description: string; readonly patterns: readonly BehaviourPattern[] }>> = {
  "trigger-state": {
    description: "The button that opens the popup says so: aria-expanded goes false → true, aria-haspopup has the pattern's value and aria-controls points at the popup (APG Menu Button, Combobox; native popovertarget counts).",
    patterns: ["menu-button", "combobox-listbox", "popover"],
  },
  "dismiss-escape": {
    description: "Esc closes the popup (APG Menu Button, Combobox, Dialog (Modal); Popover).",
    patterns: ["menu-button", "combobox-listbox", "modal-dialog", "popover"],
  },
  "focus-into": {
    description: "Opening moves focus into the popup: a menu item for a menu, anything inside the dialog for a modal dialog (APG Menu Button, Dialog (Modal)). A combobox keeps focus by design.",
    patterns: ["menu-button", "modal-dialog"],
  },
  "focus-return": {
    description: "When Esc closes it, focus goes back to the button that opened it, or where the component contract says (APG Menu Button, Dialog (Modal); Popover).",
    patterns: ["menu-button", "modal-dialog", "popover"],
  },
  "focus-trap": {
    description: "Tab and Shift+Tab stay inside an open modal dialog, visiting each focusable element in order and wrapping (APG Dialog (Modal)).",
    patterns: ["modal-dialog"],
  },
  "arrow-keys": {
    description: "ArrowDown and ArrowUp move to the next and previous enabled item of a vertical menu or listbox (APG Menu Button, Combobox).",
    patterns: ["menu-button", "combobox-listbox"],
  },
};

/**
 * The behaviour checks this youiyoux decides: only these may ever be `passed` or `failed`. Every
 * other check's popup is opened and identified, and the result is `incomplete` ("this youiyoux
 * doesn't decide <check> yet"). A stored pass or fail for any other check is not counted.
 */
export const DECIDED_BEHAVIOUR_CHECKS: readonly BehaviourCheck[] = ["dismiss-escape"];
export const decidesBehaviour = (check: string): boolean => (DECIDED_BEHAVIOUR_CHECKS as readonly string[]).includes(check);

/**
 * A rule run that should have checked and did not: unsupported, errored, or a behaviour rule with
 * no probe results (`incomplete`). Its zero findings are unknown, never clean. One answer for the
 * CLI, the MCP server and the hub.
 */
export const ruleDidNotRun = (run: Pick<RuleRun, "state">): boolean => run.state === "unsupported" || run.state === "error" || run.state === "incomplete";

/** Why a behaviour rule has no result in a code scan: the reason on its `incomplete` run. */
export const BEHAVIOUR_NOT_RUN = "behaviour rules are checked by a probe run in the running app (youiyoux behave), which hasn't run";

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
  if (rule.check.engine === "behaviour") return { state: "probe", by: `behaviour:${rule.check.id}` };
  return { state: "enforced", by: rule.check.engine === "youi" ? `youi:${rule.check.id}` : `ast-grep:${rule.check.language}` };
}

/** One line for people: what checks this rule, or why nothing does. */
export function executionLabel(execution: RuleExecution): string {
  switch (execution.state) {
    case "enforced":
      return execution.by.startsWith("youi:") ? `Checked by youiyoux check (${execution.by.slice(5)})` : `Checked by youiyoux check (ast-grep, ${execution.by.slice(9)})`;
    case "advisory":
      return "Advisory: shown to people and agents, not checked";
    case "off":
      return "Off: not checked and not shown to agents";
    case "unsupported":
      return `Not checked: ${execution.reason}`;
    case "probe":
      return `Behaviour (${execution.by.slice(10)}): checked by a probe run in the running app, not by the code scan; incomplete until one has run`;
  }
}
