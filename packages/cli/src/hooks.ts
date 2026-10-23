/**
 * Agent-time checks. Both are advisory; the CI check (`youiyoux check --baseline
 * --format github`) is the authoritative gate. What each one guarantees:
 *
 * - Claude Code PostToolUse: after Claude's Edit/Write/MultiEdit on a checked file,
 *   that file's new violations go back to Claude as context, with the drift its edit
 *   adds against HEAD (`youiyoux check --diff`: near-duplicate components, hardcoded values
 *   a token holds, off-library imports), each with its fix, and for a component file
 *   (.tsx, .jsx) one line saying how to see it (`youiyoux render`, `ui_render`); the hook
 *   itself never renders, so it stays fast. Never blocks; sees only edits made through
 *   those tools.
 * - git pre-commit (Codex, humans and any agent that commits): checks the staged
 *   content of staged files at commit time, and the drift the staged lines add. Not
 *   every edit, and `--no-verify` skips it; blocks the commit only when installed with
 *   --strict. Near-duplicates and library choices are read from the working tree.
 *
 * Neither checks generated output, files outside the project's include globs, or
 * the lockfile; failures to check are reported as incomplete, never as clean.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { relPath } from "@youiyoux/core";
import type { Project } from "@youiyoux/scanner";
import { portableYoui, viaNpx } from "./agents.ts";
import { baselinePath, runCheck, type CheckResult, type DiffCheckResult } from "./check.ts";
import { isChecked, stagedChange, workingTreeChange, isAdded, type ChangeProject, type ChangeSet } from "./check-diff.ts";
import { diffFindingLine, diffGaps } from "./check-render.ts";
import { configured, loadCheckProject, runRepoCheck } from "./check-repo.ts";
import { exists } from "./init.ts";

const run = promisify(execFile);
const MAX_LISTED = 20;
/** Files `youiyoux render` draws: React components. */
const COMPONENT_FILE = /\.(?:tsx|jsx)$/;
const quoted = (path: string): string => (/^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);

export interface HookTarget {
  readonly project?: string;
  readonly config?: string;
  readonly design?: string;
  readonly root?: string;
}

interface HookOutcome {
  readonly stdout: string;
  readonly exitCode: number;
}

const SILENT: HookOutcome = { stdout: "", exitCode: 0 };

async function load(target: HookTarget, near: string): Promise<ChangeProject> {
  return loadCheckProject(target.project ?? near, { ...(target.config ? { configPath: target.config } : {}), ...(target.design ? { designRoot: target.design } : {}), ...(target.root ? { productRoot: target.root } : {}) }, !target.project);
}

async function baselineFor(project: Project, target: HookTarget): Promise<string | null> {
  const file = baselinePath(project, target.config);
  return (await exists(file)) ? file : null;
}

/** Findings as a short list an agent can act on: rule violations, then the drift the change adds, each with its fix. */
function findingLines(result: DiffCheckResult, root: string): string[] {
  const findings = result.diff?.findings ?? [];
  const lines = findings.slice(0, MAX_LISTED).map((f) => `- ${diffFindingLine(f)}`);
  if (findings.length > MAX_LISTED) {
    const { run, setup } = portableYoui(root);
    lines.push(`- …and ${findings.length - MAX_LISTED} more. ${setup} Run \`${run} check --diff\`.`);
  }
  for (const gap of diffGaps(result)) lines.push(`- incomplete: ${gap}; 0 findings there is not a pass`);
  return lines;
}

