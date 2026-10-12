/**
 * Impact preview for a style draft. The design repository's token files at the draft's base
 * commit are built twice, as published and with the draft's edits, in throwaway directories
 * (the design repository is only read). Every token whose resolved value differs, in either
 * scheme, is a change; the project's one scan then says what reads them: contracts that bind
 * them (at rest or in a state) or whose implementation uses them, every usage-map site of
 * those contracts, and every direct use of their CSS variables and Tailwind utilities.
 * Colour pairs are graded before and after against WCAG AA.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComponentContract } from "@youiyoux/core";
import { tokenImpact, type Project, type ScanResult } from "@youiyoux/scanner";
import { buildTokens, contrastText, cssValue, gradePairs, ringOffset, systemPairs, type ContrastContract, type ContrastFinding, type ContrastRing, type ContrastText, type ContrastToken, type ResolvedToken } from "@youiyoux/tokens";
import type { StyleContrast, StyleDirectUse, StyleDraftContent, StylePreview, StyleSite, StyleTokenChange } from "./api.ts";
import type { DesignFiles } from "./design-files.ts";
import { WorkflowError } from "./policy.ts";
import { effectiveStateEdits, tokenPathOf } from "./style-drafts.ts";

/** Lists stop here so a preview stays loadable; totals always count everything. */
export const MAX_LISTED = 5000;

export type StyleImpact = Omit<StylePreview, "id" | "at" | "draftRevision" | "draftDigest" | "snapshot" | "durationMs" | "scan">;

