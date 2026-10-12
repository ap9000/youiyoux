/**
 * Builds everything the hub reads about one design system, from that system's own repo:
 *
 *   node scripts/snapshot.ts [--design <dir>] [--project <dir>] [--config <youi.project.json>] [--root <dir>] [--screens <dir>] [--inventory <file>] [--detect <detect.json>] [--out <dir>] [--commit <sha>] [--watch]
 *
 * - <out>/public/data/*.json: the system catalog (tokens, contracts, rules, narrative)
 *   and the project's usage map, content-hashed so the browser can cache them forever.
 * - <out>/public/data/<project>.screen.<hash>.webp: the project's captured screens, light and
 *   dark, from `--screens` or `<project>/.youi/screens` (screens.json plus images, written by
 *   scripts/capture-screens.ts). They belong to the project, like its usage map, so they never
 *   live in this repo; a route without a picture shows an empty state.
 * - <out>/public/data/inventory.<hash>.json: a `youi inventory` file for the Inventory page,
 *   from `--inventory` (validated against youi.inventory/v1). The committed default carries an
 *   inventory of the scanner's two inventory fixtures, so the page has something to show. It is
 *   split for lazy loading (src/data/inventory-split.ts): that file is a small index, with
 *   inventory.<project>.<role>.<hash>.json chunks and inventory.extras.<hash>.json beside it.
 * - <out>/public/data/specimens.<project>.<light|dark>.<hash>.css: each inventoried project's
 *   real CSS (and, in its chunks, static HTML per look), built here, never by `youi inventory`,
 *   from the project's own Tailwind and components, read-only, and cached by commit and content
 *   outside the project (scanner/src/specimens). A project root the inventory names that is not
 *   on this machine gets no specimens; its looks show their shape. `specimens.css` in a
 *   `--config` kept outside the product names that product's stylesheets, so it is never edited;
 *   the stylesheets each project used, in page order, and any Tailwind entry it skipped (one
 *   nothing links, imports or reads, when the page builds another) are printed.
 * - <out>/public/data/detect.<hash>.json and detect.shot.<hash>.png: a `youi detect` report
 *   (`--detect`, validated as youi.detect/v1) and its element screenshots, for Library > Stack.
 *   Like screens, it belongs to whoever ran it and never lives in this repo.
 * - <out>/preview/: the system's owned component files and their demos (`*.demo.tsx`
 *   next to a contract in the design repo), plus system.css: the system's variables
 *   scoped to the preview frame and its Tailwind theme.
 * - src/styles/generated/: the hub's own YouIyouX tokens (default snapshot only).
 *
 * With no options it writes the committed default: the made-up demo system
 * (examples/demo-design) and a scan of examples/demo-app, into apps/web/snapshot.
 * `--watch` (with `--out`) keeps that snapshot live: see watchSnapshot.
 * `--project` scans a product repo (read-only) for the usage map; its youi.project.json
 * (or `--config`) names the design repo and the CSS prefix and Tailwind names the
 * components use. `--design` overrides the design repo. `youi ui` runs this with
 * `--out apps/web/.hub`, so pointing the hub at a real system never touches the
 * committed snapshot.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { splitInventory, type SplitSpecimens } from "../src/data/inventory-split.ts";
import { screenSlug } from "../src/data/screens.ts";
import type { ProjectShots } from "../src/data/types.ts";

const APP = resolve(import.meta.dirname, "..");
const TOOL = resolve(APP, "../..");
const DEFAULT_OUT = join(APP, "snapshot");
const DEMO_PROJECT = join(TOOL, "examples/demo-app");
/** The default snapshot's inventory: the scanner's fixtures, modelled on a real console and marketing site. */
const DEMO_INVENTORY = ["console", "site"].map((name) => join(TOOL, "packages/scanner/test/fixtures/inventory", name));
const STYLES_DIR = join(APP, "src/styles/generated");
const HASH_LENGTH = 10;
const HUB_PREFIX = "yx";
/** The preview frame's root; generated CSS scopes the system's variables to it. */
const SCOPE = ".system-scope";
/** Candidate tokens for the surface a preview sits on and the text on it (the hub's stageFor uses the same order). */
const STAGE = ["color.paper", "color.surface", "color.background"];
const INK = ["color.ink", "color.foreground", "color.text"];
/**
 * The hub replaces Tailwind's own radius, font and easing scales (src/styles/theme-reset.css),
 * so it maps those reserved names to its tokens explicitly.
 */
