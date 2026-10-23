/**
 * The design-change workflow: draft → save → preview → approve → hand off to review, for
 * rule drafts, style drafts (token values and component-state bindings) and library drafts (a
 * Discover candidate saved to the Library, or an adoption request for one) alike.
 *
 * Saving never publishes and never approves. A draft is bound to the design commit it
 * started from and to the digest of its content; a preview is bound to the exact design
 * and project state it scanned; an approval is bound to all three. When any of them moves,
 * the approval is withdrawn (and the withdrawal recorded) before anything can rely on it.
 * The hand-off creates a review branch in the design repository and never touches the
 * default branch or the working tree.
 */
import { randomBytes } from "node:crypto";
import { loadProject, ruleCapability, scanProject, SCANNER_VERSION, type LoadProjectOptions, type Project, type ScanResult } from "@youiyoux/scanner";
import { buildTokens, type ResolvedToken } from "@youiyoux/tokens";
import { parseId, shortHash, stableStringify, type LibraryEntry as LibraryEntryValue } from "@youiyoux/core";
import type { Actor, Draft, DraftContent, DraftEvent, DraftView, IngestDraft, IngestDraftView, IngestPreview, IngestReading, LibraryDraft, LibraryDraftContent, LibraryDraftView, LibraryPreview, LibrarySwap, Preview, PublishedRules, RuleDraft, RuleDraftView, SnapshotIdentity, StyleDraft, StyleDraftContent, StyleContrast, StyleDraftView, StylePreview, WorkflowInfo } from "./api.ts";
import { DesignFiles } from "./design-files.ts";
import { contentDigest, draftStatus, fieldsFromRule, newRuleFields, toRuleSpec, validateContent } from "./drafts.ts";
import { describeStyle, emptyStyleContent, normalizeStyleContent, styleDigest, styleSlug, validateStyleContent, type StyleContext } from "./style-drafts.ts";
import { describeIngest, ingestDigest, ingestFiles, ingestSlug, keptEntries, normalizeIngestContent, validateIngestContent } from "./ingest-drafts.ts";
import { adoptionRefusal, describeLibrary, libraryDigest, licenceOf, libraryPath, librarySlug, normalizeLibraryContent, renderLibraryEntry, validateLibraryContent } from "./library-drafts.ts";
import { previewStyle } from "./style-preview.ts";
import { scannerExecution, type RuleExecution } from "./execution.ts";
import { branchTip, changesDigest, createReviewBranch, defaultBranch, hasChanges, headCommit, isAncestor, locate, type RepoLocation } from "./git.ts";
import { authorize, WorkflowError, type Action } from "./policy.ts";
import { comparePreview, notRunReason } from "./preview.ts";
import { RequestStore } from "./requests.ts";
import type { WorkflowStore } from "./store.ts";

const WORKFLOW_VERSION = "0.1.0";
const MAX_PLACES = 200;

interface WorkflowOptions extends LoadProjectOptions {
  readonly projectRoot: string;
  readonly store: WorkflowStore;
  readonly execution?: RuleExecution;
  readonly now?: () => Date;
  readonly newId?: (prefix: "d" | "p") => string;
  /**
   * What swapping a Library item in for an inventory family would touch, from the local index
   * (`youiyoux inventory` records it); null when the index cannot say. Without it, a library
   * preview names the families but cannot count their looks.
   */
  readonly swapImpact?: (candidate: string, family: string) => Promise<{ looks: number; files: number; routes: number; listed: boolean } | null>;
  /**
   * The licence the local Discover index lists for a Library id (`unknown` included), or null
   * when the index does not list it. A library draft's licence is always this one, never the
   * client's; without it (no index), an adoption request is refused, since nothing can check it.
   */
  readonly libraryLicence?: (id: string) => Promise<LibraryEntryValue["license"] | null>;
  /**
   * Read a link into Library items (`youiyoux library ingest`, Discover's readers). An ingest
   * draft's items are always what this read, never what a client sent; without it, no ingest
   * draft can start.
   */
  readonly ingest?: (link: string) => Promise<IngestReading>;
}

/** The design repository and project as they are right now. */
interface Current {
  readonly project: Project;
  readonly repo: RepoLocation;
  readonly files: DesignFiles;
  readonly branch: string;
  readonly tip: string;
  readonly designDirty: boolean;
  readonly snapshot: SnapshotIdentity;
  /** The published tokens (built once, on first need): what style drafts are checked against. */
  readonly tokens: () => Promise<readonly ResolvedToken[]>;
}

export type CreateInput = { kind?: "rule"; mode: "edit"; ruleId: string } | { kind?: "rule"; mode: "create" } | { kind: "style"; content?: StyleDraftContent } | { kind: "library"; content: LibraryDraftContent } | { kind: "ingest"; link: string };

/** A preview's headline, for history notes and commit messages. */
function previewSummary(draft: Draft): string {
  if (draft.kind === "rule") return draft.preview ? `flags ${draft.preview.flagged} place(s)` : "no preview";
  if (draft.kind === "ingest") {
    const q = draft.preview;
    if (!q) return "no preview";
    const edits = q.files.filter((f) => f.exists).length;
    return `writes ${q.files.length} Library item(s)${edits ? ` (${edits} already there, edited)` : ""}${q.dropped ? `, ${q.dropped} dropped` : ""}, licence ${q.license}`;
  }
  if (draft.kind === "library") {
    const q = draft.preview;
    if (!q) return "no preview";
    const counted = q.swaps.filter((s) => s.looks !== null);
    return `writes ${q.file} (${q.exists ? "an edit" : "new"}, stage ${q.stage}, licence ${q.license})${counted.length ? `; swapping it in touches ${counted.reduce((n, s) => n + s.looks!, 0)} look(s) in ${counted.reduce((n, s) => n + s.files!, 0)} file(s)` : ""}`;
  }
  const p = draft.preview;
  return p ? `changes ${p.totals.tokens} token(s) and ${p.totals.contracts} component(s): ${p.totals.sites} site(s) and ${p.totals.direct} direct use(s) in ${p.totals.files} file(s) on ${p.totals.routes} screen(s)` : "no preview";
}

const capitalized = (text: string): string => `${text[0]!.toUpperCase()}${text.slice(1)}`;
const randomId = (prefix: "d" | "p"): string => `${prefix}-${randomBytes(5).toString("hex")}`;

export class RuleWorkflow {
  private readonly options: WorkflowOptions;
  private readonly execution: RuleExecution;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The last scan for the rules list, reused while the design repo and project are unchanged. */
  private scanned: { digest: string; at: string; result: Promise<ScanResult> } | null = null;

