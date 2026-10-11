/**
 * The rule-editor workflow: draft → save → preview → approve → hand off to review.
 *
 * Saving never publishes and never approves. A draft is bound to the design commit it
 * started from and to the digest of its content; a preview is bound to the exact design
 * and project state it scanned; an approval is bound to all three. When any of them moves,
 * the approval is withdrawn (and the withdrawal recorded) before anything can rely on it.
 * The hand-off creates a review branch in the design repository and never touches the
 * default branch or the working tree.
 */
import { randomBytes } from "node:crypto";
import { loadProject, scanProject, SCANNER_VERSION, type LoadProjectOptions, type Project } from "@youiyoux/scanner";
import { parseId, shortHash, stableStringify } from "@youiyoux/core";
import type { Actor, Draft, DraftContent, DraftEvent, DraftView, Preview, PublishedRule, SnapshotIdentity, WorkflowInfo } from "./api.ts";
import { DesignFiles } from "./design-files.ts";
import { contentDigest, draftStatus, fieldsFromRule, newRuleFields, toRuleSpec, validateContent } from "./drafts.ts";
import { builtinExecution, type RuleExecution } from "./execution.ts";
import { branchTip, changesDigest, createReviewBranch, defaultBranch, hasChanges, headCommit, locate, type RepoLocation } from "./git.ts";
import { authorize, WorkflowError, type Action } from "./policy.ts";
import { comparePreview } from "./preview.ts";
import type { WorkflowStore } from "./store.ts";

export const WORKFLOW_VERSION = "0.1.0";

export interface WorkflowOptions extends LoadProjectOptions {
  readonly projectRoot: string;
  readonly store: WorkflowStore;
  readonly execution?: RuleExecution;
  readonly now?: () => Date;
  readonly newId?: (prefix: "d" | "p") => string;
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
}

const randomId = (prefix: "d" | "p"): string => `${prefix}-${randomBytes(5).toString("hex")}`;

