/**
 * The design-change workflow's wire shapes: what the loopback service returns and the
 * hub reads. Three kinds of draft share one lifecycle (draft, impact preview, approval, review
 * branch): rule drafts, style drafts (token values and component-state bindings) and library
 * drafts (a Discover candidate saved to the Library, or an adoption request for one).
 * Types only (the hub imports this file type-only), so no runtime code here.
 */
import type { ComponentState, ElementId, LibraryEntry, RuleExecution, RuleRollout, RuleSpec } from "@youiyoux/core";

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
  /** Style drafts: the keys of the colour pairs the draft puts below WCAG AA, confirmed by the approver. */
  readonly contrastAcknowledged?: readonly string[];
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

/* ------------------------------------------------------------ style drafts */

/**
 * One token's new value, as it will be written (a DTCG `$value`, or an alias like `{color.brand}`).
 * `light` goes to the file that holds the token's light value; `dark` to the theme's dark file.
 */
export interface TokenEdit {
  /** DTCG path, e.g. `color.accent`. */
  readonly path: string;
  /** New light (base) value; absent leaves it as it is. Dark follows it unless the token has its own dark value. */
  readonly light?: unknown;
  /** New dark value; absent leaves it as it is; null removes the dark value so dark follows light. */
  readonly dark?: unknown;
}

/** Re-bind one role of a component's interaction state to another token. */
export interface StateEdit {
  readonly component: ElementId;
  readonly state: ComponentState;
  /** The role in the contract's `states` (`bg.default`, `ring`). */
  readonly role: string;
  readonly token: ElementId;
}

export interface StyleDraftContent {
  /** A short name for the change, for the queue and the review branch. */
  readonly title: string;
  readonly tokens: readonly TokenEdit[];
  readonly states: readonly StateEdit[];
}

/** A token whose resolved value the draft changes, per scheme (CSS text, as the build emits it). */
export interface StyleTokenChange {
  readonly path: string;
  readonly type: string;
  readonly light: { readonly before: string; readonly after: string };
  readonly dark: { readonly before: string; readonly after: string };
  /** edited: the draft sets it; follows: it reads a token the draft sets (an alias or a part). */
  readonly cause: "edited" | "follows";
}

/** One place a changed component is used: a site from the project's usage map. */
export interface StyleSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly element: ElementId;
  readonly component: string;
  /** The export used: the component, a sub-part (CardHeader) or its variants function. */
  readonly export: string;
  readonly routes: readonly string[];
  readonly routeSource: "route-file" | "imported-by" | "shell" | "unrouted";
}

/** A file that uses a changed token's CSS variable or Tailwind utilities directly (outside the owned implementations). */
export interface StyleDirectUse {
  readonly file: string;
  readonly uses: number;
  readonly line: number;
  readonly text: string;
  readonly routes: readonly string[];
}

/** A colour pair that changes grade or stays below WCAG AA with this draft. */
export interface StyleContrast {
  /** Stable per pair and scheme: what an approval acknowledges. */
  readonly key: string;
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly scheme: "light" | "dark";
  /** text needs 4.5:1; large text and UI parts (focus rings) need 3:1. */
  readonly kind: "text" | "large" | "ui";
  readonly required: number;
  readonly before: number | null;
  readonly after: number | null;
  readonly grade: "AAA" | "AA" | "AA large" | "Fail" | null;
  /** A colour that could not be read: the pair counts as failing. */
  readonly unreadable?: string;
  /** new: below AA with this draft, and passed before (or did not exist); kept: was already below and still is; fixed: was below, now passes. */
  readonly change: "new" | "kept" | "fixed";
}

export interface StylePreview {
  readonly id: string;
  readonly at: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly snapshot: SnapshotIdentity;
  readonly durationMs: number;
  readonly scan: { readonly status: "complete" | "partial"; readonly files: number; readonly failed: ReadonlyArray<{ file: string; reason: string }> };
  readonly tokens: readonly StyleTokenChange[];
  /** Contracts that change: they bind a changed token (at rest or in a state), their implementation uses one, or the draft re-binds a state. */
  readonly contracts: ReadonlyArray<{ readonly id: ElementId; readonly name: string; readonly via: "binding" | "implementation" | "state"; readonly sites: number }>;
  /** Every usage-map site of those contracts, by file and line; `sites.length` is `totals.sites` unless `truncated`. */
  readonly sites: readonly StyleSite[];
  readonly direct: readonly StyleDirectUse[];
  /** Screens reached, with their component sites and direct uses. */
  readonly routes: ReadonlyArray<{ readonly route: string; readonly sites: number; readonly direct: number }>;
  /** A changed token is used in a stylesheet, the app shell or an unrouted file: every screen may change. */
  readonly everyScreen: boolean;
  readonly totals: { readonly tokens: number; readonly contracts: number; readonly sites: number; readonly files: number; readonly routes: number; readonly direct: number; readonly directFiles: number };
  /** Lists stop at a large bound so a preview stays loadable; the totals above always count everything. */
  readonly truncated: boolean;
  readonly contrast: readonly StyleContrast[];
  readonly limits: readonly string[];
}