/** Build the system's tokens from file texts in a throwaway directory. */
async function buildFrom(project: Project, tree: ReadonlyMap<string, string>): Promise<readonly ResolvedToken[]> {
  const root = await mkdtemp(join(tmpdir(), "youi-style-"));
  try {
    for (const [path, text] of tree) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return (await buildTokens(root, project.system.config, project.config.outputs)).tokens;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const listed = (n: number): string => n.toLocaleString("en-US");

const css = (token: ResolvedToken | undefined, scheme: "light" | "dark"): string => (token ? cssValue(token.type, token[scheme]) : "");

/** Colour tokens for the pair finder, plus each focus ring's colour as its own entry (`focus.ring.color`), and the typography for large text. */
function contrastTokens(tokens: readonly ResolvedToken[]): { list: ContrastToken[]; rings: Map<string, ContrastRing>; typography: ContrastText[] } {
  const list: ContrastToken[] = tokens.filter((t) => t.type === "color").map((t) => ({ path: t.id, type: "color", light: css(t, "light"), dark: css(t, "dark") }));
  const rings = new Map<string, ContrastRing>();
  for (const ring of tokens.filter((t) => t.type === "focusRing")) {
    const color = (scheme: "light" | "dark"): string => cssValue("color", (ring[scheme] as { color: unknown }).color);
    list.push({ path: `${ring.id}.color`, type: "color", light: color("light"), dark: color("dark") });
    rings.set(ring.id, { color: `${ring.id}.color`, offset: ringOffset(ring.light) });
  }
  const typography = tokens.filter((t) => t.type === "typography").map((t) => contrastText(t.id, t.light));
  return { list, rings, typography };
}

function contrastContracts(contracts: readonly ComponentContract[], system: string): ContrastContract[] {
  const paths = (roles: Readonly<Record<string, string>> | undefined): Record<string, string> => Object.fromEntries(Object.entries(roles ?? {}).flatMap(([role, id]) => (tokenPathOf(id, system) ? [[role, tokenPathOf(id, system)!]] : [])));
  return contracts.map((c) => ({ id: c.id, name: c.name, tokens: paths(c.tokens), states: Object.fromEntries(Object.entries(c.states ?? {}).map(([state, roles]) => [state, paths(roles)])) }));
}

const findingKey = (f: ContrastFinding): string => `${f.pair.key}|${f.scheme}`;

function compareContrast(before: readonly ContrastFinding[], after: readonly ContrastFinding[], changed: (path: string, scheme: "light" | "dark") => boolean, rebound: ReadonlySet<string>): { list: StyleContrast[]; untouchedFailing: number } {
  const was = new Map(before.map((f) => [findingKey(f), f]));
  const list: StyleContrast[] = [];
  let untouchedFailing = 0;
  for (const finding of after) {
    const previous = was.get(findingKey(finding));
    // A pair that fails now and passed before (or did not exist) is the draft's, whatever moved it (a surface under a translucent fill).
    const introduced = !finding.passes && (!previous || previous.passes);
    const touched = introduced || changed(finding.pair.foreground, finding.scheme) || changed(finding.pair.background, finding.scheme) || (finding.pair.contract !== undefined && rebound.has(finding.pair.contract));
    const entry = (change: StyleContrast["change"]): StyleContrast => ({
      key: findingKey(finding),
      label: finding.pair.label,
      foreground: finding.pair.foreground,
      background: finding.pair.background,
      scheme: finding.scheme,
      kind: finding.pair.kind,
      required: finding.required,
      before: previous?.ratio ?? null,
      after: finding.ratio,
      grade: finding.grade,
      ...(finding.unreadable ? { unreadable: finding.unreadable } : {}),
      change,
    });
    if (!touched) {
      if (!finding.passes) untouchedFailing++;
      continue;
    }
    if (!finding.passes) list.push(entry(previous && !previous.passes ? "kept" : "new"));
    else if (previous && !previous.passes) list.push(entry("fixed"));
  }
  const order = { new: 0, kept: 1, fixed: 2 } as const;
  // Unreadable pairs (no ratio) sort first within their change: they are failures nobody can grade.
  return { list: list.sort((a, b) => order[a.change] - order[b.change] || (a.after ?? 0) - (b.after ?? 0)), untouchedFailing };
}

export async function previewStyle(input: { project: Project; scan: ScanResult; files: DesignFiles; commit: string; content: StyleDraftContent; published: readonly ResolvedToken[] }): Promise<StyleImpact> {
  const { project, scan, files, commit, content, published } = input;
  const system = project.system.config.id;
  const types = new Map(published.map((t) => [t.id, t.type]));
  const rendered = await files.styleFilesFor(commit, content, types);
  if (rendered.problems.length > 0) throw new WorkflowError("invalid", "this draft cannot be written to the design repository", rendered.problems);
  const tree = await files.tokenTree(commit);
  const edited = new Map(tree);
  for (const [path, text] of Object.entries(rendered.files)) if (tree.has(path)) edited.set(path, text);
  let before: readonly ResolvedToken[];
  let after: readonly ResolvedToken[];
  try {
    [before, after] = await Promise.all([buildFrom(project, tree), buildFrom(project, edited)]);
  } catch (error: unknown) {
    throw new WorkflowError("invalid", "the edited tokens do not build", [error instanceof Error ? error.message : String(error)]);
  }

  // Every token whose resolved value moves, in either scheme.
  const beforeById = new Map(before.map((t) => [t.id, t]));
  const editedPaths = new Set(content.tokens.map((t) => t.path));
  const changes: StyleTokenChange[] = after.flatMap((token) => {
    const was = beforeById.get(token.id);
    const light = { before: css(was, "light"), after: css(token, "light") };
    const dark = { before: css(was, "dark"), after: css(token, "dark") };
    if (light.before === light.after && dark.before === dark.after) return [];
    return [{ path: token.id, type: token.type, light, dark, cause: editedPaths.has(token.id) ? "edited" : "follows" }];
  });
  const changed = new Map(changes.map((c) => [c.path, c]));

  // What reads them, from the project's scan (closure over the published aliases, so nothing is counted twice).
  const impact = tokenImpact(project, scan, [...changed.keys()], { maxSites: Number.POSITIVE_INFINITY });
  const contracts = new Map(impact.contracts.map((c) => [c.id, c.via as "binding" | "implementation" | "state"]));
  const contractsBefore = project.system.components.map((c) => c.contract);
  const states = effectiveStateEdits(content, contractsBefore);
  for (const edit of states) if (!contracts.has(edit.component)) contracts.set(edit.component, "state");
  const nameOf = (id: string): string => contractsBefore.find((c) => c.id === id)?.name ?? id;

  const allSites: StyleSite[] = scan.report.usages
    .filter((u) => contracts.has(u.element))
    .map((u) => ({ file: u.file, line: u.line, column: u.column, element: u.element, component: nameOf(u.element), export: u.export, routes: u.routes, routeSource: u.routeSource }));
  const direct: StyleDirectUse[] = impact.direct.sites.map((s) => ({ ...s, routes: scan.routes.of(s.file).routes }));
  const routes = new Map<string, { sites: number; direct: number }>();
  for (const site of allSites) for (const route of site.routes) routes.set(route, { sites: (routes.get(route)?.sites ?? 0) + 1, direct: routes.get(route)?.direct ?? 0 });
  for (const [route, uses] of impact.directRoutes) routes.set(route, { sites: routes.get(route)?.sites ?? 0, direct: (routes.get(route)?.direct ?? 0) + uses });

  // Contrast, before and after: the system's pairs, with the draft's state bindings applied after.
  const contractsAfter = contractsBefore.map((c) => {
    const mine = states.filter((s) => s.component === c.id);
    if (mine.length === 0) return c;
    const next = structuredClone(c) as ComponentContract & { states: NonNullable<ComponentContract["states"]> };
    for (const edit of mine) next.states[edit.state] = { ...next.states[edit.state], [edit.role]: edit.token };
    return next;
  });
  const colorsBefore = contrastTokens(before);
  const colorsAfter = contrastTokens(after);
  const gradedBefore = gradePairs(systemPairs(colorsBefore.list, contrastContracts(contractsBefore, system), { focusRings: colorsBefore.rings, typography: colorsBefore.typography }), colorsBefore.list);
  const gradedAfter = gradePairs(systemPairs(colorsAfter.list, contrastContracts(contractsAfter, system), { focusRings: colorsAfter.rings, typography: colorsAfter.typography }), colorsAfter.list);
  const afterColors = new Map(colorsAfter.list.map((t) => [t.path, t]));
  const beforeColors = new Map(colorsBefore.list.map((t) => [t.path, t]));
  const colorChanged = (path: string, scheme: "light" | "dark"): boolean => beforeColors.get(path)?.[scheme] !== afterColors.get(path)?.[scheme];
  const contrast = compareContrast(gradedBefore, gradedAfter, colorChanged, new Set(states.map((s) => s.component)));

  const siteFiles = new Set(allSites.map((s) => s.file));
  const limits = [
    ...(scan.report.status === "partial" ? [`The scan is partial (${scan.report.coverage.failed.length} file(s) not fully parsed): sites in them may be missing.`] : []),
    ...(allSites.length > 0 ? ["Every site of an affected component is listed, whatever variant it renders: a change that reaches one variant touches fewer of them."] : []),
    "Direct uses are found by name (the CSS variable and its Tailwind utilities): class names built at run time are not seen, so the count is a lower bound.",
    ...(impact.everyScreen ? ["A stylesheet, the app shell or a file no screen is known to import uses a changed token: every screen may change."] : []),
    ...(contrast.untouchedFailing > 0 ? [`${contrast.untouchedFailing} colour pair(s) this draft does not touch are already below WCAG AA.`] : []),
    // The lists stop at MAX_LISTED; say so, with the totals, rather than cutting silently.
    ...(allSites.length > MAX_LISTED ? [`Showing ${listed(MAX_LISTED)} of ${listed(allSites.length)} component sites; the totals count them all.`] : []),
    ...(direct.length > MAX_LISTED ? [`Showing ${listed(MAX_LISTED)} of ${listed(direct.length)} files with direct uses (${listed(impact.direct.uses)} direct uses in all); the totals count them all.`] : []),
    ...(changes.some((c) => c.type === "spring") ? ["Springs are previewed as a CSS linear() easing over their settle time; native platforms run the spring itself."] : []),
  ];
  return {
    tokens: changes,
    contracts: [...contracts].map(([id, via]) => ({ id: id as StylePreview["contracts"][number]["id"], name: nameOf(id), via, sites: allSites.filter((s) => s.element === id).length })),
    sites: allSites.slice(0, MAX_LISTED),
    direct: direct.slice(0, MAX_LISTED),
    routes: [...routes].map(([route, counts]) => ({ route, ...counts })).sort((a, b) => b.sites + b.direct - (a.sites + a.direct) || a.route.localeCompare(b.route)),
    everyScreen: impact.everyScreen,
    totals: {
      tokens: changes.length,
      contracts: contracts.size,
      sites: allSites.length,
      files: new Set([...siteFiles, ...direct.map((d) => d.file)]).size,
      routes: routes.size,
      direct: impact.direct.uses,
      directFiles: impact.direct.files,
    },
    truncated: allSites.length > MAX_LISTED || direct.length > MAX_LISTED,
    contrast: contrast.list,
    limits,
  };
}
