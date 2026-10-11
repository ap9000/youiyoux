/**
 * The rule-editor workflow's wire shapes: what the loopback service returns and the
 * hub reads. Types only (the hub imports this file type-only), so no runtime code here.
 */
import type { ElementId, RuleRollout, RuleSpec } from "@youiyoux/core";

/** Who asked. Locally every browser request is the person at the keyboard; agents never approve. */
export interface Actor {
  readonly kind: "person" | "agent";
  readonly name: string;
}

/** A rule check the editor may offer: only checks the executor can actually run. */
export interface CheckCapability {
  readonly engine: "youi" | "advisory";
  /** The built-in check id, or null for advisory rules. */
  readonly id: string | null;
  readonly label: string;
  readonly description: string;
  /** Which option editor the form shows; "none" when the check takes no options. */
  readonly options: "none" | "native-elements";
  readonly defaults: Readonly<Record<string, unknown>>;
}

/** The editable fields of a rule, as the form holds them. May be incomplete while drafting. */
export interface RuleFields {
  readonly id: string;
  readonly title: string;
  readonly severity: RuleSpec["severity"];
  readonly rollout: RuleRollout | null;
  readonly statement: string;
  readonly rationale: string;
  readonly agent: string;
  readonly check: RuleSpec["check"];
  readonly files: readonly string[];
  readonly examples: { readonly bad: readonly string[]; readonly good: readonly string[] };
}

export interface DraftContent {
  readonly rule: RuleFields;
  /** Components whose contracts list this rule (shown on their Rules tab). */
  readonly components: readonly ElementId[];
}

/** The design repository state a draft starts from. */
export interface DraftBase {
  readonly branch: string;
  readonly commit: string;
  /** sha256 of every file the draft would touch, at `commit`; null when the file does not exist there. */
  readonly files: Readonly<Record<string, string | null>>;
}

/** Exactly what a preview evaluated: change either side and the preview (and any approval of it) is stale. */
export interface SnapshotIdentity {
  readonly designCommit: string;
  /** Uncommitted edits to the definitions in the design repository's working tree. */
  readonly designDirty: boolean;
  readonly project: string;
  readonly projectCommit: string | null;
  /** Digest of the project's uncommitted changes; null when its working tree is clean. */
  readonly projectChanges: string | null;
  readonly scanner: string;
  readonly digest: string;
}

export interface PreviewFinding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly severity: "error" | "warn";
  /** new: only the draft flags it; kept: both; resolved: only the published rule did. */
  readonly change: "new" | "kept" | "resolved";
}

export interface Preview {
  readonly id: string;
  readonly at: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly snapshot: SnapshotIdentity;
  readonly durationMs: number;
  readonly scan: { readonly status: "complete" | "partial"; readonly files: number; readonly failed: ReadonlyArray<{ file: string; reason: string }> };
  /** Whether the check actually runs; advisory rules flag nothing by design. */
  readonly enforced: boolean;
  /** Places the draft flags (new + kept). */
  readonly flagged: number;
  readonly counts: { readonly new: number; readonly kept: number; readonly resolved: number; readonly suppressed: number };
  /** Places the published rule flags today (0 for a new rule). */
  readonly baseline: number;
  readonly files: number;
  /** The first findings, flagged first; `truncated` when there were more. */
  readonly findings: readonly PreviewFinding[];
  readonly truncated: boolean;
  /** What this preview cannot promise (partial scan, advisory check, severity off, …). */
  readonly limits: readonly string[];
}

export interface Approval {
  readonly by: Actor;
  readonly at: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly previewId: string;
  readonly snapshotDigest: string;
  readonly baseCommit: string;
}

export interface Handoff {
  readonly at: string;
  readonly by: Actor;
  readonly branch: string;
  readonly commit: string;
  readonly base: string;
  readonly files: readonly string[];
  readonly diff: string;
  readonly patchFile: string;
  /** The commands that take the branch to review; nothing is pushed for you. */
  readonly next: readonly string[];
}

export type DraftEventType = "created" | "saved" | "previewed" | "approved" | "approval-invalidated" | "rebased" | "handed-off" | "discarded";

export interface DraftEvent {
  readonly at: string;
  readonly actor: Actor;
  readonly type: DraftEventType;
  readonly note?: string;
}

/** A draft as stored: restart-safe, bound to its base commit and content digest. */
export interface Draft {
  readonly id: string;
  readonly kind: "rule";
  readonly mode: "edit" | "create";
  readonly ruleId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly digest: string;
  readonly content: DraftContent;
  readonly base: DraftBase;
  readonly preview: Preview | null;
  readonly approval: Approval | null;
  readonly handoff: Handoff | null;
  readonly discarded: boolean;
  readonly events: readonly DraftEvent[];
}

export type DraftStatus = "draft" | "previewed" | "approved" | "handed-off" | "discarded";

/** A draft plus what is true about it right now. */
export interface DraftView extends Draft {
  readonly status: DraftStatus;
  /** Why the draft cannot be previewed or approved as it stands (empty when it is valid). */
  readonly problems: readonly string[];
  /** Why the preview no longer describes the current draft, design repo or project. */
  readonly previewStale: readonly string[];
  /** Why the base no longer matches the design repository (rebase to continue). */
  readonly baseStale: readonly string[];
  readonly canApprove: boolean;
  readonly canHandoff: boolean;
}

export interface PublishedRule {
  readonly rule: RuleSpec;
  readonly file: string;
  readonly components: readonly ElementId[];
}

export interface WorkflowInfo {
  readonly schema: "youiyoux.workflow/v1";
  readonly version: string;
  readonly actor: Actor;
  readonly design: { readonly root: string; readonly branch: string; readonly head: string; readonly dirty: boolean };
  readonly project: { readonly id: string; readonly root: string; readonly system: string };
  readonly checks: readonly CheckCapability[];
  readonly executor: string;
  readonly components: ReadonlyArray<{ id: ElementId; name: string }>;
  readonly limits: readonly string[];
}

export interface ApiError {
  readonly error: string;
  readonly code: "bad-request" | "not-found" | "conflict" | "forbidden" | "invalid" | "stale" | "internal";
  readonly problems?: readonly string[];
}
