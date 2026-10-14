import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RuleSpec } from "@youiyoux/core";
import { loadProject, scanProject } from "@youiyoux/scanner";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer as createMcpServer } from "@youiyoux/mcp";
import { scannerExecution, createReviewBranch, FileStore, renderRuleYaml, RuleWorkflow, toRuleSpec, type Actor, type DraftContent, type DraftView, type RuleDraftView } from "../src/index.ts";
import { git, sandbox, type Sandbox } from "./helpers.ts";

const PERSON: Actor = { kind: "person", name: "captain" };
const AGENT: Actor = { kind: "agent", name: "claude" };
const RAW_COLOR = "youi:demo/rule/color.no-raw-color";
const NATIVE = "youi:demo/rule/components.no-native-controls";

let box: Sandbox;
let workflow: RuleWorkflow;

const open = (): RuleWorkflow => new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new FileStore(box.state) });

beforeEach(async () => {
  box = await sandbox();
  workflow = open();
});

afterEach(async () => {
  await box.dispose();
});

function withRule(draft: RuleDraftView, patch: Partial<DraftContent["rule"]>, components = draft.content.components): DraftContent {
  return { rule: { ...draft.content.rule, ...patch }, components };
}

/** Every draft in this file is a rule draft. */
async function previewRule(id: string): Promise<RuleDraftView> {
  const view = await workflow.preview(PERSON, id);
  if (view.kind !== "rule") throw new Error(`${id} is not a rule draft`);
  return view;
}

async function approved(id: string): Promise<DraftView> {
  const previewed = await workflow.preview(PERSON, id);
  return workflow.approve(PERSON, id, { revision: previewed.revision, previewId: previewed.preview!.id });
}

describe("drafts", () => {
  test("an edit draft starts from the default branch tip and the published rule", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    expect(draft).toMatchObject({ mode: "edit", ruleId: RAW_COLOR, revision: 1, status: "draft", problems: [], canApprove: false });
    expect(draft.base).toMatchObject({ branch: "main", commit: git(box.design, "rev-parse", "main") });
    expect(Object.keys(draft.base.files)).toEqual(["rules/color.no-raw-color.rule.yaml"]);
    expect(draft.content.rule.title).toBe("No raw colours");
  });

  test("survive a restart: a new service over the same store sees the same draft, preview and approval", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { severity: "warn", rollout: { to: "error" } }) });
    await approved(draft.id);
    const reopened = await open().get(PERSON, draft.id);
    expect(reopened).toMatchObject({ revision: 2, status: "approved", canHandoff: true });
    expect(reopened.events.map((e) => e.type)).toEqual(["created", "saved", "previewed", "approved"]);
  });

  test("saving checks the revision, and a saved change withdraws approval", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    await approved(draft.id);
    await expect(workflow.save(PERSON, draft.id, { revision: 7, content: draft.content })).rejects.toMatchObject({ code: "conflict" });
    const saved = await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { title: "No raw colors" }) });
    expect(saved).toMatchObject({ revision: 2, approval: null, status: "draft", canApprove: false });
    expect(saved.previewStale).toContain("The draft changed after this preview.");
    expect(saved.events.at(-1)).toMatchObject({ type: "approval-invalidated", note: "Approval withdrawn: the draft changed." });
  });

  test("only checks that can run are accepted; anything else is a problem, not a silent pass", async () => {
    const draft = await workflow.create(PERSON, { mode: "create" });
    const rule = { id: "youi:demo/rule/custom.thing", title: "Custom", statement: "s", agent: "a" };
    const broken = withRule(draft, { ...rule, check: { engine: "ast-grep", language: "tsx", rule: { kind: "not_a_kind" } } });
    const saved = await workflow.save(PERSON, draft.id, { revision: 1, content: broken });
    expect(saved.problems).toEqual([expect.stringMatching(/^check: a custom ast-grep rule cannot run \(ast-grep rule does not compile for tsx: .*not_a_kind/)]);
    await expect(workflow.preview(PERSON, draft.id)).rejects.toMatchObject({ code: "invalid" });
    const empty = withRule(draft, { ...rule, check: { engine: "youi", id: "native-element", options: { elements: {} } } });
    expect((await workflow.save(PERSON, draft.id, { revision: 2, content: empty })).problems).toEqual([expect.stringContaining("needs options.elements")]);
    expect(scannerExecution.supportedChecks().map((c) => c.id)).toEqual(["raw-color", "arbitrary-value", "native-element", "prop-values", "lookalike-component", null]);
  });

  test("one execution model: an ast-grep rule that compiles previews exactly as youiyoux check runs it", async () => {
    const draft = await workflow.create(PERSON, { mode: "create" });
    const content = withRule(draft, { id: "youi:demo/rule/custom.thing", title: "Custom", statement: "s", agent: "a", check: { engine: "ast-grep", language: "tsx", rule: { kind: "jsx_opening_element" } } });
    expect((await workflow.save(PERSON, draft.id, { revision: 1, content })).problems).toEqual([]);
    const { preview } = await previewRule(draft.id);
    expect(preview).toMatchObject({ enforced: true, counts: { kept: 0, resolved: 0 } });
    expect(preview!.flagged).toBeGreaterThan(0);
  });

  test("a new rule may not reuse an id, and a tightening plan needs a warning", async () => {
    const draft = await workflow.create(PERSON, { mode: "create" });
    const saved = await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { id: RAW_COLOR, title: "t", statement: "s", agent: "a", severity: "error" }) });
    expect(saved.problems).toEqual([`id: ${RAW_COLOR} already exists`, "severity: a planned tightening to error starts as a warning"]);
  });
});

