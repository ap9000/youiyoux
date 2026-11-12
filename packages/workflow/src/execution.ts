/**
 * The seam between the editor and rule execution: which checks the form offers, whether a
 * draft's check can run, and running a set of rules over one scan snapshot.
 *
 * `scannerExecution` is the scanner's one rule execution model, the same one `youiyoux check`,
 * `youiyoux rules`, the MCP server and the hub use: built-in checks with their options checked,
 * ast-grep bodies compiled, advisory rules never run, behaviour rules left to a probe run (incomplete here). A draft can never claim enforcement
 * the scanner does not perform, and a check that did not run never reads as zero findings.
 */
import { BEHAVIOUR_CHECKS, BUILT_IN_CHECKS, type BehaviourCheck, type BuiltInCheckId, type RuleRun, type RuleSpec, type Violation } from "@youiyoux/core";
import { checkInputFor, ruleCapability, runChecks, type Project, type ScanResult } from "@youiyoux/scanner";
import type { CheckCapability } from "./api.ts";

export interface Evaluation {
  readonly violations: readonly Violation[];
  readonly suppressed: number;
  /** How each rule ran, in the order given: a rule whose state is not `ran` found nothing because it did not run. */
  readonly checks: readonly RuleRun[];
}

export interface RuleExecution {
  readonly name: string;
  supportedChecks(): readonly CheckCapability[];
  /** Why this check cannot run, or null when it can (advisory rules can: they are never run). */
  problem(check: RuleSpec["check"]): string | null;
  /** Run `rules` (and only those) over the snapshot `scan` already parsed and analysed. */
  evaluate(project: Project, scan: ScanResult, rules: readonly RuleSpec[]): Evaluation;
}

const NATIVE_DEFAULTS = { elements: {}, allowInputTypes: ["hidden", "checkbox", "radio", "file", "range", "color"] };

/** How the form labels each built-in check; what it finds comes from the scanner's own list. */
const BUILT_IN_FORM: Readonly<Record<BuiltInCheckId, Pick<CheckCapability, "label" | "options" | "defaults">>> = {
  "raw-color": { label: "Raw colours", options: "none", defaults: {} },
  "arbitrary-value": { label: "Arbitrary values that copy a token", options: "none", defaults: {} },
  "native-element": { label: "Native elements styled by hand", options: "native-elements", defaults: NATIVE_DEFAULTS },
  "prop-values": { label: "Props outside the contract", options: "none", defaults: {} },
  "lookalike-component": { label: "Lookalike components", options: "none", defaults: {} },
};

/** How the form labels each behaviour check; what it verifies comes from core's own list. */
const BEHAVIOUR_FORM: Readonly<Record<BehaviourCheck, string>> = {
  "trigger-state": "Behaviour: the opening button says it is open",
  "dismiss-escape": "Behaviour: Esc closes the popup",
  "focus-into": "Behaviour: opening moves focus in",
  "focus-return": "Behaviour: closing returns focus",
  "focus-trap": "Behaviour: Tab stays inside a modal dialog",
  "arrow-keys": "Behaviour: arrow keys move through items",
};

const OFFERED: readonly CheckCapability[] = [
  ...(Object.keys(BUILT_IN_FORM) as BuiltInCheckId[]).map((id) => ({ engine: "youi" as const, id, description: BUILT_IN_CHECKS[id], ...BUILT_IN_FORM[id] })),
  ...(Object.keys(BEHAVIOUR_FORM) as BehaviourCheck[]).map((id) => ({
    engine: "behaviour" as const,
    id,
    label: BEHAVIOUR_FORM[id],
    description: `${BEHAVIOUR_CHECKS[id].description} Checked by a probe run in the running app, not by the code scan: youiyoux check reports it incomplete until one has run.`,
    options: "none" as const,
    defaults: {},
  })),
  { engine: "advisory", id: null, label: "Advisory (not checked)", description: "Guidance for people and agents. Nothing is flagged, and the rule is never shown as enforced.", options: "none", defaults: {} },
];

export const scannerExecution: RuleExecution = {
  name: "youiyoux check",
  supportedChecks: () => OFFERED,
  problem(check) {
    const execution = ruleCapability({ severity: "warn", check });
    return execution.state === "unsupported" ? execution.reason : null;
  },
  evaluate: (project, scan, rules) => runChecks(checkInputFor(project, scan, rules)),
};
