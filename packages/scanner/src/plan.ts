/**
 * `youi plan`: what would this change touch? Read-only.
 *
 * The change class (and so the semver bump and the machinery it needs) is
 * computed from the contract diff, never chosen by the author. Impact comes
 * from the usage map: sites, screens, and which sites a recipe could rewrite
 * (literal props) versus which need a person (dynamic or spread).
 */
import { ComponentContract, matchesQuery, type MigrationSpec, type UsageSite } from "@youiyoux/core";
import { runMigration, type GateResult } from "./codemod.ts";
import type { Project } from "./project.ts";
import type { ScanResult } from "./scan.ts";
import { tokenImpact, type TokenImpact } from "./token-impact.ts";

export type ChangeClass = "api-breaking" | "behavior" | "deprecation" | "api-additive" | "visual-impl" | "token-value" | "rule" | "docs";

const RANK: readonly ChangeClass[] = ["api-breaking", "behavior", "deprecation", "api-additive", "visual-impl", "token-value", "rule", "docs"];
const BUMP: Record<ChangeClass, "major" | "minor" | "patch"> = { "api-breaking": "major", behavior: "minor", deprecation: "minor", "api-additive": "minor", "visual-impl": "patch", "token-value": "patch", rule: "minor", docs: "patch" };
const RECIPE: Record<ChangeClass, string> = {
  "api-breaking": "migration recipe → gated codemod → residual sites to a person → ban the old API once every project has moved",
  behavior: "review every site that relies on the old default (listed); pass the old value explicitly where it must stay → sync → visual check of those screens",
  deprecation: "codemod where possible, warn now, error after the grace period",
  "api-additive": "sync the new version; no call-site edits",
  "visual-impl": "sync the implementation (3-way merge) → visual check of the affected screens",
  "token-value": "rebuild tokens → sync → visual check of the affected screens",
  rule: "ship as a warning with fixes, then tighten",
  docs: "release only",
};

export type PlanInput =
  | { readonly element: string; readonly patch: Record<string, unknown> }
  | { readonly token: string; readonly value?: string }
  | { readonly migration: MigrationSpec };

export interface CallSites {
  /** Sites that break, or may (see unresolved). */
  readonly affected: number;
  /** Sites a migration recipe can rewrite (literal values of a renamed or remapped prop). */
  readonly auto: number;
  /** Sites a person must change or confirm. */
  readonly residual: number;
  /** Residual sites the scan cannot decide (props spread in, dynamic values): they may or may not break. */
  readonly unresolved: number;
  readonly residualSites: readonly string[];
  /** Per change: how many sites it reaches. */
  readonly changes: ReadonlyArray<{ readonly change: string; readonly affected: number; readonly unresolved: number }>;
}

export interface ChangePlan {
  readonly target: string;
  readonly class: ChangeClass;
  readonly semver: "major" | "minor" | "patch";
  readonly version?: { readonly current: string; readonly next: string };
  readonly reasons: readonly string[];
  readonly recipe: string;
  readonly impact: {
    readonly sites: number;
    readonly files: number;
    readonly routes: ReadonlyArray<{ route: string; sites: number }>;
    readonly unrouted: number;
    /** Sites the scan could not resolve that may be this element: they are in scope, uncounted. */
    readonly unknownCandidates: number;
    readonly lookalikes: number;
    /** Something global (a stylesheet, the app shell, an unrouted file) is affected: every screen is a visual target. */
    readonly everyScreen?: boolean;
  };
  /** Call sites the change breaks: present whenever the change can break existing code. */
  readonly callSites?: CallSites;
  /** Sites whose rendering changes without any code change (they rely on a default that moves). */
  readonly review?: { readonly sites: number; readonly unresolved: number; readonly listed: readonly string[] };
  /** For a token change: what reads it. */
  readonly token?: {
    readonly dependents: readonly string[];
    readonly contracts: ReadonlyArray<{ readonly name: string; readonly via: "binding" | "implementation" }>;
    readonly direct: TokenImpact["direct"];
  };
  readonly gates?: readonly GateResult[];
  /**
   * Whether the counts are the whole impact. When not exact they are a lower bound and `limits`
   * says what is missing: zero affected is then never proof of no effect.
   */
  readonly completeness: { readonly exact: boolean; readonly limits: readonly string[] };
  readonly coverage: { readonly status: string; readonly commit: string | null; readonly scannedAt: string };
}

