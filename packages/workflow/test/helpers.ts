/** Throwaway git repositories: a copy of the design definitions and of the scanner's fixture project. */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesignRepo } from "@youiyoux/core";
import { loadProject } from "@youiyoux/scanner";

export const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "seed");
}

export interface Sandbox {
  readonly dir: string;
  readonly design: string;
  readonly project: string;
  readonly state: string;
  commitDesign(path: string, content: string, message?: string): Promise<string>;
  editProject(path: string, content: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Copy the design definitions the fixture uses (wherever they live) and the fixture project into new git repositories. */
export async function sandbox(): Promise<Sandbox> {
  const source = (await loadProject(FIXTURE)).repo.root;
  const repo = await loadDesignRepo(source);
  const dir = await mkdtemp(join(tmpdir(), "youi-workflow-"));
  const design = join(dir, "design");
  const project = join(dir, "project");
  const paths = new Set(["youi.config.json", ...repo.systems.flatMap((s) => [s.config.tokens.split("/").slice(0, -1).join("/"), s.config.components, s.config.rules, ...(s.config.design ? [s.config.design] : [])])]);
  for (const path of paths) await cp(join(source, path), join(design, path), { recursive: true });
  initRepo(design);
  await cp(FIXTURE, project, { recursive: true });
  initRepo(project);
  return {
    dir,
    design,
    project,
    state: join(dir, "state"),
    async commitDesign(path, content, message = "design change") {
      await writeFile(join(design, path), content);
      git(design, "add", "-A");
      git(design, "commit", "--quiet", "-m", message);
      return git(design, "rev-parse", "HEAD");
    },
    async editProject(path, content) {
      await writeFile(join(project, path), content);
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
