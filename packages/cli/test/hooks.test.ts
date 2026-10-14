import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { githubSlug, hookCommand, installClaudeHook, installPreCommit, installWorkflow, main, runClaudeHook, runPreCommitHook, shellQuote, workflowText } from "../src/index.ts";
import { expectOnlyNpx } from "./bare-command.ts";
import { addDrift, cli, driftFixture, repoModeWithOldFailures, type Fixture } from "./drift-fixture.ts";

const run = promisify(execFile);
const EXAMPLES = join(import.meta.dirname, "../../../examples");
const TOOL = join(import.meta.dirname, "../../..");
const RAW_COLOR = `export function Extra() {\n  return <p style={{ color: "#ff0000" }}>Paid</p>;\n}\n`;
const CLEAN = `export function Extra() {\n  return <p>Paid</p>;\n}\n`;

let dir = "";
let app = "";
const git = (...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: app });
const payload = (file: string) => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", cwd: app, tool_input: { file_path: file } });
const contextOf = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

/** A clean component edit: only the pass line and how to see it, no findings, drift or older debt. */
function expectOnlySeeIt(stdout: string, file: string): void {
  const context = contextOf(stdout);
  expect(context.startsWith(`youiyoux: ${file} passes the design-system check. See it: npx -y youiyoux render `)).toBe(true);
  expect(context).not.toMatch(/Fix:|older findings|incomplete|#ff0000|parse/);
  expect(context.split("\n")).toHaveLength(1);
}

// Git must not see the developer's own configuration (a global core.hooksPath would redirect installs).
const savedEnv = { ...process.env };
beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_CONFIG")) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
});
afterAll(() => {
  process.env = savedEnv;
});

beforeEach(async () => {
  // A space in every path the hooks see.
  dir = await mkdtemp(join(tmpdir(), "youiyoux hooks "));
  app = join(dir, "demo app");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  await git("init", "-q");
  // No detached auto-maintenance (repack) still writing into .git when afterEach deletes the repo.
  await git("config", "maintenance.auto", "false");
  await git("config", "gc.auto", "0");
  await git("add", "-A");
  await git("commit", "-qm", "init");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("Claude Code PostToolUse hook", () => {
  test("returns the edited file's violations as additional context, and never blocks", async () => {
    await writeFile(join(app, "components/extra file.tsx"), RAW_COLOR);
    const outcome = await runClaudeHook(payload("components/extra file.tsx"));
    expect(outcome.exitCode).toBe(0);
    const context = contextOf(outcome.stdout);
    expect(context).toContain("advisory");
    expect(context).toMatch(/components\/extra file\.tsx:2:\d+ rule color\.no-raw-color/);
    expect(context).not.toContain("invite-form");
    expectOnlyNpx(context);
  });

  test("for a clean component file, says only how to see it; it never renders inside the hook", async () => {
    await writeFile(join(app, "components/extra file.tsx"), CLEAN);
    const context = contextOf((await runClaudeHook(payload(join(app, "components/extra file.tsx")))).stdout);
    expect(context).toBe("youiyoux: components/extra file.tsx passes the design-system check. See it: npx -y youiyoux render 'components/extra file.tsx' (or the MCP tool ui_render), then open the images: light and dark, desktop and phone, accessibility issues and the diff against the base.");
  });

  test("a component file's findings end with the line that says how to see it", async () => {
    await writeFile(join(app, "components/extra file.tsx"), RAW_COLOR);
    expect(contextOf((await runClaudeHook(payload("components/extra file.tsx"))).stdout).split("\n").at(-1)).toMatch(/^See it: npx -y youiyoux render 'components\/extra file\.tsx' \(or the MCP tool ui_render\)/);
  });

  test("is silent for clean non-component files, generated output, unchecked files and bad input", async () => {
    await writeFile(join(app, "components/extra.ts"), `export const gap = 4;\n`);
    expect((await runClaudeHook(payload(join(app, "components/extra.ts")))).stdout).toBe("");
    await mkdir(join(app, "src/design"), { recursive: true });
    await writeFile(join(app, "src/design/tokens.ts"), `export const c = "#ff0000";\n`);
    expect((await runClaudeHook(payload("src/design/tokens.ts"))).stdout).toBe("");
    expect((await runClaudeHook(payload("README.md"))).stdout).toBe("");
    expect((await runClaudeHook("not json")).stdout).toBe("");
    expect((await runClaudeHook(JSON.stringify({ tool_input: {} }))).stdout).toBe("");
  });

  test("with a baseline, reports only what the edit added", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["baseline", "--project", app])).toBe(0);
    expect(contextOf((await runClaudeHook(payload("app/settings/index.tsx"))).stdout)).toMatch(/^youiyoux: app\/settings\/index\.tsx passes the design-system check\. See it: /);
    const settings = join(app, "app/settings/index.tsx");
    await writeFile(settings, `${await readFile(settings, "utf8")}\nexport const Bad = () => <p style={{ color: "#00ff00" }} />;\n`);
    const context = contextOf((await runClaudeHook(payload(settings))).stdout);
    expect(context).toContain("#00ff00");
    expect(context).toContain("1 older findings on unchanged lines omitted");
  });
});