const HUB_TAILWIND_MAP: Record<string, string> = {
  ...Object.fromEntries(["xs", "sm", "md", "lg", "xl", "full"].map((size) => [`radius-${size}`, `radius.${size}`])),
  "font-sans": "font.sans",
  "font-mono": "font.mono",
  "ease-out": "easing.out",
};

type CoreModule = typeof import("@youiyoux/core");
type TokensModule = typeof import("@youiyoux/tokens");
/** The scanner calls used here, typed locally so the hub's typecheck never pulls in the scanner's sources. */
interface ScannerModule {
  loadProject(root: string, options: LoadOptions): Promise<ScannedProject>;
  /** How youi check executes a rule; the scanner compiles ast-grep bodies, which the browser cannot. */
  ruleCapability(rule: import("@youiyoux/core").RuleSpec): unknown;
  scanProject(project: ScannedProject, options?: { cache?: unknown }): Promise<{ report: unknown; identity: import("@youiyoux/core").CheckIdentity }>;
  describeIdentity(identity: import("@youiyoux/core").CheckIdentity): string;
  buildInventory(dirs: readonly string[], options?: { cwd?: string }): Promise<unknown>;
  projectSpecimens(project: { id: string; root: string; commit: string | null; looks: ReadonlyArray<Pick<import("@youiyoux/core").InventoryLook, "id" | "role" | "recipe">> }, options?: { css?: { sheets: readonly string[]; from: string } }): Promise<{ css: { light: string; dark: string } | null; specimens: SplitSpecimens["specimens"]; looks: Record<string, string>; warnings: readonly string[]; tailwind: string; used: readonly string[]; skipped: readonly string[]; cached: boolean }>;
  ProjectWatcher: {
    start<R>(options: {
      root: string;
      load: LoadOptions;
      job: (project: ScannedProject, cache: unknown) => Promise<R>;
      onUpdate: (update: { generation: number; status: "ok"; result: R } | { generation: number; status: "failed"; error: string }) => void;
    }): Promise<{ close(): void }>;
  };
}
type LoadOptions = { configPath?: string; designRoot?: string; productRoot?: string };

/** --config, --design and --root, as the scanner's loader options. */
const loadOptions = (values: { config?: string; design?: string; root?: string }): LoadOptions => ({ ...(values.config ? { configPath: resolve(values.config) } : {}), ...(values.design ? { designRoot: resolve(values.design) } : {}), ...(values.root !== undefined ? { productRoot: resolve(values.root) } : {}) });

interface ScannedProject {
  readonly root: string;
  readonly config: import("@youiyoux/core").ProjectConfig;
  readonly repo: import("@youiyoux/core").DesignRepo;
}
type ResolvedToken = Awaited<ReturnType<TokensModule["buildTokens"]>>["tokens"][number];
type OutputConfig = import("@youiyoux/core").OutputConfig;
type ScanReport = import("@youiyoux/core").ScanReport;
type LoadedSystem = import("@youiyoux/core").LoadedSystem;

