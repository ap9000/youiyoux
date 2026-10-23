/** Finding the project without flags: commands run from anywhere inside a product (or a design repo), as git does. */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findUp } from "@youiyoux/core";
import { located } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const BIN = join(import.meta.dirname, "../bin/youi.js");
const run = promisify(execFile);

let dir: string;
let app: string;
let design: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-locate-")));
  app = join(dir, "demo-app");
  design = join(dir, "demo-design");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), design, { recursive: true });
  await mkdir(join(app, ".git"));
  await mkdir(join(design, ".git"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("finding the project from where you are", () => {
  test("the nearest youi.project.json upward is the project; the walk stops at the repository's top", async () => {
    const deep = join(app, "app/(tabs)/settings");
    await mkdir(deep, { recursive: true });
    expect(findUp(deep, "youi.project.json")).toBe(app);
    // A config above the repository (in a parent folder, or the home directory) is someone else's.
    const repo = join(dir, "outer/inner-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(dir, "outer/youi.project.json"), "{}");
    expect(findUp(join(repo), "youi.project.json")).toBeNull();
    // A worktree's .git is a file, and still the top.
    const worktree = join(dir, "outer/worktree");
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: elsewhere\n");
    expect(findUp(join(worktree, "src"), "youi.project.json")).toBeNull();
  });

  test("product commands get the found project; a flag that says where always wins; design-repo commands find youi.config.json", () => {
    const sub = join(app, "components/ui");
    expect(located("check", { help: false } as never, sub).project).toBe(app);
    expect(located("mcp", {} as never, sub).project).toBe(app);
    expect(located("check", { project: "/elsewhere" } as never, sub).project).toBe("/elsewhere");
    expect(located("check", { config: "/elsewhere/youi.project.json" } as never, sub).project).toBeUndefined();
    expect(located("check", { root: "/elsewhere" } as never, sub).project).toBeUndefined();
    // init writes a config where you are, never into a project found above.
    expect(located("init", {} as never, sub).project).toBeUndefined();
    expect(located("build", {} as never, join(design, "components")).design).toBe(design);
    expect(located("build", { design: "/elsewhere" } as never, join(design, "components")).design).toBe("/elsewhere");
    expect(located("check", {} as never, tmpdir()).project).toBeUndefined();
  });

  test("youiyoux show and build run from a subfolder with no flags", async () => {
    const shown = await run(process.execPath, [BIN, "show", "Button"], { cwd: join(app, "components/ui") });
    expect(shown.stdout).toContain("Button");
    expect(shown.stdout).toContain("@/components/ui");
    const built = await run(process.execPath, [BIN, "build", "--json"], { cwd: join(design, "components") });
    expect(JSON.parse(built.stdout).out).toBe(join(design, "build/demo"));
  }, 60_000);
});