describe("impact preview", () => {
  test("a new rule is measured against the same scan as the published rules", async () => {
    const project = await loadProject(box.project, { designRoot: box.design });
    const scan = await scanProject(project);
    // The fixture silences one raw colour with `youi-ignore color.no-raw-color`; that comment does not name the new rule.
    const silenced = scannerExecution.evaluate(project, scan, project.system.rules.filter((r) => r.id === RAW_COLOR)).suppressed;
    const published = scan.report.violations.filter((v) => v.rule === RAW_COLOR).length + silenced;
    const draft = await workflow.create(PERSON, { mode: "create" });
    await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { id: "youi:demo/rule/color.no-raw-color-again", title: "Again", statement: "No raw colours.", agent: "Use tokens.", check: { engine: "youi", id: "raw-color", options: {} }, files: ["**/*.{ts,tsx,css}"] }) });
    const previewed = await previewRule(draft.id);
    expect(published).toBeGreaterThan(0);
    expect(previewed.preview).toMatchObject({ flagged: published, baseline: 0, counts: { new: published, kept: 0, resolved: 0 }, enforced: true });
    expect(previewed.preview!.limits).toContain(`Ships as a warning. Tightening it to an error later would turn these ${published} place(s) into errors.`);
    expect(previewed).toMatchObject({ status: "previewed", canApprove: true });
  });

  test("an edit shows what it stops flagging", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: NATIVE });
    const check = draft.content.rule.check as { engine: "youi"; id: "native-element"; options: { elements: Record<string, string> } };
    const { button: _dropped, ...elements } = check.options.elements;
    await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { check: { ...check, options: { ...check.options, elements } } }) });
    const { preview } = await previewRule(draft.id);
    expect(preview!.baseline).toBeGreaterThan(0);
    expect(preview!.counts.resolved).toBeGreaterThan(0);
    expect(preview!.findings.filter((f) => f.change === "resolved").every((f) => f.text === "<button>")).toBe(true);
    expect(preview!.flagged).toBe(preview!.baseline - preview!.counts.resolved);
  });

  test("an off rule says plainly that it flags nothing", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { severity: "off" }) });
    const { preview } = await previewRule(draft.id);
    expect(preview).toMatchObject({ flagged: 0, enforced: false });
    expect(preview!.counts.resolved).toBe(preview!.baseline);
    expect(preview!.limits).toContain("Severity is off: once published, this rule flags nothing anywhere.");
  });
});

