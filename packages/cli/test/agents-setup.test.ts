/** Connect your agent: which agents are here, Cursor's entry, and the check that a registered server answers as its agent starts it. */
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { agentsFound, agentsSetup, checkServer, connectedAgents, setupAgents } from "../src/index.ts";

const TOOL = join(import.meta.dirname, "../../..");
const FIND_APP = join(TOOL, "packages/mcp/test/fixtures/find-app");
const CURSOR = `${JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }, null, 2)}\n`;

let dir = "";
let app = "";
const setup = () => ({ toolRoot: TOOL, target: { project: app }, system: null });

beforeEach(async () => {
  // The real folder, as git names a repo's root: the server is started there.
  dir = await realpath(await mkdtemp(join(tmpdir(), "youiyoux connect ")));
  app = join(dir, "find app");
  await cp(FIND_APP, app, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("which agents are here", () => {
  test("an agent's command on PATH, or its settings folder at home; nothing else counts", async () => {
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    await mkdir(bin);
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\n");
    await chmod(join(bin, "claude"), 0o755);
    expect(agentsFound({ PATH: bin }, home)).toEqual({ claude: true, codex: false, cursor: true });
    expect(agentsFound({}, join(dir, "nobody"))).toEqual({ claude: false, codex: false, cursor: false });
  });
});

describe("Cursor", () => {
  test("its entry starts at ${workspaceFolder}, keeps the file's other servers, and is taken out to the byte", async () => {
    await mkdir(join(app, ".cursor"));
    await writeFile(join(app, ".cursor/mcp.json"), CURSOR);
    const results = await setupAgents(setup(), "install", ["cursor"]);
    expect(results.map((r) => [r.kind, r.file.slice(app.length + 1), r.action])).toEqual([
      ["agent rule", "AGENTS.md", "created"],
      ["agent rule", "CLAUDE.md", "created"],
      ["Cursor MCP", ".cursor/mcp.json", "updated"],
    ]);
    const mcp = JSON.parse(await readFile(join(app, ".cursor/mcp.json"), "utf8")) as { mcpServers: Record<string, { type?: string; command: string; args: string[] }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["docs", "youiyoux"]);
    const entry = mcp.mcpServers.youiyoux!;
    expect(entry.type).toBe("stdio");
    // No absolute path of this machine: each starts at the folder that holds .cursor.
    expect(entry.args.filter((a) => a.startsWith("/"))).toEqual([]);
    expect(entry.args).toContain("${workspaceFolder}");
    expect(join(app, entry.args[0]!.replace("${workspaceFolder}", ""))).toBe(join(TOOL, "packages/cli/bin/youi.js"));
    expect(await connectedAgents(app)).toEqual({ claude: false, codex: false, cursor: true });
    await setupAgents(setup(), "remove", ["cursor"]);
    expect(await readFile(join(app, ".cursor/mcp.json"), "utf8")).toBe(CURSOR);
    expect(await connectedAgents(app)).toEqual({ claude: false, codex: false, cursor: false });
  });
});

describe("the check", () => {
  test("each registered server is started as its agent starts it and lists ui_find_component; the view says who is connected", async () => {
    const connect = agentsSetup(setup(), { PATH: "" }, join(dir, "home"));
    expect((await connect.view()).agents.map((a) => [a.kind, a.connected, a.file])).toEqual([["claude", false, ".mcp.json"], ["codex", false, ".codex/config.toml"], ["cursor", false, ".cursor/mcp.json"]]);
    const done = await connect.connect(["claude", "cursor"]);
    expect(done.results.map((r) => r.file)).toEqual(["AGENTS.md", "CLAUDE.md", ".mcp.json", ".cursor/mcp.json"]);
    expect(done.checks.map((c) => [c.name, c.ok, c.problem])).toEqual([["Claude Code", true, null], ["Cursor", true, null]]);
    expect(done.checks[0]!.tools).toBeGreaterThan(10);
    expect(done.view.agents.map((a) => a.connected)).toEqual([true, false, true]);
  }, 60_000);

  test("a server that stops, says nothing, or answers without ui_find_component fails, with why; never a pass by default", async () => {
    const server = (script: string) => ({ kind: "claude" as const, command: process.execPath, args: ["-e", script], cwd: dir });
    const stops = await checkServer(server("console.error('no design repo here'); process.exit(3)"));
    expect([stops.ok, stops.problem]).toEqual([false, "the server stopped (exit 3) before listing its tools: no design repo here"]);
    const silent = await checkServer(server("setInterval(() => {}, 1000)"), 500);
    expect([silent.ok, silent.problem]).toEqual([false, "the server did not list its tools within 1 seconds"]);
    const other = await checkServer(server(`
      let b = "";
      process.stdin.on("data", (d) => { b += d; for (const line of b.split("\\n").slice(0, -1)) { const m = JSON.parse(line);
        if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
        if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "other_tool" }] } }) + "\\n"); } b = b.slice(b.lastIndexOf("\\n") + 1); });
    `));
    expect([other.ok, other.tools, other.problem]).toEqual([false, 1, "the server answered without ui_find_component"]);
    const missing = await checkServer({ kind: "codex", command: join(dir, "no-such-command"), args: [], cwd: dir });
    expect(missing.ok).toBe(false);
    expect(missing.problem).toMatch(/could not start/);
  }, 30_000);
});