function bump(version: string, kind: "major" | "minor" | "patch"): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return kind === "major" ? `${major + 1}.0.0` : kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** A contract edit that existing call sites may have to follow. */
type Edit =
  | { readonly kind: "prop"; readonly prop: string; readonly change: "removed" | "type" | "required" }
  | { readonly kind: "prop"; readonly prop: string; readonly change: "values"; readonly values: ReadonlySet<string> }
  | { readonly kind: "export"; readonly name: string; readonly change: "renamed" | "removed"; readonly to?: string };

/** A default that moves: sites that omit the prop render differently with no code change. */
interface DefaultChange {
  readonly prop: string;
  readonly from: string;
  readonly to: string;
}

interface Classified {
  readonly classes: ChangeClass[];
  readonly reasons: string[];
  readonly edits: Edit[];
  readonly defaults: DefaultChange[];
  /** What this plan cannot analyse about the change. */
  readonly limits: string[];
}

const shown = (value: unknown): string => (value === undefined ? "(none)" : String(value));

function classifyProps(current: ComponentContract, next: ComponentContract, out: Classified): void {
  for (const [name, spec] of Object.entries(current.props)) {
    const after = next.props[name];
    if (!after) {
      out.classes.push("api-breaking");
      out.reasons.push(`prop ${name} removed`);
      out.edits.push({ kind: "prop", prop: name, change: "removed" });
      continue;
    }
    if (after.type !== spec.type) {
      out.classes.push("api-breaking");
      out.reasons.push(`prop ${name} changes type ${spec.type} → ${after.type}`);
      out.edits.push({ kind: "prop", prop: name, change: "type" });
      continue;
    }
    if (spec.type === "enum" && after.type === "enum") {
      const removed = spec.values.filter((v) => !after.values.includes(v));
      const added = after.values.filter((v) => !spec.values.includes(v));
      if (removed.length > 0) {
        out.classes.push("api-breaking");
        out.reasons.push(`${name} loses ${removed.join(", ")}`);
        out.edits.push({ kind: "prop", prop: name, change: "values", values: new Set(removed) });
      }
      if (added.length > 0) {
        out.classes.push("api-additive");
        out.reasons.push(`${name} gains ${added.join(", ")}`);
      }
    }
    if (after.required && !spec.required) {
      out.classes.push("api-breaking");
      out.reasons.push(`prop ${name} becomes required`);
      out.edits.push({ kind: "prop", prop: name, change: "required" });
    } else if (spec.required && !after.required) {
      out.classes.push("api-additive");
      out.reasons.push(`prop ${name} becomes optional`);
    }
    const before = "default" in spec ? spec.default : undefined;
    const now = "default" in after ? after.default : undefined;
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      out.classes.push("behavior");
      out.reasons.push(`default ${name} changes ${shown(before)} → ${shown(now)}: sites that omit it render differently`);
      out.defaults.push({ prop: name, from: shown(before), to: shown(now) });
    }
    if (after.deprecated && !spec.deprecated) {
      out.classes.push("deprecation");
      out.reasons.push(`prop ${name} deprecated: ${after.deprecated}`);
    }
  }
  for (const [name, spec] of Object.entries(next.props)) {
    if (current.props[name]) continue;
    out.classes.push(spec.required ? "api-breaking" : "api-additive");
    out.reasons.push(`${spec.required ? "required" : "optional"} prop ${name} added`);
    if (spec.required) out.edits.push({ kind: "prop", prop: name, change: "required" });
  }
}

function classifyExports(current: ComponentContract, next: ComponentContract, out: Classified): void {
  if (current.source.export !== next.source.export) {
    out.classes.push("api-breaking");
    out.reasons.push(`export ${current.source.export} renamed to ${next.source.export}: every import of it breaks`);
    out.edits.push({ kind: "export", name: current.source.export, change: "renamed", to: next.source.export });
  }
  const names = (c: ComponentContract): string[] => [...c.source.also, ...c.aliases];
  for (const name of names(current).filter((n) => !names(next).includes(n) && n !== next.source.export)) {
    out.classes.push("api-breaking");
    out.reasons.push(`export ${name} removed: every import of it breaks`);
    out.edits.push({ kind: "export", name, change: "removed" });
  }
  const added = names(next).filter((n) => !names(current).includes(n));
  if (added.length > 0) {
    out.classes.push("api-additive");
    out.reasons.push(`exports ${added.join(", ")} added`);
  }
  if (current.source.file !== next.source.file) {
    out.classes.push("visual-impl");
    out.reasons.push(`implementation moves ${current.source.file} → ${next.source.file}`);
    out.limits.push("imports of the implementation file by path (not through the components entry) are not analysed");
  }
}

