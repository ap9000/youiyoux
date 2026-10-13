/**
 * `youi agents install|remove`: one command that tells coding agents to look for the project's
 * existing components first, and gives them the tool to do it, without disturbing anything else.
 *
 * - Rule: a marked block (`<!-- youi:agents:begin -->`) with FIND_FIRST_RULE in the repo's
 *   AGENTS.md and CLAUDE.md, created when missing; every other line is kept.
 * - Claude Code: `mcpServers.youiyoux` in the repo's `.mcp.json`; other servers are kept, and
 *   the file keeps its indentation.
 * - Codex: a marked `[mcp_servers.youiyoux]` block in `.codex/config.toml`; a youiyoux table
 *   youi did not write is never touched.
 *
 * Install twice and nothing changes. Remove strips only youi's block or key, and deletes a file
 * youi created once nothing else is left in it, so the files read as they did before.
 */
import { readdir, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { readTextOrNull, writeFileAtomic } from "@youiyoux/core";
import { FIND_FIRST_RULE } from "./agents.ts";
import type { HookTarget } from "./hooks.ts";
import { shellQuote, write } from "./hooks-install.ts";

export const RULE_BEGIN = "<!-- youi:agents:begin -->";
export const RULE_END = "<!-- youi:agents:end -->";
const TOML_BEGIN = "# >>> youi mcp >>>";
const TOML_END = "# <<< youi mcp <<<";
export const MCP_NAME = "youiyoux";
export const RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const CLAUDE_MCP = ".mcp.json";
const CODEX_CONFIG = ".codex/config.toml";

export interface AgentsResult {
  readonly file: string;
  readonly action: "created" | "updated" | "unchanged" | "removed";
  /** What this entry does and does not guarantee. */
  readonly guarantee: string;
}

/** The youi MCP server as a command line: this youi, pointed at this project (and its out-of-repo config, if any). */
export function mcpCommand(toolRoot: string, target: HookTarget): { command: string; args: string[] } {
  const args = [join(toolRoot, "packages/cli/bin/youi.js"), "mcp"];
  for (const key of ["project", "config", "design", "root"] as const) {
    const value = target[key];
    if (value) args.push(`--${key}`, value);
  }
  return { command: "node", args };
}

/** The command with its paths relative to the repo root, where Claude Code starts project servers (as `youi sync` writes it). */
export function relativeTo(repoRoot: string, server: { command: string; args: readonly string[] }): { command: string; args: string[] } {
  return { command: server.command, args: server.args.map((arg) => (isAbsolute(arg) ? relative(repoRoot, arg) || "." : arg)) };
}

/** The same command for a shell, e.g. `codex mcp add youiyoux -- <this>`. */
export const shellLine = ({ command, args }: { command: string; args: readonly string[] }): string => [command, ...args].map(shellQuote).join(" ");

/* ------------------------------------------------------------ marked blocks */

/** `text` with `block` between its markers: replaced in place, else appended on its own lines. */
function withBlock(text: string | null, block: string, begin: string, end: string): string {
  if (!text) return `${block}\n`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end, start);
  if (start >= 0 && stop > start) return `${text.slice(0, start)}${block}${text.slice(stop + end.length)}`;
  // One newline before and after, and nothing else, so removing them gives the bytes back.
  return `${text}\n${block}\n`;
}

/** `text` without the marked block and the newlines `withBlock` put around it; null when it was not there. */
function withoutBlock(text: string, begin: string, end: string): string | null {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end, start);
  if (start < 0 || stop < start) return null;
  let before = text.slice(0, start);
  let after = text.slice(stop + end.length);
  if (after.startsWith("\n")) after = after.slice(1);
  if (before.endsWith("\n") && (before.length > 1 || after === "")) before = before.slice(0, -1);
  return before + after;
}

/** Remove `file` once youi's part is gone and nothing else is left, along with a directory that empties with it. */
async function removeOrWrite(file: string, next: string, guarantee: string): Promise<AgentsResult> {
  if (next.trim() === "") {
    await rm(file);
    const dir = dirname(file);
    if ((await readdir(dir).catch(() => ["keep"])).length === 0) await rmdir(dir).catch(() => undefined);
  } else await writeFileAtomic(file, next);
  return { file, action: "removed", guarantee };
}

/* --------------------------------------------------------------- the rule */

export function ruleBlock(): string {
  return [RULE_BEGIN, "## UI components (YouIyouX)", "", FIND_FIRST_RULE, RULE_END].join("\n");
}

const RULE_GUARANTEE = "advisory: agents that read this file are told to call ui_find_component before creating a component; nothing enforces it (youi check does)";

export async function installAgentRule(repoRoot: string): Promise<AgentsResult[]> {
  const results: AgentsResult[] = [];
  for (const name of RULE_FILES) {
    const file = join(repoRoot, name);
    const before = await readTextOrNull(file);
    results.push(await write(file, withBlock(before, ruleBlock(), RULE_BEGIN, RULE_END), before, RULE_GUARANTEE));
  }
  return results;
}

