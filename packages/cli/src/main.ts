/** `youi`: the YouIyouX command line. */
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs, promisify, type ParseArgsConfig } from "node:util";
import { parse as parseYaml } from "yaml";
import { DefinitionError, getSystem, loadDesignRepo, MigrationSpec, OutputConfig, renderJsonSchemas, writeFileAtomic } from "@youiyoux/core";
import { buildTokens, compareParity } from "@youiyoux/tokens";
import { componentCard, describeIdentity, findContract, ProjectWatcher, type CacheStats, type WatchUpdate, loadProject, planChange, runMigration, scanProject, screenBom, whereUsed, type PlanInput, type Project } from "@youiyoux/scanner";
import { baselinePath, exitCodeOf, runCheck, writeBaseline, type CheckResult } from "./check.ts";
import { actionable, githubAnnotations, githubSummary, renderCheckText } from "./check-render.ts";
import { runClaudeHook, runPreCommitHook, type HookTarget } from "./hooks.ts";
import { hookCommand, installClaudeHook, installPreCommit, installWorkflow, repoRootOf } from "./hooks-install.ts";
import { runHub } from "./hub.ts";
import { initProject } from "./init.ts";
import { renderBom, renderMigration, renderPlan, renderScan, renderShow, renderSync, renderWhere } from "./render.ts";
import { syncProject } from "./sync.ts";
import { ms, plural, style } from "./ui.ts";

/** This tool's own checkout: the published JSON Schemas live here. Design systems live in their own repos. */
const TOOL_ROOT = resolve(import.meta.dirname, "../../..");

const HELP = `${style.accent("youi")} ${style.dim("· YouIyouX design language")}

${style.bold("Usage")}  youi <command> [options]

${style.bold("In a product repo")}
  init --design <dir>      write youi.project.json pointing at a design repo checkout, then sync
  sync [--dry-run] [--adopt]   tokens, DESIGN.md, skill, AGENTS.md block, owned components (3-way merge), lockfile
  scan [--out file]        build the usage map (default .youi/usage.json)
  show <component>         the contract: import, legal prop values, guidance, examples
  where <component> [--route r] [--all]   where a component lives, screen by screen
  bom <route>              everything on one screen
  check [files…] [--rule id] [--quiet] [--baseline] [--format text|json|github]
                           rule violations and lockfile drift; exits 1 on errors or an incomplete check.
                           --baseline fails only on violations the baseline does not accept;
                           --format github annotates PR lines and writes the job summary
  baseline [--force]       record existing violations (youi.baseline.json beside the config);
                           later runs only remove fixed ones; --force accepts current ones as debt
  watch [--baseline] [--json]   re-check on every save (debounced; only edited files and their
                           importers are re-analysed; definition changes reload the rules)
  hooks install [--claude] [--git] [--ci] [--strict]
                           live checks, existing config kept (default: --claude --git):
                           Claude Code PostToolUse (advisory context after each edit),
                           git pre-commit (advisory on staged files; --strict blocks new errors),
                           CI workflow (authoritative, pinned rules version, PR annotations)
  plan <component> --patch <json|file>    classify a contract change and show its impact
  plan --token <id> [--value v]           impact of a token change
  migrate <migration.yaml> [--write] [--diff]   gated codemod; dry run unless --write
  mcp                      stdio MCP server (read tools + plan)

${style.bold("The hub")}
  ui [--design dir] [--project dir] [--config file] [--port n]
                           open the web hub on a design system (default: the demo system);
                           --project adds that product's usage map (read-only scan)

${style.bold("In a design repo")} ${style.dim("(the current directory, or --design)")}
  build [--out dir] [--prefix p]   build token outputs
  parity --css <file> [--prefix p] [--light sel] [--dark sel]   generated CSS vs a project's shipped CSS

${style.bold("In this tool's repo")}
  schema [--write|--check] emit JSON Schemas from the Zod definitions; --design writes or checks a design repo's schema/

${style.bold("Options")}
  --project <dir>   project root (default: current directory)
  --config <file>   project config (default: <project>/youi.project.json)
  --design <dir>    design repo checkout, the directory holding youi.config.json
                    (default: source.path from the project config; the current directory for build and parity)
  --json            machine-readable output`;

