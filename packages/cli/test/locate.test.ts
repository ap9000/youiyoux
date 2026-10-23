/**
 * Finding the project and the design system without flags: commands run from anywhere inside a
 * product (or a design repo), as git does, and a config names its design system by package.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { findUp, ProjectConfig } from "@youiyoux/core";
import { loadProject } from "@youiyoux/scanner";
import { located, main } from "../src/index.ts";

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

  test("it fails closed: outside any repository nothing is found, and a config another user owns ends the search", async () => {
    // A config left in a shared folder (/tmp) above a folder that is not a repository is never read.
    const loose = join(dir, "shared/work");
    await mkdir(loose, { recursive: true });
    await writeFile(join(dir, "shared/youi.project.json"), "{}");
    expect(findUp(loose, "youi.project.json")).toBeNull();
    // Inside a repository, a config owned by someone else is not this person's project.
    const deep = join(app, "components/ui");
    const me = process.getuid?.();
    if (me === undefined) return;
    expect(findUp(deep, "youi.project.json", me)).toBe(app);
    expect(findUp(deep, "youi.project.json", me + 1)).toBeNull();
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

describe("a design system named by package", () => {
  const withSource = async (root: string, source: unknown): Promise<void> => {
    const config = JSON.parse(await readFile(join(app, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, source }));
  };

  test("it is found in the product's node_modules, through a workspace link, or in a parent's node_modules as a monorepo hoists it", async () => {
    const product = join(dir, "pkg-app");
    await cp(app, product, { recursive: true });
    await withSource(product, { package: "@acme/design" });
    await mkdir(join(product, "node_modules/@acme"), { recursive: true });
    await symlink(design, join(product, "node_modules/@acme/design"), "dir");
    const project = await loadProject(product);
    expect(project.repo.root).toBe(design);
    expect(project.system.config.id).toBe("demo");

    const mono = join(dir, "mono");
    const web = join(mono, "apps/web");
    await cp(app, web, { recursive: true });
    await withSource(web, { package: "design" });
    await mkdir(join(mono, "node_modules"), { recursive: true });
    await symlink(design, join(mono, "node_modules/design"), "dir");
    expect((await loadProject(web)).repo.root).toBe(design);
  });

  test("not installed, it says so and what to do; never another folder", async () => {
    const product = join(dir, "missing-app");
    await cp(app, product, { recursive: true });
    await withSource(product, { package: "@acme/not-installed" });
    await expect(loadProject(product)).rejects.toThrow(/the design system package @acme\/not-installed is not installed for .*add it as a dependency and install, or set source.path/);
  });

  test("a package name is a name: no path, no .., not both forms at once", () => {
    const base = { schema: "youi.project/v1", id: "app", system: "demo", include: ["**/*.tsx"], componentsDir: "components/ui" };
    for (const name of ["../design", "@acme/../../etc", "/abs/design", "./design", "https://x.test/d", "@acme", "Design"]) expect(ProjectConfig.safeParse({ ...base, source: { package: name } }).success, name).toBe(false);
    expect(ProjectConfig.safeParse({ ...base, source: { path: "../d", package: "d" } }).success).toBe(false);
    expect(ProjectConfig.safeParse({ ...base, source: { package: "@acme/design.system" } }).success).toBe(true);
    expect(ProjectConfig.safeParse({ ...base, source: { path: "../design" } }).success).toBe(true);
  });

  test("init --design <package> writes the package, not this machine's folder, and syncs", async () => {
    const product = join(dir, "init-app");
    await mkdir(join(product, "node_modules/@acme"), { recursive: true });
    await cp(join(app, "app"), join(product, "app"), { recursive: true });
    await cp(join(app, "tsconfig.json"), join(product, "tsconfig.json"));
    await writeFile(join(product, "package.json"), JSON.stringify({ name: "init-app", dependencies: { "expo-router": "6.0.0", "@acme/design": "workspace:*" } }));
    await symlink(design, join(product, "node_modules/@acme/design"), "dir");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["init", "--project", product, "--design", "@acme/design"])).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    const config = JSON.parse(await readFile(join(product, "youi.project.json"), "utf8")) as Record<string, unknown>;
    expect(config.source).toEqual({ package: "@acme/design" });
    expect(await readFile(join(product, "components/ui/button.tsx"), "utf8")).toContain("buttonVariants");
  });
});
