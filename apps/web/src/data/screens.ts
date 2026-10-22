/**
 * Screens: every routed screen of every project, the elements it renders, the issues
 * in the files that make it up, and its captured screenshot.
 *
 * Issues use the scanner's fileRoutes map, including files with no element sites.
 * Unrouted sites and issues share one list, with the scanner's reason for each file.
 */
import type { ElementId, Manifest, ProjectShots, ScanReport, ScreenShot } from "./types.ts";
import { EVERY_SCREEN, type ProjectLookalike, type ProjectUnknown, type ProjectViolation, type Site, UNROUTED, type UsageIndex } from "./usage.ts";

/** `/work (task detail)` → `work-task-detail`, `*` → `app-shell`. Used in URLs and screenshot file names. */
export function screenSlug(route: string): string {
  if (route === EVERY_SCREEN) return "app-shell";
  if (route === UNROUTED) return "unrouted";
  const slug = route
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

/** A screen's page; `select` opens it with that element (or `file:line`) picked out on the picture. */
export function screenHref(project: string, route: string, select?: string): string {
  return `/screens/${encodeURIComponent(project)}/${screenSlug(route)}${select ? `?select=${encodeURIComponent(select)}` : ""}`;
}

export function routeLabel(route: string): string {
  return route === EVERY_SCREEN ? "App shell" : route === UNROUTED ? "Not on a screen" : route;
}

export interface IssueCounts {
  readonly errors: number;
  readonly warnings: number;
  readonly lookalikes: number;
  readonly unresolved: number;
  readonly total: number;
}

export const NO_ISSUES: IssueCounts = { errors: 0, warnings: 0, lookalikes: 0, unresolved: 0, total: 0 };

export function countIssues(violations: readonly ProjectViolation[], lookalikes: readonly unknown[], unresolved: readonly unknown[]): IssueCounts {
  const errors = violations.filter((v) => v.severity === "error").length;
  const warnings = violations.length - errors;
  return { errors, warnings, lookalikes: lookalikes.length, unresolved: unresolved.length, total: violations.length + lookalikes.length + unresolved.length };
}

const addIssues = (a: IssueCounts, b: IssueCounts): IssueCounts => ({
  errors: a.errors + b.errors,
  warnings: a.warnings + b.warnings,
  lookalikes: a.lookalikes + b.lookalikes,
  unresolved: a.unresolved + b.unresolved,
  total: a.total + b.total,
});

/** One element on one screen: where it renders, and the near-misses that might be it. */
export interface ScreenElement {
  readonly id: ElementId;
  readonly sites: readonly Site[];
  readonly lookalikes: readonly ProjectLookalike[];
  readonly unresolved: readonly ProjectUnknown[];
}

export interface Screen {
  readonly project: string;
  readonly route: string;
  readonly slug: string;
  readonly sites: number;
  /** Most-used first. */
  readonly elements: readonly ScreenElement[];
  readonly violations: readonly ProjectViolation[];
  readonly lookalikes: readonly ProjectLookalike[];
  readonly unresolved: readonly ProjectUnknown[];
  readonly issues: IssueCounts;
  readonly shot: ScreenShot | null;
}

export interface ScreenIndex {
  readonly screens: readonly Screen[];
  readonly byHref: ReadonlyMap<string, Screen>;
  /** Issues in files the usage map puts on no screen. */
  readonly unattributed: IssueCounts;
  readonly unattributedFiles: readonly UnattributedFile[];
  /** Capture details per project, when its screens were captured. */
  readonly shots: ReadonlyMap<string, ProjectShots>;
}

export interface UnattributedFile {
  readonly project: string;
  readonly file: string;
  readonly sites: number;
  readonly reason: string;
}

const routeRank = (route: string): number => (route === EVERY_SCREEN ? 0 : 1);

export function projectShots(manifest: Manifest): Map<string, ProjectShots> {
  const shots = new Map<string, ProjectShots>();
  for (const system of manifest.systems) for (const usage of system.usage) if (usage.screens) shots.set(usage.project, usage.screens);
  return shots;
}

interface ElementDraft {
  readonly sites: Site[];
  readonly lookalikes: ProjectLookalike[];
  readonly unresolved: ProjectUnknown[];
}

class ScreenDraft {
  sites = 0;
  readonly elements = new Map<ElementId, ElementDraft>();
  readonly violations: ProjectViolation[] = [];
  readonly lookalikes: ProjectLookalike[] = [];
  readonly unresolved: ProjectUnknown[] = [];

  element(id: ElementId): ElementDraft {
    const existing = this.elements.get(id);
    if (existing) return existing;
    const created: ElementDraft = { sites: [], lookalikes: [], unresolved: [] };
    this.elements.set(id, created);
    return created;
  }
}

/** One project's screens, plus what could not be placed on any of them. */
function projectScreens(report: ScanReport, sites: readonly Site[], shots: ProjectShots | undefined): { screens: Screen[]; unattributed: IssueCounts; unattributedFiles: UnattributedFile[] } {
  const { project } = report;
  const unattributedFiles = new Map<string, UnattributedFile>();
  const unplaced = (file: string, siteCount = 0, reason?: string): void => {
    const existing = unattributedFiles.get(file);
    unattributedFiles.set(file, { project, file, sites: (existing?.sites ?? 0) + siteCount, reason: report.fileRoutes?.[file]?.routeReason ?? existing?.reason ?? reason ?? "This scan has no route information for this file. Scan the project again." });
  };
  const drafts = new Map<string, ScreenDraft>();
  const draft = (route: string): ScreenDraft => {
    const existing = drafts.get(route);
    if (existing) return existing;
    const created = new ScreenDraft();
    drafts.set(route, created);
    return created;
  };

  for (const site of sites) {
    if (site.routes.length === 0) unplaced(site.file, 1, site.routeReason);
    for (const route of site.routes) {
      const d = draft(route);
      d.sites++;
      d.element(site.element).sites.push(site);
    }
  }

  const lost = { violations: [] as ProjectViolation[], lookalikes: [] as ProjectLookalike[], unresolved: [] as ProjectUnknown[] };
  for (const violation of report.violations) {
    const entry = { ...violation, project };
    const routes = report.fileRoutes?.[violation.file]?.routes;
    if (!routes?.length) {
      lost.violations.push(entry);
      unplaced(violation.file);
    } else for (const route of routes) draft(route).violations.push(entry);
  }
  for (const lookalike of report.lookalikes) {
    const entry = { ...lookalike, project };
    const routes = report.fileRoutes?.[lookalike.file]?.routes;
    if (!routes?.length) {
      lost.lookalikes.push(entry);
      unplaced(lookalike.file);
    } else
      for (const route of routes) {
        draft(route).lookalikes.push(entry);
        draft(route).element(lookalike.resembles).lookalikes.push(entry);
      }
  }
  for (const unknown of report.unknowns) {
    const entry = { ...unknown, project };
    const routes = report.fileRoutes?.[unknown.file]?.routes;
    if (!routes?.length) {
      lost.unresolved.push(entry);
      unplaced(unknown.file);
    } else
      for (const route of routes) {
        draft(route).unresolved.push(entry);
        if (unknown.candidate) draft(route).element(unknown.candidate).unresolved.push(entry);
      }
  }

  const screens = [...drafts]
    .sort(([a], [b]) => routeRank(a) - routeRank(b) || a.localeCompare(b))
    .map(([route, d]): Screen => ({
      project,
      route,
      slug: screenSlug(route),
      sites: d.sites,
      elements: [...d.elements].map(([id, e]): ScreenElement => ({ id, ...e })).sort((a, b) => b.sites.length - a.sites.length || a.id.localeCompare(b.id)),
      violations: d.violations,
      lookalikes: d.lookalikes,
      unresolved: d.unresolved,
      issues: countIssues(d.violations, d.lookalikes, d.unresolved),
      shot: shots?.screens.find((s) => s.route === route) ?? null,
    }));
  return { screens, unattributed: countIssues(lost.violations, lost.lookalikes, lost.unresolved), unattributedFiles: [...unattributedFiles.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}

/** Every screen of every project, by project, app shell first, then routes by name. */
export function buildScreens(index: UsageIndex, manifest: Manifest): ScreenIndex {
  const shots = projectShots(manifest);
  const sitesByProject = new Map<string, Site[]>();
  for (const sites of index.sitesByElement.values()) {
    for (const site of sites) {
      const list = sitesByProject.get(site.project);
      if (list) list.push(site);
      else sitesByProject.set(site.project, [site]);
    }
  }
  const reports = [...index.reports].sort((a, b) => a.project.localeCompare(b.project));
  const built = reports.map((report) => projectScreens(report, sitesByProject.get(report.project) ?? [], shots.get(report.project)));
  const screens = built.flatMap((b) => b.screens);
  return {
    screens,
    byHref: new Map(screens.map((s) => [screenHref(s.project, s.route), s])),
    unattributed: built.reduce((sum, b) => addIssues(sum, b.unattributed), NO_ISSUES),
    unattributedFiles: built.flatMap((b) => b.unattributedFiles),
    shots,
  };
}

export interface ElementScreen {
  readonly screen: Screen;
  /** This element's sites on that screen. */
  readonly sites: number;
}

/** The routed screens an element renders on, most sites first; the app shell goes last because it is on every screen. */
export function screensOfElement(screens: ScreenIndex, id: ElementId): ElementScreen[] {
  return screens.screens
    .flatMap((screen): ElementScreen[] => {
      if (screen.route === UNROUTED) return [];
      const sites = screen.elements.find((e) => e.id === id)?.sites.length ?? 0;
      return sites > 0 ? [{ screen, sites }] : [];
    })
    .sort((a, b) => Number(a.screen.route === EVERY_SCREEN) - Number(b.screen.route === EVERY_SCREEN) || b.sites - a.sites);
}

const built = new WeakMap<UsageIndex, ScreenIndex>();

/** buildScreens, once per usage index (the index and the manifest load together and never change). */
export function screensOf(index: UsageIndex, manifest: Manifest): ScreenIndex {
  const cached = built.get(index);
  if (cached) return cached;
  const result = buildScreens(index, manifest);
  built.set(index, result);
  return result;
}