describe("approval", () => {
  test("is a person's decision, of the revision they saw, after a current preview", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    await expect(workflow.approve(PERSON, draft.id, { revision: 1, previewId: "p-0" })).rejects.toMatchObject({ code: "conflict" });
    const { preview } = await previewRule(draft.id);
    const seen = { revision: 1, previewId: preview!.id };
    await expect(workflow.approve(AGENT, draft.id, seen)).rejects.toMatchObject({ code: "forbidden" });
    await expect(workflow.approve(PERSON, draft.id, { ...seen, revision: 2 })).rejects.toMatchObject({ code: "conflict" });
    const ok = await workflow.approve(PERSON, draft.id, seen);
    expect(ok).toMatchObject({ status: "approved", approval: { by: PERSON, draftRevision: 1 }, canHandoff: true });
  });

  test("is withdrawn, with the reason recorded, when the project changes after the preview", async () => {
    const draft = await approved((await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR })).id);
    await box.editProject("components/orphan.tsx", "export const late = <div style={{ color: \"#ff0000\" }} />;\n");
    const later = await workflow.get(PERSON, draft.id);
    expect(later).toMatchObject({ approval: null, status: "previewed", canHandoff: false, canApprove: false });
    expect(later.previewStale).toEqual(["expo-fixture changed since this preview (new commits or edits)."]);
    expect(later.events.at(-1)).toMatchObject({ type: "approval-invalidated", note: "Approval withdrawn: the design repository or project changed since the approved preview." });
    await expect(workflow.handoff(PERSON, draft.id)).rejects.toMatchObject({ code: "stale" });
  });

  test("is withdrawn when the default branch moves; a rebase notes upstream edits to the same rule", async () => {
    const draft = await approved((await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR })).id);
    const path = "rules/color.no-raw-color.rule.yaml";
    const text = await readFile(join(box.design, path), "utf8");
    const tip = await box.commitDesign(path, text.replace("title: No raw colours", "title: No raw colours anywhere"));
    const moved = await workflow.get(PERSON, draft.id);
    expect(moved.approval).toBeNull();
    expect(moved.baseStale[0]).toMatch(/^main moved from \w{7} to \w{7} since this draft started\. Rebase to continue\.$/);
    const rebased = await workflow.rebase(PERSON, draft.id);
    expect(rebased.base.commit).toBe(tip);
    expect(rebased.baseStale).toEqual([]);
    expect(rebased.events.at(-1)?.note).toContain(`${path} changed upstream since this draft started`);
  });
});

