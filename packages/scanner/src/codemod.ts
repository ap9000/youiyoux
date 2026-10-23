/**
 * Migrations compiled to edits, with fail-closed invariant gates.
 *
 * Only sites the scanner resolved to the element are edited (never "every JSX
 * tag named Button"). Values the spec cannot map deterministically become
 * residuals for a person or agent. Renamed and removed exports run first, as an
 * import pass (import-rewrite.ts); props are then planned on a rescan of the
 * import-rewritten sources. Nothing is written unless every gate holds on the
 * rewritten sources, checked in memory first:
 *   exports       the element's file exports every new name (`youiyoux sync` has run); import changes only
 *   parse-errors  no new tree-sitter ERROR nodes in any touched file
 *   usage-count   the element's usage count is unchanged (± the spec's declared delta, + sites the
 *                 import pass makes resolvable again)
 *   unknowns      no site became unresolvable
 *   old-api       no non-residual site still uses a removed prop, value or export name
 *   idempotent    running the migration again (both passes) changes nothing
 * A codemod that "succeeds" proves nothing; these gates are what make it safe.
 */
import type { Edit, SgNode } from "@ast-grep/napi";
import { readTextOrNull, unifiedDiff, writeFileAtomic, type MigrationSpec } from "@youiyoux/core";
import { isAbsolute, join, relative, resolve } from "node:path";
import { exportChanges, exportedNames, planImports, type ImportPlan } from "./import-rewrite.ts";
import { verifyImports } from "./import-verification.ts";
import { countParseErrors, unquote } from "./parse.ts";
import type { Project } from "./project.ts";
import { scanProject, type ScanResult } from "./scan.ts";

export type GateName = "coverage" | "exports" | "imports-resolve" | "parse-errors" | "usage-count" | "unknowns" | "old-api" | "idempotent" | "sources-unchanged";

export interface GateResult {
  readonly name: GateName;
  readonly ok: boolean;
  readonly detail: string;
}

export interface Residual {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
}

export interface FileChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
}

export interface MigrationResult {
  readonly migration: string;
  readonly element: string;
  readonly status: "applied" | "dry-run" | "rejected" | "noop";
  readonly sitesBefore: number;
  readonly sitesAfter: number;
  readonly edited: number;
  readonly residuals: readonly Residual[];
  readonly changes: readonly FileChange[];
  readonly gates: readonly GateResult[];
  readonly keptBarrels: ImportPlan["keptBarrels"];
}

export interface MigrationOptions {
  /** Write files when every gate passes (default: dry run). */
  readonly write?: boolean;
  /** How a mapped string literal is rewritten; injectable so tests can prove the gates catch a broken codemod. */
  readonly rewriteValue?: (quoted: string, from: string, to: string) => string;
}

const keepQuotes = (quoted: string, _from: string, to: string): string => `${quoted[0]}${to}${quoted.at(-1)}`;

interface Planned {
  readonly outputs: Map<string, string>;
  readonly edited: number;
  readonly residuals: Residual[];
}

function attributes(element: SgNode): Map<string, SgNode> {
  const map = new Map<string, SgNode>();
  for (const child of element.children()) {
    if (child.kind() !== "jsx_attribute") continue;
    const name = child.children()[0];
    if (name) map.set(name.text(), child);
  }
  return map;
}

function valueOf(attribute: SgNode): SgNode | undefined {
  return attribute.children().filter((c) => c.kind() !== "=")[1];
}

/** String nodes the map may rewrite: a literal, `{"x"}`, or a ternary of literals. Null when the value is not literal. */
function mappableStrings(value: SgNode): SgNode[] | null {
  if (value.kind() === "string") return [value];
  if (value.kind() !== "jsx_expression") return null;
  const inner = value.children().find((c) => c.isNamed());
  if (!inner) return null;
  if (inner.kind() === "string") return [inner];
  if (inner.kind() === "ternary_expression") {
    const branches = [inner.field("consequence"), inner.field("alternative")];
    return branches.every((b) => b?.kind() === "string") ? (branches as SgNode[]) : null;
  }
  return null;
}

