/** `youi`: the YouIyouX command line. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs, promisify, type ParseArgsConfig } from "node:util";
import { parse as parseYaml } from "yaml";
import { DefinitionError, DESIGN_CONFIG_FILE, findUp, getSystem, loadDesignRepo, loadLibrary, MigrationSpec, OutputConfig, PACKAGE_NAME, renderJsonSchemas, safeId, writeFileAtomic, InventoryReport, type ScanReport } from "@youiyoux/core";
import { buildGaps, candidateSource, declaredPackages, expandAll, MissingIndexError, selectSources, discoverCacheDir, discoverIndexPath, ingestCatalog, readCatalog, searchCatalog, sharedStore, showFromCatalog, syncIndex, type Fetcher } from "@youiyoux/discover";
import { indexHome, storeLocation } from "@youiyoux/store";
import { buildTokens, compareParity } from "@youiyoux/tokens";
import { adoptionRequest, buildInventory, captureScreens, captureText, chosenSession, openLoginBrowser, recordSession, sessionFile, type LoginBrowser, type LoginPage, within, RenderUnavailableError, renderShots, shotsNext, type ShotsOptions, checkCapabilities, componentCard, describeIdentity, designRootOf, evaluateRule, linkedDesign, linksFile, setLink, findContract, loadProject, planChange, PROJECT_FILE, type LoadProjectOptions, ProjectWatcher, ruleCapability, runMigration, scanProject, screenBom, searchLibrary, whereUsed, type CacheStats, type PlanInput, type Project, type WatchUpdate } from "@youiyoux/scanner";
import { baselinePath, diffExitCodeOf, exitCodeOf, runCheck, writeBaseline, type CheckResult } from "./check.ts";
import { configured, loadCheckProject, runRepoCheck } from "./check-repo.ts";
import { workingTreeChange, type ChangeProject } from "./check-diff.ts";
import { actionable, diffJson, githubAnnotations, githubDiffAnnotations, githubDiffSummary, githubSummary, renderCheckText, renderDiffText } from "./check-render.ts";
import { runClaudeHook, runPreCommitHook, type HookTarget } from "./hooks.ts";
import { codexFallback, installRepoAgentInstructions, hookCommand, installClaudeHook, installPreCommit, installWorkflow, repoRootOf } from "./hooks-install.ts";
import { installAgentRule, installClaudeMcp, installCodexMcp, mcpCommand, relativeTo, removeAgentRule, removeClaudeMcp, removeCodexMcp, type AgentsResult } from "./agents-install.ts";
import { detectTarget, renderDetect } from "./detect.ts";
import { renderDiscoverSearch, renderDiscoverShow, renderDiscoverSync } from "./discover.ts";
import { startRuleEditor, type RuleEditor } from "./editor.ts";
import { DEFAULT_HUB_PORT, runHub, runPreviews } from "./hub.ts";
import { renderBrief, renderRequests } from "./requests.ts";
import { initProject } from "./init.ts";
import { noteSource, rebuildIndex, recordInventory, recordProject, renderHistory, renderRebuild, SCANS_LOG, SOURCES_FILE } from "./index-store.ts";
import { renderGaps } from "./gaps.ts";
import { renderInventory } from "./inventory.ts";
import { renderAdoptionRequest, renderLibrarySearch } from "./library.ts";
import { renderBom, renderMigration, renderPlan, renderRulePreview, renderRules, renderScan, renderShots as renderShotsText, renderShow, renderSync, renderWhere } from "./render.ts";
import { mcpArgs, syncProject } from "./sync.ts";
import { COMMAND } from "./command.ts";
import { TOOL_ROOT } from "./tool.ts";
import { runReport, type ReportIo } from "./report/run.ts";
import { ms, plural, style } from "./ui.ts";


const HELP = `${style.accent(COMMAND)} ${style.dim("· YouIyouX design language")}

${style.bold("Usage")}  ${COMMAND} <command> [options]

${style.bold("Anywhere")}  ${style.dim("no design system needed")}
  report [path] [--out dir] [--render [--yes]] [--include-code] [--json]
                           a shareable report on a repo with no setup (npx youiyoux runs this):
                           projects (one section per workspace package with UI files), UI libraries,
                           the component inventory, near-duplicate groups, hardcoded values a theme
                           token holds, off-library imports and the top fixes, each with its next step.
                           Writes youiyoux-report.html (self-contained, light and dark),
                           youiyoux-card.png (1200x630) and youiyoux-summary.md to the repo or --out;
                           nothing else. Rendered looks of the most-used components when a Chromium is
                           installed; --render downloads the headless shell (~100 MB, once) after
                           asking, --yes without asking. Paths are relative; no code, home paths,
                           usernames, env values or credentials unless --include-code adds code lines
  inventory [--project <dir>…] [--include <glob>…] [--exclude <glob>…] [--out file] [--json]
                           every UI element across one or more projects: definitions, kits (CVA folders,
                           class kits), library primitives, and each rendered button, input, card,
                           badge, dialog, tabs and link-as-button with file:line and route, grouped into
                           families by resolved shape (Tailwind and CSS, the project's own theme; colour
                           ignored). --project repeats; default: the current directory. --include
                           (repeats) replaces each project's default or youi.project.json include globs,
                           e.g. --include 'src/browser/**'; stylesheets still count. --exclude (repeats)
                           adds to its exclude globs. Writes youi.inventory/v1 to
                           <first project>/.youi/inventory.json unless --out, and records the scan
                           (project, commit, time, counts, families) in the local index for trends
  inventory --history      every recorded scan per project, newest first, with what changed
  gaps [--project <dir>…] [--inventory <file>] [--json] [--out <file>]
                           per project, each kind of element: in the System, from a library, built
                           by hand or missing from the standard kit, with licensed candidates from
                           the Discover index, and what is built by hand in more than one project
  requests [--status open|addressed|closed|all] [--route r] [--json]
                           comments and change requests people pinned to components on captured
                           screens: what is asked, the file:line, the picture, and what to do next
  requests show <id> | reply <id> --message <text> | addressed <id> --message <what you changed>
                           read one, reply, or mark it done (as an agent; a person closes it in the hub)
  screens capture --base <url> [--route r] [--project dir] [--out dir] [--storage-state file] [--json]
                           photograph the routes in <project>/.youi/screens/screens.json, light and
                           dark, from the app running in development at <url>, and place each
                           component on them with the line that rendered it (for youiyoux ui)
  screens login --base <url> [--project dir] [--storage-state file]
                           open the app in a browser window to sign in once; capture then uses the
                           session (kept outside the product, readable only by you)
  render [file|component…] [--base ref] [--json]
                           see a component you changed: its looks drawn with the project's own code
                           and CSS in headless Chromium, light and dark at 1280 and 390 px, axe's
                           accessibility issues, and a pixel diff against the base commit (default:
                           the merge base with origin/main, else main); prints image paths and what to
                           do next. With no target, only components whose files changed are drawn;
                           an unchanged component comes from the cache (YOUI_SPECIMEN_CACHE)

${style.bold("In a product repo")}
  init --design <dir|package>   write youi.project.json pointing at a design repo checkout, or at
                           the npm package that holds it (named, so no machine's folder), then sync;
                           a git repository goes in its source: { "git": "github:acme/design", "ref": "v3" }
  sync [--dry-run] [--adopt]   tokens, DESIGN.md, skill, AGENTS.md block, owned components (3-way merge), lockfile;
                           a git source's ref is fetched and resolved again (every other command uses the
                           commit youi.lock.json records, from the cache, offline)
  link [<dir>] | unlink    use your own checkout of the design system for this product, on this machine only
                           (never written to the repo); link alone shows it
  scan [--out file]        build the usage map (default .youi/usage.json)
  mcp [--cache dir]        stdio MCP server: system_* tools (build with), library_* tools (browse, request),
                           discover_* tools (read the Discover index; never fetch), index_* tools
                           (where a family is used, swap impact, what a rule covers; read the local index)
                           ui_find_component (the project's existing component for a need, or where to start),
                           and ui_render (see a changed component, as youiyoux render)
  agents install|remove [--claude] [--codex]
                           tell coding agents to call ui_find_component before creating a component:
                           a marked rule in AGENTS.md and CLAUDE.md, and the youiyoux MCP server for
                           Claude Code (.mcp.json) and Codex (.codex/config.toml); default both.
                           Idempotent; remove takes out only youi's parts. No youi.project.json needed
  hooks install [--claude] [--git] [--ci [--diff]] [--strict]
                           live checks, existing config kept (default: --claude --git):
                           Claude Code PostToolUse (advisory context after each edit: violations
                           plus the drift the edit adds, each with its fix),
                           git pre-commit (advisory on staged files and their drift; --strict blocks
                           new errors and drift; Codex has no post-edit hook, so this and AGENTS.md
                           cover it), CI workflow (authoritative, pinned rules version, PR
                           annotations; --diff also fails pull requests on drift they add)

${style.bold("System")}  ${style.dim("approved elements: build only with these")}
  show <component>         the contract: import, legal prop values, guidance, examples
  where <component> [--route r] [--all]   where a component lives, screen by screen
  bom <route>              everything on one screen
  check [files…] [--rule id] [--quiet] [--baseline] [--format text|json|github]
                           rule violations and lockfile drift; exits 1 on errors or an incomplete check.
                           --baseline fails only on violations the baseline does not accept;
                           --format github annotates PR lines and writes the job summary
  check --diff [base] [--strict] [--json|--format github]
                           only what a change adds (the working tree against HEAD, or against the
                           merge-base with base): near-duplicate components, hardcoded colours, spacing
                           and radii a token holds, and imports from a library other than the project's
                           choice, plus rule violations on added lines, each with its fix. Exits 0
                           (advisory) unless --strict: then 1 on any finding or an incomplete check
  baseline [--force]       record existing violations (youi.baseline.json beside the config);
                           later runs only remove fixed ones; --force accepts current ones as debt
  watch [--baseline] [--json]   re-check on every save (debounced; only edited files and their
                           importers are re-analysed; definition changes reload the rules)
  plan <component> --patch <json|file>    classify a contract change and show its impact
  plan --token <id> [--value v]           impact of a token change
  migrate <migration.yaml> [--write] [--diff]   gated codemod for props and renamed or removed exports
                           (imports, re-exports, uses); a dry run that prints the diff and the sites
                           left for a person (file:line, why) unless --write; --diff shows it after --write too
  rules [--preview <rule.yaml>]   whether each rule is checked; preview a draft rule on the current scan

${style.bold("Library")}  ${style.dim("ingested references: browse and request adoption, never build with")}
  library search <query>   Library items (lib: ids) and the System elements each could swap in for
  library request <id> --reason <text>   draft an adoption request for a person to approve

${style.bold("Discover")}  ${style.dim("UI components by need, across shadcn registries and npm: candidates, never installed")}
  discover sync [--cache dir] [--max-registries n] [--icons]
                           refresh cached candidates, licences and signals; add --icons for icon sets
                           GITHUB_TOKEN raises GitHub limits when set; never stored or printed
  discover sources [list|add|remove] <name>  choose community sources
  discover "<need>" [--all] [--role r] [--license spdx,…] [--limit n] [--offset n] [--json]
                           candidates ranked by match (names, aliases: command menu = cmdk, toast =
                           snackbar…) plus signals, with licence (or unknown) and the install command,
                           and facets (role, source, licence, headless/styled); --all also lists
                           every other registry, kept apart from the default search
  discover show <id|ref> [--source] [--json]   one candidate: provenance, licence evidence, dependencies
  discover previews [--port n] [--registry @shadcn|all] [--role r] [--limit n] [--force]
                           photograph candidates in your theme for the hub's gallery, from a hub
                           running on your project (youiyoux ui --project <dir>)
                           (cache: --cache, else YOUI_DISCOVER_CACHE, else ~/.cache/youiyoux/discover)

${style.bold("Index")}  ${style.dim("the local store of derived data: rebuildable, never the authority")}
  index path               where it lives: YOUI_INDEX, else ~/.cache/youiyoux/index.db (beside --cache
                           when given); DATABASE_URL puts it on Postgres instead
  index stats              rows per table
  index rebuild            delete it and fill it again from the Discover cache, the scan log, the
                           inventory files and the projects' rules and usage maps
  index history [project]  inventory trends per project (as inventory --history)

${style.bold("Detect")}  ${style.dim("which UI libraries a repo or website uses (youi.detect/v1)")}
  detect <repo-path>       package.json, lockfile, components.json and the code's real imports;
                           declared but never imported packages are listed apart, not counted
  detect <url…> [--expose] load each page in headless Chromium and read its fingerprints, one
                           screenshot per element type; coverage is per page crawled, so pass
                           every page that matters; --expose opens menus, dialogs and tabs
                           (--out dir, default .youi/detect; the first run downloads Chromium, ~100 MB)

${style.bold("The hub")}
  ui [--design dir] [--project dir] [--config file] [--root dir] [--port n] [--watch] [--state dir] [--inventory file] [--detect file]
                           open the web hub on a design system (default: the demo system);
                           --project adds that product's usage map (read-only scan) and the
                           rule editor (System > Rules, Work > Changes): drafts, impact preview,
                           approval, a review branch in the design repo (drafts kept in --state);
                           --watch re-scans on every save and updates the open hub;
                           --inventory shows a youiyoux inventory file on the Inventory page
                           --detect adds a youiyoux detect report to Library > Stack

${style.bold("In a design repo")} ${style.dim("(the current directory, or --design)")}
  build [--out dir] [--prefix p]   build token outputs
  parity --css <file> [--prefix p] [--light sel] [--dark sel]   generated CSS vs a project's shipped CSS

${style.bold("In this tool's repo")}
  schema [--write|--check] emit JSON Schemas from the Zod definitions; --design writes or checks a design repo's schema/

${style.bold("Options")}
  --project <dir>   project root (default: the nearest folder upward, in this git repo, holding
                    youi.project.json; else the current directory)
  --config <file>   project config (default: <project>/youi.project.json)
  --root <dir>      product root, for a config kept outside the product
                    (default: "root" in the config, relative to it; else --project)
  --design <dir>    design repo checkout, the directory holding youi.config.json
                    (default: youiyoux link's checkout, else the config's source: a path, an installed
                    package or a git repository at a ref; for build and
                    parity, the nearest folder upward holding youi.config.json)
  --json            machine-readable output`;

const OPTIONS = {
  project: { type: "string" },
  config: { type: "string" },
  root: { type: "string" },
  design: { type: "string" },
  json: { type: "boolean", default: false },
  out: { type: "string" },
  route: { type: "string" },
  all: { type: "boolean", default: false },
  limit: { type: "string" },
  rule: { type: "string" },
  preview: { type: "string" },
  quiet: { type: "boolean", default: false },
  patch: { type: "string" },
  token: { type: "string" },
  value: { type: "string" },
  reason: { type: "string" },
  write: { type: "boolean", default: false },
  check: { type: "boolean", default: false },
  diff: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  baseline: { type: "boolean", default: false },
  claude: { type: "boolean", default: false },
  codex: { type: "boolean", default: false },
  git: { type: "boolean", default: false },
  ci: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  base: { type: "string" },
  "baseline-file": { type: "string" },
  format: { type: "string" },
  adopt: { type: "boolean", default: false },
  force: { type: "boolean", default: false },
  system: { type: "string" },
  components: { type: "string" },
  css: { type: "string" },
  prefix: { type: "string" },
  light: { type: "string" },
  port: { type: "string" },
  watch: { type: "boolean", default: false },
  expose: { type: "boolean", default: false },
  detect: { type: "string" },
  dark: { type: "string" },
  state: { type: "string" },
  inventory: { type: "string" },
  cache: { type: "string" },
  role: { type: "string" },
  license: { type: "string" },
  icons: { type: "boolean" },
  source: { type: "boolean" },
  registry: { type: "string" },
  "storage-state": { type: "string" },
  message: { type: "string" },
  status: { type: "string" },
  "max-registries": { type: "string" },
  offset: { type: "string" },
  history: { type: "boolean", default: false },
  render: { type: "boolean", default: false },
  yes: { type: "boolean", short: "y", default: false },
  "include-code": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} satisfies ParseArgsConfig["options"];

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** `youiyoux inventory` reads several projects: there, --project repeats, and so do --include and --exclude. */
const INVENTORY_OPTIONS = { ...OPTIONS, project: { type: "string", multiple: true }, include: { type: "string", multiple: true }, exclude: { type: "string", multiple: true } } satisfies ParseArgsConfig["options"];
type InventoryValues = ReturnType<typeof parseArgs<{ options: typeof INVENTORY_OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

const run = promisify(execFile);
const print = (text: string): void => void process.stdout.write(`${text}\n`);
const json = (value: unknown): void => print(JSON.stringify(value, null, 2));

/** --config, --design and --root, as loader options. An empty --root (`--root ''`) is the current directory, not unset. */
export function loadOptions(values: Pick<Values, "config" | "design" | "root">): LoadProjectOptions {
  return { ...(values.config ? { configPath: values.config } : {}), ...(values.design ? { designRoot: values.design } : {}), ...(values.root !== undefined ? { productRoot: values.root || "." } : {}) };
}

async function project(values: Values): Promise<Project> {
  return loadProject(values.project ?? process.cwd(), loadOptions(values));
}

async function readJsonOrFile(value: string): Promise<Record<string, unknown>> {
  const text = value.trim().startsWith("{") ? value : await readFile(value, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function cmdScan(values: Values): Promise<number> {
  const p = await project(values);
  const { report } = await scanProject(p);
  const out = values.out ?? join(p.root, ".youi/usage.json");
  await writeFileAtomic(resolve(out), `${JSON.stringify(report)}\n`);
  const recorded = await recordUsage(values, p, report, resolve(out));
  if (values.json) json(report);
  else print([renderScan(report, out), ...(recorded ? [recorded] : [])].join("\n"));
  return 0;
}

/** The project's rules and usage, as graph edges in the local index (rule governs component, used in file and route). */
async function recordUsage(values: Values, p: Project, report: ScanReport, usage: string): Promise<string | null> {
  const { path, home } = indexOf(values);
  try {
    await recordProject(await sharedStore(path), p, report);
    await noteSource(home, { project: { root: resolve(values.project ?? process.cwd()), options: Object.fromEntries(Object.entries(loadOptions(values)).map(([key, value]) => [key, resolve(value)])), usage } });
    return null;
  } catch (error: unknown) {
    return notRecorded(error);
  }
}

/** Why a run could not record into the local index: a warning, since the command itself still did its work. */
const notRecorded = (error: unknown): string => style.warn(`! not recorded in the local index: ${error instanceof Error ? error.message : String(error)}`);

/** The projects `inventory` and `gaps` read: --project repeats; default: the current directory. */
const inventoryDirs = (values: InventoryValues): string[] => (values.project?.length ? values.project : [process.cwd()]);

/** Those projects' inventory, with --include and --exclude. */
const scanInventory = (values: InventoryValues, dirs: readonly string[]): Promise<InventoryReport> => buildInventory(dirs, { ...(values.include ? { include: values.include } : {}), ...(values.exclude ? { exclude: values.exclude } : {}) });

/** The store this run reads and records into (DATABASE_URL, else a SQLite file), and the directory its sources are noted in. */
function indexOf(values: Pick<Values, "cache">): { path: string; home: string } {
  const path = discoverIndexPath(values.cache);
  return { path, home: indexHome(path) };
}

/** `youiyoux gaps`: per project, each kind of element in the System, from a library, built by hand or missing, with candidates. */
async function cmdGaps(values: InventoryValues): Promise<number> {
  const dirs = inventoryDirs(values);
  const inventory = values.inventory ? InventoryReport.parse(JSON.parse(await readFile(resolve(values.inventory), "utf8"))) : await scanInventory(values, dirs);
  // Paths in an inventory file are from where it was made: the file's own directory, else here.
  const cwd = values.inventory ? dirname(resolve(values.inventory)) : process.cwd();
  const project = await loadProject(resolve(dirs[0]!), loadOptions(values)).catch(() => null);
  const system = project ? { name: project.system.config.name, components: project.system.components.map((c) => c.contract.name) } : null;
  const store = await readCatalog(resolve(discoverCacheDir(values.cache)), indexOf(values).path).catch((error: unknown) => {
    if (error instanceof MissingIndexError) return null;
    throw error;
  });
  const roots = new Map(inventory.projects.map((p) => [p.id, resolve(cwd, p.root)]));
  const report = await buildGaps({ inventory, system, dependencies: declaredPackages(roots) }, store);
  if (values.out) await writeFileAtomic(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
  if (values.json) json(report);
  else print(renderGaps(report));
  return 0;
}

async function cmdInventory(values: InventoryValues): Promise<number> {
  if (values.history) return cmdHistory(values, []);
  const dirs = inventoryDirs(values);
  const report = await scanInventory(values, dirs);
  const out = resolve(values.out ?? join(dirs[0]!, ".youi/inventory.json"));
  await writeFileAtomic(out, `${JSON.stringify(report, null, 2)}\n`);
  const recorded = await recordScan(values, report, out);
  if (values.json) json(report);
  else print([renderInventory(report, relative(process.cwd(), out).startsWith("..") ? out : relative(process.cwd(), out)), recorded].join("\n"));
  return 0;
}

/** Record an inventory in the local index; the inventory itself never fails for it (a warning says why). */
async function recordScan(values: Pick<Values, "cache">, report: InventoryReport, out: string): Promise<string> {
  const { path, home } = indexOf(values);
  try {
    const store = await sharedStore(path);
    await recordInventory(store, home, report, out);
    const scans = (await store.history({ limit: 500 })).filter((s) => report.projects.some((p) => p.id === s.project)).length;
    return style.dim(`history → ${store.location} (${plural(scans, "scan")} of these projects; youiyoux inventory --history)`);
  } catch (error: unknown) {
    return notRecorded(error);
  }
}

async function cmdHistory(values: Pick<Values, "cache" | "json" | "limit">, positionals: string[]): Promise<number> {
  const { path } = indexOf(values);
  const scans = await (await sharedStore(path, process.env, { readOnly: true })).history({ ...(positionals[0] ? { project: positionals[0] } : {}), limit: positiveInt(values.limit, "--limit") ?? 50 });
  if (values.json) json(scans);
  else print(renderHistory(scans));
  return 0;
}

async function cmdIndex(values: Values, positionals: string[]): Promise<number> {
  const [action, ...rest] = positionals;
  const { path, home } = indexOf(values);
  if (action === "path") {
    if (values.json) json({ store: storeLocation({ path }), sources: join(home, SOURCES_FILE), scans: join(home, SCANS_LOG) });
    else print(storeLocation({ path }));
    return 0;
  }
  if (action === "stats") {
    const stats = await (await sharedStore(path, process.env, { readOnly: true })).stats();
    if (values.json) json(stats);
    else print([`${style.bold("index")} ${stats.location} ${style.dim(`· ${stats.engine} · schema ${stats.schema} · generation ${stats.generation ?? "not rebuilt"}`)}`, ...Object.entries(stats.tables).map(([table, n]) => `  ${table.padEnd(16)} ${n.toLocaleString("en-US")}`)].join("\n"));
    return 0;
  }
  if (action === "rebuild") {
    const summary = await rebuildIndex(path, values.cache ? { discoverCache: resolve(values.cache) } : {});
    if (values.json) json(summary);
    else print(renderRebuild(summary));
    return 0;
  }
  if (action === "history") return cmdHistory(values, rest);
  throw new UsageError("youiyoux index path|stats|rebuild|history [project]");
}

async function cmdWhere(values: Values, positionals: string[]): Promise<number> {
  const query = positionals[0];
  if (!query) throw new UsageError("youiyoux where <component>");
  const p = await project(values);
  const { report } = await scanProject(p);
  const limit = values.all ? Number.MAX_SAFE_INTEGER : Number(values.limit ?? (values.json ? 20 : 24));
  const where = whereUsed(p, report, query, { ...(values.route ? { route: values.route } : {}), limit });
  if (values.json) json(where);
  else print(renderWhere(where, report));
  return 0;
}

async function cmdShow(values: Values, positionals: string[]): Promise<number> {
  const query = positionals[0];
  if (!query) throw new UsageError("youiyoux show <component>");
  const p = await project(values);
  const contract = findContract(p, query);
  if (!contract) throw new Error(`no component "${query}"; known: ${p.system.components.map((c) => c.contract.name).join(", ")}`);
  const card = componentCard(p, contract, (await scanProject(p)).report);
  if (values.json) json(card);
  else print(renderShow(card));
  return 0;
}

async function cmdBom(values: Values, positionals: string[]): Promise<number> {
  const route = positionals[0];
  if (!route) throw new UsageError("youiyoux bom <route>");
  const p = await project(values);
  const bom = screenBom(p, (await scanProject(p)).report, route);
  if (values.json) json(bom);
  else print(renderBom(bom));
  return 0;
}

function baselineFile(values: Values, p: Project): string | null {
  if (values["baseline-file"]) return resolve(values["baseline-file"]);
  return values.baseline ? baselinePath(p, values.config) : null;
}

/** `check [files…] [--rule id] [--quiet]` as check options. */
const checkScope = (values: Values, positionals: readonly string[]): { files?: readonly string[]; rule?: string; quiet: boolean } => ({ ...(positionals.length > 0 ? { files: positionals } : {}), ...(values.rule ? { rule: values.rule } : {}), quiet: values.quiet });

/** The project's path inside its repository (`apps/web/`), so annotations land on the right file. */
async function repoPrefix(root: string): Promise<string> {
  try {
    return (await run("git", ["rev-parse", "--show-prefix"], { cwd: root })).stdout.trim();
  } catch {
    return "";
  }
}

async function cmdCheck(values: Values, positionals: string[]): Promise<number> {
  const format = values.json ? "json" : (values.format ?? "text");
  if (!["text", "json", "github"].includes(format)) throw new UsageError("youiyoux check --format text|json|github");
  if (values.diff || values.base !== undefined) return cmdCheckDiff(values, positionals, await loadCheckProject(values.project ?? process.cwd(), loadOptions(values), !values.project), format);
  const p = await project(values);
  const result = await runCheck(p, { ...checkScope(values, positionals), baseline: baselineFile(values, p) });
  if (format === "json") {
    const { report } = result.scan;
    json({ errors: result.errors, incomplete: result.incomplete, identity: result.identity, unmatched: result.unmatched, notRun: result.notRun, violations: result.violations, baseline: result.baseline, lock: result.lock, suppressed: report.suppressed, coverage: report.coverage, status: report.status, checks: report.checks });
  } else if (format === "github") {
    for (const line of githubAnnotations(result, await repoPrefix(p.root))) print(line);
    print(renderCheckText(result));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, githubSummary(result));
  } else print(renderCheckText(result));
  return exitCodeOf(result);
}

/** `youiyoux check --diff [base]`: what the change adds, with fixes. Never a pass it could not compute: without git it stops. */
async function cmdCheckDiff(values: Values, positionals: string[], p: ChangeProject, format: string): Promise<number> {
  if (values.baseline) throw new UsageError("youiyoux check --diff looks only at added lines, so a baseline does not apply; drop --baseline");
  const change = await workingTreeChange(p, values.base);
  const result = configured(p) ? await runCheck(p, { ...checkScope(values, positionals), diff: change }) : await runRepoCheck(p, change);
  if (format === "json") json(diffJson(result));
  else if (format === "github") {
    for (const line of githubDiffAnnotations(result, await repoPrefix(p.root))) print(line);
    print(renderDiffText(result));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, githubDiffSummary(result));
  } else print(renderDiffText(result));
  return diffExitCodeOf(result, values.strict);
}

/** `--diff <base>` and `--diff=<base>` for check: the word after --diff is the base it compares with. */
export function diffArgs(argv: readonly string[]): string[] {
  if (argv[0] !== "check") return [...argv];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--diff=")) out.push("--diff", "--base", arg.slice("--diff=".length));
    else if (arg === "--diff" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) out.push("--diff", "--base", argv[++i]!);
    else out.push(arg);
  }
  return out;
}

async function cmdBaseline(values: Values): Promise<number> {
  const p = await project(values);
  const file = baselineFile(values, p) ?? baselinePath(p, values.config);
  const written = await writeBaseline(p, file, { force: values.force });
  const { totals } = written.baseline;
  if (values.json) json({ file: written.file, action: written.action, totals, notAdded: written.notAdded, identity: written.baseline.identity });
  else {
    print(`${style.ok(written.action)} ${relative(process.cwd(), file) || file}: ${plural(totals.errors, "error")} · ${plural(totals.warnings, "warning")} accepted`);
    print(style.dim(`  rules ${describeIdentity(written.baseline.identity)}`));
    if (written.notAdded > 0) print(style.warn(`  ${plural(written.notAdded, "current violation")} not added: fix them, or accept them deliberately with --force`));
  }
  return 0;
}

async function cmdPlan(values: Values, positionals: string[]): Promise<number> {
  const p = await project(values);
  const scan = await scanProject(p);
  let input: PlanInput;
  if (values.token) input = { token: values.token, ...(values.value ? { value: values.value } : {}) };
  else if (positionals[0] && values.patch) input = { element: positionals[0], patch: await readJsonOrFile(values.patch) };
  else throw new UsageError("youiyoux plan <component> --patch <json|file>   or   youiyoux plan --token <id> [--value v]");
  const plan = await planChange(p, scan, input);
  if (values.json) json(plan);
  else print(renderPlan(plan));
  return 0;
}

async function cmdRules(values: Values): Promise<number> {
  const p = await project(values);
  if (values.preview) {
    const draft: unknown = parseYaml(await readFile(values.preview, "utf8"));
    const evaluation = evaluateRule(p, await scanProject(p), draft);
    if (values.json) json(evaluation);
    else print(renderRulePreview(evaluation));
    return evaluation.ok && evaluation.findings !== null ? 0 : 1;
  }
  const rules = p.system.rules.map((rule) => ({ rule, execution: ruleCapability(rule) }));
  if (values.json) json({ capabilities: checkCapabilities(), rules: rules.map(({ rule, execution }) => ({ id: rule.id, severity: rule.severity, ...execution })) });
  else print(renderRules(rules));
  return rules.some(({ execution }) => execution.state === "unsupported") ? 1 : 0;
}

async function cmdMigrate(values: Values, positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (!file) throw new UsageError("youiyoux migrate <migration.yaml> [--write] [--diff]");
  const spec = MigrationSpec.parse(parseYaml(await readFile(file, "utf8")));
  const result = await runMigration(await project(values), spec, { write: values.write });
  if (values.json) json(result);
  // A dry run is a preview: it always shows what it would write.
  else print(renderMigration(result, values.diff || !values.write));
  return result.status === "rejected" ? 1 : 0;
}

async function cmdLibrary(values: Values, positionals: string[]): Promise<number> {
  const [action, query] = positionals;
  if (action === "search" && query) {
    const p = await project(values);
    const words = positionals.slice(1).join(" ");
    const result = searchLibrary(await loadLibrary(p.repo.root), words, Number(values.limit ?? 20));
    if (values.json) json(result);
    else print(renderLibrarySearch(result, words));
    return 0;
  }
  if (action === "request" && query && values.reason) {
    const p = await project(values);
    const request = adoptionRequest(p, await loadLibrary(p.repo.root), query, values.reason, await scanProject(p));
    if (values.json) json(request);
    else print(renderAdoptionRequest(request));
    return 0;
  }
  throw new UsageError("youiyoux library search <query>   or   youiyoux library request <id> --reason <text>");
}

async function cmdSync(values: Values): Promise<number> {
  // sync is the update: a git source's ref is resolved again; every other command keeps to the recorded commit.
  const p = await loadProject(values.project ?? process.cwd(), { ...loadOptions(values), refreshDesign: true });
  const result = await syncProject(p, { dryRun: values["dry-run"], adopt: values.adopt });
  if (values.json) json(result);
  else print([renderSync(result, values["dry-run"]), ...(p.linked ? [style.warn(`! linked: the design system is your checkout ${p.linked}, not the config's source (youiyoux unlink to undo)`)] : [])].join("\n"));
  return result.actions.some((a) => a.action === "conflict") ? 1 : 0;
}

async function cmdInit(values: Values): Promise<number> {
  if (!values.design) throw new UsageError("youiyoux init --design <dir|package>   (a design repo checkout, the directory holding youi.config.json, or the npm package that holds it)");
  const root = values.project ?? process.cwd();
  const design = await designArg(values.design, root);
  const result = await initProject({ root, ...design, schemaDir: join(TOOL_ROOT, "schema"), ...(values.system ? { system: values.system } : {}), ...(values.components ? { componentsDir: values.components } : {}), force: values.force });
  if (!values.json) {
    print(`${style.ok("created")} ${result.file}`);
    for (const note of result.notes) print(style.dim(`  · ${note}`));
    print("");
  }
  // A package is found again through the config's source; a --design folder is passed on as given.
  const { design: _named, ...rest } = values;
  return cmdSync({ ...(design.package ? rest : values), project: root });
}

/**
 * `youiyoux link <dir>`: use this checkout of the design system for this product, on this machine
 * only (kept in the person's config folder, never in the repo); `youiyoux link` shows the link and
 * `youiyoux unlink` removes it. It never changes what sync writes for the team.
 */
async function cmdLink(values: Values, positionals: string[]): Promise<number> {
  const [dir] = positionals;
  // Loaded with the new checkout, which checks it is a design repo holding the project's system (and survives a stale link).
  const p = await loadProject(values.project ?? process.cwd(), { ...loadOptions(values), ...(dir !== undefined ? { designRoot: dir } : {}) });
  if (dir === undefined) {
    print(p.linked ? `${p.root} uses your checkout ${p.linked} (youiyoux unlink to undo)` : `${p.root} uses its config's source; not linked`);
    return 0;
  }
  await setLink(p.root, p.repo.root);
  print(`${style.ok("linked")} ${p.root} → ${p.repo.root}, for you only ${style.dim(`(${linksFile()}; youiyoux unlink to undo)`)}`);
  return 0;
}

async function cmdUnlink(values: Values): Promise<number> {
  const root = values.project ?? process.cwd();
  const linked = await linkedDesign(root);
  if (linked !== null) await setLink(root, null);
  print(linked ? `${style.ok("unlinked")} ${resolve(root)} uses its config's source again` : `${resolve(root)} was not linked`);
  return 0;
}

/** init's --design: a folder when one is there, else an npm package installed for the product (written to the config by name). */
async function designArg(value: string, root: string): Promise<{ design: string; package?: string }> {
  if (existsSync(resolve(value)) || !PACKAGE_NAME.test(value)) return { design: value };
  return { design: await designRootOf({ package: value }, join(resolve(root), PROJECT_FILE), root), package: value };
}

async function cmdBuild(values: Values): Promise<number> {
  const root = resolve(values.design ?? process.cwd());
  const system = getSystem(await loadDesignRepo(root), values.system);
  if (safeId(system.config.id) === null) throw new Error(`Cannot build system ${JSON.stringify(system.config.id)}: the id must be a plain name without ".." or path separators.`);
  const output = OutputConfig.parse({ cssVarPrefix: values.prefix ?? "youi", targets: ["css-vars", "tailwind-v4", "ts", "react-native"] });
  const started = performance.now();
  const built = await buildTokens(root, system.config, output, { contracts: system.components.map((c) => c.contract) });
  const out = resolve(values.out ?? join(root, "build", system.config.id));
  const boundary = values.out ? out : join(root, "build");
  if (!within(boundary, out) || built.files.some((file) => !within(out, join(out, file.path)))) throw new Error(`Cannot build system ${JSON.stringify(system.config.id)}: an output path leaves the output directory.`);
  for (const file of built.files) await writeFileAtomic(join(out, file.path), file.content);
  if (values.json) json({ out, files: built.files.map((f) => f.path), tokens: built.tokens.length });
  else print(`${style.ok("built")} ${plural(built.tokens.length, "token")} → ${built.files.map((f) => f.path).join(", ")} ${style.dim(`in ${out} (${ms(performance.now() - started)})`)}`);
  return 0;
}

async function cmdParity(values: Values): Promise<number> {
  if (!values.css) throw new UsageError("youiyoux parity --css <file> [--prefix p]");
  const root = resolve(values.design ?? process.cwd());
  const system = getSystem(await loadDesignRepo(root), values.system);
  const prefix = values.prefix ?? "youi";
  const dark = { selector: values.dark ?? ":root[data-theme=\"dark\"]" };
  const built = await buildTokens(root, system.config, OutputConfig.parse({ cssVarPrefix: prefix, dark: [dark], targets: ["css-vars"] }));
  const report = compareParity(await readFile(values.css, "utf8"), { light: { selector: values.light ?? ":root" }, dark }, built.files[0]!.content, { light: { selector: ":root" }, dark }, prefix);
  if (values.json) json(report);
  else {
    const ok = report.different.length === 0 && report.missing.length === 0;
    print(`${ok ? style.ok("✓ parity") : style.error("✖ parity")}  ${report.matched} matched · ${report.different.length} different · ${report.missing.length} missing · ${style.dim(`${report.added.length} new in the build`)}`);
    for (const d of report.different) print(`  ${style.error("≠")} ${d.variable} (${d.mode}): shipped ${d.expected} · built ${d.actual}`);
    for (const m of report.missing) print(`  ${style.warn("missing")} ${m.variable} (${m.mode})`);
  }
  return report.different.length === 0 && report.missing.length === 0 ? 0 : 1;
}

async function cmdSchema(values: Values): Promise<number> {
  const schemas = renderJsonSchemas();
  if (values.check) {
    // A design repo keeps copies for editor validation; the Zod definitions here stay the one authority.
    const dir = join(values.design ? resolve(values.design) : TOOL_ROOT, "schema");
    const stale = [];
    for (const { file, content } of schemas) if ((await readFile(join(dir, file), "utf8").catch(() => null)) !== content) stale.push(file);
    if (values.json) json({ dir, stale });
    else print(stale.length === 0 ? `${style.ok("✓")} ${dir} matches this youi's schemas` : `${style.error("✖")} out of date in ${dir}: ${stale.join(", ")}; run youiyoux schema --write${values.design ? " --design <dir>" : ""}`);
    return stale.length === 0 ? 0 : 1;
  }
  if (values.write) {
    // Into a design repo with --design (for editor validation there), otherwise into this tool's schema/.
    const root = values.design ? resolve(values.design) : TOOL_ROOT;
    for (const { file, content } of schemas) await writeFileAtomic(join(root, "schema", file), content);
    print(`${style.ok("wrote")} ${schemas.map((s) => s.file).join(", ")}`);
  } else json(Object.fromEntries(schemas.map((s) => [s.file, JSON.parse(s.content)])));
  return 0;
}

function hookTarget(values: Values): HookTarget {
  return { ...(values.project ? { project: values.project } : {}), ...(values.config ? { config: values.config } : {}), ...(values.design ? { design: values.design } : {}), ...(values.root ? { root: values.root } : {}) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdHooks(values: Values, positionals: string[]): Promise<number> {
  const [action, kind] = positionals;
  if (action === "run" && (kind === "claude" || kind === "pre-commit")) {
    const outcome = kind === "claude" ? await runClaudeHook(await readStdin(), hookTarget(values)) : await runPreCommitHook(hookTarget(values), { strict: values.strict });
    process.stdout.write(outcome.stdout);
    return outcome.exitCode;
  }
  if (action !== "install") throw new UsageError("youiyoux hooks install [--claude] [--git] [--ci [--diff]] [--strict]   or   youiyoux hooks run claude|pre-commit");
  const p = await loadCheckProject(values.project ?? process.cwd(), loadOptions(values), !values.project);
  if (values.ci && !configured(p)) throw new UsageError("Run youiyoux init --design <dir> before installing the pinned CI workflow; repo-mode CI can run youiyoux check --diff <base> --strict directly");
  // The hook finds the config it was installed with, even when --project named the config's directory and --root the product.
  const target = { ...hookTarget(values), project: p.root, ...(configured(p) && p.configFile && p.configFile !== join(p.root, PROJECT_FILE) ? { config: p.configFile } : {}), ...(values.root !== undefined ? { root: p.root } : {}) };
  const all = !values.claude && !values.git && !values.ci;
  const results = [];
  if (values.claude || all) results.push({ kind: "Claude Code", ...(await installClaudeHook(await repoRootOf(p.root), hookCommand(TOOL_ROOT, "claude", target))) });
  if (values.git || all) results.push({ kind: "git pre-commit", ...(await installPreCommit(p.root, hookCommand(TOOL_ROOT, "pre-commit", target, values.strict ? ["--strict"] : []), values.strict)) });
  if (values.git || all) results.push({ kind: "Codex", ...(configured(p) ? codexFallback(p.root, p.config.agents.agentsMd) : await installRepoAgentInstructions(p.root)) });
  if (values.ci && configured(p)) results.push({ kind: "CI", ...(await installWorkflow(p, TOOL_ROOT, target, values.force, { diff: values.diff })) });
  if (values.json) json(results);
  else for (const r of results) print(`${r.action === "unchanged" || r.action === "skipped" ? style.dim(r.action) : style.ok(r.action)} ${r.kind}: ${r.file}
  ${style.dim(r.guarantee)}`);
  return 0;
}

/**
 * `youiyoux agents install|remove`: the find-first rule in AGENTS.md and CLAUDE.md, and the youi MCP
 * server for Claude Code (.mcp.json) and Codex (.codex/config.toml), at the repo root. Works with
 * or without a youi.project.json: ui_find_component reads the code either way.
 */
async function cmdAgents(values: Values, positionals: string[]): Promise<number> {
  const [action] = positionals;
  if (action !== "install" && action !== "remove") throw new UsageError("youiyoux agents install|remove [--claude] [--codex] [--json]");
  const projectRoot = resolve(values.project ?? process.cwd());
  const repoRoot = await repoRootOf(projectRoot);
  const target = { project: projectRoot, ...(values.config ? { config: resolve(values.config) } : {}), ...(values.design ? { design: resolve(values.design) } : {}), ...(values.root !== undefined ? { root: resolve(values.root || ".") } : {}) };
  const server = mcpCommand(TOOL_ROOT, target);
  // In a System project at the repo root, the same entry youiyoux sync writes, so the two never fight over it.
  const system = existsSync(resolve(values.config ?? join(projectRoot, PROJECT_FILE))) ? await project(values) : null;
  const claudeServer = system && system.root === repoRoot ? { command: "node", args: mcpArgs(system) } : relativeTo(repoRoot, server);
  const both = !values.claude && !values.codex;
  const results: Array<AgentsResult & { kind: string }> = [];
  const rule = action === "install" ? await installAgentRule(repoRoot) : await removeAgentRule(repoRoot);
  results.push(...rule.map((r) => ({ kind: "agent rule", ...r })));
  if (values.claude || both) results.push({ kind: "Claude Code MCP", ...(action === "install" ? await installClaudeMcp(repoRoot, claudeServer) : await removeClaudeMcp(repoRoot)) });
  if (values.codex || both) results.push({ kind: "Codex MCP", ...(action === "install" ? await installCodexMcp(repoRoot, server) : await removeCodexMcp(repoRoot)) });
  if (values.json) json(results);
  else {
    for (const r of results) print(`${r.action === "unchanged" ? style.dim("unchanged") : style.ok(r.action)} ${r.kind}: ${r.file}\n  ${style.dim(r.guarantee)}`);
    print(action === "install" ? `Next: restart your agent so it loads the ${style.bold("youiyoux")} MCP server; it will call ui_find_component before creating a component. Undo with youiyoux agents remove.` : "Next: restart your agent to drop the youiyoux MCP server.");
  }
  return 0;
}

function watchLine(update: WatchUpdate<CheckResult>, stats: CacheStats): string {
  const time = new Date().toLocaleTimeString();
  if (update.status === "failed") return `${style.dim(time)} ${style.error("✖ incomplete")}  ${update.error}`;
  const result = update.result;
  const found = actionable(result);
  const verdict = result.incomplete ? style.warn("! incomplete") : result.errors > 0 ? style.error(`✖ ${plural(result.errors, "error")}`) : style.ok("✓ 0 errors");
  const known = result.baseline ? style.dim(` · ${result.baseline.comparison.known.length} baselined`) : "";
  const what = update.reloaded ? "definitions reloaded" : update.changed.length > 0 ? update.changed.join(", ") : "initial scan";
  const lines = [`${style.dim(time)} ${verdict}${known} · ${plural(found.length - found.filter((v) => v.severity === "error").length, "warning")}  ${style.dim(`${what} · ${ms(update.durationMs)} · ${stats.analysed} analysed, ${stats.reusedAnalyses} reused`)}`];
  for (const v of found.slice(0, 12)) lines.push(`  ${v.severity === "error" ? style.error("error") : style.warn("warn ")} ${v.file}:${v.line}:${v.column}  ${v.message}`);
  if (found.length > 12) lines.push(style.dim(`  …${found.length - 12} more`));
  return lines.join("\n");
}

async function cmdWatch(values: Values): Promise<number> {
  const root = values.project ?? process.cwd();
  const load = loadOptions(values);
  let stats: CacheStats = { parsed: 0, reusedParses: 0, analysed: 0, reusedAnalyses: 0 };
  const watcher = await ProjectWatcher.start<CheckResult>({
    root,
    load,
    job: async (p, cache) => {
      const result = await runCheck(p, { cache, baseline: baselineFile(values, p), lock: false });
      stats = { ...cache.stats };
      return result;
    },
    onUpdate: (update) => {
      if (!values.json) return print(watchLine(update, stats));
      const base = { generation: update.generation, status: update.status, changed: update.changed, reloaded: update.reloaded, durationMs: update.durationMs };
      if (update.status === "failed") return print(JSON.stringify({ ...base, error: update.error }));
      const r = update.result;
      print(JSON.stringify({ ...base, errors: r.errors, incomplete: r.incomplete, identity: r.identity, contentDigest: r.scan.contentDigest, findings: actionable(r), baseline: r.baseline ? { known: r.baseline.comparison.known.length, fixed: r.baseline.comparison.fixed.length } : null, cache: stats }));
    },
  });
  if (!values.json) print(style.dim(`watching ${root} and its design definitions · ctrl-c to stop`));
  await new Promise<void>((done) => process.once("SIGINT", () => done()));
  watcher.close();
  return 0;
}

/** The rule editor beside the hub: only for a named product, whose design repo the review branches go to. */
async function startEditor(values: Values, port: string): Promise<RuleEditor | null> {
  if (!values.project) return null;
  try {
    const editor = await startRuleEditor({ project: values.project, ...(values.config ? { config: values.config } : {}), ...(values.design ? { design: values.design } : {}), ...(values.root ? { root: values.root } : {}), ...(values.state ? { state: values.state } : {}) });
    const { design, project: product } = editor.info;
    print(`${style.ok("rule editor")} http://localhost:${port}/#key=${editor.sessionKey}`);
    print(style.dim(`  design   ${design.root} (${design.branch} @ ${design.head.slice(0, 7)}${design.dirty ? ", working tree differs" : ""})`));
    print(style.dim(`  project  ${product.id} at ${product.root}`));
    print(style.dim(`  drafts   ${editor.stateDir}`));
    print(style.dim("  open the link above: it carries this run's key, which every change needs (nothing else can approve)"));
    print(style.dim("  approved changes become a local review branch; nothing is pushed"));
    return editor;
  } catch (error: unknown) {
    print(style.warn(`! no rule editor: ${error instanceof Error ? error.message : String(error)}; Rules and Changes stay read-only`));
    return null;
  }
}

async function cmdUi(values: Values): Promise<number> {
  const port = values.port ?? DEFAULT_HUB_PORT;
  const editor = await startEditor(values, port);
  try {
    return await runHub(TOOL_ROOT, { ...(values.inventory ? { inventory: values.inventory } : {}), ...(values.design ? { design: values.design } : {}), ...(values.project ? { project: values.project } : {}), ...(values.config ? { config: values.config } : {}), ...(values.root ? { root: values.root } : {}), ...(values.detect ? { detect: values.detect } : {}), ...(values.port || editor ? { port } : {}), ...(editor ? { api: editor.url } : {}), watch: values.watch });
  } finally {
    await editor?.close();
  }
}

async function cmdDetect(values: Values, positionals: string[]): Promise<number> {
  const target = detectTarget(positionals);
  if (!target) throw new UsageError("youiyoux detect <repo-path>   or   youiyoux detect <url…> [--expose]   (one repo, or one or more URLs; not both)");
  const { repoReport, siteReport, writeReport } = await import("@youiyoux/detect");
  const out = resolve(values.out ?? ".youi/detect");
  const report = target.kind === "repo" ? await repoReport(target.path) : await siteReport(target.urls, { out, expose: values.expose, ...(process.env.YOUI_CHROMIUM ? { executablePath: process.env.YOUI_CHROMIUM } : {}) });
  const file = await writeReport(report, out);
  if (values.json) json(report);
  else {
    const shown = relative(process.cwd(), file);
    print(renderDetect(report, shown && !shown.startsWith("..") ? shown : file));
  }
  return 0;
}

/** `youiyoux render`: files are named from the current directory, components by name. Exit 1 only when nothing could be drawn. */
async function cmdRender(values: Values, positionals: string[], io: CliIo): Promise<number> {
  const root = resolve(values.root ?? values.project ?? process.cwd());
  const targets = positionals.map((t) => (existsSync(resolve(t)) ? resolve(t) : t));
  try {
    const report = await renderShots(root, targets, { ...(values.base ? { base: values.base } : {}), ...(process.env.YOUI_CHROMIUM ? { executablePath: process.env.YOUI_CHROMIUM } : {}), ...io.render });
    if (values.json) json({ ...report, next: shotsNext(report, (t) => `run youiyoux render${t ? ` ${t}` : ""} again`) });
    else print(renderShotsText(report));
    return targets.length > 0 && report.components.every((c) => c.shots.length === 0) ? 1 : 0;
  } catch (error: unknown) {
    if (!(error instanceof RenderUnavailableError)) throw error;
    process.stderr.write(`${style.error("✖")} youiyoux render could not run: ${error.message}. Nothing was checked; this is not a pass.\n`);
    return 1;
  }
}

/** The configured project, if any, and the product's root: the project's (a config may sit beside the design repo and name it), else the one named. */
async function product(values: Values): Promise<{ project: Project | null; root: string }> {
  const project = await loadProject(resolve(values.project ?? process.cwd()), loadOptions(values)).catch(() => null);
  return { project, root: project?.root ?? resolve(values.root ?? values.project ?? process.cwd()) };
}

/** `youiyoux requests`: the requests on the project's screens, as an agent reads and answers them. */
async function cmdRequests(values: Values, positionals: string[]): Promise<number> {
  const usage = "youiyoux requests [--status open|addressed|closed|all] [--route r]   or   youiyoux requests show <id> | reply <id> --message <text> | addressed <id> --message <what you changed>";
  const [action, id, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(usage);
  const { RequestStore, requestBrief } = await import("@youiyoux/workflow");
  const { project, root } = await product(values);
  const store = new RequestStore(root, project?.config.id ?? basename(root));
  const agent = { kind: "agent", name: "youiyoux CLI" } as const;
  const one = (request: Parameters<typeof requestBrief>[0]): number => {
    const brief = requestBrief(request, root);
    if (values.json) json(brief);
    else print(renderBrief(brief, true));
    return 0;
  };
  if (!action || action === "list") {
    if (id) throw new UsageError(usage);
    const status = values.status ?? "open";
    if (!["open", "addressed", "closed", "all"].includes(status)) throw new UsageError("--status takes open, addressed, closed or all");
    const { requests, unreadable } = await store.list();
    const briefs = requests.filter((r) => (status === "all" || r.status === status) && (!values.route || r.target.route === values.route)).map((r) => requestBrief(r, root));
    if (values.json) json({ requests: briefs, unreadable });
    else print(renderRequests(briefs, status, unreadable));
    return unreadable.length ? 1 : 0;
  }
  if (!id) throw new UsageError(usage);
  if (action === "show") return one(await store.get(id));
  if (action === "reply" || action === "addressed") {
    if (!values.message?.trim()) throw new UsageError(`youiyoux requests ${action} ${id} --message <${action === "reply" ? "text" : "what you changed, with file:line"}>`);
    return one(action === "reply" ? await store.reply(agent, id, values.message) : await store.setStatus(agent, id, "addressed", values.message));
  }
  throw new UsageError(usage);
}

/** `youiyoux screens capture`: the project's screens photographed, each component placed with its line. */
async function cmdScreens(values: Values, positionals: string[], io: CliIo): Promise<number> {
  const usage = "youiyoux screens capture --base <url of the app in development> [--route <one route>] [--project dir] [--out <screens dir>] [--storage-state <signed-in session>] [--json]   or   youiyoux screens login --base <url> [--project dir] [--storage-state <file>]";
  if (!["capture", "login"].includes(positionals[0] ?? "") || positionals.length > 1 || !values.base) throw new UsageError(usage);
  const { root } = await product(values);
  if (positionals[0] === "login") return screensLogin(values.base, values["storage-state"] ? resolve(values["storage-state"]) : sessionFile(root), io);
  const dir = resolve(values.out ?? join(root, ".youi/screens"));
  if (!existsSync(join(dir, "screens.json"))) {
    process.stderr.write(`${style.error("✖")} no screens.json in ${dir}: list the routes to capture there, as {"schema":"youiyoux.screens/v1","project":"<name>","source":"<what the app is>","capturedAt":"","viewport":{"width":1440,"height":900},"screens":[{"route":"/","path":"/"}]}\n`);
    return 1;
  }
  const session = chosenSession(root, values["storage-state"] ? resolve(values["storage-state"]) : undefined);
  if (session?.saved) process.stderr.write(`${style.dim(`signed in with the session youiyoux screens login saved (${session.file}); delete it to capture signed out`)}\n`);
  const { launchBrowser } = await import("@youiyoux/detect");
  const browser = await launchBrowser(process.env.YOUI_CHROMIUM, { purpose: { what: "youiyoux screens capture", command: "youiyoux screens capture" } });
  try {
    const report = await captureScreens(dir, { base: values.base, root, browser, ...(values.route ? { routes: [values.route] } : {}), ...(session ? { storageState: session.file } : {}), log: (line) => process.stderr.write(`${style.dim(line)}\n`) });
    if (values.json) json(report);
    else print(captureText(report));
    return report.screens.every((s) => s.error) ? 1 : 0;
  } finally {
    await browser.close();
  }
}

/** `youiyoux screens login`: a window a person signs in with, then the session kept for capture. */
async function screensLogin(base: string, file: string, io: CliIo): Promise<number> {
  const login = io.login ?? {};
  if (!login.browser && !process.stdin.isTTY) {
    process.stderr.write(`${style.error("✖")} youiyoux screens login waits for you to sign in and press Enter: run it in a terminal\n`);
    return 1;
  }
  let browser: LoginBrowser;
  try {
    browser = login.browser ?? (await openLoginBrowser(process.env.YOUI_CHROMIUM));
  } catch (error: unknown) {
    process.stderr.write(`${style.error("✖")} youiyoux screens login opens a browser window to sign in with, and could not: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}. It needs Google Chrome installed, or YOUI_CHROMIUM set to a Chromium.\n`);
    return 1;
  }
  try {
    print(`Sign in to ${base} in the window that opened, then press Enter here (or type q and Enter to give up).`);
    const signedIn = login.signedIn ?? (async (page: LoginPage) => {
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new Promise<string>((done) => page.once("close", () => done("closed")));
      try {
        return (await Promise.race([prompt.question(""), closed])).trim().toLowerCase() !== "q";
      } finally {
        prompt.close();
      }
    });
    const result = await recordSession({ base, file, browser, signedIn });
    if (!result.file) {
      print("Nothing was saved: the window was closed, or you gave up. Run youiyoux screens login again to sign in.");
      return 1;
    }
    print(`Saved the session (${result.cookies} cookies, storage for ${result.origins} sites) to ${result.file}, readable only by you: it holds your sign-in, so it is kept outside the product.`);
    print("Next: youiyoux screens capture --base <url> uses it from now on; delete the file to capture signed out.");
    return 0;
  } finally {
    if (!login.browser) await browser.close();
  }
}

/** `youiyoux report [path]`: the zero-setup report (what `npx youiyoux` runs). */
async function cmdReport(values: Values, positionals: string[], io: CliIo): Promise<number> {
  if (positionals.length > 1) throw new UsageError("youiyoux report [path] [--out dir] [--render [--yes]] [--include-code] [--json]   (one repo)");
  const result = await runReport({ ...(positionals[0] ? { path: positionals[0] } : {}), ...(values.out ? { out: values.out } : {}), render: values.render, yes: values.yes, includeCode: values["include-code"], json: values.json }, io.report ?? {});
  return result.code;
}

async function cmdMcp(values: Values): Promise<number> {
  const { startStdioServer } = await import("@youiyoux/mcp");
  await startStdioServer({ projectRoot: values.project ?? process.cwd(), ...loadOptions(values), ...(values.cache ? { discoverCache: values.cache } : {}) });
  return -1;
}

/** What a command may be handed instead of the real thing: tests pass recorded network answers. */
interface CliIo {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly fetcher?: Fetcher;
  /** Per-request timeout for `discover sync` (default 15 s). */
  readonly timeoutMs?: number;
  /** `youiyoux render`: tests count renders and never download Chromium. */
  readonly render?: Pick<ShotsOptions, "stats" | "download" | "cache">;
  /** `youiyoux report`: tests answer the download question and stand in for the download. */
  readonly report?: ReportIo;
  /** `youiyoux screens login`: tests hand it a browser and sign in for the person. */
  readonly login?: { readonly browser?: LoginBrowser; readonly signedIn?: (page: LoginPage) => Promise<boolean> };
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`${flag} takes a whole number`);
  return n;
}

async function cmdDiscover(values: Values, positionals: string[], io: CliIo): Promise<number> {
  const cacheDir = resolve(discoverCacheDir(values.cache));
  const { path, home } = indexOf(values);
  const catalog = () => readCatalog(cacheDir, path);
  const [action, ...rest] = positionals;
  if (action === "sources") {
    const names = await selectSources(cacheDir, rest[0], rest[1]);
    if (values.json) json(names); else print(names.join("\n"));
    return 0;
  }
  if (action === "sync") {
    const maxRegistries = positiveInt(values["max-registries"], "--max-registries");
    // The token goes into request headers and nowhere else: not the index, not the output.
    const token = process.env.GITHUB_TOKEN || undefined;
    const summary = await syncIndex({ ...(io.sleep ? { sleep: io.sleep } : {}), cacheDir, icons: values.icons ?? false, ...(io.fetcher ? { fetcher: io.fetcher } : {}), ...(io.timeoutMs ? { timeoutMs: io.timeoutMs } : {}), ...(token ? { token } : {}), ...(maxRegistries !== undefined ? { maxRegistries } : {}) });
    const loaded = await ingestCatalog(await sharedStore(path), cacheDir);
    await noteSource(home, { discover: cacheDir });
    if (values.json) json(summary);
    else print(`${renderDiscoverSync(summary)}\n${style.dim(`store → ${storeLocation({ path })} (${plural(loaded.chosen, "listing")})`)}`);
    return 0;
  }
  if (action === "previews") {
    if (rest.length > 0) throw new UsageError("youiyoux discover previews [--port n] [--registry @shadcn|all] [--role r] [--limit n] [--force]");
    positiveInt(values.limit, "--limit");
    return runPreviews(TOOL_ROOT, { ...(values.port ? { port: values.port } : {}), ...(values.registry ? { registry: values.registry } : {}), ...(values.role ? { role: values.role } : {}), ...(values.limit ? { limit: values.limit } : {}), ...(values.cache ? { cache: values.cache } : {}), force: values.force });
  }
  if (action === "show") {
    if (!rest[0]) throw new UsageError("youiyoux discover show <id|ref>");
    if (values.source) {
      json(await candidateSource(cacheDir, rest.join(" "), io));
      return 0;
    }
    const shown = await showFromCatalog(await catalog(), rest.join(" "));
    if (values.json) json(shown);
    else print(renderDiscoverShow(shown));
    return 0;
  }
  const need = positionals.join(" ").trim();
  if (!need) throw new UsageError("youiyoux discover \"<need>\" [--role r] [--json]   or   youiyoux discover sync   or   youiyoux discover show <id>");
  const licenses = values.license?.split(",").map((l) => l.trim()).filter(Boolean);
  if (values.all) {
    await expandAll(cacheDir, { ...io, icons: values.icons ?? false });
    await ingestCatalog(await sharedStore(path), cacheDir);
    await noteSource(home, { discover: cacheDir });
  }
  const result = await searchCatalog(await catalog(), need, { ...(values.role ? { role: values.role } : {}), ...(licenses?.length ? { constraints: { licenses } } : {}), limit: positiveInt(values.limit, "--limit") ?? 10, offset: positiveInt(values.offset, "--offset") ?? 0, all: values.all, facets: true });
  if (values.json) json(result);
  else print(renderDiscoverSearch(result));
  return 0;
}

type Command = (values: Values, positionals: string[], io: CliIo) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  link: cmdLink, unlink: cmdUnlink, show: cmdShow, where: cmdWhere, bom: cmdBom, check: cmdCheck, baseline: cmdBaseline, rules: cmdRules, plan: cmdPlan, migrate: cmdMigrate, init: cmdInit, sync: cmdSync, scan: cmdScan, watch: cmdWatch, hooks: cmdHooks, agents: cmdAgents, mcp: cmdMcp, ui: cmdUi, library: cmdLibrary, discover: cmdDiscover, index: cmdIndex, report: cmdReport, render: cmdRender, screens: cmdScreens, requests: cmdRequests, detect: cmdDetect, build: cmdBuild, parity: cmdParity, schema: cmdSchema,
};

/** Every command name, for a front end that runs one by default (the youiyoux bin runs report). */
export const COMMAND_NAMES: readonly string[] = [...Object.keys(COMMANDS), "inventory", "gaps", "help"];

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  let parsed;
  try {
    if (argv[0] === "inventory" || argv[0] === "gaps") {
      const inventory = parseArgs({ args: argv, options: INVENTORY_OPTIONS, allowPositionals: true });
      if (!inventory.values.help) return await guarded(() => (argv[0] === "gaps" ? cmdGaps(inventory.values) : cmdInventory(inventory.values)));
    }
    parsed = parseArgs({ args: diffArgs(argv), options: OPTIONS, allowPositionals: true });
  } catch (error: unknown) {
    process.stderr.write(`${style.error("✖")} ${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (!command || parsed.values.help || command === "help") {
    print(HELP);
    return command || parsed.values.help ? 0 : 2;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`${style.error("✖")} unknown command "${command}"\n\n${HELP}\n`);
    return 2;
  }
  return guarded(() => handler(located(command, parsed.values), rest, io));
}

/** Commands that work on a product, and on a design repo: each runs from anywhere inside one, as git does. */
const IN_A_PRODUCT = new Set(["link", "unlink", "show", "where", "bom", "check", "baseline", "rules", "plan", "migrate", "sync", "scan", "watch", "hooks", "agents", "mcp", "ui", "library", "render", "screens", "requests"]);
const IN_A_DESIGN_REPO = new Set(["build", "parity"]);

/**
 * The command's values with the project (or design repo) it runs on, when no option names one:
 * the nearest directory from here upward, inside this git repository, that holds
 * youi.project.json (or youi.config.json). Found nowhere, the current directory stays the default.
 */
export function located(command: string, values: Values, cwd = process.cwd()): Values {
  if (IN_A_PRODUCT.has(command) && values.project === undefined && values.config === undefined && values.root === undefined) {
    const found = findUp(cwd, PROJECT_FILE);
    if (found !== null) return { ...values, project: found };
  }
  if (IN_A_DESIGN_REPO.has(command) && values.design === undefined) {
    const found = findUp(cwd, DESIGN_CONFIG_FILE);
    if (found !== null) return { ...values, design: found };
  }
  return values;
}

/** Run a command, turning its failure into a message and an exit code. */
async function guarded(command: () => Promise<number>): Promise<number> {
  try {
    return await command();
  } catch (error: unknown) {
    if (error instanceof UsageError) process.stderr.write(`${style.error("✖")} usage: ${error.message}\n`);
    else if (error instanceof DefinitionError) process.stderr.write(`${style.error("✖")} invalid definition ${error.file}\n${error.issues.map((i) => `  · ${i}`).join("\n")}\n`);
    else process.stderr.write(`${style.error("✖")} ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