/* ---------------------------------------------------------- library drafts */

/**
 * A Library item from outside (a Discover listing), drafted for a person to approve. `save` keeps
 * it in the Library as a reference (stage `library`); `adopt` requests adoption (stage
 * `candidate`), which a person then decides. Neither installs anything.
 */
export interface LibraryDraftContent {
  /** The youi.library/v1 item as it will be written. */
  readonly entry: LibraryEntry;
  readonly request: "save" | "adopt";
  /** Why: required for an adoption request. */
  readonly reason: string;
  /** Inventory families (`button-1`) or System elements it could be swapped in for. */
  readonly swapsWith: readonly string[];
}

/** What swapping the item in for one family or element would touch, from the local index. */
export interface LibrarySwap {
  readonly target: string;
  readonly kind: "family" | "element";
  /** The element's name, for an element. */
  readonly name: string | null;
  /** null when the index could not say (no inventory recorded, or another project's family). */
  readonly looks: number | null;
  readonly files: number | null;
  readonly routes: number | null;
  /** A could-replace link joins them: the item plays the family's role. */
  readonly listed: boolean | null;
}

export interface LibraryPreview {
  readonly id: string;
  readonly at: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly snapshot: SnapshotIdentity;
  readonly durationMs: number;
  /** Design-root-relative path the item is written to. */
  readonly file: string;
  /** The file is already in the design repository (the review edits it). */
  readonly exists: boolean;
  readonly stage: "library" | "candidate";
  /** An SPDX id, or "unknown". */
  readonly license: string;
  readonly install: string | null;
  readonly swaps: readonly LibrarySwap[];
  readonly limits: readonly string[];
}

/* ----------------------------------------------------------------- drafts */

/** What every draft shares: restart-safe, bound to its base commit and content digest. */
interface DraftCommon {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly digest: string;
  readonly base: DraftBase;
  readonly approval: Approval | null;
  readonly handoff: Handoff | null;
  readonly discarded: boolean;
  readonly events: readonly DraftEvent[];
}

/** A rule draft: one rule's fields and the components that list it. */
export interface RuleDraft extends DraftCommon {
  readonly kind: "rule";
  readonly mode: "edit" | "create";
  readonly ruleId: string;
  readonly content: DraftContent;
  readonly preview: Preview | null;
}

/** A style draft: token values (light and dark) and component-state bindings, changed together. */
export interface StyleDraft extends DraftCommon {
  readonly kind: "style";
  readonly mode: "edit";
  readonly content: StyleDraftContent;
  readonly preview: StylePreview | null;
}

/** A library draft: one Library item to save, or to request adoption of. */
export interface LibraryDraft extends DraftCommon {
  readonly kind: "library";
  readonly mode: "create";
  readonly content: LibraryDraftContent;
  readonly preview: LibraryPreview | null;
}

export type Draft = RuleDraft | StyleDraft | LibraryDraft;
export type DraftKind = Draft["kind"];

export type DraftStatus = "draft" | "previewed" | "approved" | "handed-off" | "rolled-out" | "discarded";

/** What is true about a draft right now. */
export interface DraftViewFields {
  readonly status: DraftStatus;
  /** Why the draft cannot be previewed or approved as it stands (empty when it is valid). */
  readonly problems: readonly string[];
  /** Why the preview no longer describes the current draft, design repo or project. */
  readonly previewStale: readonly string[];
  /** Why the base no longer matches the design repository (rebase to continue). */
  readonly baseStale: readonly string[];
  /** The default branch moved past the draft's base: rebase before approving. */
  readonly needsRebase: boolean;
  readonly canApprove: boolean;
  readonly canHandoff: boolean;
}

export type RuleDraftView = RuleDraft & DraftViewFields;
export type StyleDraftView = StyleDraft & DraftViewFields;
export type LibraryDraftView = LibraryDraft & DraftViewFields;
/** A draft plus what is true about it right now. */
export type DraftView = RuleDraftView | StyleDraftView | LibraryDraftView;

export interface RulePlace {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly message: string;
}

export interface PublishedRule {
  /** The rule, with how youi check executes it (the scanner's one execution model). */
  readonly rule: RuleSpec & { readonly execution: RuleExecution };
  readonly file: string;
  readonly components: readonly ElementId[];
  /** Places it flags in the project's current scan (suppressed places excluded); null when it did not run there. */
  readonly flagged: number | null;
  /** Why a rule that should have run on the current scan did not; its findings are unknown, never zero. */
  readonly notRun?: string;
  readonly places: readonly RulePlace[];
}

export interface PublishedRules {
  readonly rules: readonly PublishedRule[];
  readonly project: string;
  readonly scannedAt: string;
  readonly scan: { readonly status: "complete" | "partial"; readonly files: number };
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
  /** Draft kinds this service accepts. */
  readonly kinds: readonly DraftKind[];
  readonly limits: readonly string[];
}

export interface ApiError {
  readonly error: string;
  readonly code: "bad-request" | "not-found" | "conflict" | "forbidden" | "invalid" | "stale" | "internal";
  readonly problems?: readonly string[];
}