  constructor(options: WorkflowOptions) {
    this.options = options;
    this.execution = options.execution ?? scannerExecution;
  }

  /** The product's comments and change requests on its captured screens (requests.ts), in its `.youi/requests`. */
  async requests(): Promise<RequestStore> {
    const project = await this.project();
    return new RequestStore(project.root, project.config.id, this.options.now ? { now: this.options.now } : {});
  }

  /** The project and its design definitions, as they are on disk now. */
  private project(): Promise<Project> {
    const { projectRoot, configPath, designRoot, productRoot } = this.options;
    return loadProject(projectRoot, { ...(configPath ? { configPath } : {}), ...(designRoot ? { designRoot } : {}), ...(productRoot ? { productRoot } : {}) });
  }

  /** What every kind of preview starts with: the draft revision and snapshot it read, and how long it took. */
  private previewHead(draft: Draft, before: Current, started: number): Pick<Preview, "id" | "at" | "draftRevision" | "draftDigest" | "snapshot" | "durationMs"> {
    return { id: this.id("p"), at: this.now(), draftRevision: draft.revision, draftDigest: draft.digest, snapshot: before.snapshot, durationMs: Math.round(performance.now() - started) };
  }

  /** The design repository and project now, refused when they moved since `before` (while a preview ran). */
  private async unchangedSince(before: Current): Promise<Current> {
    const after = await this.current();
    if (after.snapshot.digest !== before.snapshot.digest) throw new WorkflowError("stale", "the project or design repository changed while the preview ran; run it again");
    return after;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private id(prefix: "d" | "p"): string {
    return (this.options.newId ?? randomId)(prefix);
  }

  /** Serialize operations on one draft, so two tabs cannot interleave a save and an approval. */
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  private async current(): Promise<Current> {
    const project = await this.project();
    const repo = await locate(project.repo.root);
    if (!repo) throw new WorkflowError("invalid", `the design definitions at ${project.repo.root} are not in a git repository; drafts need a commit to start from`);
    const branch = await defaultBranch(repo.top);
    const [tip, head, dirty] = await Promise.all([branchTip(repo.top, branch), headCommit(repo.top), hasChanges(repo.top, [repo.prefix || "."])]);
    const projectRepo = await locate(project.root);
    const [projectCommit, projectChanges] = projectRepo ? await Promise.all([headCommit(projectRepo.top), changesDigest(projectRepo.top)]) : [null, null];
    const designDirty = dirty || head !== tip;
    const identity = { designCommit: tip, designDirty, project: project.config.id, projectCommit, projectChanges, scanner: SCANNER_VERSION };
    let built: Promise<readonly ResolvedToken[]> | null = null;
    const tokens = (): Promise<readonly ResolvedToken[]> => (built ??= buildTokens(project.repo.root, project.system.config, project.config.outputs).then((b) => b.tokens));
    return { project, repo, files: new DesignFiles(repo, project), branch, tip, designDirty, snapshot: { ...identity, digest: shortHash(stableStringify(identity)) }, tokens };
  }

  private event(actor: Actor, type: DraftEvent["type"], note?: string): DraftEvent {
    return { at: this.now(), actor, type, ...(note ? { note } : {}) };
  }

  private async load(id: string): Promise<Draft> {
    let draft: Draft | null;
    try {
      draft = await this.options.store.get(id);
    } catch (error: unknown) {
      throw new WorkflowError("not-found", error instanceof Error ? error.message : String(error));
    }
    if (!draft) throw new WorkflowError("not-found", `no draft ${id}`);
    return draft;
  }

  private async styleContext(current: Current): Promise<StyleContext> {
    const { system } = current.project;
    return {
      system: system.config.id,
      tokens: (await current.tokens()).map((t) => ({ path: t.id, type: t.type, source: t.source ?? { light: t.light, dark: t.dark } })),
      contracts: system.components.map((c) => c.contract),
      hasDark: system.config.themeModifier !== undefined,
    };
  }

  private async problems(draft: Draft, current: Current): Promise<string[]> {
    if (draft.kind === "style") return validateStyleContent(draft.content, await this.styleContext(current));
    if (draft.kind === "library") return validateLibraryContent(draft.content, { componentIds: new Set(current.project.system.components.map((c) => c.contract.id)) });
    if (draft.kind === "ingest") return validateIngestContent(draft.content);
    return validateContent(draft.content, {
      mode: draft.mode,
      ruleId: draft.ruleId,
      system: current.project.system.config.id,
      existingRuleIds: new Set(current.project.system.rules.map((r) => r.id)),
      componentIds: new Set(current.project.system.components.map((c) => c.contract.id)),
      execution: this.execution,
    });
  }

  private baseStale(draft: Draft, current: Current): string[] {
    const reasons: string[] = [];
    if (draft.base.commit !== current.tip) reasons.push(`${current.branch} moved from ${draft.base.commit.slice(0, 7)} to ${current.tip.slice(0, 7)} since this draft started. Rebase to continue.`);
    if (current.designDirty) reasons.push(`The design repository is not a clean checkout of ${current.branch} (${current.tip.slice(0, 7)}): commit, stash or check out ${current.branch} so previews read exactly what a review would.`);
    return reasons;
  }

  private previewStale(draft: Draft, current: Current): string[] {
    const preview = draft.preview;
    if (!preview) return [];
    const reasons: string[] = [];
    if (preview.draftDigest !== draft.digest) reasons.push("The draft changed after this preview.");
    if (preview.snapshot.designCommit !== current.snapshot.designCommit || preview.snapshot.designDirty !== current.snapshot.designDirty) reasons.push("The design repository changed since this preview.");
    if (preview.snapshot.projectCommit !== current.snapshot.projectCommit || preview.snapshot.projectChanges !== current.snapshot.projectChanges) reasons.push(`${current.snapshot.project} changed since this preview (new commits or edits).`);
    if (preview.snapshot.scanner !== current.snapshot.scanner) reasons.push("The scanner was upgraded since this preview.");
    return reasons;
  }

  /** Why the recorded approval no longer holds; empty when it does (or there is none). */
  private approvalLapsed(draft: Draft, current: Current): string[] {
    const approval = draft.approval;
    if (!approval || draft.handoff) return [];
    const reasons: string[] = [];
    if (approval.draftDigest !== draft.digest) reasons.push("the draft changed");
    if (approval.baseCommit !== current.tip) reasons.push(`${current.branch} moved`);
    if (approval.snapshotDigest !== current.snapshot.digest) reasons.push("the design repository or project changed since the approved preview");
    return reasons;
  }

  /** Withdraw an approval that no longer holds, and record why. */
  private async settle(draft: Draft, current: Current): Promise<Draft> {
    const lapsed = this.approvalLapsed(draft, current);
    if (lapsed.length === 0) return draft;
    const system: Actor = { kind: "person", name: "rule editor" };
    const next: Draft = { ...draft, approval: null, updatedAt: this.now(), events: [...draft.events, this.event(system, "approval-invalidated", `Approval withdrawn: ${lapsed.join("; ")}.`)] };
    await this.options.store.put(next);
    return next;
  }

  private async view(draft: Draft, current: Current): Promise<DraftView> {
    const merged = draft.handoff !== null && (await isAncestor(current.repo.top, draft.handoff.commit, current.tip));
    const status = draftStatus(draft, merged);
    const open = status !== "discarded" && status !== "handed-off" && status !== "rolled-out";
    // A closed draft is history: judging it against today's definitions (where its rule may now exist) would only mislead.
    const problems = open ? await this.problems(draft, current) : [];
    const previewStale = open ? this.previewStale(draft, current) : [];
    const baseStale = open ? this.baseStale(draft, current) : [];
    const previewFresh = draft.preview !== null && previewStale.length === 0;
    return {
      ...draft,
      status,
      problems,
      previewStale,
      baseStale,
      needsRebase: open && draft.base.commit !== current.tip,
      canApprove: open && !draft.approval && problems.length === 0 && previewFresh && baseStale.length === 0,
      canHandoff: open && draft.approval !== null && problems.length === 0 && baseStale.length === 0 && this.approvalLapsed(draft, current).length === 0,
    } as DraftView;
  }

  private async refreshed(draft: Draft, current: Current): Promise<DraftView> {
    return this.view(await this.settle(draft, current), current);
  }

  private guard(actor: Actor, action: Action, draft?: Draft): void {
    authorize(actor, action);
    if (draft && action !== "read" && (draft.discarded || draft.handoff)) throw new WorkflowError("conflict", `draft ${draft.id} is ${draft.discarded ? "discarded" : "already handed off"}; start a new draft`);
  }

  /* ----------------------------------------------------------------- reads */

  async info(actor: Actor): Promise<WorkflowInfo> {
    authorize(actor, "read");
    const current = await this.current();
    return {
      schema: "youiyoux.workflow/v1",
      version: WORKFLOW_VERSION,
      actor,
      design: { root: current.project.repo.root, branch: current.branch, head: current.tip, dirty: current.designDirty },
      project: { id: current.project.config.id, root: current.project.root, system: current.project.system.config.id },
      checks: this.execution.supportedChecks(),
      executor: this.execution.name,
      components: current.project.system.components.map((c) => ({ id: c.contract.id, name: c.contract.name })),
      kinds: ["rule", "style", "library", ...(this.options.ingest ? (["ingest"] as const) : [])],
      limits: [
        `One design repository and one project (${current.project.config.id}).`,
        `Approved changes become a local review branch in the design repository; nothing is pushed or merged for you.`,
        `Only checks this editor can run are offered (${this.execution.name}).`,
        ...(current.snapshot.projectCommit === null ? [`${current.project.config.id} is not a git repository, so edits to it cannot be detected: approvals are not withdrawn when its code changes.`] : []),
      ],
    };
  }

  /** Every published rule, with where the project breaks it today. */
  async published(actor: Actor): Promise<PublishedRules> {
    authorize(actor, "read");
    const current = await this.current();
    if (this.scanned?.digest !== current.snapshot.digest) this.scanned = { digest: current.snapshot.digest, at: this.now(), result: scanProject(current.project) };
    const cached = this.scanned;
    const scan = await cached.result.catch((error: unknown) => {
      if (this.scanned === cached) this.scanned = null;
      throw error;
    });
    const files = await current.files.ruleFiles(current.tip);
    const rules = await Promise.all(
      current.project.system.rules.map(async (rule) => {
        const places = scan.report.violations.filter((v) => v.rule === rule.id);
        const run = scan.report.checks.find((c) => c.rule === rule.id);
        const notRun = notRunReason(run);
        return {
          rule: { ...rule, execution: ruleCapability(rule) },
          file: files.get(rule.id)?.path ?? (await current.files.rulePath(current.tip, rule.id)),
          components: current.project.system.components.filter((c) => c.contract.rules.includes(rule.id)).map((c) => c.contract.id),
          flagged: notRun ? null : places.length,
          ...(notRun ? { notRun } : {}),
          places: places.slice(0, MAX_PLACES).map(({ file, line, column, text, message }) => ({ file, line, column, text, message })),
        };
      }),
    );
    return { rules, project: current.project.config.id, scannedAt: cached.at, scan: { status: scan.report.status, files: scan.report.coverage.filesScanned } };
  }

  async list(actor: Actor): Promise<{ drafts: DraftView[]; unreadable: ReadonlyArray<{ file: string; reason: string }> }> {
    authorize(actor, "read");
    const [current, stored] = await Promise.all([this.current(), this.options.store.list()]);
    // Each draft is re-read under its lock: a save that finished while we waited must not be overwritten by the copy listed earlier.
    const drafts = await Promise.all(stored.drafts.map((draft) => this.locked(draft.id, async () => this.refreshed(await this.load(draft.id), current))));
    return { drafts: drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), unreadable: stored.unreadable };
  }

