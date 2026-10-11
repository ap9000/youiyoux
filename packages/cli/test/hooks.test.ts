import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { githubSlug, hookCommand, installClaudeHook, installPreCommit, main, runClaudeHook, runPreCommitHook, shellQuote, workflowText } from "../src/index.ts";

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
  dir = await mkdtemp(join(tmpdir(), "youi hooks "));
  app = join(dir, "demo app");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  await git("init", "-q");
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
    expect(context).toMatch(/components\/extra file\.tsx:2:\d+ error color\.no-raw-color/);
    expect(context).not.toContain("invite-form");
  });

  test("is silent for clean files, generated output, unchecked files and bad input", async () => {
    await writeFile(join(app, "components/extra.tsx"), CLEAN);
    expect((await runClaudeHook(payload(join(app, "components/extra.tsx")))).stdout).toBe("");
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
    expect((await runClaudeHook(payload("app/settings/index.tsx"))).stdout).toBe("");
    const settings = join(app, "app/settings/index.tsx");
    await writeFile(settings, `${await readFile(settings, "utf8")}\nexport const Bad = () => <p style={{ color: "#00ff00" }} />;\n`);
    const context = contextOf((await runClaudeHook(payload(settings))).stdout);
    expect(context).toContain("#00ff00");
    expect(context).toContain("1 older ones in this file are baselined");
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
    expect(githubSlug("https://github.com/ap9000/toolroll-design.git")).toBe("ap9000/toolroll-design");
    expect(githubSlug("git@github.com:ap9000/youiyoux.git")).toBe("ap9000/youiyoux");
    expect(githubSlug("https://gitlab.com/a/b")).toBeNull();
    const text = workflowText({ tool: { slug: "ap9000/youiyoux", commit: "a".repeat(40) }, design: { slug: "ap9000/toolroll-design", commit: "b".repeat(40) }, projectDir: ".", configPath: ".youi-ci/design/pilot/toolroll/youi.project.json" });
    expect(text).toContain(`ref: ${"b".repeat(40)}`);
    expect(text).toContain("check --baseline --format github --project . --design .youi-ci/design --config .youi-ci/design/pilot/toolroll/youi.project.json");
  });
});