const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const generated = (what: string): string => `/* @generated by apps/web/scripts/snapshot.ts from ${what}. Do not edit: run \`pnpm data\`. */\n`;
const load = async <T>(pkg: string): Promise<T> => (await import(pathToFileURL(join(TOOL, "packages", pkg, "src/index.ts")).href)) as T;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The commit that last changed the definitions the snapshot reads (not whatever HEAD happens to be). */
function definitionsCommit(root: string, paths: readonly string[]): string | null {
  try {
    const sha = execFileSync("git", ["-C", root, "log", "-1", "--format=%H", "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** Follow aliasOf links to the token that holds the value: [self, …, source]. */
function aliasChain(token: ResolvedToken, byId: Map<string, ResolvedToken>): string[] {
  const chain = [token.id];
  let next = token.aliasOf;
  while (next && !chain.includes(next)) {
    chain.push(next);
    next = byId.get(next)?.aliasOf;
  }
  return chain;
}

function catalogTokens(system: string, prefix: string, tokens: readonly ResolvedToken[], darkOwn: ReadonlySet<string>, lib: TokensModule): unknown[] {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const elementId = (path: string): string => `youi:${system}/token/${path}`;
  return tokens.map((token) => ({
    id: elementId(token.id),
    path: token.id,
    group: token.id.split(".")[0],
    type: token.type,
    cssVar: `--${prefix}-${token.cssName}`,
    light: lib.cssValue(token.type, token.light),
    dark: lib.cssValue(token.type, token.dark),
    ...(token.type === "typography" ? { lightValue: token.light } : {}),
    aliasChain: aliasChain(token, byId).map(elementId),
    ...(token.description ? { description: token.description } : {}),
    // What the style editor starts from: the values as written (aliases kept) and whether dark has its own.
    ...(token.source ? { source: token.source } : {}),
    darkOwn: darkOwn.has(token.id),
  }));
}

/** Token paths the theme's dark context files give their own value (the rest follow light). */
function darkOverrides(repoRoot: string, config: import("@youiyoux/core").SystemConfig, core: CoreModule, lib: TokensModule): Set<string> {
  if (!config.themeModifier) return new Set();
  const resolverFile = join(repoRoot, config.tokens);
  const layout = lib.resolverLayout(JSON.parse(readFileSync(resolverFile, "utf8")), config.themeModifier);
  const files = layout.contexts[config.themeModifier.dark] ?? [];
  return new Set(files.flatMap((ref) => core.flattenTokens({ file: ref, document: JSON.parse(readFileSync(join(dirname(resolverFile), ref), "utf8")) }).map((t) => t.path)));
}

/** The files a project vendors for this component: its own source plus the system's support files. */
function componentFiles(componentsRoot: string, sourceFile: string, support: readonly string[]): Array<{ path: string; code: string }> {
  return [sourceFile, ...support].map((file) => ({ path: basename(file), code: readFileSync(join(componentsRoot, file), "utf8") }));
}

/**
 * The preview frame's sheet for this system: its variables scoped to the frame (light by
 * default, dark under data-scheme), the stage it sits on, the contracts' state variables, and
 * the Tailwind names its components use (from the project's outputs, so shadcn-style names map
 * like they do in the product). Aliases stay `var()` references, so the style editor's live
 * overrides of one token reach every token that reads it.
 */
function systemCss(name: string, tokens: readonly ResolvedToken[], contracts: readonly import("@youiyoux/core").ComponentContract[], output: OutputConfig, lib: TokensModule): string {
  const prefix = output.cssVarPrefix;
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const variable = (paths: readonly string[]): string | null => {
    const token = paths.map((p) => byId.get(p)).find(Boolean);
    return token ? `var(--${prefix}-${token.cssName})` : null;
  };
  const ref = (path: string, suffix = ""): string => `var(--${prefix}-${byId.get(path)?.cssName ?? path.replace(/\./g, "-")}${suffix})`;
  const decl = (scheme: "light" | "dark"): string =>
    tokens
      .flatMap((t) => lib.tokenVariables(t.type, t.source?.[scheme] ?? t[scheme], ref).map(([suffix, css]) => `  --${prefix}-${t.cssName}${suffix}: ${css};`))
      .join("\n");
  const states = lib.stateVariables(contracts, tokens, prefix).map(([property, css]) => `  ${property}: ${css};`).join("\n");
  const stage = [variable(STAGE) && `  background: ${variable(STAGE)};`, variable(INK) && `  color: ${variable(INK)};`].filter(Boolean).join("\n");
  const theme = lib.renderTailwind(tokens, output, "").trim();
  return `${generated(`the ${name} tokens`)}@source "./components";\n\n${SCOPE} {\n  color-scheme: light;\n${decl("light")}\n${states ? `${states}\n` : ""}${stage}\n}\n\n${SCOPE}[data-scheme="dark"] {\n  color-scheme: dark;\n${decl("dark")}\n}\n\n${theme}\n`;
}

async function buildHubTokens(core: CoreModule, lib: TokensModule): Promise<void> {
  const system = core.SystemConfig.parse({
    id: "youiyoux",
    name: "YouIyouX",
    version: "0.1.0",
    description: "The hub's own design language.",
    tokens: "design/youiyoux.resolver.json",
    themeModifier: { name: "theme", light: "light", dark: "dark" },
  });
  const output = core.OutputConfig.parse({ cssVarPrefix: HUB_PREFIX, targets: ["css-vars", "tailwind-v4"], tailwind: { includeAll: true, map: HUB_TAILWIND_MAP } });
  const built = await lib.buildTokens(APP, system, output);
  rmSync(STYLES_DIR, { recursive: true, force: true });
  for (const file of built.files) write(join(STYLES_DIR, file.path), file.content);
}

interface Source {
  readonly designRoot: string;
  /** The scanned product repo, when there is one. */
  readonly projectDir?: string;
  readonly systemId?: string;
  readonly output: OutputConfig;
  readonly usage: ScanReport | null;
}

/**
 * The directory the scanner loads the project from: --project, else a --config's own directory
 * when --root names its product (the config's `root` and --root win over it), else the demo.
 */
function projectArg(values: { design?: string; project?: string; config?: string; root?: string }): string | undefined {
  if (values.project) return values.project;
  if (values.config) return values.root !== undefined ? dirname(resolve(values.config)) : undefined;
  return values.design ? undefined : DEMO_PROJECT;
}

/** Where the system comes from, and the project whose scan and outputs go with it. */
export async function readSource(values: { design?: string; project?: string; config?: string; root?: string }, core: CoreModule, scanner: ScannerModule): Promise<Source> {
  const projectDir = projectArg(values);
  if (projectDir) {
    const project = await scanner.loadProject(projectDir, loadOptions(values));
    const { report } = await scanner.scanProject(project);
    return { designRoot: project.repo.root, projectDir: project.root, systemId: project.config.system, output: project.config.outputs, usage: core.ScanReport.parse(report) };
  }
  if (values.config) {
    const configFile = resolve(values.config);
    const config = core.ProjectConfig.parse(JSON.parse(readFileSync(configFile, "utf8")));
    const designRoot = values.design ? resolve(values.design) : isAbsolute(config.source.path) ? config.source.path : resolve(dirname(configFile), config.source.path);
    return { designRoot, systemId: config.system, output: config.outputs, usage: null };
  }
  return { designRoot: resolve(values.design!), output: core.OutputConfig.parse({}), usage: null };
}

/** Owned sources plus every `*.demo.tsx` beside a contract, flattened the way projects vendor them. */
function writePreview(out: string, system: LoadedSystem, componentsRoot: string): number {
  const header = (from: string): string => `// @generated from ${from} by apps/web/scripts/snapshot.ts. Do not edit.\n`;
  const files = new Set([...system.components.map((c) => c.contract.source.file), ...system.config.support]);
  for (const file of files) write(join(out, "components", basename(file)), `${header(`components/${file}`)}${readFileSync(join(componentsRoot, file), "utf8")}`);
  let demos = 0;
  for (const { dir } of system.components) {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".demo.tsx"))) {
      write(join(out, "components", name), `${header(relative(componentsRoot, join(dir, name)))}${readFileSync(join(dir, name), "utf8")}`);
      demos++;
    }
  }
  return demos;
}

interface ScreensFile {
  schema: "youiyoux.screens/v1";
  project: string;
  source: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  screens: Array<{ route: string; path: string; note?: string }>;
}

function readScreensFile(dir: string, project: string): ScreensFile {
  const path = join(dir, "screens.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ScreensFile>;
  const valid =
    value.schema === "youiyoux.screens/v1" &&
    value.project === project &&
    typeof value.source === "string" &&
    typeof value.capturedAt === "string" &&
    typeof value.viewport?.width === "number" &&
    typeof value.viewport.height === "number" &&
    Array.isArray(value.screens) &&
    value.screens.every((s) => typeof s.route === "string" && typeof s.path === "string");
  if (!valid) throw new Error(`${path} is not a youiyoux.screens/v1 document for ${project}`);
  return value as ScreensFile;
}

/** A captured image, named by its content alone (two routes showing the same page share one file); null when never captured. */
function copyShot(dir: string, dataDir: string, project: string, slug: string, variant: string): string | null {
  const source = join(dir, `${slug}.${variant}.webp`);
  if (!existsSync(source)) return null;
  const bytes = readFileSync(source);
  const file = `${project}.screen.${createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH)}.webp`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, file), bytes);
  return file;
}