function classifyContract(current: ComponentContract, next: ComponentContract): Classified {
  const out: Classified = { classes: [], reasons: [], edits: [], defaults: [], limits: [] };
  classifyProps(current, next, out);
  classifyExports(current, next, out);
  if (current.passthrough !== next.passthrough) {
    if (current.passthrough) {
      out.classes.push("api-breaking");
      out.reasons.push(`native <${current.passthrough}> props ${next.passthrough ? `now pass to <${next.passthrough}>` : "no longer pass through"}`);
      out.limits.push(`native <${current.passthrough}> props at call sites are not analysed: sites passing them are not counted`);
    } else {
      out.classes.push("api-additive");
      out.reasons.push(`native <${next.passthrough}> props now pass through`);
    }
  }
  const dropped = current.platforms.filter((p) => !next.platforms.includes(p));
  if (dropped.length > 0) {
    out.classes.push("api-breaking");
    out.reasons.push(`drops platform ${dropped.join(", ")}`);
    out.limits.push(`which call sites run on ${dropped.join(", ")} is not analysed`);
  }
  if (next.status === "deprecated" && current.status !== "deprecated") {
    out.classes.push("deprecation");
    out.reasons.push("status → deprecated");
  }
  if (JSON.stringify(current.tokens) !== JSON.stringify(next.tokens)) {
    out.classes.push("visual-impl");
    out.reasons.push("token bindings changed");
  }
  if (JSON.stringify(current.rules) !== JSON.stringify(next.rules)) {
    out.classes.push("rule");
    out.reasons.push("governing rules changed");
  }
  if (out.classes.length === 0) {
    out.classes.push("docs");
    out.reasons.push("summary, guidance, examples or notes only");
  }
  return out;
}

function impactOf(sites: readonly UsageSite[], scan: ScanResult, elementIds: ReadonlySet<string>): ChangePlan["impact"] {
  const routes = new Map<string, number>();
  for (const site of sites) for (const route of site.routes) routes.set(route, (routes.get(route) ?? 0) + 1);
  return {
    sites: sites.length,
    files: new Set(sites.map((s) => s.file)).size,
    routes: [...routes].sort((a, b) => b[1] - a[1]).map(([route, count]) => ({ route, sites: count })),
    unrouted: sites.filter((s) => s.routeSource === "unrouted").length,
    unknownCandidates: scan.report.unknowns.filter((u) => u.candidate && elementIds.has(u.candidate)).length,
    lookalikes: scan.report.lookalikes.filter((l) => elementIds.has(l.resembles)).length,
  };
}

interface Verdict {
  readonly reason: string;
  /** A migration recipe can rewrite it. */
  readonly auto: boolean;
  /** Spread or dynamic: the scan cannot tell whether it breaks. */
  readonly unresolved: boolean;
}

/** Renders the element itself (or calls its variants function): the sites its props apply to. */
const usesProps = (site: UsageSite, contract: ComponentContract): boolean => site.kind === "variants" || (site.kind === "render" && site.export === contract.source.export);

function propVerdict(site: UsageSite, edit: Extract<Edit, { kind: "prop" }>): Verdict | null {
  const value = site.props[edit.prop];
  const spread = (what: string): Verdict | null => (site.spread ? { reason: `props spread in may ${what}`, auto: false, unresolved: true } : null);
  if (edit.change === "required") {
    if (site.kind !== "render" || value) return null;
    return spread(`pass required ${edit.prop}`) ?? { reason: `missing required ${edit.prop}`, auto: false, unresolved: false };
  }
  if (!value) return spread(`pass ${edit.prop}`);
  if (edit.change === "values") {
    if (!("literal" in value)) return { reason: `${edit.prop}={${value.dynamic}} may be ${[...edit.values].join(" or ")}`, auto: false, unresolved: true };
    return edit.values.has(String(value.literal)) ? { reason: `${edit.prop}="${String(value.literal)}" is removed`, auto: true, unresolved: false } : null;
  }
  if (edit.change === "removed") return { reason: `passes removed ${edit.prop}`, auto: "literal" in value, unresolved: false };
  return { reason: `passes ${edit.prop}, which changes type`, auto: false, unresolved: false };
}

function verdictsFor(site: UsageSite, contract: ComponentContract, edits: readonly Edit[]): Array<{ edit: Edit; verdict: Verdict }> {
  return edits.flatMap((edit): Array<{ edit: Edit; verdict: Verdict }> => {
    if (edit.kind === "export") {
      // Migrations rewrite props, not imports: a renamed or removed export is always a person's edit.
      return site.export === edit.name ? [{ edit, verdict: { reason: edit.change === "renamed" ? `imports ${edit.name}, renamed to ${edit.to}` : `imports ${edit.name}, which is removed`, auto: false, unresolved: false } }] : [];
    }
    if (!usesProps(site, contract)) return [];
    const verdict = propVerdict(site, edit);
    return verdict ? [{ edit, verdict }] : [];
  });
}

