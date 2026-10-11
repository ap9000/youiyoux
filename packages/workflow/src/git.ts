/**
 * Git, read mostly. The one write is `createReviewBranch`: it builds a commit from a
 * base with plumbing (a private index, hash-object, commit-tree) and creates a new
 * branch for it, so the working tree, the checked-out branch and the default branch
 * are never touched.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

/** The branch reviews merge into: origin's HEAD when known, else the checked-out branch, else main. */
export async function defaultBranch(top: string): Promise<string> {
  const remote = await gitOrNull(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote.replace(/^origin\//, "");
  return (await gitOrNull(top, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? "main";
}

export async function branchTip(top: string, branch: string): Promise<string> {
  const tip = await gitOrNull(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!tip) throw new GitError(`the design repository has no local branch "${branch}"`);
  return tip;
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

/** File names directly under `dir` at a commit. */
export async function listAt(top: string, commit: string, dir: string): Promise<string[]> {
  const out = await gitOrNull(top, ["ls-tree", "--name-only", `${commit}:${dir}`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** True when any of `paths` has uncommitted changes (including untracked files). */
export async function hasChanges(top: string, paths: readonly string[]): Promise<boolean> {
  const out = await git(top, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
  return out.trim().length > 0;
}

/**
 * A digest of a working tree's uncommitted changes (tracked diffs plus untracked file
 * contents), or null when it is clean. Two equal digests mean the same files on disk.
 */
export async function changesDigest(top: string): Promise<string | null> {
  const status = await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.length === 0) return null;
  const diff = await git(top, ["diff", "HEAD", "--binary"]);
  const untracked = (await git(top, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  const contents = await Promise.all(untracked.map(async (path) => `${path}\0${sha256(await readFile(join(top, path)).catch(() => Buffer.from("")))}`));
  return sha256([status, diff, ...contents].join("\0"));
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
 * pointing at it. Refuses an existing branch name and the protected branch; never
 * checks anything out.
 */
export async function createReviewBranch(top: string, input: { base: string; branch: string; protectedBranch: string; files: Readonly<Record<string, string>>; message: string }): Promise<ReviewBranch> {
  const { base, branch, protectedBranch, files, message } = input;
  if (branch === protectedBranch) throw new GitError(`refusing to write to ${protectedBranch}: changes go to a review branch`);
  await git(top, ["check-ref-format", "--branch", branch]);
  if ((await gitOrNull(top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) !== null) throw new GitError(`branch ${branch} already exists`);
  const scratch = await mkdtemp(join(tmpdir(), "youi-index-"));
  const env = { ...(await identityEnv(top)), GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await git(top, ["read-tree", base], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = (await git(top, ["hash-object", "-w", "--stdin", `--path=${path}`], { input: content })).trim();
      await git(top, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = (await git(top, ["write-tree"], { env })).trim();
    const commit = (await git(top, ["commit-tree", tree, "-p", base, "-F", "-"], { env, input: message })).trim();
    // The all-zero old value makes creation fail if the branch appeared in the meantime.
    await git(top, ["update-ref", "-m", "youi rule editor: review branch", `refs/heads/${branch}`, commit, "0".repeat(base.length)]);
    return { branch, commit, diff: await git(top, ["diff", "--no-color", base, commit]) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