export async function removeAgentRule(repoRoot: string): Promise<AgentsResult[]> {
  const results: AgentsResult[] = [];
  for (const name of RULE_FILES) {
    const file = join(repoRoot, name);
    const before = await readTextOrNull(file);
    const next = before === null ? null : withoutBlock(before, RULE_BEGIN, RULE_END);
    results.push(next === null ? { file, action: "unchanged", guarantee: "no youi rule here" } : await removeOrWrite(file, next, "youi's rule block removed; the rest of the file is as it was"));
  }
  return results;
}

/* ----------------------------------------------------------- Claude Code */

interface JsonFile {
  readonly data: Record<string, unknown>;
  readonly indent: string;
  readonly newline: boolean;
}

function readJson(file: string, text: string | null): JsonFile {
  if (text === null) return { data: {}, indent: "  ", newline: true };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix it first (youi will not overwrite it)`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} is not a JSON object; fix it first (youi will not overwrite it)`);
  const servers = (data as Record<string, unknown>).mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error(`${file}: mcpServers is not an object; fix it first (youi will not overwrite it)`);
  // Keep the file's own indentation, so removing youi's key gives the same bytes back.
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? (text.trim().includes("\n") ? "  " : "");
  return { data: data as Record<string, unknown>, indent, newline: text.endsWith("\n") };
}

const serialize = ({ data, indent, newline }: JsonFile): string => `${JSON.stringify(data, null, indent)}${newline ? "\n" : ""}`;

export async function installClaudeMcp(repoRoot: string, server: { command: string; args: string[] }): Promise<AgentsResult> {
  const file = join(repoRoot, CLAUDE_MCP);
  const before = await readTextOrNull(file);
  const json = readJson(file, before);
  const servers = (json.data.mcpServers ?? {}) as Record<string, unknown>;
  const next = { ...json, data: { ...json.data, mcpServers: { ...servers, [MCP_NAME]: { command: server.command, args: server.args } } } };
  return write(file, serialize(next), before, `Claude Code starts the ${MCP_NAME} MCP server in this repo (it asks once before trusting a project .mcp.json); the paths are relative to the repo root and point at this machine's youi checkout; youi sync writes the same entry`);
}

export async function removeClaudeMcp(repoRoot: string): Promise<AgentsResult> {
  const file = join(repoRoot, CLAUDE_MCP);
  const before = await readTextOrNull(file);
  if (before === null) return { file, action: "unchanged", guarantee: `no ${MCP_NAME} server here` };
  const json = readJson(file, before);
  const servers = { ...((json.data.mcpServers ?? {}) as Record<string, unknown>) };
  if (!(MCP_NAME in servers)) return { file, action: "unchanged", guarantee: `no ${MCP_NAME} server here` };
  delete servers[MCP_NAME];
  const { mcpServers: _, ...rest } = json.data;
  const data = Object.keys(servers).length > 0 ? { ...json.data, mcpServers: servers } : rest;
  return removeOrWrite(file, Object.keys(data).length > 0 ? serialize({ ...json, data }) : "", `${MCP_NAME} removed; other servers kept`);
}

/* ------------------------------------------------------------------ Codex */

const tomlString = (value: string): string => JSON.stringify(value);

export function codexBlock(server: { command: string; args: readonly string[] }): string {
  return [TOML_BEGIN, `[mcp_servers.${MCP_NAME}]`, `command = ${tomlString(server.command)}`, `args = [${server.args.map(tomlString).join(", ")}]`, TOML_END].join("\n");
}

/** A `[mcp_servers.youiyoux]` table outside youi's block: someone else's, never overwritten. */
function foreignTable(text: string): boolean {
  const inside = withoutBlock(text, TOML_BEGIN, TOML_END) ?? text;
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${MCP_NAME}"?\\s*\\]`, "m").test(inside);
}

export async function installCodexMcp(repoRoot: string, server: { command: string; args: string[] }): Promise<AgentsResult> {
  const file = join(repoRoot, CODEX_CONFIG);
  const before = await readTextOrNull(file);
  if (before !== null && foreignTable(before)) throw new Error(`${file} already has an [mcp_servers.${MCP_NAME}] table youi did not write; youi leaves it alone. To use youi's instead, remove that table, or run: codex mcp add ${MCP_NAME} -- ${shellLine(server)}`);
  // Appended at the end, so no table of the file's own swallows youi's keys.
  return write(file, withBlock(before, codexBlock(server), TOML_BEGIN, TOML_END), before, `Codex starts the ${MCP_NAME} MCP server for this project (project config is read for trusted projects; otherwise run: codex mcp add ${MCP_NAME} -- ${shellLine(server)})`);
}

export async function removeCodexMcp(repoRoot: string): Promise<AgentsResult> {
  const file = join(repoRoot, CODEX_CONFIG);
  const before = await readTextOrNull(file);
  const next = before === null ? null : withoutBlock(before, TOML_BEGIN, TOML_END);
  if (next === null) return { file, action: "unchanged", guarantee: `no youi ${MCP_NAME} block here` };
  return removeOrWrite(file, next, `${MCP_NAME} removed; other settings kept`);
}
