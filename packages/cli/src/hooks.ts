/**
 * Agent-time checks. Both are advisory; the CI check (`youi check --baseline
 * --format github`) is the authoritative gate. What each one guarantees:
 *
 * - Claude Code PostToolUse: after Claude's Edit/Write/MultiEdit on a checked file,
 *   that file's new violations go back to Claude as context. Never blocks; sees only
 *   edits made through those tools.
 * - git pre-commit (Codex, humans and any agent that commits): checks the staged
 *   content of staged files at commit time. Not every edit, and `--no-verify` skips
 *   it; blocks the commit only when installed with --strict.
 *
 * Neither checks generated output, files outside the project's include globs, or
 * the lockfile; failures to check are reported as incomplete, never as clean.
 */
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { matchesAny, relPath } from "@youiyoux/core";
import { langOf, loadProject, PROJECT_FILE, type Project } from "@youiyoux/scanner";
import { baselinePath, runCheck, type CheckResult } from "./check.ts";
import { actionable } from "./check-render.ts";

const run = promisify(execFile);
const MAX_LISTED = 20;
const ALWAYS_SKIPPED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.youi/**"];

export interface HookTarget {
  readonly project?: string;
  readonly config?: string;
  readonly design?: string;
  readonly root?: string;
}

export interface HookOutcome {
  readonly stdout: string;
  readonly exitCode: number;
}

const SILENT: HookOutcome = { stdout: "", exitCode: 0 };

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** The nearest directory at or above `start` holding youi.project.json. */
async function findProjectRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    if (await exists(join(dir, PROJECT_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function load(target: HookTarget, near: string): Promise<Project | null> {
  const root = target.project ?? (await findProjectRoot(near));
  if (!root) return null;
  return loadProject(root, { ...(target.config ? { configPath: target.config } : {}), ...(target.design ? { designRoot: target.design } : {}), ...(target.root ? { productRoot: target.root } : {}) });
}

/** Whether a project-relative file is one youi checks: included, not excluded, not generated output, a checked language. */
export function isChecked(project: Project, file: string): boolean {
  const { include, exclude, outputs } = project.config;
  if (file.startsWith("../") || isAbsolute(file) || file.startsWith(`${outputs.dir}/`) || langOf(file) === null) return false;
  return matchesAny(file, include) && !matchesAny(file, [...ALWAYS_SKIPPED, ...exclude]);
}

async function baselineFor(project: Project, target: HookTarget): Promise<string | null> {
  const file = baselinePath(project, target.config);
  return (await exists(file)) ? file : null;
}

/** Findings as a short list an agent can act on. */
function findingLines(result: CheckResult): string[] {
  const list = actionable(result);
  const lines = list.slice(0, MAX_LISTED).map((v) => `- ${v.file}:${v.line}:${v.column} ${v.severity} ${v.rule.slice(v.rule.indexOf("/rule/") + 6)}: ${v.message}${v.suggestion ? ` → ${v.suggestion}` : ""}`);
  if (list.length > MAX_LISTED) lines.push(`- …and ${list.length - MAX_LISTED} more (run \`youi check\`)`);
  for (const failure of result.failed) lines.push(`- ${failure.file}: incomplete, could not be fully analysed (${failure.reason}); 0 findings there is not a pass`);
  return lines;
}

/* ----------------------------------------------------------- Claude Code hook */

interface PostToolUseInput {
  readonly cwd?: string;
  readonly tool_input?: { readonly file_path?: unknown };
}

function claudeContext(text: string): HookOutcome {
  return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } })}\n`, exitCode: 0 };
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
    if (!project) return SILENT;
    // Real paths on both sides: the payload and the configured root may differ only by symlinks.
    const real = (path: string): Promise<string> => realpath(path).catch(() => path);
    const relative = relPath(await real(project.root), await real(file));
    if (!isChecked(project, relative)) return SILENT;
    const result = await runCheck(project, { files: [file], lock: false, baseline: await baselineFor(project, target) });
    const lines = findingLines(result);
    if (lines.length === 0) return SILENT;
    const known = result.baseline && result.baseline.comparison.known.length > 0 ? ` (${result.baseline.comparison.known.length} older ones in this file are baselined)` : "";
    return claudeContext(`youi design-system check (advisory) on ${relative}${known}:\n${lines.join("\n")}\nFix these before finishing; \`youi show <component>\` and the youi MCP tools give the legal values. CI runs the authoritative check.`);
  } catch (error: unknown) {
    return claudeContext(`youi could not check ${raw}: ${error instanceof Error ? error.message : String(error)}. The result is incomplete, not a pass.`);
  }
}

/* ------------------------------------------------------------ git pre-commit */

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await run("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** Staged files under the project, with their staged content (paths with spaces or newlines are safe). */
async function stagedSources(project: Project): Promise<Record<string, string>> {
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
  const label = options.strict ? "youi pre-commit (blocks new errors; CI is authoritative)" : "youi pre-commit (advisory; CI is authoritative)";
  try {
    const project = await load(target, process.cwd());
    if (!project) return SILENT;
    const staged = await stagedSources(project);
    const files = Object.keys(staged);
    if (files.length === 0) return SILENT;
    const result = await runCheck(project, { files: files.map((f) => join(project.root, f)), overrides: staged, lock: false, baseline: await baselineFor(project, target) });
    const lines = findingLines(result);
    const failing = result.errors > 0 || result.incomplete;
    if (lines.length === 0) return { stdout: `${label}: ${files.length} staged file(s) clean\n`, exitCode: 0 };
    const verdict = failing ? (options.strict ? "commit blocked; fix these, or commit with --no-verify and let CI decide" : "not blocking; CI will fail on these errors") : "warnings only";
    return { stdout: `${label}: ${verdict}\n${lines.join("\n")}\n`, exitCode: options.strict && failing ? 1 : 0 };
  } catch (error: unknown) {
    return { stdout: `${label}: could not check the staged files (${error instanceof Error ? error.message : String(error)}); the result is incomplete, not a pass\n`, exitCode: options.strict ? 1 : 0 };
  }
}
