/** `youi agents install|remove`: the find-first rule and the MCP registrations, idempotent and reversible to the byte. */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FIND_FIRST_RULE, installCodexMcp, main, mcpArgs, mcpCommand, RULE_BEGIN, RULE_END, loadOptions } from "../src/index.ts";
import { loadProject } from "@youiyoux/scanner";

const run = promisify(execFile);
const TOOL = join(import.meta.dirname, "../../..");
const FIND_APP = join(TOOL, "packages/mcp/test/fixtures/find-app");
const EXAMPLES = join(TOOL, "examples");

const AGENTS = "# Agents\n\nRun pnpm test before you push.\n";
const MCP = `${JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } } }, null, 2)}\n`;
const CODEX = 'model = "gpt-5-codex"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';

let dir = "";
let app = "";

const read = (file: string): Promise<string> => readFile(join(app, file), "utf8");
const exists = (file: string): Promise<boolean> => stat(join(app, file)).then(() => true, () => false);
const snapshot = async (): Promise<Record<string, string | null>> => Object.fromEntries(await Promise.all(["AGENTS.md", "CLAUDE.md", ".mcp.json", ".codex/config.toml"].map(async (f) => [f, (await exists(f)) ? await read(f) : null] as const)));

/** `youi agents …` in-process, with its --json output parsed. */
async function agents(...args: string[]): Promise<Array<{ kind: string; file: string; action: string; guarantee: string }>> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await main(["agents", ...args, "--project", app, "--json"])).toBe(0);
    return JSON.parse(out.mock.calls.map((c) => String(c[0])).join("")) as Array<{ kind: string; file: string; action: string; guarantee: string }>;
  } finally {
    out.mockRestore();
  }
}