/** The project's captured screens → the manifest's screens entry. Pictures that are missing stay missing. */
function writeScreens(dir: string, dataDir: string, project: string): ProjectShots {
  const file = readScreensFile(dir, project);
  const screens = file.screens.map((screen) => {
    const slug = screenSlug(screen.route);
    const schemes = Object.fromEntries(
      (["light", "dark"] as const).flatMap((scheme) => {
        const full = copyShot(dir, dataDir, project, slug, scheme);
        const thumb = copyShot(dir, dataDir, project, slug, `${scheme}.thumb`);
        return full && thumb ? [[scheme, { full, thumb }]] : [];
      }),
    );
    return { route: screen.route, path: screen.path, ...(screen.note ? { note: screen.note } : {}), ...schemes };
  });
  return { source: file.source, capturedAt: file.capturedAt, viewport: file.viewport, screens };
}

/** `--screens`, else the project's own `.youi/screens` when it has one. */
function screensDir(explicit: string | undefined, projectDir: string | undefined): string | null {
  if (explicit) return resolve(explicit);
  const conventional = projectDir ? join(projectDir, ".youi/screens") : null;
  return conventional && existsSync(join(conventional, "screens.json")) ? conventional : null;
}

function previousSystemId(dataDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8")) as { systems?: { id?: string }[] };
    return manifest.systems?.[0]?.id;
  } catch {
    return undefined;
  }
}

