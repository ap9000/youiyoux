/** Usage-map aggregation: where an element lives, grouped project → screen → site. */
import { append } from "../lib/append.ts";
import type { ComponentContract, ElementId, Lookalike, PropValue, ScanReport, UnknownSite, UsageSite, Violation } from "./types.ts";

export interface Site extends UsageSite {
  readonly project: string;
  readonly commit: string | null;
}

export interface ProjectViolation extends Violation {
  readonly project: string;
}

export interface ProjectLookalike extends Lookalike {
  readonly project: string;
}

export interface ProjectUnknown extends UnknownSite {
  readonly project: string;
}

export interface UsageIndex {
  readonly reports: readonly ScanReport[];
  readonly sitesByElement: ReadonlyMap<ElementId, readonly Site[]>;
  readonly violationsByRule: ReadonlyMap<ElementId, readonly ProjectViolation[]>;
  /** Local components that share an element's name but are not it (never counted as usage). */
  readonly lookalikesByElement: ReadonlyMap<ElementId, readonly ProjectLookalike[]>;
  /** Sites the scanner could not resolve that might be the element, by name only. */
  readonly unknownsByCandidate: ReadonlyMap<ElementId, readonly ProjectUnknown[]>;
}

export const EVERY_SCREEN = "*";
export const UNROUTED = "(no screen)";

export function indexUsage(reports: readonly ScanReport[]): UsageIndex {
  const sitesByElement = new Map<ElementId, Site[]>();
  const violationsByRule = new Map<ElementId, ProjectViolation[]>();
  const lookalikesByElement = new Map<ElementId, ProjectLookalike[]>();
  const unknownsByCandidate = new Map<ElementId, ProjectUnknown[]>();
  for (const report of reports) {
    const { project } = report;
    for (const usage of report.usages) append(sitesByElement, usage.element, { ...usage, project, commit: report.commit });
    for (const violation of report.violations) append(violationsByRule, violation.rule, { ...violation, project });
    for (const lookalike of report.lookalikes) append(lookalikesByElement, lookalike.resembles, { ...lookalike, project });
    for (const unknown of report.unknowns) if (unknown.candidate) append(unknownsByCandidate, unknown.candidate, { ...unknown, project });
  }
  return { reports, sitesByElement, violationsByRule, lookalikesByElement, unknownsByCandidate };
}

export interface UsageSummary {
  readonly projects: number;
  readonly sites: number;
  /** Distinct routed screens (project + route), not counting the every-screen shell. */
  readonly screens: number;
  readonly files: number;
}

export function summarize(sites: readonly Site[]): UsageSummary {
  const projects = new Set<string>();
  const screens = new Set<string>();
  const files = new Set<string>();
  for (const site of sites) {
    projects.add(site.project);
    files.add(`${site.project}\u0000${site.file}`);
    for (const route of site.routes) if (route !== EVERY_SCREEN) screens.add(`${site.project}\u0000${route}`);
  }
  return { projects: projects.size, sites: sites.length, screens: screens.size, files: files.size };
}

export const DYNAMIC = "dynamic";
export const UNSET = "unset";

/** The default the contract gives an enum prop, if any. */
export function enumDefault(contract: ComponentContract, prop: string): string | undefined {
  const spec = contract.props[prop];
  return spec?.type === "enum" ? spec.default : undefined;
}

/** How a filterable value reads: an unset prop shows its default when the contract has one. */
export function valueLabel(value: string, fallback: string | undefined): string {
  if (value === UNSET) return fallback ? `${fallback} (implicit)` : "not set";
  return value === DYNAMIC ? "computed" : value;
}

/** The value a site passes for `prop`, as a filterable label. */
export function propLabel(value: PropValue | undefined): string {
  if (value === undefined) return UNSET;
  return "literal" in value ? String(value.literal) : DYNAMIC;
}

export interface ValueCount {
  readonly value: string;
  readonly count: number;
}

/** For each enum prop: how often each value is passed (unset = the default applies). */
export function propDistribution(sites: readonly Site[], contract: ComponentContract): ReadonlyMap<string, readonly ValueCount[]> {
  const result = new Map<string, ValueCount[]>();
  for (const [name, spec] of Object.entries(contract.props)) {
    if (spec.type !== "enum") continue;
    const counts = new Map<string, number>([...spec.values.map((v): [string, number] => [v, 0]), [UNSET, 0]]);
    for (const site of sites) {
      if (site.kind !== "render") continue;
      const label = propLabel(site.props[name]);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    result.set(name, [...counts].map(([value, count]) => ({ value, count })));
  }
  return result;
}

export type PropFilters = Readonly<Record<string, string>>;

export function filterSites(sites: readonly Site[], filters: PropFilters): Site[] {
  const active = Object.entries(filters);
  if (active.length === 0) return [...sites];
  return sites.filter((site) => active.every(([prop, value]) => propLabel(site.props[prop]) === value));
}

interface ScreenGroup {
  readonly route: string;
  readonly sites: readonly Site[];
}

export interface ProjectGroup {
  readonly project: string;
  readonly commit: string | null;
  readonly sites: number;
  readonly screens: readonly ScreenGroup[];
}

const routeRank = (route: string): number => (route === EVERY_SCREEN ? 0 : route === UNROUTED ? 2 : 1);

/** Project → screen → sites. A site that reaches several screens is listed under each. */
export function groupByScreen(sites: readonly Site[]): ProjectGroup[] {
  const projects = new Map<string, { commit: string | null; count: number; routes: Map<string, Site[]> }>();
  for (const site of sites) {
    const project = projects.get(site.project) ?? { commit: site.commit, count: 0, routes: new Map<string, Site[]>() };
    project.count++;
    for (const route of site.routes.length > 0 ? site.routes : [UNROUTED]) append(project.routes, route, site);
    projects.set(site.project, project);
  }
  return [...projects]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, { commit, count, routes }]) => ({
      project,
      commit,
      sites: count,
      screens: [...routes]
        .sort(([a], [b]) => routeRank(a) - routeRank(b) || a.localeCompare(b))
        .map(([route, list]) => ({ route, sites: [...list].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line) })),
    }));
}

export interface ElementIssues {
  /** Local components named like the element that resolve elsewhere: candidates to replace. */
  readonly lookalikes: number;
  /** Sites the scanner could not resolve that might be the element. */
  readonly unresolved: number;
  /** Render sites that leave the element's main choice (its first enum prop, e.g. variant) unset when the contract gives it no default. */
  readonly unset: { readonly prop: string; readonly count: number } | null;
  readonly total: number;
}

/** The enum prop a reader means by "which kind": `variant` when the contract has one, else its first enum. */
export function mainChoice(contract: ComponentContract): string | null {
  const enums = Object.entries(contract.props).filter(([, spec]) => spec.type === "enum").map(([name]) => name);
  return enums.includes("variant") ? "variant" : (enums[0] ?? null);
}

export function elementIssues(index: UsageIndex, contract: ComponentContract): ElementIssues {
  const lookalikes = index.lookalikesByElement.get(contract.id)?.length ?? 0;
  const unresolved = index.unknownsByCandidate.get(contract.id)?.length ?? 0;
  const main = mainChoice(contract);
  const prop = main && enumDefault(contract, main) === undefined ? main : null;
  const count = prop ? (index.sitesByElement.get(contract.id) ?? []).filter((s) => s.kind === "render" && s.props[prop] === undefined).length : 0;
  const unset = prop && count > 0 ? { prop, count } : null;
  return { lookalikes, unresolved, unset, total: lookalikes + unresolved + count };
}
