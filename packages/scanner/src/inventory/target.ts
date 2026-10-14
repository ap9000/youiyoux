/**
 * What `youiyoux inventory` reads in one directory. No design repo, no element index: if the
 * directory has a youi.project.json, only its include, exclude, tsconfig and routes are used;
 * otherwise default globs, and routes detected from the files (Expo Router, Next.js `app/`
 * pages, Astro `src/pages/`). Include globs given on the command line replace either include;
 * exclude globs are added to either exclude.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { findFiles, normalizeRelPath, RouteConfig, safeId } from "@youiyoux/core";
import { PROJECT_FILE } from "../project.ts";

export interface InventoryTarget {
  readonly id: string;
  /** Absolute root. */
  readonly root: string;
  /** The root as it was named, for the report. */
  readonly label: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly tsconfig: string;
  readonly routes: RouteConfig;
  /** How routes were found, for a reader. */
  readonly routeSource: string;
  readonly files: readonly string[];
  /** HTML documents and server templates, for the stylesheets their links load (specimens). */
  readonly templates: readonly string[];
  /** youi.project.json `specimens.css`: the stylesheets specimens use, exactly and in order; null when not set. */
  readonly specimenCss: readonly string[] | null;
}

export const DEFAULT_INCLUDE = ["**/*.{tsx,jsx,ts,js,mjs,astro,css}"];
export const DEFAULT_EXCLUDE = ["**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/*.stories.*", "**/.storybook/**", "**/.next/**", "**/.astro/**", "**/build/**", "**/out/**", "**/coverage/**", "**/*.config.*"];
/** Styles always count, even when a project config's globs name only components. */
const STYLES = ["**/*.css"];

const TEMPLATES = ["**/*.{html,htm,ejs,hbs,handlebars}"];

const ROUTE_FILE = /\.(tsx|ts|jsx|js)$/;

function idOf(name: string): string {
  return name.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+|-+$/g, "") || "project";
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `src/app/(auth)/login/page.tsx` → `/login`; null for anything but a page. */
export function nextRoute(file: string, appDir: string): string | null {
  if (!file.startsWith(`${appDir}/`) || !/\/?page\.(tsx|ts|jsx|js)$/.test(file)) return null;
  const segments = file.slice(appDir.length + 1).split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return `/${segments.join("/")}`;
}

/** `src/pages/docs/index.astro` → `/docs`. */
export function astroRoute(file: string, pagesDir: string): string | null {
  if (!file.startsWith(`${pagesDir}/`) || !/\.(astro|md|mdx)$/.test(file)) return null;
  const segments = file.slice(pagesDir.length + 1).replace(/\.(astro|md|mdx)$/, "").split("/");
  if (segments.at(-1) === "index") segments.pop();
  return `/${segments.join("/")}`;
}

/** Routes from the file layout, when no project config names them. */
export function detectRoutes(files: readonly string[]): { config: RouteConfig; source: string } {
  for (const appDir of ["app", "src/app"]) {
    if (files.some((f) => f.startsWith(`${appDir}/`) && /\/_layout\.(tsx|jsx|ts|js)$/.test(f))) return { config: RouteConfig.parse({ strategy: "expo-router", appDir }), source: `expo-router (${appDir}/)` };
    const pages = files.filter((f) => nextRoute(f, appDir) !== null);
    if (pages.length > 0) {
      const map = pages.map((file) => ({ file, routes: [nextRoute(file, appDir)!], evidence: "Next.js app router page" }));
      const shell = files.filter((f) => f.startsWith(`${appDir}/`) && /(^|\/)layout\.(tsx|jsx|ts|js)$/.test(f) && ROUTE_FILE.test(f));
      return { config: RouteConfig.parse({ strategy: "map", map, shell }), source: `next-app (${appDir}/**/page)` };
    }
  }
  const pages = files.filter((f) => astroRoute(f, "src/pages") !== null);
  if (pages.length > 0) {
    const map = pages.map((file) => ({ file, routes: [astroRoute(file, "src/pages")!], evidence: "Astro page" }));
    return { config: RouteConfig.parse({ strategy: "map", map }), source: "astro (src/pages/)" };
  }
  return { config: RouteConfig.parse({}), source: "none detected" };
}

export interface TargetGlobs {
  /** Replace the default or configured include globs (stylesheets still count). */
  readonly include?: readonly string[];
  /** Added to the default or configured exclude globs. */
  readonly exclude?: readonly string[];
}

export async function loadInventoryTarget(dir: string, globs: TargetGlobs = {}): Promise<InventoryTarget> {
  const root = resolve(dir);
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`${dir} is not a directory`);
  const config = await readJson(join(root, PROJECT_FILE));
  const pkg = await readJson(join(root, "package.json"));
  const include = globs.include?.length ? [...globs.include, ...STYLES] : Array.isArray(config?.include) ? [...(config.include as string[]), ...STYLES] : DEFAULT_INCLUDE;
  const exclude = [...(Array.isArray(config?.exclude) ? (config.exclude as string[]) : DEFAULT_EXCLUDE), ...(globs.exclude ?? [])];
  const tsconfig = typeof config?.tsconfig === "string" ? normalizeRelPath(config.tsconfig) : "tsconfig.json";
  const files = (await findFiles(root, include, exclude)).filter((f) => /\.(tsx|jsx|ts|js|mjs|cjs|astro|css)$/.test(f));
  const configured = config?.routes ? RouteConfig.safeParse(config.routes) : null;
  const routes = configured?.success && configured.data.strategy !== "none" ? { config: configured.data, source: `${PROJECT_FILE} (${configured.data.strategy})` } : detectRoutes(files);
  const id = safeId(config?.id) ?? idOf(typeof pkg?.name === "string" ? pkg.name : basename(root));
  const templates = await findFiles(root, TEMPLATES, exclude);
  const specimens = config?.specimens as { css?: unknown } | undefined;
  const specimenCss = Array.isArray(specimens?.css) ? specimens.css.filter((p): p is string => typeof p === "string") : null;
  return { id, root, label: dir, include, exclude, tsconfig, routes: routes.config, routeSource: routes.source, files, templates, specimenCss };
}
