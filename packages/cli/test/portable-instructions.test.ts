import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { installAgentRule, installRepoAgentInstructions, syncProject } from "../src/index.ts";
import { COMMAND_NAMES } from "../src/main.ts";
import { SUBCOMMANDS } from "../src/command.ts";
import { expectOnlyNpx } from "./bare-command.ts";

const exec = promisify(execFile);
const TOOL = join(import.meta.dirname, "../../..");

test.each([false, true])("generated instructions run after a fresh copy (local dependency: %s)", async (local) => {
  const dir = await mkdtemp(join(tmpdir(), "youi-portable-"));
  try {
    const app = join(dir, "app");
    await cp(join(TOOL, "examples/demo-app"), app, { recursive: true });
    await cp(join(TOOL, "examples/demo-design"), join(dir, "demo-design"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ private: true, ...(local ? { devDependencies: { "@youiyoux/cli": "*" } } : {}) }));
    await syncProject(await loadProject(app));
    const texts = await Promise.all(["AGENTS.md", ".agents/skills/youiyoux/SKILL.md"].map((f) => readFile(join(app, f), "utf8")));
    await rm(join(app, "AGENTS.md"));
    await installRepoAgentInstructions(app);
    texts.push(await readFile(join(app, "AGENTS.md"), "utf8"));
    await installAgentRule(app);
    texts.push(await readFile(join(app, "CLAUDE.md"), "utf8"));
    const command = local ? "npx --no-install youiyoux check --diff" : "npx -y youiyoux check --diff";
    for (const text of texts) {
      expect(text).toContain(`After UI edits, run \`${command}\``);
      expect(text).not.toContain(TOOL);
      expect(text).not.toContain(dir);
      if (!local) expect(text).toContain("Run from the repo root.");
      expectOnlyNpx(text);
    }
    // A teammate's checkout has the generated text but none of the author's local config.
    const clone = join(dir, "fresh clone");
    await cp(app, clone, { recursive: true });
    await rm(app, { recursive: true });
    const bin = join(clone, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await symlink(join(TOOL, "packages/cli/bin/youi.js"), join(bin, "youiyoux"));
    const env = { ...process.env, PATH: local ? process.env.PATH : `${bin}:${process.env.PATH}`, npm_config_offline: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    await exec("git", ["init", "-q"], { cwd: clone, env });
    const [program, ...args] = command.split(" ");
    const { stdout } = await exec(program!, args, { cwd: clone, env });
    expect(stdout).not.toMatch(/command not found|Cannot find module/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("every youiyoux command is known to the npx rewrite of agent-facing text (c5)", () => {
  expect([...SUBCOMMANDS].sort()).toEqual([...COMMAND_NAMES].sort());
});

test.each([["agents install, then hooks install", false], ["hooks install, then agents install", true]])("AGENTS.md gets one check --diff line: %s, twice over", async (_name, hooksFirst) => {
  const dir = await mkdtemp(join(tmpdir(), "youi-one-block-"));
  try {
    await writeFile(join(dir, "AGENTS.md"), "# Notes\n\nKeep this.\n");
    const steps = hooksFirst ? [() => installRepoAgentInstructions(dir), () => installAgentRule(dir)] : [() => installAgentRule(dir), () => installRepoAgentInstructions(dir)];
    for (const step of [...steps, ...steps]) await step();
    const text = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(text.match(/ check --diff`/g)).toHaveLength(1);
    expect(text.match(/<!-- youi:(?:agents:)?begin -->/g)).toHaveLength(1);
    expect(text).toContain("Keep this.");
    expect(text).toContain("ui_find_component");
    // Running either again changes nothing.
    for (const step of steps) await step();
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
