/**
 * Connecting coding agents to a project, as `youiyoux agents install|remove` does it and the hub's
 * Connect your agent asks for it: which agents this machine has, which already start the youiyoux
 * MCP server here, the install itself (agents-install.ts writes the files), and a check that each
 * server it registered answers when started the way its agent starts it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import type { Project } from "@youiyoux/scanner";
import type { AgentCheck, AgentKind, AgentsConnected, AgentsSetup, AgentsView } from "@youiyoux/workflow/api";
import { AGENT_FILES, connectedAgents, cursorServer, installAgentRule, installClaudeMcp, installCodexMcp, installCursorMcp, mcpCommand, relativeTo, removeAgentRule, removeClaudeMcp, removeCodexMcp, removeCursorMcp, type AgentsResult } from "./agents-install.ts";
import type { HookTarget } from "./hooks.ts";
import { repoRootOf } from "./hooks-install.ts";
import { mcpArgs } from "./sync.ts";

export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex", "cursor"];
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const BINARY: Readonly<Record<AgentKind, string>> = { claude: "claude", codex: "codex", cursor: "cursor" };
const SETTINGS: Readonly<Record<AgentKind, string>> = { claude: ".claude", codex: ".codex", cursor: ".cursor" };
/** The server must list its tools within this long; the first start of an npx install can take a while. */
export const CHECK_MS = 30_000;
/** The tool every connected agent is told to call first. */
const FIRST_TOOL = "ui_find_component";

