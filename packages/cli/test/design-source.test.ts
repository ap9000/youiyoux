/** A design system from git, fetched into a cache and pinned by the lockfile. The repositories are local (file://): nothing touches the network. */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectConfig } from "@youiyoux/core";
import { gitCheckout, loadProject } from "@youiyoux/scanner";
import { main } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd });
const head = async (cwd: string): Promise<string> => (await git(cwd, "rev-parse", "HEAD")).stdout.trim();

let dir: string;
let source: string;
let url: string;
let first: string;
let env: NodeJS.ProcessEnv;
let out = "";

/** A product whose config names the design repo by git. */
async function product(name: string, ref = "main"): Promise<string> {
  const root = join(dir, name);
  await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
  const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { git: url, ref } }));
  return root;
}

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-git-source-")));
  source = join(dir, "design");
  await cp(join(EXAMPLES, "demo-design"), source, { recursive: true });
  await git(source, "init", "--quiet", "--initial-branch=main");
  await git(source, "add", ".");
  await git(source, "commit", "--quiet", "-m", "v1");
  await git(source, "tag", "v1");
  first = await head(source);
  url = `file://${source}`;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  env = { ...process.env };
  process.env.YOUI_SYSTEMS_CACHE = join(dir, `cache-${Math.random().toString(36).slice(2)}`);
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
});
afterEach(() => {
  process.env = env;
  vi.restoreAllMocks();
});

describe("a design system from git", () => {
  test("a tag is fetched once, kept per commit, and used offline from then on", async () => {
    const got = await gitCheckout(url, "v1");
    expect(got.commit).toBe(first);
    expect(await readFile(join(got.root, "youi.config.json"), "utf8")).toContain('"demo"');
    // With the repository unreachable, the cache still answers.
    await rename(source, `${source}-away`);
    try {
      expect(await gitCheckout(url, "v1")).toEqual(got);
    } finally {
      await rename(`${source}-away`, source);
    }
  });

  test("a branch keeps its recorded commit until sync resolves it again, and sync records the commit in the lockfile", async () => {
    const root = await product("branch-app");
    expect((await loadProject(root)).designCommit).toBe(first);
    // The design moves on.
    await writeFile(join(source, "NEWS.md"), "v2\n");
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "v2");
    const second = await head(source);
    expect((await loadProject(root)).designCommit).toBe(first);
    expect(await main(["sync", "--project", root])).toBe(0);
    const lock = JSON.parse(await readFile(join(root, "youi.lock.json"), "utf8")) as { sourceCommit: string };
    expect(lock.sourceCommit).toBe(second);
    expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toContain("buttonVariants");
    expect((await loadProject(root)).designCommit).toBe(second);
  }, 60_000);

  test("the lockfile's commit wins over the ref, so a teammate's fresh clone uses the same design", async () => {
    const root = await product("locked-app");
    await writeFile(join(root, "youi.lock.json"), JSON.stringify({ schema: "youi.lock/v1", system: "demo", systemVersion: "1.0.0", sourceCommit: first, syncedAt: "2026-10-23T00:00:00.000Z", files: {} }));
    const project = await loadProject(root);
    expect(project.designCommit).toBe(first);
    expect(project.repo.root.endsWith(first)).toBe(true);
  });

  test("a ref or a locked commit the repository lacks says what to do", async () => {
    await expect(gitCheckout(url, "v9")).rejects.toThrow(`${url} has no branch, tag or commit "v9"`);
    const root = await product("gone-app");
    await writeFile(join(root, "youi.lock.json"), JSON.stringify({ schema: "youi.lock/v1", system: "demo", systemVersion: "1.0.0", sourceCommit: "0".repeat(40), syncedAt: "2026-10-23T00:00:00.000Z", files: {} }));
    await expect(loadProject(root)).rejects.toThrow("which youi.lock.json records: run youiyoux sync to resolve");
    await expect(gitCheckout(`file://${join(dir, "nowhere")}`, "main")).rejects.toThrow(/could not fetch the design system from file:\/\//);
  });

  test("only git URLs and refs that cannot be read as anything else are accepted", () => {
    const base = { schema: "youi.project/v1", id: "app", system: "demo", include: ["**/*.tsx"], componentsDir: "components/ui" };
    const ok = (git: string, ref = "v3") => ProjectConfig.safeParse({ ...base, source: { git, ref } }).success;
    for (const good of ["github:acme/design", "https://github.com/acme/design.git", "git@github.com:acme/design.git", "ssh://git@example.com/acme/design.git", "file:///srv/design"]) expect(ok(good), good).toBe(true);
    for (const bad of ["ext::sh -c touch% /tmp/pwned", "--upload-pack=touch /tmp/pwned", "-uhttps://x", "https://x y", "github:acme/../design", "http://example.com/design.git", "/srv/design", "fd::17"]) expect(ok(bad), bad).toBe(false);
    for (const ref of ["-x", "--upload-pack=x", "a..b", "v 3", "main;rm"]) expect(ok("github:acme/design", ref), ref).toBe(false);
    for (const ref of ["v3", "main", "release/2026-10", "a".repeat(40)]) expect(ok("github:acme/design", ref), ref).toBe(true);
  });
});
