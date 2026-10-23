/** `youiyoux init`: write youi.project.json from what the project already looks like. */
import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getSystem, loadDesignRepo, OutputConfig, ProjectConfig, readTextOrNull, writeFileAtomic } from "@youiyoux/core";
import { PROJECT_FILE } from "@youiyoux/scanner";
import { buildTokens } from "@youiyoux/tokens";
import { GENERATED_MARK } from "./agents.ts";

interface InitOptions {
  readonly root: string;
  /** The design repo checkout (the directory holding youi.config.json). */
  readonly design: string;
  /** The npm package `design` was found as: the config then names the package, not the folder. */
  readonly package?: string;
  /** This tool's published JSON Schemas, for the config's `$schema`. */
  readonly schemaDir: string;
  /** Defaults to the design repo's first system. */
  readonly system?: string;
  readonly componentsDir?: string;
  readonly force?: boolean;
  /** Outputs to write instead of the defaults (adopt: the product's own variable names and dark selector). */
  readonly outputs?: Record<string, unknown>;
  /** Files allowed to define raw values (adopt: the stylesheet the tokens came from). */
  readonly tokenSources?: readonly string[];
}

interface InitResult {
  readonly file: string;
  readonly config: ProjectConfig;
  /** What was detected and why, for the person reading the output. */
  readonly notes: readonly string[];
}

/** Whether a path exists (any kind of file). */
export const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** A JSON file as an object, or null when it is missing or not JSON. */
export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The project's @/* path alias, shared by init and drift import suggestions. */
export async function aliasRoot(root: string, tsconfig = "tsconfig.json"): Promise<string | undefined> {
  const paths = ((await readJson(join(root, tsconfig)))?.compilerOptions as { paths?: Record<string, string[]> } | undefined)?.paths;
  return paths?.["@/*"]?.[0]?.replace(/^\.\//, "").replace(/\*$/, "");
}

/**
 * The variable prefix of a tokens.css youi already generated here (`--so-accent` → `so`), or null.
 * Syncing with another prefix would rename every variable the product's CSS uses. The prefix is
 * what is left of each variable once the system's own token name (`cssNames`, without `--` or a
 * prefix) is stripped from its end, so tokens all in one group (`--acme-color-bg`,
 * `--acme-color-fg`) still give `acme`. The prefix most variables agree on wins; no match is null.
 */
export function generatedPrefix(css: string | null, cssNames: readonly string[]): string | null {
  if (css === null || !css.slice(0, 400).includes(GENERATED_MARK)) return null;
  const votes = new Map<string, number>();
  for (const [, variable] of css.matchAll(/^\s*--([a-z][a-z0-9-]*)\s*:/gm)) {
    // The longest token name that ends this variable: `accent-hover` before `hover`.
    const name = cssNames.filter((n) => variable!.endsWith(`-${n}`)).sort((a, b) => b.length - a.length)[0];
    const prefix = name === undefined ? "" : variable!.slice(0, -name.length - 1);
    if (/^[a-z][a-z0-9-]*$/.test(prefix)) votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export async function initProject(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.root);
  const file = join(root, PROJECT_FILE);
  if (!options.force && (await exists(file))) throw new Error(`${PROJECT_FILE} already exists; use --force to replace it`);
  const design = resolve(options.design);
  const system = getSystem(await loadDesignRepo(design), options.system).config;
  const notes: string[] = [`design repo: ${options.package ? `the package ${options.package}, at ` : ""}${design} (system ${system.id})`];
  const pkg = await readJson(join(root, "package.json"));
  const deps = { ...(pkg?.dependencies as Record<string, string> | undefined), ...(pkg?.devDependencies as Record<string, string> | undefined) };

  const appDir = (await exists(join(root, "app"))) ? "app" : (await exists(join(root, "src/app"))) ? "src/app" : null;
  const expo = "expo-router" in deps && appDir !== null;
  if (expo) notes.push(`expo-router found: routes come from ${appDir}/`);
  else notes.push("no expo-router app dir: add routes.map entries (file → route, with evidence) to attribute screens");

  const candidates = [options.componentsDir, "components/ui", "src/components/ui", "src/browser/components/ui"].filter((c): c is string => Boolean(c));
  let componentsDir = candidates[0]!;
  for (const candidate of candidates) {
    if (await exists(join(root, candidate))) {
      componentsDir = candidate;
      break;
    }
  }
  notes.push(`owned components: ${componentsDir}`);

  const alias = await aliasRoot(root);
  // With no index barrel (shadcn/ui's layout), each component is imported from its own file.
  const barrel = (await Promise.all(["index.ts", "index.tsx", "index.js"].map((f) => exists(join(root, componentsDir, f))))).some(Boolean);
  const importFrom = alias !== undefined && componentsDir.startsWith(alias) ? `@/${componentsDir.slice(alias.length)}${barrel ? "" : "/{file}"}` : undefined;
  if (importFrom) notes.push(`imports use the @/ alias: ${importFrom}${barrel ? "" : " (each component from its own file; no index barrel)"}`);

  const include = (
    await Promise.all(
      [
        ["app", "app/**/*.{ts,tsx,css}"],
        ["src", "src/**/*.{ts,tsx,css}"],
        ["components", "components/**/*.{ts,tsx,css}"],
      ].map(async ([dir, glob]) => ((await exists(join(root, dir!))) ? glob! : null)),
    )
  ).filter((g): g is string => g !== null);

  const outputDir = OutputConfig.parse({}).dir;
  const tokensCss = await readTextOrNull(join(root, outputDir, "tokens.css"));
  const cssNames = tokensCss === null ? [] : (await buildTokens(design, system, OutputConfig.parse({}))).tokens.map((t) => t.cssName);
  const prefix = generatedPrefix(tokensCss, cssNames);
  if (prefix) notes.push(`${outputDir}/tokens.css was generated with the prefix "${prefix}": kept, so the product's --${prefix}-* variables keep their names`);

  const config = ProjectConfig.parse({
    $schema: `${relative(root, resolve(options.schemaDir))}/youi.project.schema.json`,
    schema: "youi.project/v1",
    id: (String(pkg?.name ?? "app").replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "app"),
    system: system.id,
    source: options.package ? { package: options.package } : { path: relative(root, design) || "." },
    include: include.length > 0 ? include : ["**/*.{ts,tsx,css}"],
    exclude: ["**/*.test.*", "**/*.spec.*", "**/*.d.ts"],
    componentsDir,
    ...(importFrom ? { importFrom } : {}),
    routes: expo ? { strategy: "expo-router", appDir } : { strategy: "none" },
    ...(options.outputs ? { outputs: options.outputs } : prefix ? { outputs: { cssVarPrefix: prefix } } : {}),
    ...(options.tokenSources && options.tokenSources.length > 0 ? { tokenSources: [...options.tokenSources] } : {}),
  });
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, config, notes };
}
