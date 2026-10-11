/**
 * Git, read mostly. The one write is `createReviewBranch`: it builds a commit from a
 * base with plumbing (a private index, hash-object, commit-tree) and creates a new
 * branch for it, so the working tree, the checked-out branch and the default branch
 * are never touched.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "@youiyoux/core";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  override name = "GitError";
}

interface GitOptions {
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  try {
    if (options.input !== undefined) return await gitWithInput(cwd, args, options);
    const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, ...options.env } });
    return stdout;
  } catch (error: unknown) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new GitError(`git ${args[0]} failed in ${cwd}: ${detail}`);
  }
}

function gitWithInput(cwd: string, args: readonly string[], options: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, ...options.env } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
    child.stdin?.end(options.input);
  });
}

async function gitOrNull(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return null;
  }
}

/** Where a directory sits in its repository. */
export interface RepoLocation {
  readonly top: string;
  /** The directory relative to `top`, with a trailing slash, or "" at the top. */
  readonly prefix: string;
}

export async function locate(dir: string): Promise<RepoLocation | null> {
  const top = await gitOrNull(dir, ["rev-parse", "--show-toplevel"]);
  if (top === null) return null;
  return { top, prefix: (await gitOrNull(dir, ["rev-parse", "--show-prefix"])) ?? "" };
}

const SAFE_BRANCH = /^[\w./-]+$/;

/**
 * The branch reviews merge into: origin's HEAD when known, else a local main or master.
 * Never whatever happens to be checked out: a draft based on a feature branch would carry
 * that branch's commits into its review.
 */