/** The prop pass. Sites in `held` files (an ambiguous import rewrite there) are never edited: a site that needs an edit becomes a residual. */
function planEdits(migration: MigrationSpec, scan: ScanResult, rewriteValue: NonNullable<MigrationOptions["rewriteValue"]>, held: ReadonlyMap<string, string>): Planned {
  const contract = scan.elements.contracts.get(migration.element);
  const outputs = new Map<string, string>();
  const residuals: Residual[] = [];
  let edited = 0;
  if (!contract) return { outputs, edited, residuals };
  const sites = scan.report.usages.filter((u) => u.element === migration.element && u.kind === "render" && u.export === contract.source.export);
  const byFile = Map.groupBy(sites, (site) => site.file);
  for (const [file, fileSites] of byFile) {
    const module = scan.modules.get(file);
    if (!module) continue;
    const nodes = new Map(module.jsx.map((el) => [`${el.line}:${el.column}`, el.node]));
    const edits: Edit[] = [];
    for (const site of fileSites) {
      const element = nodes.get(`${site.line}:${site.column}`);
      const where = { file, line: site.line, column: site.column };
      if (!element) {
        residuals.push({ ...where, reason: "site not found in the parsed file" });
        continue;
      }
      const attrs = attributes(element);
      const renamed = new Map<string, SgNode>();
      const before = edits.length;
      if (site.spread) residuals.push({ ...where, reason: "spread props may set a migrated prop; check by hand" });
      for (const change of migration.changes) {
        if ("renameProp" in change) {
          const attr = attrs.get(change.renameProp.from);
          if (!attr) continue;
          if (attrs.has(change.renameProp.to)) {
            residuals.push({ ...where, reason: `both ${change.renameProp.from} and ${change.renameProp.to} are set` });
            continue;
          }
          edits.push(attr.children()[0]!.replace(change.renameProp.to));
          renamed.set(change.renameProp.to, attr);
        } else if ("mapValues" in change) {
          const attr = attrs.get(change.mapValues.prop) ?? renamed.get(change.mapValues.prop);
          const value = attr ? valueOf(attr) : undefined;
          if (!value) continue;
          const strings = mappableStrings(value);
          if (!strings) {
            residuals.push({ ...where, reason: `non-literal ${change.mapValues.prop}={${value.text().slice(1, -1)}}` });
            continue;
          }
          for (const node of strings) {
            const literal = unquote(node.text());
            const target = change.mapValues.map[literal];
            if (target !== undefined) edits.push(node.replace(rewriteValue(node.text(), literal, target)));
          }
        }
        // renameExport and removeExport are the import pass's (import-rewrite.ts), planned before this one.
      }
      const why = held.get(file);
      if (why !== undefined && edits.length > before) {
        residuals.push({ ...where, reason: `not rewritten: ${why}` });
        edits.length = before;
      } else if (edits.length > before) edited++;
    }
    if (edits.length > 0) outputs.set(file, module.root.root().commitEdits(edits));
  }
  return { outputs, edited, residuals: mergeResiduals(residuals) };
}

/** One entry per site, reasons joined, so a person sees each site once. */
function mergeResiduals(residuals: readonly Residual[]): Residual[] {
  const bySite = new Map<string, Residual>();
  for (const r of residuals) {
    const key = `${r.file}:${r.line}:${r.column}`;
    const seen = bySite.get(key);
    bySite.set(key, seen ? { ...seen, reason: `${seen.reason}; ${r.reason}` } : r);
  }
  return [...bySite.values()];
}

function count(scan: ScanResult, element: string, files?: ReadonlySet<string>): number {
  return scan.report.usages.filter((u) => u.element === element && (!files || files.has(u.file))).length;
}

