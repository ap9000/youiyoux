/**
 * Rule drafts as data: form fields ↔ youi.rule/v1, validation, the content digest a draft
 * is bound to, and rendering the files a review branch carries. Pure; no I/O.
 */
import { isDeepStrictEqual } from "node:util";
import { parseDocument, type Document } from "yaml";
import { parseId, RuleSpec, sha256, stableStringify, type ElementId } from "@youiyoux/core";
import type { Draft, DraftContent, DraftStatus, RuleFields } from "./api.ts";
import type { RuleExecution } from "./execution.ts";

/** Key order of a rule file, as the hand-written rules use it. */
const RULE_KEYS = ["$schema", "schema", "id", "title", "severity", "rollout", "statement", "rationale", "agent", "check", "files", "examples"] as const;

export const DEFAULT_FILES = ["**/*.tsx"];

export function fieldsFromRule(rule: RuleSpec): RuleFields {
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    rollout: rule.rollout ?? null,
    statement: rule.statement,
    rationale: rule.rationale,
    agent: rule.agent,
    check: rule.check,
    files: rule.files,
    examples: { bad: rule.examples.bad, good: rule.examples.good },
  };
}

/** A new rule starts as a warning with a planned tightening: new rules never break builds on day one. */
export function newRuleFields(system: string): RuleFields {
  return {
    id: `youi:${system}/rule/`,
    title: "",
    severity: "warn",
    rollout: { to: "error" },
    statement: "",
    rationale: "",
    agent: "",
    check: { engine: "advisory" },
    files: DEFAULT_FILES,
    examples: { bad: [], good: [] },
  };
}

/** Plain words for the schema's messages on the fields people type. */
const REQUIRED: Record<string, string> = { title: "give the rule a title", statement: "say what the rule is", agent: "write the one-line instruction agents follow" };

function issues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string; code: string }> }, id: string): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length ? issue.path.map(String).join(".") : "rule";
    if (field === "id") return id.endsWith("/rule/") ? "id: name the rule after the prefix" : "id: use lowercase letters, digits, dots and dashes, starting with a letter or digit";
    return `${field}: ${(issue.code === "too_small" && REQUIRED[field]) || issue.message}`;
  });
}

/** The published form of the fields, or why it cannot be published as it stands. */
export function toRuleSpec(fields: RuleFields): { rule: RuleSpec | null; problems: string[] } {
  const candidate = {
    schema: "youi.rule/v1",
    id: fields.id.trim(),
    title: fields.title.trim(),
    severity: fields.severity,
    ...(fields.rollout ? { rollout: fields.rollout } : {}),
    statement: fields.statement.trim(),
    rationale: fields.rationale.trim(),
    agent: fields.agent.trim(),
    check: fields.check,
    files: fields.files.map((f) => f.trim()).filter(Boolean),
    examples: { bad: fields.examples.bad.filter((e) => e.trim()), good: fields.examples.good.filter((e) => e.trim()) },
  };
  const parsed = RuleSpec.safeParse(candidate);
  return parsed.success ? { rule: parsed.data, problems: [] } : { rule: null, problems: issues(parsed.error, candidate.id) };
}

export interface ValidationContext {
  readonly mode: Draft["mode"];
  /** The rule a draft edits (its id may not change). */
  readonly ruleId: string;
  readonly system: string;
  readonly existingRuleIds: ReadonlySet<string>;
  readonly componentIds: ReadonlySet<string>;
  readonly execution: RuleExecution;
}

