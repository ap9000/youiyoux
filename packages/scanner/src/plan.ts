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

export type ChangeClass = "api-breaking" | "deprecation" | "api-additive" | "visual-impl" | "token-value" | "rule" | "docs";

const RANK: readonly ChangeClass[] = ["api-breaking", "deprecation", "api-additive", "visual-impl", "token-value", "rule", "docs"];
const BUMP: Record<ChangeClass, "major" | "minor" | "patch"> = { "api-breaking": "major", deprecation: "minor", "api-additive": "minor", "visual-impl": "patch", "token-value": "patch", rule: "minor", docs: "patch" };
const RECIPE: Record<ChangeClass, string> = {
  "api-breaking": "migration recipe → gated codemod → residual sites to a person → ban the old API once every project has moved",
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
  };
  readonly callSites?: {
    readonly affected: number;
    readonly auto: number;
    readonly residual: number;
    readonly residualSites: readonly string[];
  };
  readonly gates?: readonly GateResult[];
  readonly coverage: { readonly status: string; readonly commit: string | null; readonly scannedAt: string };
}

function bump(version: string, kind: "major" | "minor" | "patch"): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return kind === "major" ? `${major + 1}.0.0` : kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

interface Classified {
  readonly classes: ChangeClass[];
  readonly reasons: string[];
  /** Props whose existing uses break, with the values that break (null = any use). */
  readonly breaking: Map<string, Set<string> | null>;
}

function classifyContract(current: ComponentContract, next: ComponentContract): Classified {
  const classes: ChangeClass[] = [];
  const reasons: string[] = [];
  const breaking = new Map<string, Set<string> | null>();
  for (const [name, spec] of Object.entries(current.props)) {
    const after = next.props[name];
    if (!after) {
      classes.push("api-breaking");
      reasons.push(`prop ${name} removed`);
      breaking.set(name, null);
    } else if (after.type !== spec.type) {
      classes.push("api-breaking");
      reasons.push(`prop ${name} changes type ${spec.type} → ${after.type}`);
      breaking.set(name, null);
    } else if (spec.type === "enum" && after.type === "enum") {
      const removed = spec.values.filter((v) => !after.values.includes(v));
      const added = after.values.filter((v) => !spec.values.includes(v));
      if (removed.length > 0) {
        classes.push("api-breaking");
        reasons.push(`${name} loses ${removed.join(", ")}`);
        breaking.set(name, new Set(removed));
      }
      if (added.length > 0) {
        classes.push("api-additive");
        reasons.push(`${name} gains ${added.join(", ")}`);
      }
    }
  }
  for (const [name, spec] of Object.entries(next.props)) {
    if (current.props[name]) continue;
    classes.push(spec.required ? "api-breaking" : "api-additive");
    reasons.push(`${spec.required ? "required" : "optional"} prop ${name} added`);
  }
  if (next.status === "deprecated" && current.status !== "deprecated") {
    classes.push("deprecation");
    reasons.push("status → deprecated");
  }
  if (JSON.stringify(current.tokens) !== JSON.stringify(next.tokens) || JSON.stringify(current.source) !== JSON.stringify(next.source)) {
    classes.push("visual-impl");
    reasons.push("token bindings or implementation changed");
  }
  if (JSON.stringify(current.rules) !== JSON.stringify(next.rules)) {
    classes.push("rule");
    reasons.push("governing rules changed");
  }
  if (classes.length === 0) {
    classes.push("docs");
    reasons.push("summary, guidance, examples or notes only");
  }
  return { classes, reasons, breaking };
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

function callSitesFor(sites: readonly UsageSite[], breaking: Map<string, Set<string> | null>): ChangePlan["callSites"] {
  const affected = sites.filter((site) => site.spread || [...breaking].some(([prop, values]) => {
    const value = site.props[prop];
    if (!value) return false;
    return values === null || !("literal" in value) || values.has(String(value.literal));
  }));
  const residual = affected.filter((site) => site.spread || [...breaking.keys()].some((prop) => site.props[prop] !== undefined && !("literal" in site.props[prop]!)));
  return { affected: affected.length, auto: affected.length - residual.length, residual: residual.length, residualSites: residual.slice(0, 10).map((s) => `${s.file}:${s.line}`) };
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

export async function planChange(project: Project, scan: ScanResult, input: PlanInput): Promise<ChangePlan> {
  const coverage = { status: scan.report.status, commit: scan.report.commit, scannedAt: scan.report.generatedAt };
  if ("token" in input) {
    const tokenId = input.token.replace(/^youi:[a-z-]+\/token\//, "");
    if (!scan.tokens.tokens.some((t) => t.id === tokenId)) throw new Error(`no token ${tokenId}`);
    const aliases = new Set([tokenId, ...scan.tokens.tokens.filter((t) => t.aliasOf === tokenId).map((t) => t.id)]);
    const contracts = project.system.components.filter(({ contract }) => Object.values(contract.tokens).some((id) => aliases.has(id.replace(/^youi:[a-z-]+\/token\//, ""))));
    const ids = new Set(contracts.map((c) => c.contract.id));
    const sites = scan.report.usages.filter((u) => ids.has(u.element));
    return {
      target: `youi:${project.system.config.id}/token/${tokenId}`,
      class: "token-value",
      semver: BUMP["token-value"],
      reasons: [`${tokenId}${input.value ? ` → ${input.value}` : ""} changes ${[...aliases].join(", ")}`, `bound by ${contracts.map((c) => c.contract.name).join(", ") || "no contract"}`],
      recipe: RECIPE["token-value"],
      impact: impactOf(sites, scan, ids),
      coverage,
    };
  }
  if ("migration" in input) {
    const contract = findContract(project, input.migration.element);
    const result = await runMigration(project, input.migration, { write: false });
    const sites = scan.report.usages.filter((u) => u.element === contract.id);
    return {
      target: contract.id,
      class: "api-breaking",
      semver: "major",
      version: { current: contract.version, next: input.migration.to },
      reasons: input.migration.changes.map((c) => ("renameProp" in c ? `rename ${c.renameProp.from} → ${c.renameProp.to}` : `map ${c.mapValues.prop}: ${Object.entries(c.mapValues.map).map(([a, b]) => `${a}→${b}`).join(", ")}`)),
      recipe: RECIPE["api-breaking"],
      impact: impactOf(sites, scan, new Set([contract.id])),
      callSites: { affected: result.edited + result.residuals.length, auto: result.edited, residual: result.residuals.length, residualSites: result.residuals.slice(0, 10).map((r) => `${r.file}:${r.line} (${r.reason})`) },
      gates: result.gates,
      coverage,
    };
  }
  const current = findContract(project, input.element);
  const next = ComponentContract.parse({ ...applyPatch(current, input.patch), id: current.id, schema: current.schema });
  const { classes, reasons, breaking } = classifyContract(current, next);
  const top = RANK.find((c) => classes.includes(c)) ?? "docs";
  const sites = scan.report.usages.filter((u) => u.element === current.id);
  return {
    target: current.id,
    class: top,
    semver: BUMP[top],
    version: { current: current.version, next: bump(current.version, BUMP[top]) },
    reasons,
    recipe: RECIPE[top],
    impact: impactOf(sites, scan, new Set([current.id])),
    ...(breaking.size > 0 ? { callSites: callSitesFor(sites.filter((s) => s.kind !== "reference"), breaking) } : {}),
    coverage,
  };
}