export async function defaultBranch(top: string): Promise<string> {
  const remote = (await gitOrNull(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "");
  const branch = remote ?? (await Promise.all(["main", "master"].map(async (b) => ((await gitOrNull(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) ? b : null)))).find(Boolean);
  if (!branch) throw new GitError(`cannot tell the design repository's default branch: run \`git -C ${top} remote set-head origin --auto\`, or create main`);
  if (!SAFE_BRANCH.test(branch)) throw new GitError(`the default branch name "${branch}" has characters this editor will not put in a command`);
  return branch;
}

/** The tip of `branch`: the local branch, or origin's when there is no local one. */
export async function branchTip(top: string, branch: string): Promise<string> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const tip = await gitOrNull(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (tip) return tip;
  }
  throw new GitError(`the design repository has no branch "${branch}"`);
}

export async function headCommit(top: string): Promise<string | null> {
  return gitOrNull(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
}

/** A file's content at a commit (path relative to the repository top), or null when it is not there. */
export async function readAt(top: string, commit: string, path: string): Promise<string | null> {
  const exists = await gitOrNull(top, ["cat-file", "-t", `${commit}:${path}`]);
  if (exists !== "blob") return null;
  return git(top, ["cat-file", "blob", `${commit}:${path}`]);
}

/** True when `commit` is already part of `tip` (merged). */
export async function isAncestor(top: string, commit: string, tip: string): Promise<boolean> {
  try {
    await git(top, ["merge-base", "--is-ancestor", commit, tip]);
    return true;
  } catch {
    return false;
  }
}

/** File names directly under `dir` at a commit. */
export async function listAt(top: string, commit: string, dir: string): Promise<string[]> {
  const out = await gitOrNull(top, ["ls-tree", "--name-only", `${commit}:${dir}`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** True when any of `paths` has uncommitted changes (including untracked files). */
export async function hasChanges(top: string, paths: readonly string[]): Promise<boolean> {
  const out = await git(top, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--", ...paths]);
  return out.trim().length > 0;
}

/**
 * A digest of a working tree's uncommitted changes (tracked diffs plus untracked file
 * contents), or null when it is clean. Two equal digests mean the same files on disk.
 */
export async function changesDigest(top: string): Promise<string | null> {
  const status = await git(top, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.length === 0) return null;
  const diff = await streamDigest(top, ["--no-optional-locks", "diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"]);
  const untracked = (await git(top, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  const contents = await Promise.all(untracked.map(async (path) => `${path}\0${await fileDigest(join(top, path))}`));
  return sha256([status, diff, ...contents].join("\0"));
}

const MAX_HASHED_FILE = 8 * 1024 * 1024;

/** A regular file's content digest; size and time for very large files; a marker for anything else (FIFOs, devices, links). */
async function fileDigest(file: string): Promise<string> {
  const info = await lstat(file).catch(() => null);
  if (!info) return "missing";
  if (!info.isFile()) return `${info.isSymbolicLink() ? "link" : "special"}:${info.mtimeMs}`;
  if (info.size > MAX_HASHED_FILE) return `large:${info.size}:${info.mtimeMs}`;
  return sha256(await readFile(file));
}

/** sha256 of a git command's output, streamed, so a large diff cannot exhaust a buffer. */
function streamDigest(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(hash.digest("hex")) : reject(new GitError(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`))));
  });
}

export interface ReviewBranch {
  readonly branch: string;
  readonly commit: string;
  readonly diff: string;
}

const FALLBACK_IDENTITY = { name: "YouIyouX rule editor", email: "rule-editor@youiyoux.local" };

async function identityEnv(top: string): Promise<Record<string, string>> {
  const name = await gitOrNull(top, ["config", "user.name"]);
  const email = await gitOrNull(top, ["config", "user.email"]);
  if (name && email) return {};
  return { GIT_AUTHOR_NAME: name || FALLBACK_IDENTITY.name, GIT_AUTHOR_EMAIL: email || FALLBACK_IDENTITY.email, GIT_COMMITTER_NAME: name || FALLBACK_IDENTITY.name, GIT_COMMITTER_EMAIL: email || FALLBACK_IDENTITY.email };
}

/**
 * Commit `files` (top-relative path → new content) on top of `base` and create `branch`
 * pointing at it. Never checks anything out and refuses the protected branch. If `branch`
 * already holds exactly this change (a hand-off that was interrupted after creating it),
 * it is adopted; any other existing branch of that name is refused.
 */
export async function createReviewBranch(top: string, input: { base: string; branch: string; protectedBranch: string; files: Readonly<Record<string, string>>; message: string }): Promise<ReviewBranch & { adopted: boolean }> {
  const { base, branch, protectedBranch, files, message } = input;
  if (branch === protectedBranch) throw new GitError(`refusing to write to ${protectedBranch}: changes go to a review branch`);
  await git(top, ["check-ref-format", "--branch", branch]);
  const scratch = await mkdtemp(join(tmpdir(), "youi-index-"));
  const env = { ...(await identityEnv(top)), GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await git(top, ["read-tree", base], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = (await git(top, ["hash-object", "-w", "--stdin", `--path=${path}`], { input: content })).trim();
      await git(top, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = (await git(top, ["write-tree"], { env })).trim();
    const existing = await gitOrNull(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (existing) {
      const [existingTree, parent] = await Promise.all([gitOrNull(top, ["rev-parse", `${existing}^{tree}`]), gitOrNull(top, ["rev-parse", `${existing}^`])]);
      if (existingTree !== tree || parent !== base) throw new GitError(`branch ${branch} already exists with other content`);
      return { branch, commit: existing, diff: await reviewDiff(top, base, existing), adopted: true };
    }
    const commit = (await git(top, ["commit-tree", tree, "-p", base, "-F", "-"], { env, input: message })).trim();
    // The all-zero old value makes creation fail if the branch appeared in the meantime.
    await git(top, ["update-ref", "-m", "youi rule editor: review branch", `refs/heads/${branch}`, commit, "0".repeat(base.length)]);
    return { branch, commit, diff: await reviewDiff(top, base, commit), adopted: false };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function reviewDiff(top: string, base: string, commit: string): Promise<string> {
  return git(top, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, commit]);
}