describe("git pre-commit hook", () => {
  test("checks staged content, advisory unless strict", async () => {
    await writeFile(join(app, "components/extra file.tsx"), RAW_COLOR);
    await git("add", "components/extra file.tsx");
    await writeFile(join(app, "components/extra file.tsx"), CLEAN); // unstaged fix: the commit would still carry the bad version
    const target = { project: app };
    const advisory = await runPreCommitHook(target);
    expect(advisory.exitCode).toBe(0);
    expect(advisory.stdout).toContain("advisory; CI is authoritative");
    expect(advisory.stdout).toContain("components/extra file.tsx:2");
    expect((await runPreCommitHook(target, { strict: true })).exitCode).toBe(1);
  });

  test("is silent when nothing checked is staged", async () => {
    await writeFile(join(app, "notes.md"), "hi\n");
    await git("add", "notes.md");
    expect(await runPreCommitHook({ project: app })).toEqual({ stdout: "", exitCode: 0 });
  });

  test("installed with --strict, git runs it and blocks the commit", async () => {
    const result = await installPreCommit(app, hookCommand(TOOL, "pre-commit", { project: app }, ["--strict"]), true);
    expect(result.action).toBe("created");
    expect((await stat(result.file)).mode & 0o111).not.toBe(0);
    await writeFile(join(app, "components/extra file.tsx"), RAW_COLOR);
    await git("add", "-A");
    await expect(git("commit", "-qm", "bad")).rejects.toThrow(/commit blocked/);
    await writeFile(join(app, "components/extra file.tsx"), CLEAN);
    await git("add", "-A");
    await expect(git("commit", "-qm", "good")).resolves.toBeTruthy();
  }, 60_000);

  test("installed from a config kept beside the design repo (--project <its dir> --root <product>), the hook finds both", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const pilot = join(dir, "demo-design/pilot");
    await mkdir(pilot, { recursive: true });
    const config = JSON.parse(await readFile(join(app, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(pilot, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: ".." } }));
    await git("rm", "-q", "youi.project.json");
    await git("commit", "-qm", "config lives in the design repo");
    expect(await main(["hooks", "install", "--git", "--strict", "--project", pilot, "--root", app])).toBe(0);
    const hook = await readFile(join(app, ".git/hooks/pre-commit"), "utf8");
    expect(hook).toContain(`--config ${shellQuote(join(pilot, "youi.project.json"))}`);
    expect(hook).toContain(`--root ${shellQuote(app)}`);
    await writeFile(join(app, "components/extra file.tsx"), RAW_COLOR);
    await git("add", "-A");
    await expect(git("commit", "-qm", "bad")).rejects.toThrow(/commit blocked[\s\S]*components\/extra file\.tsx:2/);
  }, 60_000);
});