beforeEach(async () => {
  // A space in the path, and no git repository: the project directory is the repo root.
  dir = await mkdtemp(join(tmpdir(), "youi agents "));
  app = join(dir, "find app");
  await cp(FIND_APP, app, { recursive: true });
  await writeFile(join(app, "AGENTS.md"), AGENTS);
  await writeFile(join(app, ".mcp.json"), MCP);
  await mkdir(join(app, ".codex"));
  await writeFile(join(app, ".codex/config.toml"), CODEX);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("youi agents install|remove", () => {
  test("install adds the rule to AGENTS.md and CLAUDE.md and registers youiyoux for Claude Code and Codex, keeping what was there", async () => {
    const results = await agents("install");
    expect(results.map((r) => [r.kind, r.file.slice(app.length + 1), r.action])).toEqual([
      ["agent rule", "AGENTS.md", "updated"],
      ["agent rule", "CLAUDE.md", "created"],
      ["Claude Code MCP", ".mcp.json", "updated"],
      ["Codex MCP", ".codex/config.toml", "updated"],
    ]);
    for (const r of results) expect(r.guarantee.length).toBeGreaterThan(0);
    const rule = await read("AGENTS.md");
    expect(rule.startsWith(AGENTS)).toBe(true);
    expect(rule).toContain(`${RULE_BEGIN}\n## UI components (YouIyouX)\n\n${FIND_FIRST_RULE}\n${RULE_END}\n`);
    expect(FIND_FIRST_RULE).toMatch(/^Before creating a UI component, call `ui_find_component`/);
    expect(await read("CLAUDE.md")).toBe(`${RULE_BEGIN}\n## UI components (YouIyouX)\n\n${FIND_FIRST_RULE}\n${RULE_END}\n`);
    // Claude Code: the same entry youi sync writes, relative to the repo root; the other server is kept.
    const mcp = JSON.parse(await read(".mcp.json")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["github", "youiyoux"]);
    expect(mcp.mcpServers.youiyoux).toEqual({ command: "node", args: [expect.stringMatching(/packages\/cli\/bin\/youi\.js$/), "mcp", "--project", "."] });
    expect(join(app, mcp.mcpServers.youiyoux!.args[0]!)).toBe(join(TOOL, "packages/cli/bin/youi.js"));
    // Codex: a marked block at the end, absolute paths (Codex may start it from anywhere).
    const toml = await read(".codex/config.toml");
    expect(toml.startsWith(CODEX)).toBe(true);
    expect(toml.slice(CODEX.length)).toBe(`\n# >>> youi mcp >>>\n[mcp_servers.youiyoux]\ncommand = "node"\nargs = [${JSON.stringify(join(TOOL, "packages/cli/bin/youi.js"))}, "mcp", "--project", ${JSON.stringify(app)}]\n# <<< youi mcp <<<\n`);
  });

  test("a second install changes nothing, byte for byte", async () => {
    await agents("install");
    const first = await snapshot();
    const again = await agents("install");
    expect(again.map((r) => r.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(await snapshot()).toEqual(first);
  });

  test("remove restores the original files byte for byte and deletes the ones youi created; a second remove is unchanged", async () => {
    const before = await snapshot();
    await agents("install");
    const removed = await agents("remove");
    expect(removed.map((r) => r.action)).toEqual(["removed", "removed", "removed", "removed"]);
    expect(await snapshot()).toEqual(before);
    expect(await exists("CLAUDE.md")).toBe(false);
    const again = await agents("remove");
    expect(again.map((r) => r.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(await snapshot()).toEqual(before);
  });

  test("on a bare project it creates every file, and remove deletes them all, the .codex folder too", async () => {
    for (const f of ["AGENTS.md", ".mcp.json"]) await rm(join(app, f));
    await rm(join(app, ".codex"), { recursive: true });
    expect((await agents("install")).map((r) => r.action)).toEqual(["created", "created", "created", "created"]);
    await agents("remove");
    expect(await snapshot()).toEqual({ "AGENTS.md": null, "CLAUDE.md": null, ".mcp.json": null, ".codex/config.toml": null });
    expect(await exists(".codex")).toBe(false);
  });

  test("--claude or --codex registers only that agent; the rule is always written", async () => {
    expect((await agents("install", "--claude")).map((r) => r.kind)).toEqual(["agent rule", "agent rule", "Claude Code MCP"]);
    expect(await read(".codex/config.toml")).toBe(CODEX);
    expect((await agents("remove", "--codex")).map((r) => [r.kind, r.action])).toEqual([["agent rule", "removed"], ["agent rule", "removed"], ["Codex MCP", "unchanged"]]);
    expect(JSON.parse(await read(".mcp.json")).mcpServers).toHaveProperty("youiyoux");
  });

  test("a youiyoux table youi did not write is refused, with the codex mcp add line; invalid .mcp.json is never overwritten", async () => {
    const foreign = `${CODEX}\n[mcp_servers.youiyoux]\ncommand = "my-own"\n`;
    await writeFile(join(app, ".codex/config.toml"), foreign);
    const server = mcpCommand(TOOL, { project: app });
    await expect(installCodexMcp(app, server)).rejects.toThrow(/did not write; youi leaves it alone.*codex mcp add youiyoux -- node .*youi\.js mcp --project '.*find app'/);
    expect(await read(".codex/config.toml")).toBe(foreign);
    await writeFile(join(app, ".mcp.json"), "{ not json");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["agents", "install", "--claude", "--project", app])).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain(".mcp.json is not valid JSON; fix it first");
    err.mockRestore();
    expect(await read(".mcp.json")).toBe("{ not json");
  });

  test("in a System project it writes the same .mcp.json entry youi sync does, so the two never fight", async () => {
    app = join(dir, "demo app");
    await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
    await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
    await agents("install", "--claude");
    const mcp = JSON.parse(await read(".mcp.json")) as { mcpServers: { youiyoux: { args: string[] } } };
    expect(mcp.mcpServers.youiyoux.args).toEqual(mcpArgs(await loadProject(app, loadOptions({}))));
  });

  test("the youi binary: one `agents install --json` run", async () => {
    const { stdout } = await run(process.execPath, [join(TOOL, "packages/cli/bin/youi.js"), "agents", "install", "--json"], { cwd: app });
    const results = JSON.parse(stdout) as Array<{ kind: string; action: string }>;
    expect(results.map((r) => `${r.kind}: ${r.action}`)).toEqual(["agent rule: updated", "agent rule: created", "Claude Code MCP: updated", "Codex MCP: updated"]);
    expect(await read("CLAUDE.md")).toContain("ui_find_component");
  });
});
