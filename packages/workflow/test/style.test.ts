import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProject, scanProject } from "@youiyoux/scanner";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileStore, MAX_LISTED, RuleWorkflow, type Actor, type DraftView, type StyleDraftContent, type StyleDraftView } from "../src/index.ts";
import { git, sandbox, type Sandbox } from "./helpers.ts";

const PERSON: Actor = { kind: "person", name: "captain" };
const AGENT: Actor = { kind: "agent", name: "claude" };
const BUTTON = "youi:demo/component/button";
const INPUT = "youi:demo/component/input";
const TOKENS = "tokens/demo/demo.tokens.json";
const DARK = "tokens/demo/demo.dark.tokens.json";

let box: Sandbox;
let workflow: RuleWorkflow;

beforeEach(async () => {
  box = await sandbox();
  workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new FileStore(box.state) });
});

afterEach(async () => {
  await box.dispose();
});

const srgb = (hex: string) => ({ colorSpace: "srgb", components: [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 10000) / 10000), hex });

function style(view: DraftView): StyleDraftView {
  if (view.kind !== "style") throw new Error(`${view.id} is not a style draft`);
  return view;
}

/** A warmer brand in both schemes, a dashed 3px focus ring, a softer spring, and Button's hover re-bound to brand. */
const EDITS: StyleDraftContent = {
  title: "Warmer brand",
  tokens: [
    { path: "color.brand", light: srgb("#c2410c"), dark: srgb("#fb923c") },
    { path: "focus.ring", light: { color: "{color.accent}", width: { value: 3, unit: "px" }, offset: { value: 2, unit: "px" }, style: "dashed" } },
    { path: "motion.spring.snappy", light: { stiffness: 300, damping: 30, mass: 1 } },
    { path: "color.background", light: srgb("#fffdf8") },
  ],
  states: [{ component: BUTTON, state: "hover", role: "bg.default", token: "youi:demo/token/color.brand" }],
};

async function previewed(content: StyleDraftContent = EDITS): Promise<StyleDraftView> {
  const draft = await workflow.create(PERSON, { kind: "style" });
  await workflow.save(PERSON, draft.id, { revision: 1, content });
  return style(await workflow.preview(PERSON, draft.id));
}