  async get(actor: Actor, id: string): Promise<DraftView> {
    authorize(actor, "read");
    return this.locked(id, async () => this.refreshed(await this.load(id), await this.current()));
  }

  /* ---------------------------------------------------------------- writes */

  async create(actor: Actor, input: { kind?: "rule"; mode: "edit"; ruleId: string } | { kind?: "rule"; mode: "create" }): Promise<RuleDraftView>;
  async create(actor: Actor, input: { kind: "style"; content?: StyleDraftContent }): Promise<StyleDraftView>;
  async create(actor: Actor, input: { kind: "library"; content: LibraryDraftContent }): Promise<LibraryDraftView>;
  async create(actor: Actor, input: { kind: "ingest"; link: string }): Promise<IngestDraftView>;
  async create(actor: Actor, input: CreateInput): Promise<DraftView>;
  async create(actor: Actor, input: CreateInput): Promise<DraftView> {
    authorize(actor, "draft");
    const current = await this.current();
    if (input.kind === "style") return this.createStyle(actor, current, input.content);
    if (input.kind === "library") return this.createLibrary(actor, current, input.content);
    if (input.kind === "ingest") return this.createIngest(actor, current, input.link);
    let content: DraftContent;
    let ruleId: string;
    const files: Record<string, string | null> = {};
    if (input.mode === "edit") {
      const rule = current.project.system.rules.find((r) => r.id === input.ruleId);
      if (!rule) throw new WorkflowError("not-found", `no published rule ${input.ruleId}`);
      ruleId = rule.id;
      content = { rule: fieldsFromRule(rule), components: current.project.system.components.filter((c) => c.contract.rules.includes(rule.id)).map((c) => c.contract.id) };
      const path = await current.files.rulePath(current.tip, rule.id);
      files[path] = await current.files.digest(current.tip, path);
    } else {
      content = { rule: newRuleFields(current.project.system.config.id), components: [] };
      ruleId = content.rule.id;
    }
    const at = this.now();
    const draft: RuleDraft = {
      id: this.id("d"),
      kind: "rule",
      mode: input.mode,
      ruleId,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      digest: contentDigest(content),
      content,
      base: { branch: current.branch, commit: current.tip, files },
      preview: null,
      approval: null,
      handoff: null,
      discarded: false,
      events: [this.event(actor, "created", input.mode === "edit" ? `Editing ${ruleId} from ${current.branch}@${current.tip.slice(0, 7)}.` : `New rule from ${current.branch}@${current.tip.slice(0, 7)}.`)],
    };
    await this.options.store.put(draft);
    return this.view(draft, current);
  }

