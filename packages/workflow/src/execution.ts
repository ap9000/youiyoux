/**
 * The seam between the editor and rule execution: which checks can run, and running
 * a set of rules over one scan snapshot. The editor offers only what `supportedChecks`
 * lists, so a draft can never claim enforcement the scanner does not perform.
 *
 * `builtinExecution` wraps the scanner's built-in checks. When the shared rule
 * execution capability model lands, it replaces this object; nothing else changes.
 */
import type { RuleSpec, Violation } from "@youiyoux/core";
import { runChecks, type Project, type ScanResult } from "@youiyoux/scanner";
import type { CheckCapability } from "./api.ts";

export interface Evaluation {
  readonly violations: readonly Violation[];
  readonly suppressed: number;
}

export interface RuleExecution {
  readonly name: string;
  supportedChecks(): readonly CheckCapability[];
  isSupported(check: RuleSpec["check"]): boolean;
  /** Run `rules` (and only those) over the snapshot `scan` already parsed and analysed. */
  evaluate(project: Project, scan: ScanResult, rules: readonly RuleSpec[]): Evaluation;
}

const NATIVE_DEFAULTS = { elements: {}, allowInputTypes: ["hidden", "checkbox", "radio", "file", "range", "color"] };

const BUILTIN: readonly CheckCapability[] = [
  { engine: "youi", id: "raw-color", label: "Raw colours", description: "Hex, rgb() and hsl() literals in components, class names, inline styles and stylesheets (token sources excepted).", options: "none", defaults: {} },
  { engine: "youi", id: "arbitrary-value", label: "Arbitrary values that copy a token", description: "Tailwind [arbitrary] values whose value a token utility already provides.", options: "none", defaults: {} },
  { engine: "youi", id: "native-element", label: "Native elements styled by hand", description: "Native tags (button, input, …) rendered outside the components directory where an owned component exists.", options: "native-elements", defaults: NATIVE_DEFAULTS },
  { engine: "youi", id: "prop-values", label: "Props outside the contract", description: "Literal values for enumerated props that the component's contract does not list.", options: "none", defaults: {} },
  { engine: "youi", id: "lookalike-component", label: "Lookalike components", description: "Components named like a design-system element that resolve to another implementation.", options: "none", defaults: {} },
  { engine: "advisory", id: null, label: "Advisory (not checked)", description: "Guidance for people and agents. Nothing is flagged, and the rule is never shown as enforced.", options: "none", defaults: {} },
];

export const builtinExecution: RuleExecution = {
  name: "youi built-in checks",
  supportedChecks: () => BUILTIN,
  isSupported: (check) => BUILTIN.some((c) => c.engine === check.engine && (check.engine !== "youi" || c.id === check.id)),
  evaluate(project, scan, rules) {
    return runChecks({
      modules: scan.modules,
      analyses: scan.analyses,
      elements: scan.elements,
      tokens: scan.tokens,
      rules,
      componentsDir: project.config.componentsDir,
      tokenSources: project.config.tokenSources,
      generatedDir: project.config.outputs.dir,
    });
  },
};