/** Which agents this machine has: the command on PATH, or the settings folder in the home folder. */
export function agentsFound(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Record<AgentKind, boolean> {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const onPath = (name: string): boolean => dirs.some((dir) => existsSync(join(dir, name)) || existsSync(join(dir, `${name}.cmd`)));
  return Object.fromEntries(AGENT_KINDS.map((kind) => [kind, onPath(BINARY[kind]) || existsSync(join(home, SETTINGS[kind]))])) as Record<AgentKind, boolean>;
}

/** The server each agent's file registers, as that agent starts it: the command, its arguments and where it runs. */
interface Registered {
  readonly kind: AgentKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface AgentsTarget {
  readonly toolRoot: string;
  readonly target: HookTarget;
  /** The System project when there is one (a youi.project.json): its server is the one `youiyoux sync` writes. */
  readonly system: Project | null;
}

async function plan(setup: AgentsTarget): Promise<{ repoRoot: string; servers: Record<AgentKind, { command: string; args: string[] }> }> {
  const repoRoot = await repoRootOf(setup.target.project ?? process.cwd());
  const server = mcpCommand(setup.toolRoot, setup.target);
  // In a System project at the repo root, the same entry youiyoux sync writes, so the two never fight over it.
  const claude = setup.system && setup.system.root === repoRoot ? { command: "node", args: mcpArgs(setup.system) } : relativeTo(repoRoot, server);
  return { repoRoot, servers: { claude, codex: server, cursor: server } };
}

/** `youiyoux agents install|remove` for these agents: the find-first rule, then each agent's server entry. */
export async function setupAgents(setup: AgentsTarget, action: "install" | "remove", kinds: readonly AgentKind[]): Promise<Array<AgentsResult & { kind: string }>> {
  const { repoRoot, servers } = await plan(setup);
  const results: Array<AgentsResult & { kind: string }> = [];
  const rule = action === "install" ? await installAgentRule(repoRoot) : await removeAgentRule(repoRoot);
  results.push(...rule.map((r) => ({ kind: "agent rule", ...r })));
  const install = { claude: installClaudeMcp, codex: installCodexMcp, cursor: installCursorMcp };
  const remove = { claude: removeClaudeMcp, codex: removeCodexMcp, cursor: removeCursorMcp };
  for (const kind of AGENT_KINDS.filter((k) => kinds.includes(k))) {
    results.push({ kind: `${AGENT_NAMES[kind]} MCP`, ...(action === "install" ? await install[kind](repoRoot, servers[kind]) : await remove[kind](repoRoot)) });
  }
  return results;
}

/** Each agent's server as its file starts it: Claude Code from the repo root; Cursor with `${workspaceFolder}` filled in. */
async function registered(setup: AgentsTarget, kinds: readonly AgentKind[]): Promise<Registered[]> {
  const { repoRoot, servers } = await plan(setup);
  return kinds.map((kind) => {
    if (kind !== "cursor") return { kind, ...servers[kind], cwd: repoRoot };
    const fill = (value: string): string => value.split("${workspaceFolder}").join(repoRoot);
    const cursor = cursorServer(repoRoot, servers.cursor);
    return { kind, command: fill(cursor.command), args: cursor.args.map(fill), cwd: repoRoot };
  });
}

/**
 * Start a registered server as its agent would, ask it for its tools over stdio, and stop it: it
 * passes when it lists ui_find_component. Never a pass by default: a server that exits, writes
 * something other than the protocol, or is silent past `ms` fails, with why.
 */
export function checkServer(server: Registered, ms: number = CHECK_MS): Promise<AgentCheck> {
  const name = AGENT_NAMES[server.kind];
  return new Promise((done) => {
    let settled = false;
    let out = "";
    let err = "";
    const child = spawn(server.command, [...server.args], { cwd: server.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (ok: boolean, tools: number, problem: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      done({ kind: server.kind, name, ok, tools, problem });
    };
    const timer = setTimeout(() => finish(false, 0, `the server did not list its tools within ${Math.round(ms / 1000)} seconds`), ms);
    const send = (message: Record<string, unknown>): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.on("error", (error) => finish(false, 0, `${server.command} could not start: ${error.message}`));
    child.on("exit", (code) => {
      const said = reason(err);
      finish(false, 0, `the server stopped (exit ${code ?? "signal"}) before listing its tools${said ? `: ${said}` : ""}`);
    });
    child.stderr.on("data", (chunk: Buffer) => void (err = (err + chunk.toString()).slice(-4000)));
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      for (let end = out.indexOf("\n"); end >= 0; end = out.indexOf("\n")) {
        const line = out.slice(0, end).trim();
        out = out.slice(end + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: { tools?: Array<{ name?: unknown }> }; error?: { message?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return finish(false, 0, `the server wrote something that is not the MCP protocol: ${line.slice(0, 120)}`);
        }
        if (message.error) return finish(false, 0, `the server refused: ${String(message.error.message ?? "an error")}`);
        if (message.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          const tools = (message.result?.tools ?? []).map((tool) => tool.name);
          return tools.includes(FIRST_TOOL) ? finish(true, tools.length, null) : finish(false, tools.length, `the server answered without ${FIRST_TOOL}`);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "youiyoux-agents-check", version: "1" } } });
  });
}

/** What a crashed server said: its error line, not Node's version footer or a stack frame. */
function reason(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line && !/^Node\.js v\d/.test(line) && !/^at /.test(line));
  return (lines.find((line) => /Error\b|error:/.test(line)) ?? lines.at(-1) ?? "").slice(0, 300);
}

/** Check each of these agents' servers as registered, side by side. */
export async function checkAgents(setup: AgentsTarget, kinds: readonly AgentKind[], ms?: number): Promise<AgentCheck[]> {
  return Promise.all((await registered(setup, kinds)).map((server) => checkServer(server, ms)));
}

/** The hub's Connect your agent, for the workflow service: what is here, and connecting the agents a person picks. */
export function agentsSetup(setup: AgentsTarget, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AgentsSetup {
  const view = async (): Promise<AgentsView> => {
    const { repoRoot } = await plan(setup);
    const found = agentsFound(env, home);
    const connected = await connectedAgents(repoRoot);
    return {
      agents: AGENT_KINDS.map((kind) => ({ kind, name: AGENT_NAMES[kind], found: found[kind], connected: connected[kind], file: AGENT_FILES[kind] })),
      command: "youiyoux agents install",
    };
  };
  return {
    view,
    async connect(kinds: readonly AgentKind[]): Promise<AgentsConnected> {
      const { repoRoot } = await plan(setup);
      const results = (await setupAgents(setup, "install", kinds)).map((r) => ({ ...r, file: relative(repoRoot, r.file) }));
      return { results, checks: await checkAgents(setup, kinds), view: await view() };
    },
  };
}