describe("style drafts", () => {
  test("start empty from the default branch tip, bound to every token file and stateful contract", async () => {
    const draft = await workflow.create(PERSON, { kind: "style" });
    expect(draft).toMatchObject({ kind: "style", revision: 1, status: "draft", canApprove: false, content: { title: "", tokens: [], states: [] } });
    expect(draft.base.commit).toBe(git(box.design, "rev-parse", "main"));
    expect(Object.keys(draft.base.files).sort()).toEqual(["components/button/button.contract.json", "components/input/input.contract.json", DARK, TOKENS]);
    expect(draft.problems).toEqual(["nothing changes yet: edit a token or a state"]);
    expect((await workflow.list(PERSON)).drafts.map((d) => d.kind)).toEqual(["style"]);
  });

  test("saving validates each value against its type, aliases, cycles and state bindings", async () => {
    const draft = await workflow.create(PERSON, { kind: "style" });
    const saved = await workflow.save(PERSON, draft.id, {
      revision: 1,
      content: {
        title: "",
        tokens: [
          { path: "motion.spring.snappy", light: { stiffness: -1, damping: 30, mass: 1 } },
          { path: "focus.ring", light: { color: "{color.nope}", width: { value: 2, unit: "px" }, offset: { value: 2, unit: "px" }, style: "solid" } },
          { path: "radius.card", light: "{color.brand}" },
          { path: "color.brand", light: "{color.accent}" },
          { path: "color.nowhere", light: srgb("#000000") },
        ],
        states: [
          { component: BUTTON, state: "hover", role: "bg.ghost", token: "youi:demo/token/color.card" },
          { component: BUTTON, state: "disabled", role: "opacity", token: "youi:demo/token/color.card" },
        ],
      },
    });
    expect(saved.problems).toEqual([
      "tokens.color.nowhere: no token color.nowhere in demo; the style editor changes existing tokens",
      "tokens.focus.ring (light): alias {color.nope} names no token",
      expect.stringMatching(/^tokens\.motion\.spring\.snappy \(light\): \$value\.stiffness: /),
      "tokens.radius.card (light): {color.brand} is a color, not a dimension",
      "tokens: alias cycle color.brand → color.accent → color.brand",
      "states.button.disabled.opacity: color.card is a color; this role takes a number",
      "states.button.hover.bg.ghost: Button's contract defines no hover bg.ghost; states are added in the contract",
    ]);
    await expect(workflow.preview(PERSON, draft.id)).rejects.toMatchObject({ code: "invalid" });
  });

  test("a light value cannot be removed: light: null is refused with what to do instead", async () => {
    const draft = await workflow.create(PERSON, { kind: "style" });
    const saved = await workflow.save(PERSON, draft.id, { revision: 1, content: { title: "", tokens: [{ path: "color.brand", light: null }, { path: "color.accent", light: null, dark: srgb("#000000") }], states: [] } });
    expect(saved.problems).toEqual([
      "tokens.color.accent: the light value cannot be removed; set a value or drop the edit",
      "tokens.color.brand: the light value cannot be removed; set a value or drop the edit",
    ]);
    await expect(workflow.preview(PERSON, draft.id)).rejects.toMatchObject({ code: "invalid" });
    // dark: null still means "dark follows light".
    const dark = await workflow.save(PERSON, draft.id, { revision: 2, content: { title: "", tokens: [{ path: "color.brand", dark: null }], states: [] } });
    expect(dark.problems).toEqual([]);
  });

  test("a font family that would inject CSS is refused by style-draft validation, alone or inside a typography", async () => {
    const INJECTION = 'Geist"; --demo-color-accent: red; --x: "';
    const draft = await workflow.create(PERSON, { kind: "style" });
    const saved = await workflow.save(PERSON, draft.id, {
      revision: 1,
      content: {
        title: "",
        tokens: [
          { path: "font.sans", light: INJECTION },
          { path: "typography.body", light: { fontFamily: ["Geist", "a;b{c}"], fontSize: { value: 14, unit: "px" }, fontWeight: 400, lineHeight: 1.5 } },
        ],
        states: [],
      },
    });
    expect(saved.problems).toEqual([
      expect.stringMatching(/^tokens\.font\.sans \(light\): \$value: a font family name may hold only letters, digits, spaces and hyphens \(no quotes, semicolons, braces, backslashes, angle brackets or control characters\)/),
      expect.stringMatching(/^tokens\.typography\.body \(light\): \$value\.fontFamily\.1: a font family name may hold only/),
    ]);
    await expect(workflow.preview(PERSON, draft.id)).rejects.toMatchObject({ code: "invalid" });
    await expect(workflow.approve(PERSON, draft.id, { revision: 2, previewId: "p-none" })).rejects.toMatchObject({ code: "conflict" });
    // Nothing reached the design repository.
    expect(git(box.design, "status", "--porcelain")).toBe("");
    expect(git(box.design, "branch", "--list", "youi/*")).toBe("");
  });

  test("rule content cannot be saved into a style draft", async () => {
    const draft = await workflow.create(PERSON, { kind: "style" });
    await expect(workflow.save(PERSON, draft.id, { revision: 1, content: { rule: {} as never, components: [] } })).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("style impact preview", () => {
  test("lists every changed token, every site of every affected component and every direct use", async () => {
    const { preview } = await previewed();
    const tokens = Object.fromEntries(preview!.tokens.map((t) => [t.path, t]));
    // Edited, and what follows through aliases (accent reads brand; the focus ring reads accent).
    expect(tokens["color.brand"]).toMatchObject({ cause: "edited", light: { before: "#4f46e5", after: "#c2410c" }, dark: { before: "#8c85ff", after: "#fb923c" } });
    expect(tokens["color.accent"]).toMatchObject({ cause: "follows", light: { after: "#c2410c" } });
    expect(tokens["focus.ring"]).toMatchObject({ cause: "edited", light: { before: "2px solid #4f46e5", after: "3px dashed #c2410c" } });
    expect(tokens["motion.spring.snappy"]!.light.after).toMatch(/^linear\(/);
    expect(preview!.contracts.map((c) => [c.name, c.via]).sort()).toEqual([["Button", "binding"], ["Input", "binding"]]);

    // Every usage-map site of Button and Input, exactly as the scan records them.
    const project = await loadProject(box.project, { designRoot: box.design });
    const scan = await scanProject(project);
    const expected = scan.report.usages.filter((u) => u.element === BUTTON || u.element === INPUT);
    expect(expected.length).toBeGreaterThan(3);
    expect(preview!.totals.sites).toBe(expected.length);
    expect(preview!.sites.map((s) => `${s.file}:${s.line}:${s.column}`)).toEqual(expected.map((u) => `${u.file}:${u.line}:${u.column}`));
    expect(preview!.sites.every((s) => Array.isArray(s.routes) && s.routeSource)).toBe(true);
    expect(preview!.contracts.reduce((n, c) => n + c.sites, 0)).toBe(expected.length);
    // The fixture's stylesheet reads --demo-color-background directly.
    expect(preview!.direct).toEqual([expect.objectContaining({ file: "styles/app.css", uses: 1 })]);
    expect(preview!.totals).toMatchObject({ direct: 1, directFiles: 1 });
    expect(preview!.truncated).toBe(false);
    expect(preview!.routes.length).toBe(preview!.totals.routes);
    expect(preview!.limits.some((l) => l.startsWith("Every site of an affected component is listed"))).toBe(true);
  });

  test("flags a colour pair that falls below WCAG AA, and leaves passing pairs alone", async () => {
    const { preview } = await previewed({ title: "", tokens: [{ path: "color.muted", light: srgb("#c4c4cc") }], states: [] });
    const failing = preview!.contrast.filter((c) => c.change === "new");
    expect(failing.map((c) => `${c.label} ${c.scheme}`)).toEqual(expect.arrayContaining(["color.muted on color.background light", "color.muted on color.card light"]));
    for (const finding of failing) {
      expect(finding).toMatchObject({ kind: "text", required: 4.5, grade: "Fail" });
      expect(finding.after!).toBeLessThan(4.5);
      expect(finding.before!).toBeGreaterThanOrEqual(4.5);
    }
    expect(preview!.contrast.some((c) => c.foreground === "color.foreground")).toBe(false);
    expect(preview!.contrast.some((c) => c.scheme === "dark")).toBe(false);
  });

  test("lists stop at the cap and say so: the totals count every direct use", async () => {
    // One more stylesheet reading a changed token than the preview lists.
    await mkdir(join(box.project, "styles/many"), { recursive: true });
    await Promise.all(Array.from({ length: MAX_LISTED }, (_, i) => writeFile(join(box.project, `styles/many/s${i}.css`), `.s${i} { background: var(--demo-color-background); }\n`)));
    git(box.project, "add", "-A");
    git(box.project, "commit", "--quiet", "-m", "many stylesheets");
    const { preview } = await previewed({ title: "", tokens: [{ path: "color.background", light: srgb("#fffdf8") }], states: [] });
    expect(preview!.totals).toMatchObject({ direct: MAX_LISTED + 1, directFiles: MAX_LISTED + 1 });
    expect(preview!.direct.length).toBe(MAX_LISTED);
    expect(preview!.truncated).toBe(true);
    expect(preview!.limits).toContain(`Showing 5,000 of 5,001 files with direct uses (5,001 direct uses in all); the totals count them all.`);
  }, 120_000);

  test("a re-bound hover that loses contrast is flagged for its contract and state", async () => {
    const { preview } = await previewed({ title: "", tokens: [], states: [{ component: BUTTON, state: "hover", role: "bg.default", token: "youi:demo/token/color.card" }] });
    expect(preview!.contracts).toEqual([expect.objectContaining({ name: "Button", via: "state" })]);
    expect(preview!.contrast).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Button default (hover): text on fill", foreground: "color.on-accent", background: "color.card", change: "new" })]));
  });
});

describe("approval and review branch", () => {
  test("agents can draft and preview but never approve or hand off", async () => {
    const draft = await previewed();
    await expect(workflow.approve(AGENT, draft.id, { revision: draft.revision, previewId: draft.preview!.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(workflow.handoff(AGENT, draft.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  test("approval produces a youi/style branch holding only the edited keys; main and the working tree are untouched", async () => {
    const draft = await previewed();
    const main = git(box.design, "rev-parse", "main");
    const before = { tokens: await readFile(join(box.design, TOKENS), "utf8"), dark: await readFile(join(box.design, DARK), "utf8"), button: await readFile(join(box.design, "components/button/button.contract.json"), "utf8") };
    const approved = await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id });
    expect(approved).toMatchObject({ status: "approved", canHandoff: true });
    const done = style(await workflow.handoff(PERSON, draft.id));
    const branch = `youi/style/warmer-brand-${draft.id.slice(2, 8)}`;
    expect(done.handoff).toMatchObject({ branch, base: main });
    expect([...done.handoff!.files].sort()).toEqual(["components/button/button.contract.json", DARK, TOKENS]);

    // Never a direct write: the default branch, HEAD and the working tree are as they were.
    expect(git(box.design, "rev-parse", "main")).toBe(main);
    expect(git(box.design, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(box.design, "status", "--porcelain")).toBe("");
    expect(await readFile(join(box.design, TOKENS), "utf8")).toBe(before.tokens);

    // Only the edited keys change: parsed, the files differ exactly at the edited paths.
    const show = (path: string) => JSON.parse(git(box.design, "show", `${branch}:${path}`)) as Record<string, any>;
    const light = show(TOKENS);
    const was = JSON.parse(before.tokens) as Record<string, any>;
    expect(light.color.brand.$value).toEqual(srgb("#c2410c"));
    expect(light.focus.ring.$value.style).toBe("dashed");
    expect(light.motion.spring.snappy.$value).toEqual({ stiffness: 300, damping: 30, mass: 1 });
    for (const path of ["color.brand", "focus.ring", "motion.spring.snappy", "color.background"]) {
      const [group, ...rest] = path.split(".");
      let a: any = light[group!];
      let b: any = was[group!];
      for (const key of rest) [a, b] = [a[key], b[key]];
      a.$value = b.$value;
    }
    expect(light).toEqual(was);
    expect(show(DARK).color.brand.$value).toEqual(srgb("#fb923c"));
    expect(show("components/button/button.contract.json").states.hover["bg.default"]).toBe("youi:demo/token/color.brand");

    // And textually: every changed line is inside an edited value (no reformatting, no reordering).
    const numstat = git(box.design, "diff", "--numstat", main, branch).split("\n").map((l) => l.split("\t"));
    expect(Object.fromEntries(numstat.map(([added, removed, file]) => [file, [Number(added), Number(removed)]]))).toEqual({
      "components/button/button.contract.json": [1, 1],
      // brand: three channels and the hex.
      [DARK]: [4, 4],
      // brand (3 channels, hex), background (2 channels that moved, hex), focus ring width and style, spring stiffness and damping.
      [TOKENS]: [11, 11],
    });
    expect(done.handoff!.diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l)).every((l) => /"(?:components|hex|value|style|stiffness|damping|bg\.default)"|^[+-]\s+-?\d/.test(l))).toBe(true);
    expect(done.events.at(-1)).toMatchObject({ type: "handed-off" });
    expect(git(box.design, "log", "-1", "--format=%s", branch)).toBe("style: Warmer brand");
  });

  test("new WCAG AA failures need one confirmation that names them; approving without it, or with other pairs, is refused", async () => {
    const draft = await previewed({ title: "Quieter muted", tokens: [{ path: "color.muted", light: srgb("#c4c4cc") }], states: [] });
    const failing = draft.preview!.contrast.filter((c) => c.change === "new");
    expect(failing.length).toBeGreaterThanOrEqual(2);
    const keys = failing.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const named = (error: unknown) => (error as { problems: string[] }).problems;

    // No confirmation: refused, naming each pair with its scheme, ratio and what it needs.
    const refused = await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "invalid", message: `this draft puts ${failing.length} colour pair(s) below WCAG AA: confirm exactly these pairs to approve it` });
    expect(named(refused)).toEqual(expect.arrayContaining([expect.stringMatching(/^color\.muted on color\.background, light: \d\.\d\d:1, needs 4\.5:1 \(not confirmed\)$/), expect.stringMatching(/^color\.muted on color\.card, light: \d\.\d\d:1, needs 4\.5:1 \(not confirmed\)$/)]));
    expect(named(refused)).toHaveLength(failing.length);

    // Only some of them, or one that is not a failure of this preview: refused too.
    const partial = await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id, acknowledgeContrast: keys.slice(1) }).catch((error: unknown) => error);
    expect(partial).toMatchObject({ code: "invalid" });
    expect(named(partial).filter((p) => p.endsWith("(not confirmed)"))).toHaveLength(1);
    const extra = await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id, acknowledgeContrast: [...keys, "surface:color.ink|color.paper|light"] }).catch((error: unknown) => error);
    expect(named(extra)).toContain("confirmed, but not a new failure of this preview: surface:color.ink|color.paper|light");
    expect((await workflow.get(PERSON, draft.id)).approval).toBeNull();

    // Exactly those pairs: approved, recorded, and named in the review branch's commit.
    const approved = await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id, acknowledgeContrast: [...keys].reverse() });
    expect(approved).toMatchObject({ status: "approved", canHandoff: true, approval: { contrastAcknowledged: [...keys].sort() } });
    expect(approved.events.at(-1)?.note).toContain(`Confirmed ${failing.length} colour pair(s) this draft puts below WCAG AA.`);
    const done = await workflow.handoff(PERSON, draft.id);
    const message = git(box.design, "log", "-1", "--format=%B", done.handoff!.branch);
    expect(message).toContain("captain confirmed these new WCAG AA failures:");
    expect(message).toMatch(/- color\.muted on color\.card, light: \d\.\d\d:1, needs 4\.5:1/);
    expect(git(box.design, "status", "--porcelain")).toBe("");
  });

  test("a draft with no new contrast failure approves without a confirmation, and refuses one it does not need", async () => {
    const draft = await previewed({ title: "", tokens: [{ path: "radius.card", light: { value: 16, unit: "px" } }], states: [] });
    expect(draft.preview!.contrast.filter((c) => c.change === "new")).toEqual([]);
    await expect(workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id, acknowledgeContrast: ["surface:color.muted|color.card|light"] })).rejects.toMatchObject({ code: "invalid" });
    expect(await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id })).toMatchObject({ status: "approved" });
  });

  test("dark edits go to the dark file: a new override is added, null removes one so dark follows light", async () => {
    const draft = await previewed({
      title: "",
      tokens: [
        { path: "color.accent", dark: "{color.danger}" },
        { path: "color.brand", dark: null },
        { path: "radius.card", light: { value: 16, unit: "px" } },
      ],
      states: [],
    });
    expect(draft.problems).toEqual([]);
    const tokens = Object.fromEntries(draft.preview!.tokens.map((t) => [t.path, t]));
    expect(tokens["color.accent"]!.dark).toEqual({ before: "#8c85ff", after: "#ff8a80" });
    expect(tokens["color.brand"]!.dark).toEqual({ before: "#8c85ff", after: "#4f46e5" });
    expect(tokens["radius.card"]!.light).toEqual({ before: "12px", after: "16px" });
    await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id });
    const done = await workflow.handoff(PERSON, draft.id);
    const dark = JSON.parse(git(box.design, "show", `${done.handoff!.branch}:${DARK}`)) as { color: Record<string, unknown> };
    expect(dark.color.accent).toEqual({ $type: "color", $value: "{color.danger}" });
    expect(dark.color.brand).toBeUndefined();
    const light = JSON.parse(git(box.design, "show", `${done.handoff!.branch}:${TOKENS}`)) as { radius: { card: { $value: unknown } } };
    expect(light.radius.card.$value).toEqual({ value: 16, unit: "px" });
  });

  test("a saved edit withdraws the approval; a moved default branch needs a rebase that notes upstream token edits", async () => {
    const draft = await previewed();
    await workflow.approve(PERSON, draft.id, { revision: draft.revision, previewId: draft.preview!.id });
    const resaved = await workflow.save(PERSON, draft.id, { revision: draft.revision, content: { ...EDITS, title: "Warmer brand, again" } });
    expect(resaved).toMatchObject({ approval: null, canApprove: false });
    expect(resaved.previewStale).toContain("The draft changed after this preview.");
    const text = await readFile(join(box.design, TOKENS), "utf8");
    const tip = await box.commitDesign(TOKENS, text.replace('"Card: cards and panels."', '"Card: cards, panels and sheets."'));
    const moved = await workflow.get(PERSON, draft.id);
    expect(moved.needsRebase).toBe(true);
    const rebased = await workflow.rebase(PERSON, draft.id);
    expect(rebased.base.commit).toBe(tip);
    expect(rebased.events.at(-1)?.note).toContain(`${TOKENS} changed upstream since this draft started`);
  });

  test("survive a restart, and old drafts without a kind load as rule drafts", async () => {
    const draft = await previewed();
    const reopened = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new FileStore(box.state) });
    expect(await reopened.get(PERSON, draft.id)).toMatchObject({ kind: "style", status: "previewed", revision: 2 });
    const rule = await workflow.create(PERSON, { mode: "edit", ruleId: "youi:demo/rule/color.no-raw-color" });
    const file = join(box.state, "drafts", `${rule.id}.json`);
    const stored = JSON.parse(await readFile(file, "utf8")) as { draft: { kind?: string } };
    delete stored.draft.kind;
    await writeFile(file, JSON.stringify(stored));
    expect(await reopened.get(PERSON, rule.id)).toMatchObject({ kind: "rule", mode: "edit" });
  });
});