describe("hooks install", () => {
  test("keeps existing Claude settings and hooks; reinstalling changes nothing", async () => {
    const file = join(app, ".claude/settings.local.json");
    await mkdir(join(app, ".claude"), { recursive: true });
    const mine = { permissions: { allow: ["Bash(ls)"] }, hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    await writeFile(file, JSON.stringify(mine));
    const command = hookCommand(TOOL, "claude", { project: app });
    expect((await installClaudeHook(app, command)).action).toBe("updated");
    const settings = JSON.parse(await readFile(file, "utf8")) as typeof mine;
    expect(settings.permissions).toEqual(mine.permissions);
    expect(settings.hooks.Stop).toEqual(mine.hooks.Stop);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0]).toEqual(mine.hooks.PostToolUse[0]);
    expect((await installClaudeHook(app, command)).action).toBe("unchanged");
  });

  test("refuses to overwrite invalid settings", async () => {
    await mkdir(join(app, ".claude"), { recursive: true });
    await writeFile(join(app, ".claude/settings.local.json"), "{ nope");
    await expect(installClaudeHook(app, "x")).rejects.toThrow(/not valid JSON/);
  });

  test("appends to an existing shell pre-commit once, and leaves other hooks alone", async () => {
    const file = join(app, ".git/hooks/pre-commit");
    await writeFile(file, "#!/bin/bash\nnpm run lint\n");
    await installPreCommit(app, "youi-one", false);
    await installPreCommit(app, "youi-two", false);
    const script = await readFile(file, "utf8");
    expect(script).toContain("npm run lint");
    expect(script.match(/>>> youi pre-commit >>>/g)).toHaveLength(1);
    expect(script).toContain("youi-two || exit $?");
    expect(script).not.toContain("youi-one");
    await writeFile(file, "#!/usr/bin/env python3\nprint('hi')\n");
    await expect(installPreCommit(app, "youi", false)).rejects.toThrow(/not a shell script/);
  });

  test("quotes paths with spaces and quotes", () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(shellQuote("/plain/path")).toBe("/plain/path");
    expect(hookCommand("/tool dir", "claude", { project: "/my app" })).toBe(`node '/tool dir/packages/cli/bin/youi.js' hooks run claude --project '/my app'`);
  });

  test("the CI workflow pins the tool and the rules version and runs the baseline check", () => {
    expect(githubSlug("https://github.com/acme/acme-design.git")).toBe("acme/acme-design");
    expect(githubSlug("git@github.com:acme/youiyoux.git")).toBe("acme/youiyoux");
    expect(githubSlug("https://gitlab.com/a/b")).toBeNull();
    const text = workflowText({ tool: { slug: "acme/youiyoux", commit: "a".repeat(40) }, design: { slug: "acme/acme-design", commit: "b".repeat(40) }, projectDir: ".", configPath: ".youi-ci/design/pilots/acme-app/youi.project.json" });
    expect(text).toContain(`ref: ${"b".repeat(40)}`);
    expect(text).toContain("check --baseline --format github --project . --design .youi-ci/design --config .youi-ci/design/pilots/acme-app/youi.project.json --root .");
  });

  test("for a product at its repo root the CI workflow passes --root ., never an empty argument", () => {
    const text = workflowText({ tool: { slug: "acme/youiyoux", commit: "a".repeat(40) }, design: { slug: "acme/acme-design", commit: "b".repeat(40) }, projectDir: "", configPath: ".youi-ci/design/pilots/acme-app/youi.project.json" });
    expect(text).toContain("check --baseline --format github --project . --design .youi-ci/design --config .youi-ci/design/pilots/acme-app/youi.project.json --root .\n");
    expect(text).not.toContain("''");
  });
});