const OPTIONS = {
  project: { type: "string" },
  config: { type: "string" },
  design: { type: "string" },
  json: { type: "boolean", default: false },
  out: { type: "string" },
  route: { type: "string" },
  all: { type: "boolean", default: false },
  limit: { type: "string" },
  rule: { type: "string" },
  quiet: { type: "boolean", default: false },
  patch: { type: "string" },
  token: { type: "string" },
  value: { type: "string" },
  write: { type: "boolean", default: false },
  check: { type: "boolean", default: false },
  diff: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  baseline: { type: "boolean", default: false },
  claude: { type: "boolean", default: false },
  git: { type: "boolean", default: false },
  ci: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
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
  dark: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} satisfies ParseArgsConfig["options"];

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

const run = promisify(execFile);
const print = (text: string): void => void process.stdout.write(`${text}\n`);
const json = (value: unknown): void => print(JSON.stringify(value, null, 2));

async function project(values: Values): Promise<Project> {
  return loadProject(values.project ?? process.cwd(), { ...(values.config ? { configPath: values.config } : {}), ...(values.design ? { designRoot: values.design } : {}) });
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
  if (values.json) json(report);
  else print(renderScan(report, out));
  return 0;
}

async function cmdWhere(values: Values, positionals: string[]): Promise<number> {
  const query = positionals[0];
  if (!query) throw new UsageError("youi where <component>");
  const p = await project(values);
  const { report } = await scanProject(p);
  const limit = values.all ? Number.MAX_SAFE_INTEGER : Number(values.limit ?? (values.json ? 20 : 24));
  const where = whereUsed(p, report, query, { ...(values.route ? { route: values.route } : {}), limit });
  if (values.json) json(where);
  else print(renderWhere(where, report, where.sites));
  return 0;
}

async function cmdShow(values: Values, positionals: string[]): Promise<number> {
  const query = positionals[0];
  if (!query) throw new UsageError("youi show <component>");
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
  if (!route) throw new UsageError("youi bom <route>");
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

/** The project's path inside its repository (`apps/web/`), so annotations land on the right file. */
async function repoPrefix(root: string): Promise<string> {
  try {
    return (await run("git", ["rev-parse", "--show-prefix"], { cwd: root })).stdout.trim();
  } catch {
    return "";
  }
}

async function cmdCheck(values: Values, positionals: string[]): Promise<number> {
  const p = await project(values);
  const format = values.json ? "json" : (values.format ?? "text");
  if (!["text", "json", "github"].includes(format)) throw new UsageError("youi check --format text|json|github");
  const result = await runCheck(p, { ...(positionals.length > 0 ? { files: positionals } : {}), ...(values.rule ? { rule: values.rule } : {}), quiet: values.quiet, baseline: baselineFile(values, p) });
  if (format === "json") {
    const { report } = result.scan;
    json({ errors: result.errors, incomplete: result.incomplete, identity: result.identity, unmatched: result.unmatched, violations: result.violations, baseline: result.baseline, lock: result.lock, suppressed: report.suppressed, coverage: report.coverage, status: report.status });
  } else if (format === "github") {
    for (const line of githubAnnotations(result, await repoPrefix(p.root))) print(line);
    print(renderCheckText(result));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, githubSummary(result));
  } else print(renderCheckText(result));
  return exitCodeOf(result);
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
  else throw new UsageError("youi plan <component> --patch <json|file>   or   youi plan --token <id> [--value v]");
  const plan = await planChange(p, scan, input);
  if (values.json) json(plan);
  else print(renderPlan(plan));
  return 0;
}

async function cmdMigrate(values: Values, positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (!file) throw new UsageError("youi migrate <migration.yaml> [--write]");
  const spec = MigrationSpec.parse(parseYaml(await readFile(file, "utf8")));
  const result = await runMigration(await project(values), spec, { write: values.write });
  if (values.json) json(result);
  else print(renderMigration(result, values.diff));
  return result.status === "rejected" ? 1 : 0;
}

async function cmdSync(values: Values): Promise<number> {
  const p = await project(values);
  const result = await syncProject(p, { dryRun: values["dry-run"], adopt: values.adopt });
  if (values.json) json(result);
  else print(renderSync(result.actions, values["dry-run"]));
  return result.actions.some((a) => a.action === "conflict") ? 1 : 0;
}

async function cmdInit(values: Values): Promise<number> {
  if (!values.design) throw new UsageError("youi init --design <dir>   (a design repo checkout, the directory holding youi.config.json)");
  const root = values.project ?? process.cwd();
  const result = await initProject({ root, design: values.design, schemaDir: join(TOOL_ROOT, "schema"), ...(values.system ? { system: values.system } : {}), ...(values.components ? { componentsDir: values.components } : {}), force: values.force });
  if (!values.json) {
    print(`${style.ok("created")} ${result.file}`);
    for (const note of result.notes) print(style.dim(`  · ${note}`));
    print("");
  }
  return cmdSync({ ...values, project: root });
}