describe("approval of what was seen", () => {
  test("a preview re-run elsewhere cannot be approved unseen", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    const first = await previewRule(draft.id);
    await previewRule(draft.id);
    await expect(workflow.approve(PERSON, draft.id, { revision: 1, previewId: first.preview!.id })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("hand-off", () => {
  test("creates a review branch with only the edit, leaving main and the working tree alone", async () => {
    const draft = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    await workflow.save(PERSON, draft.id, { revision: 1, content: withRule(draft, { severity: "warn", rollout: { to: "error", after: "2026-11-01" } }) });
    await approved(draft.id);
    const main = git(box.design, "rev-parse", "main");
    const done = await workflow.handoff(PERSON, draft.id);
    expect(done).toMatchObject({ status: "handed-off", handoff: { branch: `youi/rules/color.no-raw-color-${draft.id.slice(2, 8)}`, base: main, files: ["rules/color.no-raw-color.rule.yaml"] } });
    expect(git(box.design, "rev-parse", "main")).toBe(main);
    expect(git(box.design, "status", "--porcelain")).toBe("");
    expect(git(box.design, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    const changed = done.handoff!.diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l));
    expect(changed).toEqual(["-severity: error", "+severity: warn", "+rollout:", "+  to: error", '+  after: 2026-11-01']);
    const published = RuleSpec.parse(parseYaml(git(box.design, "show", `${done.handoff!.branch}:rules/color.no-raw-color.rule.yaml`)));
    expect(published).toMatchObject({ severity: "warn", rollout: { to: "error", after: "2026-11-01" } });
    expect(await readFile(done.handoff!.patchFile, "utf8")).toBe(done.handoff!.diff);
    await expect(workflow.save(PERSON, draft.id, { revision: 2, content: draft.content })).rejects.toMatchObject({ code: "conflict" });
  });

  test("an interrupted hand-off is completed by adopting the identical branch; a different one is refused", async () => {
    const created = await workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR });
    await workflow.save(PERSON, created.id, { revision: 1, content: withRule(created, { severity: "warn" }) });
    const draft = await approved(created.id);
    const branch = `youi/rules/color.no-raw-color-${draft.id.slice(2, 8)}`;
    const main = git(box.design, "rev-parse", "main");
    git(box.design, "branch", branch, main);
    await expect(workflow.handoff(PERSON, draft.id)).rejects.toThrow(/already exists with other content/);
    git(box.design, "branch", "-D", branch);
    // As if the service died right after creating the branch: the same commit content exists, nothing was recorded.
    const path = "rules/color.no-raw-color.rule.yaml";
    const text = await readFile(join(box.design, path), "utf8");
    await createReviewBranch(box.design, { base: main, branch, protectedBranch: "main", files: { [path]: text.replace("severity: error", "severity: warn") }, message: "interrupted" });
    const done = await workflow.handoff(PERSON, draft.id);
    expect(done.handoff).toMatchObject({ branch, commit: git(box.design, "rev-parse", branch) });
    expect(done.events.at(-1)?.note).toContain("completing an interrupted hand-off");
  });

  test("never bases a draft on a checked-out feature branch", async () => {
    git(box.design, "checkout", "--quiet", "-b", "feature/x");
    git(box.design, "branch", "-m", "main", "trunk");
    await expect(workflow.create(PERSON, { mode: "edit", ruleId: RAW_COLOR })).rejects.toThrow(/cannot tell the design repository's default branch/);
  });

  test("a new rule lands as a new file plus the contracts that declare it, and agents see it once merged", async () => {
    const draft = await workflow.create(PERSON, { mode: "create" });
    const id = "youi:demo/rule/components.no-native-select";
    await workflow.save(PERSON, draft.id, {
      revision: 1,
      content: withRule(draft, { id, title: "Use the owned Select", statement: "Render Select, never a native <select>.", agent: "Never render a native <select>.", check: { engine: "youi", id: "native-element", options: { elements: { button: "youi:demo/component/button" } } } }, ["youi:demo/component/button"]),
    });
    const done = await workflow.handoff(PERSON, (await approved(draft.id)).id);
    expect(done.handoff!.files).toEqual(["rules/components.no-native-select.rule.yaml", "components/button/button.contract.json"]);
    const mcp = createMcpServer({ projectRoot: box.project, designRoot: box.design, scanTtlMs: 0 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([mcp.connect(b), client.connect(a)]);
    const rules = async (): Promise<string[]> => (JSON.parse(((await client.callTool({ name: "system_get_rules", arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text) as { rules: Array<{ id: string }> }).rules.map((r) => r.id);
    expect(await rules()).not.toContain(id);
    git(box.design, "merge", "--quiet", "--ff-only", done.handoff!.branch);
    expect(await rules()).toContain(id);
    const button = JSON.parse(await readFile(join(box.design, "components/button/button.contract.json"), "utf8")) as { rules: string[] };
    expect(button.rules).toContain(id);
    await client.close();
  });
});

describe("rule files", () => {
  test("an in-place edit changes only the lines that changed", async () => {
    const text = await readFile(join(box.design, "rules/components.no-native-controls.rule.yaml"), "utf8");
    const rule = RuleSpec.parse(parseYaml(text));
    expect(renderRuleYaml(rule, text, "../schema/youi.rule.schema.json")).toBe(text);
    const { rule: error } = toRuleSpec({ ...rule, rollout: null, severity: "error" });
    expect(renderRuleYaml(error!, text, "../schema/youi.rule.schema.json")).toBe(text.replace("severity: warn", "severity: error"));
  });
});