  /** A style draft starts from the default branch tip, bound to every file it could touch. */
  private async createStyle(actor: Actor, current: Current, initial?: StyleDraftContent): Promise<StyleDraftView> {
    const content = normalizeStyleContent(initial ?? emptyStyleContent());
    const files: Record<string, string | null> = {};
    for (const path of await current.files.stylePaths(current.tip)) files[path] = await current.files.digest(current.tip, path);
    const at = this.now();
    const draft: StyleDraft = {
      id: this.id("d"),
      kind: "style",
      mode: "edit",
      createdAt: at,
      updatedAt: at,
      revision: 1,
      digest: styleDigest(content),
      content,
      base: { branch: current.branch, commit: current.tip, files },
      preview: null,
      approval: null,
      handoff: null,
      discarded: false,
      events: [this.event(actor, "created", `Style change from ${current.branch}@${current.tip.slice(0, 7)}${content.tokens.length + content.states.length ? `: ${describeStyle(content)}` : ""}.`)],
    };
    await this.options.store.put(draft);
    return (await this.view(draft, current)) as StyleDraftView;
  }

  /**
   * A library draft starts from the default branch tip, bound to the one file it writes. An
   * adoption request for an item whose licence is unknown is refused here, before any draft exists.
   */
  private async createLibrary(actor: Actor, current: Current, initial: LibraryDraftContent): Promise<LibraryDraftView> {
    const content = await this.indexedLicence(normalizeLibraryContent(initial));
    const refusal = adoptionRefusal(content);
    if (refusal) throw new WorkflowError("invalid", refusal, [`licence: unknown for ${content.entry.id}`]);
    let path: string;
    try {
      path = libraryPath(content.entry.id);
    } catch (error: unknown) {
      throw new WorkflowError("invalid", error instanceof Error ? error.message : String(error));
    }
    const at = this.now();
    const draft: LibraryDraft = {
      id: this.id("d"),
      kind: "library",
      mode: "create",
      createdAt: at,
      updatedAt: at,
      revision: 1,
      digest: libraryDigest(content),
      content,
      base: { branch: current.branch, commit: current.tip, files: { [path]: await current.files.digest(current.tip, path) } },
      preview: null,
      approval: null,
      handoff: null,
      discarded: false,
      events: [this.event(actor, "created", `${capitalized(describeLibrary(content))}, from ${current.branch}@${current.tip.slice(0, 7)}.`)],
    };
    await this.options.store.put(draft);
    return (await this.view(draft, current)) as LibraryDraftView;
  }

  /**
   * An ingest draft starts from what this service reads at the link, every item kept, bound to the
   * Library files the items would write. A link that cannot be read is said, and no draft exists.
   */
  private async createIngest(actor: Actor, current: Current, link: string): Promise<IngestDraftView> {
    if (!this.options.ingest) throw new WorkflowError("invalid", "this service cannot read links: run youiyoux library ingest <link> --draft");
    const reading = await this.options.ingest(link).catch((error: unknown) => {
      throw new WorkflowError("invalid", error instanceof Error ? error.message : String(error));
    });
    const content = normalizeIngestContent({ reading, keep: reading.entries.map((e) => e.id) });
    const problems = validateIngestContent(content);
    if (problems.length > 0) throw new WorkflowError("invalid", `${link} was read, but not into items the Library takes`, problems);
    const files: Record<string, string | null> = {};
    for (const entry of reading.entries) {
      const path = libraryPath(entry.id);
      files[path] = await current.files.digest(current.tip, path);
    }
    const at = this.now();
    const draft: IngestDraft = {
      id: this.id("d"),
      kind: "ingest",
      mode: "create",
      createdAt: at,
      updatedAt: at,
      revision: 1,
      digest: ingestDigest(content),
      content,
      base: { branch: current.branch, commit: current.tip, files },
      preview: null,
      approval: null,
      handoff: null,
      discarded: false,
      events: [this.event(actor, "created", `${capitalized(describeIngest(content))}: read from ${reading.link}, from ${current.branch}@${current.tip.slice(0, 7)}.`)],
    };
    await this.options.store.put(draft);
    return (await this.view(draft, current)) as IngestDraftView;
  }

  /**
   * The draft with the licence the local Discover index lists for its id, whatever the client
   * sent: `unknown` when the index does not list it. With no index, a save keeps what was sent
   * (a reference only) and an adoption request is refused, since nothing can check its licence.
   */
  private async indexedLicence(content: LibraryDraftContent): Promise<LibraryDraftContent> {
    if (!this.options.libraryLicence) {
      if (content.request === "adopt") throw new WorkflowError("invalid", `${content.entry.name}'s licence cannot be checked: the hub has no Discover index to check it against (run youiyoux discover sync), so it cannot be adopted yet.`, [`licence: unchecked for ${content.entry.id}`]);
      return content;
    }
    const listed = await this.options.libraryLicence(content.entry.id).catch(() => null);
    return { ...content, entry: { ...content.entry, license: listed ?? "unknown" } };
  }