/** The change to check for drift, or why there is none: drift needs git, the rule check does not. */
async function changeFor(read: () => Promise<ChangeSet>): Promise<{ change: ChangeSet; problem?: undefined } | { change?: undefined; problem: string }> {
  try {
    return { change: await read() };
  } catch (error: unknown) {
    return { problem: `- drift (youiyoux check --diff) not checked: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/* ----------------------------------------------------------- Claude Code hook */

interface PostToolUseInput {
  readonly cwd?: string;
  readonly tool_input?: { readonly file_path?: unknown };
}

/** What the agent reads: every command in it runs through npx (`root` decides `-y` or `--no-install`). */
function claudeContext(text: string, root?: string): HookOutcome {
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: viaNpx(text, root) } })}\n`, exitCode: 0 };
}

/** Claude Code PostToolUse: check the edited file and return its findings as additional context. Always exits 0. */
export async function runClaudeHook(input: string, target: HookTarget = {}): Promise<HookOutcome> {
  let payload: PostToolUseInput;
  try {
    payload = JSON.parse(input) as PostToolUseInput;
  } catch {
    return SILENT;
  }
  const raw = payload.tool_input?.file_path;
  if (typeof raw !== "string" || raw.length === 0) return SILENT;
  const file = resolve(payload.cwd ?? process.cwd(), raw);
  try {
    const project = await load(target, dirname(file));
    // Real paths on both sides: the payload and the configured root may differ only by symlinks.
    const real = (path: string): Promise<string> => realpath(path).catch(() => path);
    const relative = relPath(await real(project.root), await real(file));
    if (!isChecked(project, relative)) return SILENT;
    const found = await changeFor(() => workingTreeChange(project, undefined, [relative]));
    if (found.problem !== undefined) return claudeContext(found.problem, project.root);
    const { change } = found;
    const result = configured(project) ? await runCheck(project, { files: [file], lock: false, baseline: await baselineFor(project, target), diff: change }) : await runRepoCheck(project, change);
    const lines = findingLines(result, project.root);
    const see = COMPONENT_FILE.test(relative) ? `See it: youiyoux render ${quoted(relative)} (or the MCP tool ui_render), then open the images: light and dark, desktop and phone, accessibility issues and the diff against the base.` : null;
    if (lines.length === 0) return see ? claudeContext(`youiyoux: ${relative} passes the design-system check. ${see}`, project.root) : SILENT;
    const older = "violations" in result ? (result as CheckResult).violations.filter((v) => !isAdded(change.added, v.file, v.line)).length : 0;
    const known = older > 0 ? ` (${older} older findings on unchanged lines omitted)` : "";
    return claudeContext(`youiyoux design-system check (advisory) on ${relative}${known}:\n${lines.join("\n")}${!configured(project) ? `\n${result.diff?.notes.join("\n")}` : ""}\nFix these before finishing (each "Fix:" says what to write); \`youiyoux show <component>\` and the youiyoux MCP tools give the legal values. CI runs the authoritative check.${see ? `\n${see}` : ""}`, project.root);
  } catch (error: unknown) {
    return claudeContext(`youiyoux could not check ${raw}: ${error instanceof Error ? error.message : String(error)}. The result is incomplete, not a pass.`);
  }
}

/* ------------------------------------------------------------ git pre-commit */

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await run("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** Staged files under the project, with their staged content (paths with spaces or newlines are safe). */
async function stagedSources(project: ChangeProject): Promise<Record<string, string>> {
  // The project's path inside the repo, from git itself: comparing paths would trip over symlinks (/var vs /private/var).
  const prefix = (await git(project.root, ["rev-parse", "--show-prefix"])).trim();
  const names = (await git(project.root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--relative"])).split("\0").filter(Boolean);
  const sources: Record<string, string> = {};
  for (const file of names) {
    if (isChecked(project, file)) sources[file] = await git(project.root, ["show", `:${prefix}${file}`]);
  }
  return sources;
}

/** git pre-commit: check the staged content of staged files. Exits 1 only when `strict` and something fails. */
export async function runPreCommitHook(target: HookTarget = {}, options: { strict?: boolean } = {}): Promise<HookOutcome> {
  const label = options.strict ? "youiyoux pre-commit (blocks new errors and drift; CI is authoritative)" : "youiyoux pre-commit (advisory; CI is authoritative)";
  try {
    const project = await load(target, process.cwd());
    const staged = await stagedSources(project);
    const files = Object.keys(staged);
    if (files.length === 0) return SILENT;
    const found = await changeFor(() => stagedChange(project));
    if (found.problem !== undefined) return { stdout: `${viaNpx(found.problem, project.root)}\n`, exitCode: options.strict ? 1 : 0 };
    const { change } = found;
    const result = configured(project) ? await runCheck(project, { files: files.map((f) => join(project.root, f)), overrides: staged, lock: false, baseline: await baselineFor(project, target), diff: change }) : await runRepoCheck(project, change);
    const lines = findingLines(result, project.root);
    const failing = result.incomplete || (result.diff?.findings.length ?? 0) > 0;
    if (lines.length === 0) return { stdout: `${label}: ${files.length} staged file(s) clean, no drift\n`, exitCode: 0 };
    const verdict = !failing ? "warnings only" : options.strict ? "commit blocked; fix these, or commit with --no-verify and let CI decide" : "not blocking; fix these before you push (CI fails on errors)";
    return { stdout: `${label}: ${verdict}\n${viaNpx(lines.join("\n"), project.root)}\n`, exitCode: options.strict && failing ? 1 : 0 };
  } catch (error: unknown) {
    return { stdout: `${label}: could not check the staged files (${error instanceof Error ? error.message : String(error)}); the result is incomplete, not a pass\n`, exitCode: options.strict ? 1 : 0 };
  }
}