/** Captured thumbnails (public/previews) belong to the system: they survive a refresh of its data, not a switch to another system. */
function dropPreviewsOfOtherSystem(out: string, previousId: string | undefined, systemId: string): void {
  if (previousId !== systemId) rmSync(join(out, "public/previews"), { recursive: true, force: true });
}

interface Libraries {
  readonly core: CoreModule;
  readonly lib: TokensModule;
  readonly scanner: ScannerModule;
}

type UsageRef = { project: string; file: string; screens?: ProjectShots };
type InventoryReport = import("@youiyoux/core").InventoryReport;
type DetectRef = { file: string; name: string; kind: "repo" | "site"; shots: string[] };
type Live = { generation: number; status: "complete" | "partial" | "failed"; updatedAt: string; rules?: string; message?: string };

interface WrittenSystem {
  readonly id: string;
  readonly catalogFile: string;
  readonly commit: string | null;
  readonly summary: string;
}

/** The catalog (content-hashed) and the preview frame's files for one system. */
async function writeSystem(out: string, designRoot: string, systemId: string | undefined, output: OutputConfig, commitOverride: string | undefined, { core, lib, scanner }: Libraries): Promise<WrittenSystem> {
  const repo = await core.loadDesignRepo(designRoot);
  const system = core.getSystem(repo, systemId);
  const { config } = system;
  const built = await lib.buildTokens(repo.root, config, output);
  const componentsRoot = join(repo.root, config.components);
  const catalog = {
    schema: "youiyoux.catalog/v1",
    system: {
      id: config.id,
      name: config.name,
      version: config.version,
      description: config.description,
      cssPrefix: output.cssVarPrefix,
      design: config.design ? readFileSync(join(repo.root, config.design), "utf8") : "",
    },
    tokens: catalogTokens(config.id, output.cssVarPrefix, built.tokens, darkOverrides(repo.root, config, core, lib), lib),
    components: system.components.map(({ contract }) => ({ contract, files: componentFiles(componentsRoot, contract.source.file, config.support) })),
    // Each rule with how youi check executes it, so the hub never shows an uncompilable rule as enforced.
    rules: system.rules.map((rule) => ({ ...rule, execution: scanner.ruleCapability(rule) })),
  };
  const catalogText = json(catalog);
  const catalogFile = `${config.id}.catalog.${hash(catalogText)}.json`;
  write(join(out, "public/data", catalogFile), catalogText);
  const previewDir = join(out, "preview");
  rmSync(previewDir, { recursive: true, force: true });
  write(join(previewDir, "system.css"), systemCss(config.name, built.tokens, system.components.map((c) => c.contract), output, lib));
  const demos = writePreview(previewDir, system, componentsRoot);
  const commit = commitOverride ?? definitionsCommit(repo.root, ["youi.config.json", dirname(config.tokens), config.components, config.rules, ...(config.design ? [config.design] : [])]);
  const summary = `${config.name} from ${repo.root} @ ${commit ?? "unknown"}: ${catalog.tokens.length} tokens, ${catalog.components.length} components (${demos} demos), ${catalog.rules.length} rules`;
  return { id: config.id, catalogFile, commit, summary };
}

function writeUsage(dataDir: string, report: ScanReport, screens: ProjectShots | null): UsageRef {
  const text = json(report);
  const file = `${report.project}.usage.${hash(text)}.json`;
  write(join(dataDir, file), text);
  return { project: report.project, file, ...(screens ? { screens } : {}) };
}

/** A written inventory: the index the manifest names, and every file beside it. */
export interface WrittenInventory {
  readonly file: string;
  readonly files: string[];
}

/** An inventory split for lazy loading, every file under its content hash; the index last. */
export function writeInventory(dataDir: string, inventory: InventoryReport, specimens: Readonly<Record<string, SplitSpecimens>> = {}): WrittenInventory {
  const { index, files } = splitInventory(inventory, specimens, (stem, ext, text) => `${stem}.${hash(text)}.${ext}`);
  for (const f of files) write(join(dataDir, f.name), f.text);
  const text = json(index);
  const file = `inventory.${hash(text)}.json`;
  write(join(dataDir, file), text);
  return { file, files: files.map((f) => f.name) };
}