  /** Save content. Saving is only saving: it withdraws any approval and never publishes. */
  async save(actor: Actor, id: string, input: { revision: number; content: DraftContent | StyleDraftContent | LibraryDraftContent | { keep: readonly string[] } }): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "draft", draft);
      if (input.revision !== draft.revision) throw new WorkflowError("conflict", `draft ${id} is at revision ${draft.revision}, not ${input.revision}: it was saved elsewhere. Reload it before saving.`);
      const isStyle = "tokens" in input.content;
      const isLibrary = "entry" in input.content;
      const isIngest = "keep" in input.content;
      if (isStyle !== (draft.kind === "style") || isLibrary !== (draft.kind === "library") || isIngest !== (draft.kind === "ingest")) throw new WorkflowError("bad-request", `draft ${id} is a ${draft.kind} draft; send ${draft.kind === "ingest" ? "the items to keep ({ keep: [ids] })" : `${draft.kind} content`}`);
      if (draft.kind === "library") return this.saveLibrary(actor, draft, input.revision, input.content as LibraryDraftContent);
      if (draft.kind === "ingest") return this.saveIngest(actor, draft, input.revision, (input.content as { keep: readonly string[] }).keep);
      const current = await this.current();
      const content = isStyle ? normalizeStyleContent(input.content as StyleDraftContent) : (input.content as DraftContent);
      const digest = isStyle ? styleDigest(content as StyleDraftContent) : contentDigest(content as DraftContent);
      if (digest === draft.digest) return this.refreshed(draft, current);
      const events = [...draft.events, this.event(actor, "saved", `Revision ${draft.revision + 1}${isStyle ? `: ${describeStyle(content as StyleDraftContent)}` : ""}.`)];
      if (draft.approval) events.push(this.event(actor, "approval-invalidated", "Approval withdrawn: the draft changed."));
      const common = { revision: draft.revision + 1, digest, approval: null, updatedAt: this.now(), events };
      const next: Draft =
        draft.kind === "style"
          ? { ...draft, ...common, content: content as StyleDraftContent }
          : { ...draft, ...common, content: content as DraftContent, ruleId: draft.mode === "create" ? (content as DraftContent).rule.id.trim() : draft.ruleId };
      await this.options.store.put(next);
      return this.view(next, current);
    });
  }

  /** Only which items are kept changes: the reading is what the service read, and stays so. */
  private async saveIngest(actor: Actor, draft: IngestDraft, revision: number, keep: readonly string[]): Promise<DraftView> {
    const current = await this.current();
    const known = new Set(draft.content.reading.entries.map((e) => e.id));
    const unknown = keep.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new WorkflowError("invalid", `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in what ${draft.content.reading.source.name} held`);
    const content = normalizeIngestContent({ reading: draft.content.reading, keep });
    const digest = ingestDigest(content);
    if (digest === draft.digest) return this.refreshed(draft, current);
    const events = [...draft.events, this.event(actor, "saved", `Revision ${revision + 1}: ${describeIngest(content)}.`)];
    if (draft.approval) events.push(this.event(actor, "approval-invalidated", "Approval withdrawn: the draft changed."));
    const next: IngestDraft = { ...draft, revision: draft.revision + 1, digest, content, approval: null, updatedAt: this.now(), events };
    await this.options.store.put(next);
    return this.view(next, current);
  }

  private async saveLibrary(actor: Actor, draft: LibraryDraft, revision: number, input: LibraryDraftContent): Promise<DraftView> {
    const current = await this.current();
    const content = await this.indexedLicence(normalizeLibraryContent(input));
    if (content.entry.id !== draft.content.entry.id) throw new WorkflowError("bad-request", `draft ${draft.id} is for ${draft.content.entry.id}; start a new draft for ${content.entry.id}`);
    const refusal = adoptionRefusal(content);
    if (refusal) throw new WorkflowError("invalid", refusal, [`licence: unknown for ${content.entry.id}`]);
    const digest = libraryDigest(content);
    if (digest === draft.digest) return this.refreshed(draft, current);
    const events = [...draft.events, this.event(actor, "saved", `Revision ${revision + 1}: ${describeLibrary(content)}.`)];
    if (draft.approval) events.push(this.event(actor, "approval-invalidated", "Approval withdrawn: the draft changed."));
    const next: LibraryDraft = { ...draft, revision: draft.revision + 1, digest, content, approval: null, updatedAt: this.now(), events };
    await this.options.store.put(next);
    return this.view(next, current);
  }

  /** Evaluate the draft over one fresh scan of the project: a rule against the published rule, a style change against the published tokens. */
  async preview(actor: Actor, id: string): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "preview", draft);
      if (draft.kind === "style") return this.previewStyle(actor, draft);
      if (draft.kind === "library") return this.previewLibrary(actor, draft);
      if (draft.kind === "ingest") return this.previewIngest(actor, draft);
      const before = await this.current();
      const problems = await this.problems(draft, before);
      const { rule } = toRuleSpec(draft.content.rule);
      if (!rule || problems.length > 0) throw new WorkflowError("invalid", "fix the draft before previewing it", problems);
      const started = performance.now();
      const scan = await scanProject(before.project);
      const baseline = before.project.system.rules.find((r) => r.id === draft.ruleId) ?? null;
      const comparison = comparePreview({ project: before.project, scan, execution: this.execution, draft: rule, baseline: draft.mode === "edit" ? baseline : null });
      const after = await this.unchangedSince(before);
      const { report } = scan;
      const designLimits = [
        ...(before.designDirty ? ["The design repository has uncommitted changes or another branch checked out; this preview reads the working tree."] : []),
        ...(before.snapshot.projectCommit === null ? [`${report.project} is not a git repository: later edits to it cannot be detected, so this preview cannot go stale.`] : []),
      ];
      const preview: Preview = {
        ...this.previewHead(draft, before, started),
        scan: { status: report.status, files: report.coverage.filesScanned, failed: report.coverage.failed },
        ...comparison,
        limits: [...comparison.limits, ...designLimits],
      };
      const note = `Flags ${preview.flagged} place(s) in ${report.project}: ${preview.counts.new} new, ${preview.counts.kept} already flagged, ${preview.counts.resolved} no longer flagged.`;
      const next: Draft = { ...draft, preview, updatedAt: this.now(), events: [...draft.events, this.event(actor, "previewed", note)] };
      await this.options.store.put(next);
      return this.refreshed(next, after);
    });
  }

  /** A library draft's preview: the item is valid youi.library/v1, where it is written, and what swapping it in would touch. */
  private async previewLibrary(actor: Actor, draft: LibraryDraft): Promise<DraftView> {
    const before = await this.current();
    const problems = await this.problems(draft, before);
    if (problems.length > 0) throw new WorkflowError("invalid", "fix the draft before previewing it", problems);
    const started = performance.now();
    const file = libraryPath(draft.content.entry.id);
    const exists = (await before.files.read(before.tip, file)) !== null;
    const components = new Map(before.project.system.components.map((c) => [c.contract.id as string, c.contract.name]));
    const swaps: LibrarySwap[] = [];
    let indexed = Boolean(this.options.swapImpact);
    for (const target of draft.content.swapsWith) {
      if (components.has(target)) {
        swaps.push({ target, kind: "element", name: components.get(target)!, looks: null, files: null, routes: null, listed: null });
        continue;
      }
      const impact = this.options.swapImpact ? await this.options.swapImpact(draft.content.entry.id, target).catch(() => null) : null;
      if (!impact) indexed = false;
      swaps.push({ target, kind: "family", name: null, looks: impact?.looks ?? null, files: impact?.files ?? null, routes: impact?.routes ?? null, listed: impact?.listed ?? null });
    }
    const after = await this.unchangedSince(before);
    const entry = draft.content.entry;
    const preview: LibraryPreview = {
      ...this.previewHead(draft, before, started),
      file,
      exists,
      stage: draft.content.request === "adopt" ? "candidate" : "library",
      license: licenceOf(draft.content),
      install: entry.install?.command ?? null,
      swaps,
      limits: [
        "Nothing is installed: approving writes the Library item for review; adding it to a project stays a person's step, after adoption.",
        ...(draft.content.request === "save" ? ["Saved to the Library, it is a reference: not in the System, and not to be built with."] : []),
        ...(swaps.some((s) => s.kind === "family") && !indexed ? ["Some families could not be counted: the local index has no inventory for them (run youiyoux inventory)."] : []),
        ...(swaps.some((s) => s.kind === "element") ? ["System elements are named, not counted: youiyoux where-used counts their sites."] : []),
      ],
    };
    const next: LibraryDraft = { ...draft, preview, updatedAt: this.now(), events: [...draft.events, this.event(actor, "previewed", `${capitalized(previewSummary({ ...draft, preview }))}.`)] };
    await this.options.store.put(next);
    return this.refreshed(next, after);
  }

  /** An ingest draft's preview: each kept item's Library file, new or an edit, and what the items are not. */
  private async previewIngest(actor: Actor, draft: IngestDraft): Promise<DraftView> {
    const before = await this.current();
    const problems = await this.problems(draft, before);
    if (problems.length > 0) throw new WorkflowError("invalid", "fix the draft before previewing it", problems);
    const started = performance.now();
    const files: Array<{ id: string; file: string; exists: boolean }> = [];
    for (const entry of keptEntries(draft.content)) {
      const file = libraryPath(entry.id);
      files.push({ id: entry.id, file, exists: (await before.files.read(before.tip, file)) !== null });
    }
    const after = await this.unchangedSince(before);
    const { reading } = draft.content;
    const license = reading.license === "unknown" ? "unknown" : reading.license.spdx;
    const preview: IngestPreview = {
      ...this.previewHead(draft, before, started),
      files,
      dropped: reading.entries.length - files.length,
      license,
      limits: [
        "Nothing is installed and nothing joins the System: approving writes the kept items to the Library as references, each to be requested for adoption on its own.",
        ...(license === "unknown" ? [`${reading.source.name}'s licence is unknown: its items can be kept as references, not adopted, until a licence is found.`] : []),
        ...(files.some((f) => f.exists) ? ["Items already in the Library are rewritten with what this link holds now."] : []),
        ...(reading.skipped.length > 0 ? [`${reading.skipped.length} thing(s) at the link were not read as items; the draft lists them.`] : []),
      ],
    };
    const next: IngestDraft = { ...draft, preview, updatedAt: this.now(), events: [...draft.events, this.event(actor, "previewed", `${capitalized(previewSummary({ ...draft, preview }))}.`)] };
    await this.options.store.put(next);
    return this.refreshed(next, after);
  }

  /** Build the tokens as published and as drafted, and trace every changed value through one fresh scan. */
  private async previewStyle(actor: Actor, draft: StyleDraft): Promise<DraftView> {
    const before = await this.current();
    const problems = await this.problems(draft, before);
    if (problems.length > 0) throw new WorkflowError("invalid", "fix the draft before previewing it", problems);
    const started = performance.now();
    const scan = await scanProject(before.project);
    const impact = await previewStyle({ project: before.project, scan, files: before.files, commit: draft.base.commit, content: draft.content, published: await before.tokens() });
    const after = await this.unchangedSince(before);
    const { report } = scan;
    const preview: StylePreview = {
      ...this.previewHead(draft, before, started),
      scan: { status: report.status, files: report.coverage.filesScanned, failed: report.coverage.failed },
      ...impact,
      limits: [
        ...impact.limits,
        ...(before.designDirty ? ["The design repository has uncommitted changes or another branch checked out; the project scan reads the working tree, the token build reads the draft's base commit."] : []),
        ...(before.snapshot.projectCommit === null ? [`${report.project} is not a git repository: later edits to it cannot be detected, so this preview cannot go stale.`] : []),
      ],
    };
    const failing = preview.contrast.filter((c) => c.change !== "fixed").length;
    const next: StyleDraft = { ...draft, preview, updatedAt: this.now(), events: [...draft.events, this.event(actor, "previewed", `In ${report.project}, ${previewSummary({ ...draft, preview })}${failing ? `; ${failing} colour pair(s) below WCAG AA` : ""}.`)] };
    await this.options.store.put(next);
    return this.refreshed(next, after);
  }

  /**
   * A person approves exactly the revision and preview they saw. A style draft that puts colour
   * pairs below WCAG AA that passed before (or did not exist) needs `acknowledgeContrast`: exactly
   * those pairs' keys, from one explicit confirmation that named them.
   */
  async approve(actor: Actor, id: string, input: { revision: number; previewId: string; acknowledgeContrast?: readonly string[] }): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "approve", draft);
      if (input.revision !== draft.revision) throw new WorkflowError("conflict", `you are approving revision ${input.revision}, but the draft is at revision ${draft.revision}. Review the current revision first.`);
      if (input.previewId !== draft.preview?.id) throw new WorkflowError("conflict", "the preview changed since you looked at it (it was run again elsewhere). Review the current preview first.");
      const current = await this.current();
      const view = await this.refreshed(draft, current);
      if (view.approval) return view;
      if (!view.canApprove) {
        const reasons = [...view.problems, ...view.baseStale, ...view.previewStale, ...(view.preview ? [] : ["Run the impact preview first."])];
        throw new WorkflowError(view.problems.length ? "invalid" : "stale", "this draft cannot be approved yet", reasons);
      }
      const preview = view.preview!;
      const acknowledged = view.kind === "style" ? contrastAcknowledgement(view.preview!, input.acknowledgeContrast) : [];
      const confirmed = acknowledged.length ? ` Confirmed ${acknowledged.length} colour pair(s) this draft puts below WCAG AA.` : "";
      const next = {
        ...view,
        approval: { by: actor, at: this.now(), draftRevision: draft.revision, draftDigest: draft.digest, previewId: preview.id, snapshotDigest: current.snapshot.digest, baseCommit: current.tip, ...(acknowledged.length ? { contrastAcknowledged: acknowledged } : {}) },
        updatedAt: this.now(),
        events: [...view.events, this.event(actor, "approved", `Approved revision ${draft.revision} after a preview that ${previewSummary(view)}.${confirmed}`)],
      };
      await this.options.store.put(stored(next));
      return this.view(stored(next), current);
    });
  }

  /** Move a draft onto the current tip of the default branch; withdraws any approval. */
  async rebase(actor: Actor, id: string): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "draft", draft);
      const current = await this.current();
      if (draft.base.commit === current.tip) return this.refreshed(draft, current);
      const files: Record<string, string | null> = {};
      const changedUpstream: string[] = [];
      for (const [path, digest] of Object.entries(draft.base.files)) {
        files[path] = await current.files.digest(current.tip, path);
        if (files[path] !== digest) changedUpstream.push(path);
      }
      const note = changedUpstream.length
        ? `Rebased onto ${current.tip.slice(0, 7)}. ${changedUpstream.join(", ")} changed upstream since this draft started; compare before approving.`
        : `Rebased onto ${current.tip.slice(0, 7)}.`;
      const events = [...draft.events, this.event(actor, "rebased", note)];
      if (draft.approval) events.push(this.event(actor, "approval-invalidated", "Approval withdrawn: the draft moved to a new base."));
      const next: Draft = { ...draft, base: { branch: current.branch, commit: current.tip, files }, approval: null, updatedAt: this.now(), events };
      await this.options.store.put(next);
      return this.view(next, current);
    });
  }

  /** Write the approved change to a new review branch in the design repository. */
  async handoff(actor: Actor, id: string): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "handoff", draft);
      const current = await this.current();
      const view = await this.refreshed(draft, current);
      if (!view.canHandoff) throw new WorkflowError("stale", "only a current approval can be handed off", [...view.problems, ...view.baseStale, ...(view.approval ? [] : ["Approve the draft first (an approval is withdrawn when the draft, the design repository or the project changes)."])]);
      const { files, branch, message } = draft.kind === "style" ? await this.styleChange(draft, view as StyleDraftView, current) : draft.kind === "library" ? await this.libraryChange(draft, view as LibraryDraftView, current) : draft.kind === "ingest" ? await this.ingestChange(draft, view as IngestDraftView, current) : await this.ruleChange(draft, view as RuleDraftView, current);
      if (Object.keys(files).length === 0) throw new WorkflowError("invalid", "this draft changes nothing in the design repository");
      const created = await createReviewBranch(current.repo.top, {
        base: draft.base.commit,
        branch,
        protectedBranch: current.branch,
        files: Object.fromEntries(Object.entries(files).map(([path, text]) => [current.files.top(path), text])),
        message,
      });
      const patchFile = await this.options.store.putArtifact(`${draft.id}.patch`, created.diff);
      const top = shellQuote(current.repo.top);
      const [base, head] = [shellQuote(current.branch), shellQuote(branch)];
      const handoff = {
        at: this.now(),
        by: actor,
        branch,
        commit: created.commit,
        base: draft.base.commit,
        files: Object.keys(files),
        diff: created.diff,
        patchFile,
        next: [`git -C ${top} push -u origin ${head}`, `cd ${top} && gh pr create --base ${base} --head ${head} --fill`],
      };
      const settled = stored(view);
      const next: Draft = { ...settled, handoff, updatedAt: this.now(), events: [...settled.events, this.event(actor, "handed-off", `Review branch ${branch} at ${created.commit.slice(0, 7)}, on ${current.branch}@${draft.base.commit.slice(0, 7)}${created.adopted ? " (completing an interrupted hand-off)" : ""}.`)] };
      await this.options.store.put(next);
      return this.view(next, current);
    });
  }

  /** What a rule draft's review branch carries. */
  private async ruleChange(draft: RuleDraft, view: RuleDraftView, current: Current): Promise<{ files: Record<string, string>; branch: string; message: string }> {
    const { rule } = toRuleSpec(draft.content.rule);
    const files = await current.files.filesFor(draft.base.commit, rule!, draft.content);
    const approval = view.approval!;
    const preview = view.preview!;
    const message = [
      `rule: ${draft.mode === "create" ? "add" : "update"} ${rule!.title}`,
      "",
      rule!.statement,
      "",
      `Rule ${rule!.id}, draft ${draft.id} revision ${draft.revision}.`,
      `Approved by ${approval.by.name} at ${approval.at}.`,
      `Impact on ${current.project.config.id}${current.snapshot.projectCommit ? ` @ ${current.snapshot.projectCommit.slice(0, 12)}` : ""}: flags ${preview.flagged} place(s), ${preview.counts.new} new, ${preview.counts.resolved} no longer flagged.`,
    ].join("\n");
    return { files, branch: `youi/rules/${parseId(rule!.id)?.name ?? "rule"}-${draft.id.slice(2, 8)}`, message };
  }

  /** What a style draft's review branch carries: the token files and contracts, edited in place. */
  private async styleChange(draft: StyleDraft, view: StyleDraftView, current: Current): Promise<{ files: Record<string, string>; branch: string; message: string }> {
    const types = new Map((await current.tokens()).map((t) => [t.id, t.type]));
    const { files, problems } = await current.files.styleFilesFor(draft.base.commit, draft.content, types);
    if (problems.length > 0) throw new WorkflowError("invalid", "this draft cannot be written to the design repository", problems);
    const approval = view.approval!;
    const scheme = (edit: StyleDraftContent["tokens"][number]): string => [edit.light !== undefined ? "light" : "", edit.dark === null ? "dark follows light" : edit.dark !== undefined ? "dark" : ""].filter(Boolean).join(", ");
    const lines = [
      ...draft.content.tokens.map((edit) => `- ${edit.path} (${scheme(edit)})`),
      ...draft.content.states.map((edit) => `- ${edit.component.split("/").at(-1)} ${edit.state} ${edit.role} → ${edit.token.split("/").at(-1)}`),
    ];
    const contrast = view.preview!.contrast.filter((c) => c.change !== "fixed").length;
    const confirmed = view.preview!.contrast.filter((c) => approval.contrastAcknowledged?.includes(c.key));
    const message = [
      `style: ${draft.content.title.trim() || `update ${describeStyle(draft.content)}`}`,
      "",
      ...lines,
      "",
      `Style draft ${draft.id} revision ${draft.revision}.`,
      `Approved by ${approval.by.name} at ${approval.at}.`,
      `Impact on ${current.project.config.id}${current.snapshot.projectCommit ? ` @ ${current.snapshot.projectCommit.slice(0, 12)}` : ""}: ${previewSummary(view)}${contrast ? `; ${contrast} colour pair(s) below WCAG AA` : ""}.`,
      ...(confirmed.length ? ["", `${approval.by.name} confirmed these new WCAG AA failures:`, ...confirmed.map((c) => `- ${describeContrast(c)}`)] : []),
    ].join("\n");
    return { files, branch: `youi/style/${styleSlug(draft.content)}-${draft.id.slice(2, 8)}`, message };
  }

  /** What a library draft's review branch carries: the one Library item file. */
  private async libraryChange(draft: LibraryDraft, view: LibraryDraftView, current: Current): Promise<{ files: Record<string, string>; branch: string; message: string }> {
    // Checked again at hand-off: the index may say otherwise now.
    const checked = await this.indexedLicence(draft.content);
    if (stableStringify(checked.entry.license) !== stableStringify(draft.content.entry.license)) throw new WorkflowError("stale", `the Discover index now lists ${draft.content.entry.name}'s licence differently; save the draft again to take it up`);
    const refusal = adoptionRefusal(checked);
    if (refusal) throw new WorkflowError("invalid", refusal);
    const path = libraryPath(draft.content.entry.id);
    const existing = await current.files.read(draft.base.commit, path);
    const text = renderLibraryEntry(draft.content, existing);
    const approval = view.approval!;
    const entry = draft.content.entry;
    const message = [
      `library: ${describeLibrary(draft.content)}`,
      "",
      ...(draft.content.reason ? [draft.content.reason, ""] : []),
      `${entry.id} (${entry.source.ref ?? entry.source.name}), stage ${draft.content.request === "adopt" ? "candidate" : "library"}, licence ${view.preview!.license}.`,
      ...(entry.install ? [`Install, after adoption: ${entry.install.command}`] : []),
      `Library draft ${draft.id} revision ${draft.revision}.`,
      `Approved by ${approval.by.name} at ${approval.at}.`,
    ].join("\n");
    return { files: text === existing ? {} : { [path]: text }, branch: `youi/library/${librarySlug(draft.content)}-${draft.id.slice(2, 8)}`, message };
  }

  /** What an ingest draft's review branch carries: one Library file per kept item. */
  private async ingestChange(draft: IngestDraft, view: IngestDraftView, current: Current): Promise<{ files: Record<string, string>; branch: string; message: string }> {
    const existing = new Map<string, string | null>();
    for (const entry of keptEntries(draft.content)) existing.set(libraryPath(entry.id), await current.files.read(draft.base.commit, libraryPath(entry.id)));
    const all = ingestFiles(draft.content, (path) => existing.get(path) ?? null);
    const files = Object.fromEntries(Object.entries(all).filter(([path, text]) => text !== existing.get(path)));
    const { reading } = draft.content;
    const approval = view.approval!;
    const message = [
      `library: ${describeIngest(draft.content)}`,
      "",
      `Read from ${reading.link} at ${reading.fetchedAt}; licence ${view.preview!.license}.`,
      ...keptEntries(draft.content).map((e) => `- ${e.id}: ${e.name}`),
      "",
      `Ingest draft ${draft.id} revision ${draft.revision}.`,
      `Approved by ${approval.by.name} at ${approval.at}.`,
    ].join("\n");
    return { files, branch: `youi/library/ingest-${ingestSlug(draft.content)}-${draft.id.slice(2, 8)}`, message };
  }

  async discard(actor: Actor, id: string): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "discard", draft);
      const next: Draft = { ...draft, discarded: true, approval: null, updatedAt: this.now(), events: [...draft.events, this.event(actor, "discarded")] };
      await this.options.store.put(next);
      return this.view(next, await this.current());
    });
  }
}

