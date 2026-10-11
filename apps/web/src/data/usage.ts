/** Usage-map aggregation: where an element lives, grouped project → screen → site. */
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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
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
    for (const usage of report.usages) push(sitesByElement, usage.element, { ...usage, project, commit: report.commit });
    for (const violation of report.violations) push(violationsByRule, violation.rule, { ...violation, project });
    for (const lookalike of report.lookalikes) push(lookalikesByElement, lookalike.resembles, { ...lookalike, project });
    for (const unknown of report.unknowns) if (unknown.candidate) push(unknownsByCandidate, unknown.candidate, { ...unknown, project });
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

export interface ScreenGroup {
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
    for (const route of site.routes.length > 0 ? site.routes : [UNROUTED]) project.routes.set(route, [...(project.routes.get(route) ?? []), site]);
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

export interface ScreenBom {
  readonly project: string;
  readonly route: string;
  readonly elements: ReadonlyMap<ElementId, number>;
  readonly sites: number;
}

/** Every screen of every project with the elements it renders (a bill of materials). */
export function screenBoms(index: UsageIndex): ScreenBom[] {
  const boms = new Map<string, { project: string; route: string; elements: Map<ElementId, number>; sites: number }>();
  for (const [element, sites] of index.sitesByElement) {
    for (const site of sites) {
      for (const route of site.routes.length > 0 ? site.routes : [UNROUTED]) {
        const key = `${site.project}\u0000${route}`;
        const bom = boms.get(key) ?? { project: site.project, route, elements: new Map<ElementId, number>(), sites: 0 };
        bom.elements.set(element, (bom.elements.get(element) ?? 0) + 1);
        bom.sites++;
        boms.set(key, bom);
      }
    }
  }
  return [...boms.values()].sort((a, b) => a.project.localeCompare(b.project) || routeRank(a.route) - routeRank(b.route) || a.route.localeCompare(b.route));
}
