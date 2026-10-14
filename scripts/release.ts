/**
 * `pnpm release <patch|minor|major|x.y.z> [--yes] [--dry-run] [--trailer "Key: value"]…`
 *
 * Cuts a release from an up-to-date, clean main: bumps every workspace package.json to the new
 * version (the workspace keeps one version), runs the typecheck and tests, commits
 * "Release vX.Y.Z", tags vX.Y.Z (annotated), then pushes main and the tag after saying exactly
 * what it pushes and getting --yes or a typed "y". The tag push runs .github/workflows/release.yml,
 * which publishes to npm and creates the GitHub Release.
 *
 * --dry-run does everything but commit, tag and push, then restores the files; guards that would
 * stop a real release are listed and make it exit 1. --trailer (repeatable, or RELEASE_TRAILERS,
 * one per line) adds commit trailers, e.g. an agent's Co-Authored-By; none are added by default.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

export type Bump = "patch" | "minor" | "major";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The version after `current`: a bump, or an explicit x.y.z that must be greater. */
export function nextVersion(current: string, bump: string): string {
  const now = SEMVER.exec(current);
  if (!now) throw new Error(`the current version ${current} is not x.y.z`);
  const [major, minor, patch] = now.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  const to = SEMVER.exec(bump.replace(/^v/, ""));
  if (!to) throw new Error(`"${bump}" is not patch, minor, major or a version like 1.2.3`);
  const next = to.slice(1).map(Number) as [number, number, number];
  const [a, b, c] = next;
  if (a < major || (a === major && (b < minor || (b === minor && c <= patch)))) throw new Error(`${a}.${b}.${c} is not greater than ${current}`);
  return `${a}.${b}.${c}`;
}

export interface RepoState {
  readonly branch: string;
  /** `git status --porcelain` output. */
  readonly status: string;
  /** Commits on HEAD not on origin/main, and on origin/main not on HEAD. */
  readonly ahead: number;
  readonly behind: number;
  readonly tagExists: boolean;
}

/** Why a release cannot start from this state; empty when it can. */
export function guardProblems(state: RepoState, tag: string): string[] {
  const problems: string[] = [];
  if (state.branch !== "main") problems.push(`on branch ${state.branch}, not main`);
  if (state.status.trim() !== "") problems.push("the working tree has uncommitted changes");
  if (state.behind > 0) problems.push(`${state.branch} is ${state.behind} commit(s) behind origin/main: pull first`);
  if (state.ahead > 0) problems.push(`${state.branch} is ${state.ahead} commit(s) ahead of origin/main: push or drop them first, so the release holds only reviewed commits`);
  if (state.tagExists) problems.push(`the tag ${tag} already exists`);
  return problems;
}

/** Commit trailers from --trailer flags and RELEASE_TRAILERS (one per line); only well-formed `Key: value` lines. */
export function trailersFrom(flags: readonly string[], env: string | undefined): string[] {
  const lines = [...flags, ...(env ?? "").split("\n")].map((l) => l.trim()).filter(Boolean);
  for (const line of lines) if (!/^[A-Za-z][A-Za-z0-9-]*: \S/.test(line)) throw new Error(`"${line}" is not a trailer like "Co-Authored-By: Name <email>"`);
  return lines;
}

export interface Options {
  readonly bump: string;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly trailers: string[];
}

export function parseArgs(argv: readonly string[]): Options {
  let bump: string | null = null;
  let yes = false;
  let dryRun = false;
  const trailers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--trailer") {
      const value = argv[++i];
      if (!value) throw new Error("--trailer needs a value");
      trailers.push(value);
    } else if (arg.startsWith("--trailer=")) trailers.push(arg.slice("--trailer=".length));
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (bump === null) bump = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!bump) throw new Error("usage: pnpm release <patch|minor|major|x.y.z> [--yes] [--dry-run] [--trailer \"Key: value\"]");
  return { bump, yes, dryRun, trailers };
}

/** Every workspace manifest: the root, packages/*, apps/*. */
export function manifests(root: string): string[] {
  const inDir = (dir: string): string[] => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((name) => join(dir, name, "package.json")).filter((f) => existsSync(join(root, f))) : []);
  return ["package.json", ...inDir("packages"), ...inDir("apps")];
}

/** The manifest's text with its top-level version set; formatting and key order are kept. */
export function setVersion(text: string, version: string): string {
  const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error("no version field to set");
  return next;
}

const git = (root: string, args: readonly string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function run(root: string, command: string, args: readonly string[]): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function release(root: string, options: Options): Promise<number> {
  const pkgFile = join(root, "packages/youiyoux/package.json");
  const current = (JSON.parse(readFileSync(pkgFile, "utf8")) as { version: string }).version;
  const version = nextVersion(current, options.bump);
  const tag = `v${version}`;
  const trailers = trailersFrom(options.trailers, process.env.RELEASE_TRAILERS);

  git(root, ["fetch", "--quiet", "--tags", "origin", "main"]);
  const [ahead, behind] = git(root, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]).split(/\s+/).map(Number) as [number, number];
  const state: RepoState = {
    branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    status: git(root, ["status", "--porcelain"]),
    ahead,
    behind,
    tagExists: git(root, ["tag", "--list", tag]) !== "" || git(root, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "",
  };
  const problems = guardProblems(state, tag);
  if (problems.length > 0 && !options.dryRun) {
    console.error(`Refusing to release ${tag}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }

  console.log(`Release ${current} -> ${version}${options.dryRun ? " (dry run: nothing is committed, tagged or pushed)" : ""}`);
  const files = manifests(root);
  const originals = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
  const restore = (): void => { for (const [f, text] of originals) writeFileSync(join(root, f), text); };
  try {
    for (const [f, text] of originals) writeFileSync(join(root, f), setVersion(text, version));
    console.log(`Set version ${version} in ${files.join(", ")}`);
    run(root, "pnpm", ["typecheck"]);
    run(root, "pnpm", ["test"]);
  } catch (error: unknown) {
    restore();
    console.error(`\nRelease stopped, files restored: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const message = [`Release ${tag}`, ...(trailers.length > 0 ? ["", ...trailers] : [])].join("\n");
  if (options.dryRun) {
    restore();
    console.log(`\nDry run done, files restored. A real run would now:\n  commit ${files.length} files: ${JSON.stringify(message)}\n  tag ${tag} (annotated)\n  push main and ${tag} to origin`);
    if (problems.length > 0) {
      console.error(`\nA real release would refuse:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
      return 1;
    }
    return 0;
  }

  git(root, ["add", "--", ...files]);
  execFileSync("git", ["commit", "--quiet", "-F", "-"], { cwd: root, input: message });
  git(root, ["tag", "-a", tag, "-m", tag]);
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  console.log(`\nCommitted ${head} "Release ${tag}" and tagged ${tag}.\nWill run: git push --atomic origin main ${tag}\n  main -> ${head} (the release commit, on top of origin/main)\n  ${tag} -> ${head}, which starts the npm publish and the GitHub Release`);
  if (!options.yes && !(await confirm("Push now?"))) {
    console.log(`Not pushed. To push later: git push --atomic origin main ${tag}\nTo undo: git tag -d ${tag} && git reset --hard HEAD~1`);
    return 0;
  }
  run(root, "git", ["push", "--atomic", "origin", "main", tag]);
  console.log(`\nPushed. Watch the publish: https://github.com/ap9000/youiyoux/actions/workflows/release.yml`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await release(join(import.meta.dirname, ".."), parseArgs(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
