/** `youi`: the YouIyouX command line. */
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { parse as parseYaml } from "yaml";
import { DefinitionError, findFiles, getSystem, loadDesignRepo, MigrationSpec, OutputConfig, renderJsonSchemas, writeFileAtomic } from "@youiyoux/core";
import { buildTokens, compareParity } from "@youiyoux/tokens";
import { checkCapabilities, componentCard, evaluateRule, failedChecks, findContract, loadProject, planChange, ruleCapability, runMigration, scanProject, screenBom, whereUsed, type PlanInput, type Project } from "@youiyoux/scanner";
import { runHub } from "./hub.ts";
import { initProject } from "./init.ts";
import { renderBom, renderCheck, renderMigration, renderPlan, renderRulePreview, renderRules, renderScan, renderShow, renderSync, renderWhere } from "./render.ts";
import { syncProject, verifyLock, verifyWiring } from "./sync.ts";
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
  check [files…] [--rule id] [--quiet]   rule violations and lockfile drift; exits 1 on errors
  plan <component> --patch <json|file>    classify a contract change and show its impact
  plan --token <id> [--value v]           impact of a token change
  migrate <migration.yaml> [--write] [--diff]   gated codemod; dry run unless --write
  rules [--preview <rule.yaml>]   whether each rule is checked; preview a draft rule on the current scan
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
  preview: { type: "string" },
  quiet: { type: "boolean", default: false },
  patch: { type: "string" },
  token: { type: "string" },
  value: { type: "string" },
  write: { type: "boolean", default: false },
  check: { type: "boolean", default: false },
  diff: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
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

const print = (text: string): void => void process.stdout.write(`${text}\n`);
const json = (value: unknown): void => print(JSON.stringify(value, null, 2));

async function project(values: Values): Promise<Project> {
  return loadProject(values.project ?? process.cwd(), { ...(values.config ? { configPath: values.config } : {}), ...(values.design ? { designRoot: values.design } : {}) });
}

async function scannedFiles(p: Project): Promise<string[]> {
  return findFiles(p.root, p.config.include, p.config.exclude);
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

async function cmdCheck(values: Values, positionals: string[]): Promise<number> {
  const p = await project(values);
  const { report } = await scanProject(p);
  const only = new Set(positionals.map((f) => relative(p.root, resolve(f)).split(sep).join("/")));
  const scanned = new Set([...report.usages.map((u) => u.file), ...report.violations.map((v) => v.file), ...(await scannedFiles(p))]);
  const unmatched = [...only].filter((f) => !scanned.has(f));
  const failedHere = report.coverage.failed.filter((f) => only.size === 0 || only.has(f.file) || !f.file.match(/\.(tsx?|css)$/));
  const wantedRule = (id: string): boolean => !values.rule || id.endsWith(`/rule/${values.rule}`);
  const violations = report.violations.filter((v) => (only.size === 0 || only.has(v.file)) && wantedRule(v.rule) && (!values.quiet || v.severity === "error"));
  const notRun = failedChecks(report.checks).filter((c) => wantedRule(c.rule));
  const lock = await verifyLock(p);
  const lockIssues = lock === null ? null : [...lock, ...(await verifyWiring(p))];
  const errors = violations.filter((v) => v.severity === "error").length + (lockIssues ?? []).filter((i) => i.severity === "error").length;
  // A clean result only counts when everything asked about was actually checked.
  const incomplete = unmatched.length > 0 || failedHere.length > 0 || notRun.length > 0;
  if (values.json) json({ errors, incomplete, unmatched, notRun, violations, lock: lockIssues, suppressed: report.suppressed, coverage: report.coverage, status: report.status, checks: report.checks });
  else {
    print(renderCheck(violations, lockIssues, report, report.suppressed));
    for (const file of unmatched) print(style.error(`✖ ${file} was not checked: it is not in this project's include globs (or does not exist)`));
    if (failedHere.length > 0) print(style.warn(`! incomplete: ${failedHere.map((f) => f.file).join(", ")} could not be fully analysed, so 0 errors there is not a pass`));
  }
  return errors > 0 || incomplete ? 1 : 0;
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

async function cmdUi(values: Values): Promise<number> {
  return runHub(TOOL_ROOT, { ...(values.design ? { design: values.design } : {}), ...(values.project ? { project: values.project } : {}), ...(values.config ? { config: values.config } : {}), ...(values.port ? { port: values.port } : {}) });
}

async function cmdMcp(values: Values): Promise<number> {
  const { startStdioServer } = await import("@youiyoux/mcp");
  await startStdioServer({ projectRoot: values.project ?? process.cwd(), ...(values.config ? { configPath: values.config } : {}), ...(values.design ? { designRoot: values.design } : {}) });
  return -1;
}

const COMMANDS: Record<string, (values: Values, positionals: string[]) => Promise<number>> = {
  init: cmdInit, sync: cmdSync, scan: cmdScan, show: cmdShow, where: cmdWhere, bom: cmdBom, check: cmdCheck, rules: cmdRules, plan: cmdPlan, migrate: cmdMigrate, mcp: cmdMcp, ui: cmdUi, build: cmdBuild, parity: cmdParity, schema: cmdSchema,
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