const MAX_LISTED = 10;
const editLabel = (edit: Edit): string => (edit.kind === "export" ? `export ${edit.name} ${edit.change}` : `prop ${edit.prop} ${edit.change === "values" ? `loses ${[...edit.values].join(", ")}` : edit.change}`);

function callSitesFor(sites: readonly UsageSite[], contract: ComponentContract, edits: readonly Edit[]): CallSites {
  const judged = sites.map((site) => ({ site, verdicts: verdictsFor(site, contract, edits) })).filter((j) => j.verdicts.length > 0);
  const residual = judged.filter((j) => j.verdicts.some(({ verdict }) => !verdict.auto));
  return {
    affected: judged.length,
    auto: judged.length - residual.length,
    residual: residual.length,
    unresolved: residual.filter((j) => j.verdicts.every(({ verdict }) => verdict.unresolved)).length,
    residualSites: residual.slice(0, MAX_LISTED).map((j) => `${j.site.file}:${j.site.line} (${j.verdicts.map(({ verdict }) => verdict.reason).join("; ")})`),
    changes: edits.map((edit) => {
      const hits = judged.flatMap((j) => j.verdicts.filter((v) => v.edit === edit));
      return { change: editLabel(edit), affected: hits.length, unresolved: hits.filter((v) => v.verdict.unresolved).length };
    }),
  };
}

function reviewFor(sites: readonly UsageSite[], contract: ComponentContract, defaults: readonly DefaultChange[]): NonNullable<ChangePlan["review"]> {
  const relying = sites.filter((site) => usesProps(site, contract) && defaults.some((d) => site.props[d.prop] === undefined));
  const unresolved = relying.filter((site) => site.spread);
  return {
    sites: relying.length,
    unresolved: unresolved.length,
    listed: relying.slice(0, MAX_LISTED).map((site) => `${site.file}:${site.line} (${site.spread ? "props spread in may set " : "relies on default "}${defaults.filter((d) => site.props[d.prop] === undefined).map((d) => d.prop).join(", ")})`),
  };
}

function scanLimits(scan: ScanResult, unknownCandidates: number, name: string): string[] {
  const limits: string[] = [];
  const failed = scan.report.coverage.failed.length;
  if (failed > 0) limits.push(`${failed} file(s) not fully analysed: sites in them are missing`);
  if (unknownCandidates > 0) limits.push(`${unknownCandidates} unresolved site(s) may be ${name}: not counted`);
  return limits;
}

const MERGED_FIELDS = new Set(["props", "tokens", "a11y", "guidance", "source", "deprecation"]);

/**
 * A patch merges into the contract one level deep for map-like fields (props, tokens, …),
 * so `{"props": {"loading": {...}}}` adds one prop; `null` removes an entry or field.
 */
export function applyPatch(contract: ComponentContract, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...contract };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (MERGED_FIELDS.has(key) && typeof value === "object" && !Array.isArray(value)) {
      const merged: Record<string, unknown> = { ...(next[key] as Record<string, unknown> | undefined), ...(value as Record<string, unknown>) };
      next[key] = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null));
    } else next[key] = value;
  }
  return next;
}

function findContract(project: Project, query: string): ComponentContract {
  const match = project.system.components.find(({ contract }) => matchesQuery(contract.id, query) || contract.name.toLowerCase() === query.toLowerCase());
  if (!match) throw new Error(`no component "${query}" in ${project.system.config.id}; known: ${project.system.components.map((c) => c.contract.name).join(", ")}`);
  return match.contract;
}