/**
 * How many sites the element should have once the import pass is applied, found by the scanner
 * rather than by the rewrite: a scan of the original sources in which the element's file also
 * exports each old name as an alias of its new one, so every old-name site resolves again. Held
 * files stay as they were, so they keep their count from before.
 */
async function expectedWithImports(project: Project, migration: MigrationSpec, before: ScanResult, imports: ImportPlan): Promise<number> {
  const renames = exportChanges(migration).flatMap((c) => (c.to === null ? [] : [{ from: c.from, to: c.to }]));
  const target = await before.graph.load(imports.target);
  if (renames.length === 0 || imports.outputs.size === 0 || !target) return count(before, migration.element);
  // Each old name joins the contract in its new name's role, so a variants function's calls still count.
  const system = {
    ...project.system,
    components: project.system.components.map(({ contract, ...rest }) => {
      if (contract.id !== migration.element) return { ...rest, contract };
      const variants = renames.filter((r) => contract.aliases.includes(r.to)).map((r) => r.from);
      const parts = renames.filter((r) => !contract.aliases.includes(r.to)).map((r) => r.from);
      return { ...rest, contract: { ...contract, source: { ...contract.source, also: [...contract.source.also, ...parts] }, aliases: [...contract.aliases, ...variants] } };
    }),
  };
  const aliases = `\nexport { ${renames.map((r) => `${r.to} as ${r.from}`).join(", ")} };\n`;
  const whatIf = await scanProject({ ...project, system }, { overrides: { [imports.target]: `${target.source}${aliases}` } });
  const held = new Set(imports.held.keys());
  return count(whatIf, migration.element) - count(whatIf, migration.element, held) + count(before, migration.element, held);
}

/**
 * A site's identity across a rewrite: its file and its order among the element's render sites
 * in that file. Lines and columns move when props are renamed; the order does not (the
 * usage-count gate holds the count fixed).
 */
function siteKeys(scan: ScanResult, element: string): Map<string, string> {
  const keys = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const u of scan.report.usages) {
    if (u.element !== element || u.kind !== "render") continue;
    const n = seen.get(u.file) ?? 0;
    seen.set(u.file, n + 1);
    keys.set(`${u.file}:${u.line}:${u.column}`, `${u.file}#${n}`);
  }
  return keys;
}

/** Site keys still using a prop the migration removes, or a value it maps away. */
function oldApiSites(migration: MigrationSpec, scan: ScanResult): Array<{ key: string; at: string }> {
  const removed = migration.changes.flatMap((c) => ("renameProp" in c ? [c.renameProp.from] : []));
  const mapped = migration.changes.flatMap((c) => ("mapValues" in c ? [c.mapValues] : []));
  const keys = siteKeys(scan, migration.element);
  return scan.report.usages
    .filter((u) => u.element === migration.element && u.kind === "render")
    .filter((u) => removed.some((p) => p in u.props) || mapped.some((m) => { const v = u.props[m.prop]; return v !== undefined && "literal" in v && String(v.literal) in m.map; }))
    .map((u) => ({ key: keys.get(`${u.file}:${u.line}:${u.column}`)!, at: `${u.file}:${u.line}` }));
}

/** Files the scan could not fully parse that may hold sites of this element: the migration would miss them. */
function coverageGate(scan: ScanResult, element: string): GateResult {
  const name = scan.elements.contracts.get(element)?.name ?? element;
  const risky = scan.report.coverage.failed.filter((f) => !/\.(tsx?|jsx?|css)$/.test(f.file) || (scan.modules.get(f.file)?.source ?? "").includes(name));
  return risky.length === 0
    ? { name: "coverage", ok: true, detail: scan.report.status === "complete" ? "every file parsed" : `${scan.report.coverage.failed.length} unparsed file(s), none mentions ${name}` }
    : { name: "coverage", ok: false, detail: `cannot see every site: ${risky.map((f) => `${f.file} (${f.reason})`).join("; ")}` };
}