describe("drift findings reach the agent after a UI edit", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await driftFixture();
  }, 60_000);
  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
  });
  const edit = (file: string) => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", cwd: fixture.app, tool_input: { file_path: file } });

  test("Claude Code PostToolUse: the edited file's drift, each with its fix, as additional context; exits 0", async () => {
    await addDrift(fixture.app);
    const promo = await runClaudeHook(edit("components/promo.tsx"));
    expect(promo.exitCode).toBe(0);
    const context = contextOf(promo.stdout);
    expect(context).toContain("advisory");
    expect(context).toMatch(/components\/promo\.tsx:1:1 off-library import: .*MUI.* Fix: import \{ Button \} from "@\/components\/ui"/);
    expect(context).toMatch(/components\/promo\.tsx:2:1 off-library import: .* Fix: use the dialog from "@radix-ui\/react-dialog" instead/);
    expect(context).toMatch(/components\/promo\.tsx:6:\d+ hardcoded value \(also rule tokens\.no-arbitrary-values\): .* Fix: use rounded-control \(radius\.control, var\(--demo-radius-control\)\)/);
    expect(context).toContain("Fix: use p-[var(--demo-space-md)] (space.md)");
    expect(context).toContain("Fix: use var(--demo-color-brand) (color.brand)");
    // Only the edited file.
    expect(context).not.toContain("quiet-button");
    expect(context).not.toContain("app/index.tsx");

    const quiet = contextOf((await runClaudeHook(edit(join(fixture.app, "components/quiet-button.tsx")))).stdout);
    expect(quiet).toMatch(/components\/quiet-button\.tsx:3:1 near-duplicate: QuietButton is a new button that looks like the existing Button variant="ghost".* Fix: use <Button variant="ghost"> from "@\/components\/ui"/);
  });

  test("an edit that adds no drift adds nothing; the demo's committed violations are not drift", async () => {
    const settings = join(fixture.app, "app/settings/index.tsx");
    await writeFile(settings, (await readFile(settings, "utf8")).replace("<Button>Save</Button>", "<Button>Save now</Button>"));
    expectOnlySeeIt((await runClaudeHook(edit("app/settings/index.tsx"))).stdout, "app/settings/index.tsx");
  });

  test("one edited line does not flood the agent with committed violations; clean edits are silent", async () => {
    const file = join(fixture.app, "components/flood.tsx");
    const old = 'export const Flood = () => <div>\n' + Array.from({length: 28}, (_, n) => `<p style={{ color: "#ff0000" }}>Old ${n}</p>`).join("\n") + '\n<p>Change me</p>\n</div>;\n';
    await writeFile(file, old);
    await fixture.git("add", "components/flood.tsx");
    await fixture.git("commit", "-qm", "old debt");
    const input = JSON.stringify({ cwd: fixture.app, tool_input: { file_path: file } });
    await writeFile(file, old.replace("Change me", "Clean edit"));
    expectOnlySeeIt((await runClaudeHook(input)).stdout, "components/flood.tsx");
    await fixture.git("add", "components/flood.tsx");
    expect((await runPreCommitHook({project: fixture.app}, {strict: true})).exitCode).toBe(0);
    await writeFile(file, old.replace('<p>Change me</p>', '<p style={{ color: "#00ff00" }}>New</p>'));
    const context = contextOf((await runClaudeHook(input)).stdout);
    expect(context).toContain("#00ff00");
    expect(context).not.toContain("#ff0000");
    expect(context.match(/28 older findings/g)).toHaveLength(1);
    const checked = await cli(["check", "--diff", "--project", fixture.app, "--json"]);
    expect(JSON.parse(checked.out).findings.map((f: {line: number}) => f.line)).toEqual([30]);
    const text = await cli(["check", "--diff", "--project", fixture.app]);
    expect(text.out).not.toContain("#ff0000");
  });

  test("repo mode clean UI edits are silent despite untouched parse failures", async () => {
    await repoModeWithOldFailures(fixture);
    const home = join(fixture.app, "app/index.tsx");
    await writeFile(home, (await readFile(home, "utf8")).replace("Projects</h1>", "My projects</h1>"));
    const outcome = await runClaudeHook(edit("app/index.tsx"));
    expect(outcome.exitCode).toBe(0);
    expectOnlySeeIt(outcome.stdout, "app/index.tsx");
  });

  test("repo mode installs hooks and sends drift back after an edit without a project config", async () => {
    await rm(join(fixture.app, "youi.project.json"));
    await writeFile(join(fixture.app, "theme.css"), ':root { --color-brand: #4f46e5; --radius-card: 8px; }\n');
    await fixture.git("add", "-A");
    await fixture.git("commit", "-qm", "repo mode");
    await writeFile(join(fixture.app, "AGENTS.md"), "# Project guidance\nKeep this text.\n");
    const installed = await cli(["hooks", "install", "--claude", "--git", "--project", fixture.app, "--json"]);
    expect(installed.code).toBe(0);
    expect(await readFile(join(fixture.app, ".claude/settings.local.json"), "utf8")).toContain("--project");
    const agents = await readFile(join(fixture.app, "AGENTS.md"), "utf8");
    // Committed instructions are portable; the machine-local hook keeps its working path.
    const youiJs = join(import.meta.dirname, "../bin/youi.js");
    expect(agents).toContain("After UI edits, run `npx -y youiyoux check --diff`");
    expect(agents).toContain("Run from the repo root.");
    expect(agents).not.toContain(youiJs);
    expect(await readFile(join(fixture.app, ".git/hooks/pre-commit"), "utf8")).toContain(`node ${youiJs} hooks run pre-commit`);
    expect(agents).toContain("Keep this text.");
    await cli(["hooks", "install", "--git", "--project", fixture.app]);
    expect(await readFile(join(fixture.app, "AGENTS.md"), "utf8")).toBe(agents);
    await addDrift(fixture.app);
    const input = (file: string) => JSON.stringify({cwd: fixture.app, tool_input: {file_path: file}});
    const context = contextOf((await runClaudeHook(input("components/promo.tsx"))).stdout);
    expect(context).toContain("var(--color-brand)");
    expect(context).toContain("var(--radius-card)");
    expect(context).toContain("off-library");
    const quiet = contextOf((await runClaudeHook(input("components/quiet-button.tsx"))).stdout);
    expect(quiet).toContain("near-duplicate");
    // Every command the agent is told to run works through npx (c5).
    for (const text of [agents, context, quiet]) expectOnlyNpx(text);
    await fixture.git("add", "components/promo.tsx");
    await writeFile(join(fixture.app, "components/promo.tsx"), "export const Promo = () => <p>Fixed only in working tree</p>;\n");
    const staged = await runPreCommitHook({project: fixture.app}, {strict: true});
    expect(staged.exitCode).toBe(1);
    expect(staged.stdout).toContain("var(--color-brand)");
    expectOnlyNpx(staged.stdout);
  });

  test("outside git the hook explains why lines cannot be isolated without listing old findings", async () => {
    await rm(join(fixture.app, ".git"), {recursive: true});
    const context = contextOf((await runClaudeHook(JSON.stringify({cwd: fixture.app, tool_input: {file_path: "app/index.tsx"}}))).stdout);
    expect(context).toContain("git init");
    expect(context).not.toContain("#c62828");
  });

  test("git pre-commit: the staged drift, with fixes; --strict blocks the commit", async () => {
    await addDrift(fixture.app);
    await fixture.git("add", "-A");
    const advisory = await runPreCommitHook({ project: fixture.app });
    expect(advisory.exitCode).toBe(0);
    expect(advisory.stdout).toContain('components/quiet-button.tsx:3:1 near-duplicate: QuietButton is a new button that looks like the existing Button variant="ghost"');
    expect(advisory.stdout).toContain('Fix: use <Button variant="ghost"> from "@/components/ui"');
    expect(advisory.stdout).toContain('components/promo.tsx:1:1 off-library import');
    expect(advisory.stdout).toContain("Fix: use text-danger (color.danger)");
    const strict = await runPreCommitHook({ project: fixture.app }, { strict: true });
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toContain("commit blocked");
  });

  test("hooks install: Codex is covered by pre-commit and AGENTS.md, said plainly; sync tells agents to run check --diff", async () => {
    const { code, out } = await cli(["hooks", "install", "--git", "--json", "--project", fixture.app]);
    expect(code).toBe(0);
    const codex = (JSON.parse(out) as Array<{ kind: string; action: string; file: string; guarantee: string }>).find((r) => r.kind === "Codex");
    expect(codex).toMatchObject({ action: "skipped", file: join(fixture.app, "AGENTS.md") });
    expect(codex?.guarantee).toMatch(/pre-commit/);
    expect(await readFile(join(fixture.app, "AGENTS.md"), "utf8")).toContain("youiyoux check --diff");
  });

  test("CI: --diff adds a pull-request step that fails on drift; reinstalling keeps it and changes nothing", async () => {
    const remote = async (cwd: string, slug: string) => {
      const g = (...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
      await g("init", "-q");
      await g("add", "-A");
      await g("commit", "-qm", "init", "--allow-empty");
      await g("remote", "add", "origin", `https://github.com/${slug}.git`);
    };
    const tool = join(fixture.dir, "tool");
    await mkdir(tool);
    await remote(tool, "acme/youiyoux");
    await remote(join(fixture.dir, "demo-design"), "acme/demo-design");
    await fixture.git("remote", "add", "origin", "https://github.com/acme/demo-app.git");
    const project = await loadProject(fixture.app);
    const first = await installWorkflow(project, tool, { project: fixture.app }, false, { diff: true });
    const text = await readFile(first.file, "utf8");
    expect(text).toContain("fetch-depth: 0");
    expect(text).toContain("YOUI_BASE: ${{ github.base_ref }}");
    expect(text).toContain('check --diff "origin/$YOUI_BASE" --strict --format github --project . --design .youi-ci/design');
    expect(first.guarantee).toContain("drift");
    expect((await installWorkflow(project, tool, { project: fixture.app }, false)).action).toBe("unchanged");
    // A cached npm install has no tool git checkout: CI uses portable commands as well.
    const portable = await installWorkflow(project, join(fixture.dir, "_npx/hash/node_modules/youiyoux/dist"), { project: fixture.app }, false);
    const portableText = await readFile(portable.file, "utf8");
    expect(portableText).toContain("npx -y youiyoux check");
    expect(portableText).not.toMatch(/_npx|dist\/chunks|\.youi-ci\/tool|repository: npm\/youiyoux/);
    expect(portableText).toContain('npx -y youiyoux check --diff "origin/$YOUI_BASE"');
    await writeFile(portable.file, portableText.replaceAll("youiyoux hooks install", "youi hooks install").replaceAll("name: youiyoux check", "name: youi check"));
    expect((await installWorkflow(project, join(fixture.dir, "_npx/hash/node_modules/youiyoux/dist"), { project: fixture.app }, false)).action).toBe("updated");
    expect(await readFile(portable.file, "utf8")).toContain('check --diff "origin/$YOUI_BASE"');
  });
});

test("the CI workflow has no diff step unless asked", () => {
  const text = workflowText({ tool: { slug: "acme/youiyoux", commit: "a".repeat(40) }, design: { slug: "acme/acme-design", commit: "b".repeat(40) }, projectDir: ".", configPath: null });
  expect(text).not.toContain("--diff");
  expect(text).not.toContain("fetch-depth");
});
