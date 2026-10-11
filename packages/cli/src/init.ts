/** `youi init`: write youi.project.json from what the project already looks like. */
import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getSystem, loadDesignRepo, ProjectConfig, writeFileAtomic } from "@youiyoux/core";
import { PROJECT_FILE } from "@youiyoux/scanner";

export interface InitOptions {
  readonly root: string;
  /** The design repo checkout (the directory holding youi.config.json). */
  readonly design: string;
  /** This tool's published JSON Schemas, for the config's `$schema`. */
  readonly schemaDir: string;
  /** Defaults to the design repo's first system. */
  readonly system?: string;
  readonly componentsDir?: string;
  readonly force?: boolean;
}

export interface InitResult {
  readonly file: string;
  readonly config: ProjectConfig;
  /** What was detected and why, for the person reading the output. */
  readonly notes: readonly string[];
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function initProject(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.root);
  const file = join(root, PROJECT_FILE);
  if (!options.force && (await exists(file))) throw new Error(`${PROJECT_FILE} already exists; use --force to replace it`);
  const design = resolve(options.design);
  const system = getSystem(await loadDesignRepo(design), options.system).config;
  const notes: string[] = [`design repo: ${design} (system ${system.id})`];
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

  const tsconfig = (await exists(join(root, "tsconfig.json"))) ? "tsconfig.json" : "tsconfig.json";
  const paths = ((await readJson(join(root, tsconfig)))?.compilerOptions as { paths?: Record<string, string[]> } | undefined)?.paths;
  const alias = paths?.["@/*"]?.[0]?.replace(/^\.\//, "").replace(/\*$/, "");
  const importFrom = alias !== undefined && componentsDir.startsWith(alias) ? `@/${componentsDir.slice(alias.length)}` : undefined;
  if (importFrom) notes.push(`imports use the @/ alias: ${importFrom}`);

  const include = (
    await Promise.all(
      [
        ["app", "app/**/*.{ts,tsx,css}"],
        ["src", "src/**/*.{ts,tsx,css}"],
        ["components", "components/**/*.{ts,tsx,css}"],
      ].map(async ([dir, glob]) => ((await exists(join(root, dir!))) ? glob! : null)),
    )
  ).filter((g): g is string => g !== null);

  const config = ProjectConfig.parse({
    $schema: `${relative(root, resolve(options.schemaDir))}/youi.project.schema.json`,
    schema: "youi.project/v1",
    id: (String(pkg?.name ?? "app").replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "app"),
    system: system.id,
    source: { path: relative(root, design) || "." },
    include: include.length > 0 ? include : ["**/*.{ts,tsx,css}"],
    exclude: ["**/*.test.*", "**/*.spec.*", "**/*.d.ts"],
    componentsDir,
    ...(importFrom ? { importFrom } : {}),
    routes: expo ? { strategy: "expo-router", appDir } : { strategy: "none" },
  });
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, config, notes };
}