async function parseGate(changes: readonly FileChange[]): Promise<GateResult> {
  const regressions: string[] = [];
  for (const change of changes) {
    const [before, after] = await Promise.all([countParseErrors(change.file, change.before), countParseErrors(change.file, change.after)]);
    if (after > before) regressions.push(`${change.file} (${before} → ${after} error nodes)`);
  }
  return { name: "parse-errors", ok: regressions.length === 0, detail: regressions.length === 0 ? `${changes.length} rewritten file(s) parse cleanly` : `new parse errors: ${regressions.join(", ")}` };
}

/** Both passes: imports first, then props on a rescan of the import-rewritten sources (the basis). */
interface FullPlan extends Planned {
  readonly imports: ImportPlan;
  readonly basis: ScanResult;
}

async function planAll(project: Project, migration: MigrationSpec, scan: ScanResult, rewriteValue: NonNullable<MigrationOptions["rewriteValue"]>): Promise<FullPlan> {
  const imports = await planImports(project, migration, scan);
  const basis = imports.outputs.size > 0 ? await scanProject(project, { overrides: Object.fromEntries(imports.outputs) }) : scan;
  const props = planEdits(migration, basis, rewriteValue, imports.held);
  return { outputs: new Map([...imports.outputs, ...props.outputs]), edited: imports.edited + props.edited, residuals: mergeResiduals([...imports.residuals, ...props.residuals]), imports, basis };
}

/** The element's file must already export every new name: rewriting imports before `youiyoux sync` breaks them. */
async function exportsGate(migration: MigrationSpec, after: ScanResult, target: string): Promise<GateResult> {
  const wanted = [...new Set(exportChanges(migration).flatMap((c) => (c.to === null ? [] : [c.to])))];
  const module = await after.graph.load(target);
  const names = module ? exportedNames(module) : new Set<string>();
  const missing = wanted.filter((name) => !names.has(name));
  if (!module) return { name: "exports", ok: false, detail: `cannot read ${target || migration.element}: run youiyoux sync, then migrate` };
  return missing.length === 0
    ? { name: "exports", ok: true, detail: wanted.length > 0 ? `${target} exports ${wanted.join(", ")}` : "no new export names" }
    : { name: "exports", ok: false, detail: `${target} does not export ${missing.join(", ")} yet: run youiyoux sync, then migrate` };
}

/**
 * The invariant gates, on rewritten sources held in memory. Exported so any rewrite path
 * (a recipe here, an agent's patch for residual sites later) is held to the same checks.
 * `planned` is the plan the outputs came from; without it the import pass is planned again.
 */
export async function verifyRewrite(project: Project, migration: MigrationSpec, before: ScanResult, outputs: ReadonlyMap<string, string>, residuals: readonly Residual[] = [], rewriteValue: NonNullable<MigrationOptions["rewriteValue"]> = keepQuotes, planned?: Pick<FullPlan, "imports" | "basis">): Promise<{ gates: GateResult[]; sitesAfter: number }> {
  const importChanges = exportChanges(migration).length > 0;
  const { imports, basis } = planned ?? (importChanges ? await planAll(project, migration, before, rewriteValue) : { imports: null, basis: before });
  const changes = [...outputs].map(([file, after]) => ({ file, before: before.modules.get(file)?.source ?? "", after, diff: "" }));
  const after = await scanProject(project, { overrides: Object.fromEntries(outputs) });
  const sitesBefore = count(before, migration.element);
  const sitesAfter = count(after, migration.element);
  const expected = (imports ? await expectedWithImports(project, migration, before, imports) : sitesBefore) + migration.expectedUsageDelta;
  const recovered = expected - migration.expectedUsageDelta - sitesBefore;
  // Prop residuals were planned on the basis (the import-rewritten sources); held files are unchanged in every scan.
  const basisKeys = siteKeys(basis, migration.element);
  const residualKeys = new Set(residuals.map((r) => basisKeys.get(`${r.file}:${r.line}:${r.column}`)));
  const importVerification = importChanges ? await verifyImports(migration, before, after, imports!.target, outputs, residuals) : null;
  const again = await planAll(project, migration, after, rewriteValue);
  const leftover = [
    ...oldApiSites(migration, after).filter((site) => !residualKeys.has(site.key)).map((site) => site.at),
    ...(importVerification?.leftover ?? []),
  ];
  const gates: GateResult[] = [
    coverageGate(before, migration.element),
    ...(importVerification ? [await exportsGate(migration, after, imports!.target), importVerification.resolution] : []),
    await parseGate(changes),
    { name: "usage-count", ok: sitesAfter === expected, detail: `${migration.element}: ${sitesBefore} before, ${sitesAfter} after, ${expected} expected${recovered > 0 ? ` (${recovered} resolvable again under the new name)` : ""}` },
    { name: "unknowns", ok: after.report.unknowns.length <= before.report.unknowns.length, detail: `${before.report.unknowns.length} unknown site(s) before, ${after.report.unknowns.length} after` },
    { name: "old-api", ok: leftover.length === 0, detail: leftover.length === 0 ? "no non-residual site uses the old API" : `still on the old API: ${[...new Set(leftover)].join(", ")}` },
    { name: "idempotent", ok: again.outputs.size === 0, detail: again.outputs.size === 0 ? "a second run changes nothing" : `a second run would change ${again.outputs.size} file(s)` },
  ];
  return { gates, sitesAfter };
}

