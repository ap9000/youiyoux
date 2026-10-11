/** A consumer project: its youi.project.json, its root, and the design system it uses. */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getSystem, loadDesignRepo, normalizeProjectConfig, ProjectConfig, readDefinition, type DesignRepo, type LoadedSystem } from "@youiyoux/core";

export const PROJECT_FILE = "youi.project.json";

export interface Project {
  /** Absolute project root. */
  readonly root: string;
  readonly config: ProjectConfig;
  readonly repo: DesignRepo;
  readonly system: LoadedSystem;
}

export interface LoadProjectOptions {
  /** Use this config file instead of `<root>/youi.project.json` (e.g. a pilot config kept outside a read-only project). */
  readonly configPath?: string;
  /** Override the design repo location (otherwise `source.path` from the config). */
  readonly designRoot?: string;
}

export async function loadProject(root: string, options: LoadProjectOptions = {}): Promise<Project> {
  const absoluteRoot = resolve(root);
  const configFile = resolve(options.configPath ?? join(absoluteRoot, PROJECT_FILE));
  const config = normalizeProjectConfig(await readDefinition(configFile, ProjectConfig));
  const designRoot = options.designRoot
    ? resolve(options.designRoot)
    : isAbsolute(config.source.path)
      ? config.source.path
      : resolve(options.configPath ? dirname(configFile) : absoluteRoot, config.source.path);
  const repo = await loadDesignRepo(designRoot);
  return { root: absoluteRoot, config, repo, system: getSystem(repo, config.system) };
}
