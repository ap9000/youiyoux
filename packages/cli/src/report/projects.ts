/**
 * What `youiyoux report` scans in a repo with no youiyoux setup: the workspace members that have UI
 * files (pnpm-workspace.yaml, else package.json `workspaces`), one section each, or else the repo
 * itself as one project. The repo is named from its package.json, else its directory; never from
 * a git remote, which can carry credentials.
 */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { findFiles } from "@youiyoux/core";
import { DEFAULT_EXCLUDE } from "@youiyoux/scanner";
import { readJson } from "../init.ts";

export interface ReportProject {
  /** Repo-relative POSIX directory: `apps/web`, or `.` for the repo itself. */
  readonly dir: string;
  /** Absolute. */
  readonly root: string;
  /** Its package.json name, when it has one. */
  readonly name: string | null;
}

interface RepoProjects {
  /** Absolute. */
  readonly root: string;
  readonly name: string;
  /** How the projects were found, for a reader. */
  readonly layout: string;
  readonly projects: readonly ReportProject[];
  /** Workspace members left out because they have no UI files. */
  readonly skipped: readonly string[];
}

const UI_FILES = ["**/*.{tsx,jsx,astro,vue,svelte}"];

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The workspace globs and where they came from, or null for a single-package repo. */
async function workspaceGlobs(root: string, pkg: Record<string, unknown> | null): Promise<{ globs: string[]; source: string } | null> {
  const pnpm = await readFile(join(root, "pnpm-workspace.yaml"), "utf8").catch(() => null);
  if (pnpm !== null) {
    try {
      const globs = strings((parseYaml(pnpm) as { packages?: unknown } | null)?.packages);
      if (globs.length > 0) return { globs, source: "pnpm-workspace.yaml" };
    } catch {
      // An unreadable workspace file: fall through to package.json, then the repo as one project.
    }
  }
  const workspaces = pkg?.workspaces;
  const globs = Array.isArray(workspaces) ? strings(workspaces) : strings((workspaces as { packages?: unknown } | undefined)?.packages);
  return globs.length > 0 ? { globs, source: "package.json workspaces" } : null;
}

const hasUi = async (dir: string): Promise<boolean> => (await findFiles(dir, UI_FILES, DEFAULT_EXCLUDE)).length > 0;

export async function findProjects(dir: string): Promise<RepoProjects> {
  const root = resolve(dir);
  const pkg = await readJson(join(root, "package.json"));
  const name = typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name.trim() : basename(root);
  const single: ReportProject = { dir: ".", root, name: typeof pkg?.name === "string" ? pkg.name : null };
  const workspace = await workspaceGlobs(root, pkg);
  if (!workspace) return { root, name, layout: "one project", projects: [single], skipped: [] };
  const include = workspace.globs.filter((g) => !g.startsWith("!")).map((g) => `${g.replace(/\/+$/, "")}/package.json`);
  const exclude = workspace.globs.filter((g) => g.startsWith("!")).map((g) => `${g.slice(1).replace(/\/+$/, "")}/package.json`);
  const members = (await findFiles(root, include, exclude)).map((file) => file.slice(0, -"/package.json".length)).filter((member) => member && member !== ".");
  const projects: ReportProject[] = [];
  const skipped: string[] = [];
  for (const member of members) {
    const memberRoot = join(root, member);
    if (!(await hasUi(memberRoot))) {
      skipped.push(member);
      continue;
    }
    const memberPkg = await readJson(join(memberRoot, "package.json"));
    projects.push({ dir: member, root: memberRoot, name: typeof memberPkg?.name === "string" ? memberPkg.name : null });
  }
  if (projects.length === 0) return { root, name, layout: `one project (${workspace.source} names no package with UI files)`, projects: [single], skipped };
  return { root, name, layout: `${projects.length} workspace package${projects.length === 1 ? "" : "s"} with UI files (${workspace.source})`, projects, skipped };
}