function tokenPlan(project: Project, scan: ScanResult, input: { readonly token: string; readonly value?: string }, coverage: ChangePlan["coverage"]): ChangePlan {
  const tokenId = input.token.replace(/^youi:[a-z-]+\/token\//, "");
  if (!scan.tokens.tokens.some((t) => t.id === tokenId)) throw new Error(`no token ${tokenId}`);
  const reach = tokenImpact(project, scan, tokenId);
  const ids = new Set(reach.contracts.map((c) => c.id));
  const sites = scan.report.usages.filter((u) => ids.has(u.element));
  const base = impactOf(sites, scan, ids);
  const routes = new Map(base.routes.map((r) => [r.route, r.sites]));
  for (const [route, uses] of reach.directRoutes) routes.set(route, (routes.get(route) ?? 0) + uses);
  const generated = project.config.outputs.targets.filter((t) => t === "ts" || t === "react-native");
  const limits = [
    "a lower bound: class names built at runtime (bg-${tone}) and uses outside the scanned files are not traced",
    ...(generated.length > 0 ? [`reads through the generated ${generated.map((t) => (t === "ts" ? "tokens.ts" : "tokens.native.ts")).join(" and ")} are not traced`] : []),
    ...scanLimits(scan, base.unknownCandidates, "a bound component"),
  ];
  return {
    target: `youi:${project.system.config.id}/token/${tokenId}`,
    class: "token-value",
    semver: BUMP["token-value"],
    reasons: [
      `${tokenId}${input.value ? ` → ${input.value}` : ""}${reach.dependents.length ? `; its value flows into ${reach.dependents.join(", ")}` : ""}`,
      reach.contracts.length ? `read by ${reach.contracts.map((c) => `${c.name} (${c.via})`).join(", ")}` : "no contract binds it or uses it in its implementation",
      reach.direct.uses ? `${reach.direct.uses} direct use(s) in ${reach.direct.files} file(s)` : "no direct use found in the scanned files",
    ],
    recipe: RECIPE["token-value"],
    impact: { ...base, files: new Set([...sites.map((s) => s.file), ...reach.direct.sites.map((s) => s.file)]).size, routes: [...routes].sort((a, b) => b[1] - a[1]).map(([route, n]) => ({ route, sites: n })), everyScreen: reach.everyScreen },
    token: { dependents: reach.dependents, contracts: reach.contracts.map(({ name, via }) => ({ name, via })), direct: reach.direct },
    completeness: { exact: false, limits },
    coverage,
  };
}

async function migrationPlan(project: Project, scan: ScanResult, migration: MigrationSpec, coverage: ChangePlan["coverage"]): Promise<ChangePlan> {
  const contract = findContract(project, migration.element);
  const result = await runMigration(project, migration, { write: false });
  const sites = scan.report.usages.filter((u) => u.element === contract.id);
  const impact = impactOf(sites, scan, new Set([contract.id]));
  const limits = scanLimits(scan, impact.unknownCandidates, contract.name);
  return {
    target: contract.id,
    class: "api-breaking",
    semver: "major",
    version: { current: contract.version, next: migration.to },
    reasons: migration.changes.map((c) => ("renameProp" in c ? `rename ${c.renameProp.from} → ${c.renameProp.to}` : `map ${c.mapValues.prop}: ${Object.entries(c.mapValues.map).map(([a, b]) => `${a}→${b}`).join(", ")}`)),
    recipe: RECIPE["api-breaking"],
    impact,
    callSites: { affected: result.edited + result.residuals.length, auto: result.edited, residual: result.residuals.length, unresolved: result.residuals.length, residualSites: result.residuals.slice(0, MAX_LISTED).map((r) => `${r.file}:${r.line} (${r.reason})`), changes: [] },
    gates: result.gates,
    completeness: { exact: limits.length === 0, limits },
    coverage,
  };
}

export async function planChange(project: Project, scan: ScanResult, input: PlanInput): Promise<ChangePlan> {
  const coverage = { status: scan.report.status, commit: scan.report.commit, scannedAt: scan.report.generatedAt };
  if ("token" in input) return tokenPlan(project, scan, input, coverage);
  if ("migration" in input) return migrationPlan(project, scan, input.migration, coverage);
  const current = findContract(project, input.element);
  const next = ComponentContract.parse({ ...applyPatch(current, input.patch), id: current.id, schema: current.schema });
  const classified = classifyContract(current, next);
  const top = RANK.find((c) => classified.classes.includes(c)) ?? "docs";
  const sites = scan.report.usages.filter((u) => u.element === current.id);
  const impact = impactOf(sites, scan, new Set([current.id]));
  const callSites = classified.edits.length > 0 ? callSitesFor(sites, current, classified.edits) : undefined;
  const review = classified.defaults.length > 0 ? reviewFor(sites, current, classified.defaults) : undefined;
  const limits = [
    ...scanLimits(scan, impact.unknownCandidates, current.name),
    ...classified.limits,
    ...(callSites?.unresolved ? [`${callSites.unresolved} call site(s) spread props or pass dynamic values: whether they break is unknown`] : []),
    ...(review?.unresolved ? [`${review.unresolved} site(s) spread props: whether they rely on the default is unknown`] : []),
  ];
  return {
    target: current.id,
    class: top,
    semver: BUMP[top],
    version: { current: current.version, next: bump(current.version, BUMP[top]) },
    reasons: classified.reasons,
    recipe: RECIPE[top],
    impact,
    ...(callSites ? { callSites } : {}),
    ...(review ? { review } : {}),
    completeness: { exact: limits.length === 0, limits },
    coverage,
  };
}