export class RuleWorkflow {
  private readonly options: WorkflowOptions;
  private readonly execution: RuleExecution;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: WorkflowOptions) {
    this.options = options;
    this.execution = options.execution ?? builtinExecution;
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
    const { projectRoot, configPath, designRoot } = this.options;
    const project = await loadProject(projectRoot, { ...(configPath ? { configPath } : {}), ...(designRoot ? { designRoot } : {}) });
    const repo = await locate(project.repo.root);
    if (!repo) throw new WorkflowError("invalid", `the design definitions at ${project.repo.root} are not in a git repository; drafts need a commit to start from`);
    const branch = await defaultBranch(repo.top);
    const [tip, head, dirty] = await Promise.all([branchTip(repo.top, branch), headCommit(repo.top), hasChanges(repo.top, [repo.prefix || "."])]);
    const projectRepo = await locate(project.root);
    const [projectCommit, projectChanges] = projectRepo ? await Promise.all([headCommit(projectRepo.top), changesDigest(projectRepo.top)]) : [null, null];
    const designDirty = dirty || head !== tip;
    const identity = { designCommit: tip, designDirty, project: project.config.id, projectCommit, projectChanges, scanner: SCANNER_VERSION };
    return { project, repo, files: new DesignFiles(repo, project), branch, tip, designDirty, snapshot: { ...identity, digest: shortHash(stableStringify(identity)) } };
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

  private problems(draft: Draft, current: Current): string[] {
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

  private view(draft: Draft, current: Current): DraftView {
    const status = draftStatus(draft);
    const open = status !== "discarded" && status !== "handed-off";
    // A closed draft is history: judging it against today's definitions (where its rule may now exist) would only mislead.
    const problems = open ? this.problems(draft, current) : [];
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
    };
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
      limits: [
        `One design repository and one project (${current.project.config.id}).`,
        `Approved changes become a local review branch in the design repository; nothing is pushed or merged for you.`,
        `Only checks this editor can run are offered (${this.execution.name}).`,
        ...(current.snapshot.projectCommit === null ? [`${current.project.config.id} is not a git repository, so edits to it cannot be detected: approvals are not withdrawn when its code changes.`] : []),
      ],
    };
  }

  async published(actor: Actor): Promise<PublishedRule[]> {
    authorize(actor, "read");
    const current = await this.current();
    const files = await current.files.ruleFiles(current.tip);
    return Promise.all(
      current.project.system.rules.map(async (rule) => ({
        rule,
        file: files.get(rule.id)?.path ?? (await current.files.rulePath(current.tip, rule.id)),
        components: current.project.system.components.filter((c) => c.contract.rules.includes(rule.id)).map((c) => c.contract.id),
      })),
    );
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

  async create(actor: Actor, input: { mode: "edit"; ruleId: string } | { mode: "create" }): Promise<DraftView> {
    authorize(actor, "draft");
    const current = await this.current();
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
    const draft: Draft = {
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

  /** Save content. Saving is only saving: it withdraws any approval and never publishes. */
  async save(actor: Actor, id: string, input: { revision: number; content: DraftContent }): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "draft", draft);
      if (input.revision !== draft.revision) throw new WorkflowError("conflict", `draft ${id} is at revision ${draft.revision}, not ${input.revision}: it was saved elsewhere. Reload it before saving.`);
      const current = await this.current();
      const digest = contentDigest(input.content);
      if (digest === draft.digest) return this.refreshed(draft, current);
      const events = [...draft.events, this.event(actor, "saved", `Revision ${draft.revision + 1}.`)];
      if (draft.approval) events.push(this.event(actor, "approval-invalidated", "Approval withdrawn: the draft changed."));
      const next: Draft = {
        ...draft,
        ruleId: draft.mode === "create" ? input.content.rule.id.trim() : draft.ruleId,
        revision: draft.revision + 1,
        digest,
        content: input.content,
        approval: null,
        updatedAt: this.now(),
        events,
      };
      await this.options.store.put(next);
      return this.view(next, current);
    });
  }

  /** Evaluate the draft and the published rule over one fresh scan of the project. */
  async preview(actor: Actor, id: string): Promise<DraftView> {
    return this.locked(id, async () => {
      const draft = await this.load(id);
      this.guard(actor, "preview", draft);
      const before = await this.current();
      const problems = this.problems(draft, before);
      const { rule } = toRuleSpec(draft.content.rule);
      if (!rule || problems.length > 0) throw new WorkflowError("invalid", "fix the draft before previewing it", problems);
      const started = performance.now();
      const scan = await scanProject(before.project);
      const baseline = before.project.system.rules.find((r) => r.id === draft.ruleId) ?? null;
      const comparison = comparePreview({ project: before.project, scan, execution: this.execution, draft: rule, baseline: draft.mode === "edit" ? baseline : null });
      const after = await this.current();
      if (after.snapshot.digest !== before.snapshot.digest) throw new WorkflowError("stale", "the project or design repository changed while the preview ran; run it again");
      const { report } = scan;
      const designLimits = [
        ...(before.designDirty ? ["The design repository has uncommitted changes or another branch checked out; this preview reads the working tree."] : []),
        ...(before.snapshot.projectCommit === null ? [`${report.project} is not a git repository: later edits to it cannot be detected, so this preview cannot go stale.`] : []),
      ];
      const preview: Preview = {
        id: this.id("p"),
        at: this.now(),
        draftRevision: draft.revision,
        draftDigest: draft.digest,
        snapshot: before.snapshot,
        durationMs: Math.round(performance.now() - started),
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

  /** A person approves exactly the revision and preview they saw. */
  async approve(actor: Actor, id: string, input: { revision: number; previewId: string }): Promise<DraftView> {
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
      const next: Draft = {
        ...view,
        approval: { by: actor, at: this.now(), draftRevision: draft.revision, draftDigest: draft.digest, previewId: preview.id, snapshotDigest: current.snapshot.digest, baseCommit: current.tip },
        updatedAt: this.now(),
        events: [...view.events, this.event(actor, "approved", `Approved revision ${draft.revision} after a preview that flags ${preview.flagged} place(s).`)],
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
      const { rule } = toRuleSpec(draft.content.rule);
      const files = await current.files.filesFor(draft.base.commit, rule!, draft.content);
      if (Object.keys(files).length === 0) throw new WorkflowError("invalid", "this draft changes nothing in the design repository");
      const branch = `youi/rules/${parseId(rule!.id)?.name ?? "rule"}-${draft.id.slice(2, 8)}`;
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

/** A view's stored part: drop the computed fields before persisting. */
function stored(view: Draft | DraftView): Draft {
  const { status: _s, problems: _p, previewStale: _ps, baseStale: _bs, needsRebase: _nr, canApprove: _ca, canHandoff: _ch, ...draft } = view as DraftView;
  return draft;
}

function shellQuote(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}