export async function runMigration(project: Project, migration: MigrationSpec, options: MigrationOptions = {}): Promise<MigrationResult> {
  const rewriteValue = options.rewriteValue ?? keepQuotes;
  const before = await scanProject(project);
  const planned = await planAll(project, migration, before, rewriteValue);
  const changes: FileChange[] = [...planned.outputs].map(([file, after]) => {
    const original = before.modules.get(file)!.source;
    return { file, before: original, after, diff: unifiedDiff(file, original, after) };
  });
  const sitesBefore = count(before, migration.element);
  const base = { migration: migration.id, element: migration.element, sitesBefore, edited: planned.edited, residuals: planned.residuals, changes, keptBarrels: planned.imports.keptBarrels };
  if (changes.length === 0) return { ...base, status: "noop", sitesAfter: sitesBefore, gates: [] };
  const { gates, sitesAfter } = await verifyRewrite(project, migration, before, planned.outputs, planned.residuals, rewriteValue, planned);
  if (gates.every((g) => g.ok) && options.write) gates.push(await writeChanges(project, changes));
  const passed = gates.every((g) => g.ok);
  return { ...base, status: !passed ? "rejected" : options.write ? "applied" : "dry-run", sitesAfter, gates };
}

/**
 * Write all rewritten files or none: every target must be inside the project and still hold
 * exactly the source that was scanned (nobody edited it meanwhile). A failed write restores
 * the files already written.
 */
async function writeChanges(project: Project, changes: readonly FileChange[]): Promise<GateResult> {
  const outside = changes.filter((c) => isAbsolute(c.file) || relative(project.root, resolve(project.root, c.file)).startsWith(".."));
  if (outside.length > 0) return { name: "sources-unchanged", ok: false, detail: `refusing to write outside the project: ${outside.map((c) => c.file).join(", ")}` };
  const moved: string[] = [];
  for (const change of changes) if ((await readTextOrNull(join(project.root, change.file))) !== change.before) moved.push(change.file);
  if (moved.length > 0) return { name: "sources-unchanged", ok: false, detail: `changed since the scan, nothing written: ${moved.join(", ")}` };
  const written: FileChange[] = [];
  try {
    for (const change of changes) {
      await writeFileAtomic(join(project.root, change.file), change.after);
      written.push(change);
    }
  } catch (error: unknown) {
    for (const change of written) await writeFileAtomic(join(project.root, change.file), change.before);
    return { name: "sources-unchanged", ok: false, detail: `write failed, ${written.length} file(s) restored: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { name: "sources-unchanged", ok: true, detail: `${changes.length} file(s) written, each verified unchanged since the scan` };
}
