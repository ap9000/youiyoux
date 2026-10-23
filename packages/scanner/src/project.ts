/** A consumer project: its youi.project.json, its root, and the design system it uses. */
import { stat } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { getSystem, loadDesignRepo, normalizeProjectConfig, ProjectConfig, readDefinition, type DesignRepo, type LoadedSystem } from "@youiyoux/core";
import { locateDesign } from "./design-source.ts";

export const PROJECT_FILE = "youi.project.json";

export interface Project {
  /** Absolute project root. */
  readonly root: string;
  readonly config: ProjectConfig;
  readonly repo: DesignRepo;
  readonly system: LoadedSystem;
  /** Absolute path of the config this project was loaded from (it may live outside the project, e.g. in a design repo). */
  readonly configFile?: string;
  /** True when the design repo came from an explicit override rather than the config's source. */
  readonly designOverride?: boolean;
  /** The commit a git source is at, for the lockfile. */
  readonly designCommit?: string;
  /** True when the root came from an explicit override (`--root`) rather than the config or the project directory. */
  readonly rootOverride?: boolean;
}

export interface LoadProjectOptions {
  /** Use this config file instead of `<root>/youi.project.json` (e.g. a pilot config kept outside a read-only project). */
  readonly configPath?: string;
  /** Override the design repo location (otherwise `source.path` from the config). */
  readonly designRoot?: string;
  /** Override the product root (otherwise the config's `root`, then the directory passed to loadProject). */
  readonly productRoot?: string;
  /** Resolve a git source's ref again, fetching first (youiyoux sync), instead of the recorded commit. */
  readonly refreshDesign?: boolean;
}

/** The product root is missing, or holds nothing the config matches: every finding would be a false zero. */
export class ProjectRootError extends Error {}

/** How to point a config at its product, for every "wrong root" message. */
export const ROOT_HINT = 'set "root" in the config (relative to it, or absolute) or pass --root <dir>';

/**
 * Load a product's config, its root and its design system. The root is `options.productRoot`,
 * else the config's `root` (relative to the config file), else `root`: a config kept beside
 * the design repo names its product with `root` or `--root`.
 */
export async function loadProject(root: string, options: LoadProjectOptions = {}): Promise<Project> {
  const configFile = resolve(options.configPath ?? join(resolve(root), PROJECT_FILE));
  const config = normalizeProjectConfig(await readDefinition(configFile, ProjectConfig));
  const fromConfig = (path: string): string => resolve(dirname(configFile), path);
  const productRoot = options.productRoot !== undefined ? resolve(options.productRoot || ".") : config.root ? fromConfig(config.root) : resolve(root);
  if (!(await isDirectory(productRoot))) throw new ProjectRootError(`product root ${productRoot} is not a directory (config ${configFile}); ${ROOT_HINT}`);
  const located = options.designRoot ? { root: resolve(options.designRoot), commit: null } : await locateDesign(config.source, configFile, productRoot, { refresh: options.refreshDesign });
  const repo = await loadDesignRepo(located.root);
  return {
    root: productRoot,
    config,
    repo,
    system: getSystem(repo, config.system),
    configFile,
    designOverride: Boolean(options.designRoot),
    rootOverride: options.productRoot !== undefined,
    ...(located.commit ? { designCommit: located.commit } : {}),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * How a file imports the owned components: `importFrom` when the config sets it (an alias such
 * as `@/components/ui`), otherwise a relative path from that file to `componentsDir`. Without a
 * file, the componentsDir itself, which only reads as a path, not an import specifier.
 */
export function importSpecifier(config: Pick<ProjectConfig, "importFrom" | "componentsDir">, fromFile?: string): string {
  if (config.importFrom) return config.importFrom;
  if (!fromFile) return config.componentsDir;
  const path = posix.relative(posix.dirname(fromFile), config.componentsDir) || ".";
  return path.startsWith(".") ? path : `./${path}`;
}

/** Why a full scan of this project would be empty, or null: no file matches the config's include globs. */
export async function emptyRootProblem(project: Project, matched: number): Promise<string | null> {
  if (matched > 0) return null;
  const tsconfig = (await stat(join(project.root, project.config.tsconfig)).catch(() => null)) ? "" : ` and no ${project.config.tsconfig}`;
  return `product root ${project.root} has 0 files matching ${project.config.include.join(", ")}${tsconfig} (config ${project.configFile}); if the product lives elsewhere, ${ROOT_HINT}`;
}