/**
 * Where each inventoried project is on this machine: its root as the inventory names it, from
 * the directory the inventory was made in (the tool's root for the default) or the file's own.
 */
export function inventoryRoots(inventory: InventoryReport, path: string | undefined): Map<string, string> {
  const bases = path ? [process.cwd(), dirname(resolve(path))] : [TOOL];
  const roots = new Map<string, string>();
  for (const project of inventory.projects) {
    const root = bases.map((base) => resolve(base, project.root)).find((dir) => existsSync(join(dir, "package.json")));
    if (root) roots.set(project.id, root);
  }
  return roots;
}

/** `specimens.css` from a config kept outside its product: the product's root, the sheets, and the config that names them. */
export interface ConfiguredCss {
  readonly root: string;
  readonly sheets: readonly string[];
  readonly from: string;
}

/**
 * `--config`'s `specimens.css`, for the product it names (--root, else the config's `root`
 * relative to it, else the config's directory); null when it lists none.
 */
export function configuredSpecimenCss(values: { config?: string; root?: string }, core: CoreModule): ConfiguredCss | null {
  if (!values.config) return null;
  const configFile = resolve(values.config);
  const config = core.ProjectConfig.parse(JSON.parse(readFileSync(configFile, "utf8")));
  const sheets = config.specimens?.css;
  if (!sheets?.length) return null;
  const root = values.root !== undefined ? resolve(values.root || ".") : config.root ? resolve(dirname(configFile), config.root) : dirname(configFile);
  return { root, sheets, from: configFile };
}

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The stylesheets a project's specimens used, in page order, then the Tailwind entries it skipped, for the snapshot's output. */
export function sheetReport(id: string, used: readonly string[], skipped: readonly string[] = []): string[] {
  const left = skipped.map((line) => `  ${line}`);
  if (used.length === 0) return [`specimens ${id}: no stylesheet`, ...left];
  return [`specimens ${id}: ${used.length} stylesheet${used.length === 1 ? "" : "s"}, in page order`, ...used.map((line, i) => `  ${i + 1}. ${line}`), ...left];
}

/**
 * Each project's specimens (scanner/src/specimens: cached, read-only); a project not on this
 * machine gets none. The product a `--config` kept outside it names uses that config's
 * `specimens.css`. Each project's stylesheets, in order, go to `log`.
 */