async function cmdBuild(values: Values): Promise<number> {
  const root = resolve(values.design ?? process.cwd());
  const system = getSystem(await loadDesignRepo(root), values.system);
  const output = OutputConfig.parse({ cssVarPrefix: values.prefix ?? "youi", targets: ["css-vars", "tailwind-v4", "ts", "react-native"] });
  const started = performance.now();
  const built = await buildTokens(root, system.config, output);
  const out = resolve(values.out ?? join(root, "build", system.config.id));
  for (const file of built.files) await writeFileAtomic(join(out, file.path), file.content);
  if (values.json) json({ out, files: built.files.map((f) => f.path), tokens: built.tokens.length });
  else print(`${style.ok("built")} ${plural(built.tokens.length, "token")} → ${built.files.map((f) => f.path).join(", ")} ${style.dim(`in ${out} (${ms(performance.now() - started)})`)}`);
  return 0;
}

async function cmdParity(values: Values): Promise<number> {
  if (!values.css) throw new UsageError("youi parity --css <file> [--prefix p]");
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
    else print(stale.length === 0 ? `${style.ok("✓")} ${dir} matches this youi's schemas` : `${style.error("✖")} out of date in ${dir}: ${stale.join(", ")}; run youi schema --write${values.design ? " --design <dir>" : ""}`);
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
  return { ...(values.project ? { project: values.project } : {}), ...(values.config ? { config: values.config } : {}), ...(values.design ? { design: values.design } : {}) };
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
  if (action !== "install") throw new UsageError("youi hooks install [--claude] [--git] [--ci] [--strict]   or   youi hooks run claude|pre-commit");
  const p = await project(values);
  const target = { ...hookTarget(values), project: p.root };
  const all = !values.claude && !values.git && !values.ci;
  const results = [];
  if (values.claude || all) results.push({ kind: "Claude Code", ...(await installClaudeHook(await repoRootOf(p.root), hookCommand(TOOL_ROOT, "claude", target))) });
  if (values.git || all) results.push({ kind: "git pre-commit", ...(await installPreCommit(p.root, hookCommand(TOOL_ROOT, "pre-commit", target, values.strict ? ["--strict"] : []), values.strict)) });
  if (values.ci) results.push({ kind: "CI", ...(await installWorkflow(p, TOOL_ROOT, target, values.force)) });
  if (values.json) json(results);
  else for (const r of results) print(`${r.action === "unchanged" ? style.dim("unchanged") : style.ok(r.action)} ${r.kind}: ${r.file}
  ${style.dim(r.guarantee)}`);
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
  const load = { ...(values.config ? { configPath: values.config } : {}), ...(values.design ? { designRoot: values.design } : {}) };
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

async function cmdUi(values: Values): Promise<number> {
  return runHub(TOOL_ROOT, { ...(values.design ? { design: values.design } : {}), ...(values.project ? { project: values.project } : {}), ...(values.config ? { config: values.config } : {}), ...(values.port ? { port: values.port } : {}) });
}

async function cmdMcp(values: Values): Promise<number> {
  const { startStdioServer } = await import("@youiyoux/mcp");
  await startStdioServer({ projectRoot: values.project ?? process.cwd(), ...(values.config ? { configPath: values.config } : {}), ...(values.design ? { designRoot: values.design } : {}) });
  return -1;
}

const COMMANDS: Record<string, (values: Values, positionals: string[]) => Promise<number>> = {
  init: cmdInit, sync: cmdSync, scan: cmdScan, show: cmdShow, where: cmdWhere, bom: cmdBom, check: cmdCheck, baseline: cmdBaseline, hooks: cmdHooks, watch: cmdWatch, plan: cmdPlan, migrate: cmdMigrate, mcp: cmdMcp, ui: cmdUi, build: cmdBuild, parity: cmdParity, schema: cmdSchema,
};

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
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
  try {
    return await handler(parsed.values, rest);
  } catch (error: unknown) {
    if (error instanceof UsageError) process.stderr.write(`${style.error("✖")} usage: ${error.message}\n`);
    else if (error instanceof DefinitionError) process.stderr.write(`${style.error("✖")} invalid definition ${error.file}\n${error.issues.map((i) => `  · ${i}`).join("\n")}\n`);
    else process.stderr.write(`${style.error("✖")} ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