/** One colour pair below AA, in words: "Button default (hover): text on fill, light: 1.21:1, needs 4.5:1". */
function describeContrast(c: StyleContrast): string {
  return `${c.label}, ${c.scheme}: ${c.after === null ? (c.unreadable ?? "could not read colour") : `${c.after.toFixed(2)}:1`}, needs ${c.required}:1`;
}

/** The colour pairs a style draft puts below WCAG AA (they passed before, or did not exist): what its approval must acknowledge. */
function newContrastFailures(preview: StylePreview): StyleContrast[] {
  return preview.contrast.filter((c) => c.change === "new");
}

/** The keys an approval confirms, or a refusal naming every pair when they are not exactly the draft's new failures. */
function contrastAcknowledgement(preview: StylePreview, given: readonly string[] | undefined): string[] {
  const failing = newContrastFailures(preview);
  // A preview from before pairs had keys cannot be confirmed pair by pair.
  if (failing.some((c) => typeof c.key !== "string")) throw new WorkflowError("stale", "this preview predates contrast confirmation; run the impact preview again");
  const keys = failing.map((c) => c.key).sort();
  const acknowledged = [...new Set(given ?? [])].sort();
  if (keys.length === acknowledged.length && keys.every((key, i) => key === acknowledged[i])) return keys;
  if (keys.length === 0) throw new WorkflowError("invalid", "this draft puts no colour pair below WCAG AA, so there is nothing to confirm; approve it without a contrast acknowledgement", acknowledged.map((key) => `not a new failure: ${key}`));
  const unknown = acknowledged.filter((key) => !keys.includes(key));
  throw new WorkflowError("invalid", `this draft puts ${failing.length} colour pair(s) below WCAG AA: confirm exactly these pairs to approve it`, [
    ...failing.map((c) => `${describeContrast(c)}${acknowledged.includes(c.key) ? "" : " (not confirmed)"}`),
    ...unknown.map((key) => `confirmed, but not a new failure of this preview: ${key}`),
  ]);
}

/** A view's stored part: drop the computed fields before persisting. */
function stored(view: Draft | DraftView): Draft {
  const { status: _s, problems: _p, previewStale: _ps, baseStale: _bs, needsRebase: _nr, canApprove: _ca, canHandoff: _ch, ...draft } = view as DraftView;
  return draft;
}

function shellQuote(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}
