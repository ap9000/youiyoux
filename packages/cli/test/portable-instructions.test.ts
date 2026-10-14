import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { installAgentRule, installRepoAgentInstructions, syncProject } from "../src/index.ts";

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
    const command = local ? "npx --no-install youi check --diff" : "youi check --diff";
    for (const text of texts) {
      expect(text).toContain(`After UI edits, run \`${command}\``);
      expect(text).not.toContain(TOOL);
      expect(text).not.toContain(dir);
      if (!local) expect(text).toContain('export PATH="$PWD/packages/cli/bin:$PATH"');
    }
    // A teammate's checkout has the generated text but none of the author's local config.
    const clone = join(dir, "fresh clone");
    await cp(app, clone, { recursive: true });
    await rm(app, { recursive: true });
    const bin = local ? join(clone, "node_modules/.bin") : join(dir, "installed-bin");
    await mkdir(bin, { recursive: true });
    await symlink(join(TOOL, "packages/cli/bin/youi.js"), join(bin, "youi"));
    const env = { ...process.env, PATH: local ? process.env.PATH : `${bin}:${process.env.PATH}`, npm_config_offline: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    await exec("git", ["init", "-q"], { cwd: clone, env });
    const [program, ...args] = command.split(" ");
    const { stdout } = await exec(program!, args, { cwd: clone, env });
    expect(stdout).not.toMatch(/command not found|Cannot find module/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