export async function buildSpecimens(inventory: InventoryReport, roots: ReadonlyMap<string, string>, scanner: ScannerModule, configured: ConfiguredCss | null = null, log: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<Record<string, SplitSpecimens>> {
  const out: Record<string, SplitSpecimens> = {};
  let matched = false;
  for (const project of inventory.projects) {
    const root = roots.get(project.id);
    if (!root) {
      out[project.id] = { css: null, specimens: {}, looks: {}, notes: [`${project.root} is not on this machine: looks show their shape`] };
      continue;
    }
    const css = configured && realOr(configured.root) === realOr(root) ? { sheets: configured.sheets, from: configured.from } : null;
    matched ||= css !== null;
    try {
      const built = await scanner.projectSpecimens({ id: project.id, root, commit: project.commit, looks: inventory.looks.filter((l) => l.project === project.id) }, css ? { css } : {});
      out[project.id] = { css: built.css, specimens: built.specimens, looks: built.looks, notes: [`CSS: ${built.tailwind}`, ...built.used, ...built.skipped, ...built.warnings] };
      for (const line of sheetReport(project.id, built.used, built.skipped)) log(line);
    } catch (error: unknown) {
      out[project.id] = { css: null, specimens: {}, looks: {}, notes: [`specimens failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  if (configured && !matched) log(`specimens.css in ${configured.from}: its product ${configured.root} is not an inventoried project on this machine; not used`);
  return out;
}

/** Specimens for an inventory, then its split files. */
async function writeInventoryWithSpecimens(dataDir: string, inventory: InventoryReport, path: string | undefined, libs: Pick<Libraries, "core" | "scanner">, values: { config?: string; root?: string }): Promise<WrittenInventory> {
  return writeInventory(dataDir, inventory, await buildSpecimens(inventory, inventoryRoots(inventory, path), libs.scanner, configuredSpecimenCss(values, libs.core)));
}

/**
 * `--inventory <file>`, validated against youi.inventory/v1 (a bad file names itself and each
 * failing field); else, for the default snapshot only, a fresh inventory of the fixtures.
 */
export async function readInventory(path: string | undefined, isDefault: boolean, { core, scanner }: Pick<Libraries, "core" | "scanner">): Promise<InventoryReport | null> {
  if (path) return core.parseDefinition(resolve(path), readFileSync(resolve(path), "utf8"), core.InventoryReport);
  return isDefault ? core.InventoryReport.parse(await scanner.buildInventory(DEMO_INVENTORY, { cwd: TOOL })) : null;
}

/**
 * `--detect`: the report and its element screenshots, each named by its content. Screenshot
 * paths (relative to the report, never outside it: the schema refuses `..`) become the hashed
 * file names beside it; a screenshot that is missing is dropped, never left dangling.
 */
export function writeDetect(file: string, dataDir: string, core: CoreModule): DetectRef {
  const report = core.DetectReport.parse(JSON.parse(readFileSync(file, "utf8")));
  const base = dirname(resolve(file));
  const shots: string[] = [];
  const elements = report.elements.map(({ screenshot, ...element }) => {
    const source = screenshot ? join(base, screenshot) : null;
    if (!source || !existsSync(source)) return element;
    const bytes = readFileSync(source);
    const name = `detect.shot.${createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH)}.png`;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, name), bytes);
    shots.push(name);
    return { ...element, screenshot: name };
  });
  const text = json({ ...report, elements });
  const name = `detect.${hash(text)}.json`;
  write(join(dataDir, name), text);
  return { file: name, name: report.target.name, kind: report.target.kind, shots };
}

/** Every data file a usage ref names: its usage map and its screenshots. */
function usageFiles(usage: readonly UsageRef[]): string[] {
  return usage.flatMap((u) => [u.file, ...(u.screens?.screens ?? []).flatMap((shot) => [shot.light, shot.dark].flatMap((f) => (f ? [f.full, f.thumb] : [])))]);
}

/** The manifest last: written to a temporary name and renamed, so a reader never sees half of it. */
function writeManifest(dataDir: string, system: WrittenSystem, usage: readonly UsageRef[], live?: Live, inventory?: WrittenInventory | null, detect?: DetectRef | null): void {
  const manifest = { schema: "youiyoux.manifest/v1", source: { commit: system.commit }, systems: [{ id: system.id, catalog: system.catalogFile, usage }], ...(inventory ? { inventory: inventory.file, inventoryFiles: inventory.files } : {}), ...(detect ? { detect: { file: detect.file, name: detect.name, kind: detect.kind } } : {}), ...(live ? { live } : {}) };
  const file = join(dataDir, "manifest.json");
  write(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Delete hashed data files that neither the current nor the previous generation names (an open page may still be loading the previous one). */
function pruneData(dataDir: string, keep: ReadonlySet<string>): void {
  for (const name of readdirSync(dataDir)) if (name !== "manifest.json" && !keep.has(name)) rmSync(join(dataDir, name), { force: true });
}

/**
 * `--watch`: keep the snapshot live. Every change to the project's sources re-scans (only
 * edited files and their importers are re-analysed) and writes a new usage map; a change
 * to the design definitions also rewrites the catalog and previews. Each generation ends
 * with an atomic manifest write, which the dev server announces to the open hub. A failed
 * run keeps the last good data and marks the manifest failed.
 */
async function watchSnapshot(values: { design?: string; project?: string; config?: string; root?: string; commit?: string; screens?: string; inventory?: string; detect?: string }, out: string, libs: Libraries): Promise<void> {
  const dataDir = join(out, "public/data");
  mkdirSync(dataDir, { recursive: true });
  // The inventory and the detect report are files someone produced, not views of the watched sources: written once.
  const read = await readInventory(values.inventory, false, libs);
  const inventory = read ? await writeInventoryWithSpecimens(dataDir, read, values.inventory, libs, values) : null;
  const detect = values.detect ? writeDetect(values.detect, dataDir, libs.core) : null;
  const root = projectArg(values) ?? (values.config ? dirname(resolve(values.config)) : DEMO_PROJECT);
  let previousId = previousSystemId(dataDir);
  let system: WrittenSystem | null = null;
  let systemOf: ScannedProject | null = null;
  let usage: UsageRef[] = [];
  // Screenshots are copied once: they come from a capture, not from the sources being watched.
  let shots: ProjectShots | null | undefined;
  let previous = new Set<string>();
  const stamp = (): string => new Date().toISOString();
  const watcher = await libs.scanner.ProjectWatcher.start({
    root,
    load: loadOptions(values),
    job: async (project, cache) => {
      // A new project object means the definitions were (re)loaded: rebuild the catalog too.
      if (project !== systemOf) {
        system = await writeSystem(out, project.repo.root, project.config.system, project.config.outputs, values.commit, libs);
        dropPreviewsOfOtherSystem(out, previousId, system.id);
        previousId = system.id;
        systemOf = project;
      }
      const scan = await libs.scanner.scanProject(project, { cache });
      const report = libs.core.ScanReport.parse(scan.report);
      return { report, rules: libs.scanner.describeIdentity(scan.identity) };
    },
    onUpdate: (update) => {
      if (!system) return void process.stderr.write(`youi ui: ${update.status === "failed" ? update.error : "no system"}\n`);
      if (update.status === "ok") {
        const { report } = update.result;
        if (shots === undefined) {
          const dir = screensDir(values.screens, systemOf?.root ?? resolve(root));
          shots = dir ? writeScreens(dir, dataDir, report.project) : null;
        }
        usage = [writeUsage(dataDir, report, shots)];
      }
      const live: Live =
        update.status === "ok"
          ? { generation: update.generation, status: update.result.report.status, updatedAt: stamp(), rules: update.result.rules }
          : { generation: update.generation, status: "failed", updatedAt: stamp(), message: update.error };
      writeManifest(dataDir, system, usage, live, inventory, detect);
      const current = new Set([system.catalogFile, ...usageFiles(usage), ...(inventory ? [inventory.file, ...inventory.files] : []), ...(detect ? [detect.file, ...detect.shots] : [])]);
      pruneData(dataDir, new Set([...current, ...previous]));
      previous = current;
      process.stdout.write(`youi ui: generation ${update.generation} ${live.status}${live.message ? `: ${live.message}` : ""}\n`);
    },
  });
  const stop = (): void => {
    watcher.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** The workspace packages this script uses, loaded from their sources. */
export async function libraries(): Promise<Libraries> {
  return { core: await load<CoreModule>("core"), lib: await load<TokensModule>("tokens"), scanner: await load<ScannerModule>("scanner") };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { design: { type: "string" }, project: { type: "string" }, config: { type: "string" }, root: { type: "string" }, out: { type: "string" }, commit: { type: "string" }, screens: { type: "string" }, inventory: { type: "string" }, detect: { type: "string" }, watch: { type: "boolean", default: false } } });
  const libs = await libraries();
  const out = resolve(values.out ?? DEFAULT_OUT);
  if (values.watch) {
    if (out === DEFAULT_OUT) throw new Error("--watch writes a live snapshot; pass --out (the committed default snapshot is never watched)");
    return watchSnapshot(values, out, libs);
  }
  // A detect report belongs to whoever ran it: the committed demo snapshot never holds one.
  if (values.detect && out === DEFAULT_OUT) throw new Error("--detect adds a report you ran; pass --out (the committed demo snapshot never holds one)");
  const dataDir = join(out, "public/data");
  const source = await readSource(values, libs.core, libs.scanner);
  const previousId = previousSystemId(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
  const system = await writeSystem(out, source.designRoot, source.systemId, source.output, values.commit, libs);
  dropPreviewsOfOtherSystem(out, previousId, system.id);
  const shotsDir = source.usage ? screensDir(values.screens, source.projectDir) : null;
  const shots = source.usage && shotsDir ? writeScreens(shotsDir, dataDir, source.usage.project) : null;
  const usage = source.usage ? [writeUsage(dataDir, source.usage, shots)] : [];
  const read = await readInventory(values.inventory, out === DEFAULT_OUT, libs);
  const inventory = read ? await writeInventoryWithSpecimens(dataDir, read, values.inventory, libs, values) : null;
  const detect = values.detect ? writeDetect(values.detect, dataDir, libs.core) : null;
  writeManifest(dataDir, system, usage, undefined, inventory, detect);
  if (out === DEFAULT_OUT) await buildHubTokens(libs.core, libs.lib);
  process.stdout.write(`snapshot of ${system.summary}; ${usage.length ? `usage map of ${usage[0]!.project}${shots ? ` with ${shots.screens.length} screens` : ""}` : "no usage map"}${inventory ? `; ${inventory.file} (+${inventory.files.length} chunks and stylesheets)` : ""}${detect ? `; detect report of ${detect.name} (${detect.shots.length} screenshots)` : ""} → ${relative(process.cwd(), out) || "."}\n`);
}

// Run as a script, not when a test imports readSource.
if (import.meta.main) await main();