export function validateContent(content: DraftContent, context: ValidationContext): string[] {
  const { rule, problems } = toRuleSpec(content.rule);
  const id = content.rule.id.trim();
  const parsed = parseId(id);
  if (parsed && parsed.kind !== "rule") problems.push(`id: ${id} is not a rule id`);
  if (parsed && parsed.system !== context.system) problems.push(`id: rules here belong to system "${context.system}"`);
  if (parsed && (parsed.name.includes("..") || /(?:\.|\.lock)$/.test(parsed.name))) problems.push("id: a rule name cannot contain \"..\" or end with \".\" or \".lock\"");
  if (context.mode === "edit" && id !== context.ruleId) problems.push(`id: renaming a rule is not supported; it stays ${context.ruleId}`);
  if (context.mode === "create" && context.existingRuleIds.has(id)) problems.push(`id: ${id} already exists`);
  if (!context.execution.isSupported(content.rule.check)) problems.push(`check: ${describeCheck(content.rule.check)} cannot run yet; choose a supported check or advisory`);
  if (content.rule.rollout && content.rule.severity !== "warn") problems.push("severity: a planned tightening to error starts as a warning");
  if (rule && rule.files.length === 0) problems.push("files: list at least one glob");
  for (const component of content.components) if (!context.componentIds.has(component)) problems.push(`components: no component ${component}`);
  return problems;
}

function describeCheck(check: RuleSpec["check"]): string {
  return check.engine === "youi" ? `the youi check "${check.id}"` : check.engine === "ast-grep" ? "a custom ast-grep rule" : "this check";
}

export function contentDigest(content: DraftContent): string {
  return sha256(stableStringify(content));
}

function insertOrdered(doc: Document, key: string, value: unknown): void {
  const map = doc.contents as { items: Array<{ key: unknown }> } | null;
  const pair = doc.createPair(key, value);
  if (!map || !Array.isArray(map.items)) {
    doc.set(key, value);
    return;
  }
  const later = RULE_KEYS.slice(RULE_KEYS.indexOf(key as (typeof RULE_KEYS)[number]) + 1);
  const index = map.items.findIndex((item) => later.includes(String((item.key as { value?: unknown })?.value ?? item.key) as (typeof RULE_KEYS)[number]));
  if (index === -1) map.items.push(pair as never);
  else map.items.splice(index, 0, pair as never);
}

/**
 * The rule file for `rule`. An existing file is edited in place, key by key, so lines the
 * draft did not change stay byte-identical and the review diff shows only the edit.
 */
export function renderRuleYaml(rule: RuleSpec, existing: string | null, schemaRef: string): string {
  const doc = parseDocument(existing ?? `$schema: ${schemaRef}\n`);
  const current = (doc.toJS() ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { $schema: current.$schema ?? schemaRef, ...rule };
  for (const key of RULE_KEYS) {
    const value = next[key];
    if (value === undefined) {
      if (key in current) doc.delete(key);
      continue;
    }
    if (key in current) {
      if (!isDeepStrictEqual(current[key], value)) doc.set(key, value);
    } else if (!(existing !== null && key === "rationale" && value === "")) {
      insertOrdered(doc, key, value);
    }
  }
  return doc.toString({ lineWidth: 0 });
}

/** A contract with `ruleId` added to or removed from its rules; null when nothing changes. */
export function renderContract(text: string, ruleId: string, listed: boolean): string | null {
  const contract = JSON.parse(text) as { rules?: string[] };
  const rules = contract.rules ?? [];
  if (rules.includes(ruleId) === listed) return null;
  const next = { ...contract, rules: listed ? [...rules, ruleId] : rules.filter((id) => id !== ruleId) };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function draftStatus(draft: Draft, merged = false): DraftStatus {
  if (draft.discarded) return "discarded";
  if (draft.handoff) return merged ? "rolled-out" : "handed-off";
  if (draft.approval) return "approved";
  if (draft.preview && draft.preview.draftDigest === draft.digest) return "previewed";
  return "draft";
}

/** Components to add the rule to and remove it from, relative to the published state. */
export function componentChanges(published: readonly ElementId[], wanted: readonly ElementId[]): { add: ElementId[]; remove: ElementId[] } {
  return { add: wanted.filter((id) => !published.includes(id)), remove: published.filter((id) => !wanted.includes(id)) };
}
