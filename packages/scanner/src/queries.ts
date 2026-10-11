/**
 * Read queries over a scan and the definitions, shared by the CLI and the MCP
 * server so a person and an agent get the same facts. Results are compact and
 * bounded (pagination, top-N) so an agent lookup stays around 2 KB.
 */
import { matchesQuery, systemStage, type ComponentContract, type PropValue, type ScanReport, type UsageSite } from "@youiyoux/core";
import { cssValue } from "@youiyoux/tokens";
import { ruleCapability } from "./capabilities.ts";
import type { TokenIndex } from "./checks.ts";
import { assertSystemQuery } from "./library.ts";
import type { Project } from "./project.ts";

/** A System contract by id, name or part name. A Library id (`lib:…`) is refused, never looked up. */
export function findContract(project: Project, query: string): ComponentContract | null {
  assertSystemQuery(query);
  const q = query.trim();
  return project.system.components.find(({ contract }) => matchesQuery(contract.id, q) || contract.name.toLowerCase() === q.toLowerCase() || contract.source.also.some((p) => p.toLowerCase() === q.toLowerCase()))?.contract ?? null;
}

export function importLine(project: Project, contract: ComponentContract): string {
  const names = [contract.source.export, ...contract.source.also].join(", ");
  return `import { ${names} } from "${project.config.importFrom ?? project.config.componentsDir}";`;
}

const MAX_PROP_TEXT = 40;

/**
 * `variant=outline size=sm`. With `keep`, only those props are spelled out and the rest are
 * counted (`+2`), so a site reads as its design-relevant choices, not its event handlers.
 */
export function formatProps(props: Readonly<Record<string, PropValue>>, spread = false, keep?: ReadonlySet<string>): string {
  const entries = Object.entries(props);
  const shown = keep ? entries.filter(([name]) => keep.has(name)) : entries;
  const parts = shown.map(([name, value]) => {
    if ("literal" in value) return value.literal === true ? name : `${name}=${String(value.literal)}`;
    const text = value.dynamic.length > MAX_PROP_TEXT ? `${value.dynamic.slice(0, MAX_PROP_TEXT - 1)}…` : value.dynamic;
    return `${name}={${text}}`;
  });
  const hidden = entries.length - shown.length;
  if (hidden > 0) parts.push(`+${hidden}`);
  if (spread) parts.push("{...spread}");
  return parts.join(" ");
}

function designProps(contract: ComponentContract): Set<string> {
  return new Set(Object.entries(contract.props).filter(([, spec]) => spec.type === "enum" || spec.type === "boolean").map(([name]) => name));
}

export interface Coverage {
  readonly status: ScanReport["status"];
  readonly commit: string | null;
  readonly scannedAt: string;
  readonly files: number;
  readonly failed: number;
}

export function coverageOf(report: ScanReport): Coverage {
  return { status: report.status, commit: report.commit?.slice(0, 12) ?? null, scannedAt: report.generatedAt, files: report.coverage.filesScanned, failed: report.coverage.failed.length };
}

export interface WhereOptions {
  readonly route?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WhereResult {
  readonly element: string;
  readonly name: string;
  readonly version: string;
  readonly status: string;
  readonly import: string;
  readonly total: number;
  readonly files: number;
  readonly screens: number;
  readonly byRoute: ReadonlyArray<{ route: string; sites: number }>;
  readonly unrouted: number;
  /** Unresolved sites that may be this element by name: in scope, never counted. */
  readonly unknown: ReadonlyArray<{ at: string; name: string; reason: string }>;
  /** Same-named components that resolve elsewhere. */
  readonly lookalikes: ReadonlyArray<{ resolved: string; sites: number }>;
  readonly props: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly sites: ReadonlyArray<{ at: string; use: string; props: string; routes: readonly string[] }>;
  readonly nextOffset: number | null;
  readonly coverage: Coverage;
}

function propHistogram(sites: readonly UsageSite[], contract: ComponentContract): Record<string, Record<string, number>> {
  const histogram: Record<string, Record<string, number>> = {};
  for (const [prop, spec] of Object.entries(contract.props)) {
    if (spec.type !== "enum") continue;
    const counts: Record<string, number> = {};
    for (const site of sites) {
      if (site.kind === "reference" || (site.kind === "render" && site.export !== contract.source.export)) continue;
      const value = site.props[prop];
      const key = value === undefined ? "(unset)" : "literal" in value ? String(value.literal) : "(dynamic)";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    histogram[prop] = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  }
  return histogram;
}

export function whereUsed(project: Project, report: ScanReport, query: string, options: WhereOptions = {}): WhereResult {
  const contract = findContract(project, query);
  if (!contract) throw new Error(`no component "${query}"; known: ${project.system.components.map((c) => c.contract.name).join(", ")}`);
  const all = report.usages.filter((u) => u.element === contract.id);
  const inRoute = options.route ? all.filter((u) => u.routes.includes(options.route!)) : all;
  const routes = new Map<string, number>();
  for (const site of all) for (const route of site.routes) routes.set(route, (routes.get(route) ?? 0) + 1);
  const lookalikes = new Map<string, number>();
  for (const l of report.lookalikes) if (l.resembles === contract.id) lookalikes.set(l.resolved, (lookalikes.get(l.resolved) ?? 0) + 1);
  const limit = options.limit ?? 20;
  const keep = designProps(contract);
  const offset = options.offset ?? 0;
  const page = inRoute.slice(offset, offset + limit);
  return {
    element: contract.id,
    name: contract.name,
    version: contract.version,
    status: contract.status,
    import: importLine(project, contract),
    total: all.length,
    files: new Set(all.map((s) => s.file)).size,
    screens: [...routes.keys()].filter((r) => r !== "*").length,
    byRoute: [...routes].sort((a, b) => b[1] - a[1]).map(([route, sites]) => ({ route, sites })),
    unrouted: all.filter((s) => s.routeSource === "unrouted").length,
    unknown: report.unknowns.filter((u) => u.candidate === contract.id).map((u) => ({ at: `${u.file}:${u.line}`, name: u.name, reason: u.reason })),
    lookalikes: [...lookalikes].map(([resolved, sites]) => ({ resolved, sites })),
    props: propHistogram(all, contract),
    sites: page.map((s) => ({ at: `${s.file}:${s.line}`, use: s.kind === "render" ? `<${s.local}>` : s.kind === "variants" ? `${s.local}()` : s.local, props: formatProps(s.props, s.spread, keep), routes: s.routes })),
    nextOffset: offset + limit < inRoute.length ? offset + limit : null,
    coverage: coverageOf(report),
  };
}

export interface ScreenBom {
  readonly route: string;
  readonly files: readonly string[];
  readonly elements: ReadonlyArray<{ element: string; name: string; sites: number; props: Readonly<Record<string, number>> }>;
  readonly lookalikes: ReadonlyArray<{ resolved: string; sites: number }>;
  readonly violations: Readonly<Record<string, number>>;
  readonly coverage: Coverage;
}

export function screenBom(project: Project, report: ScanReport, route: string): ScreenBom {
  const sites = report.usages.filter((u) => u.routes.includes(route));
  const files = new Set(sites.map((s) => s.file));
  const byElement = Map.groupBy(sites, (s) => s.element);
  const elements = [...byElement].map(([element, list]) => {
    const name = project.system.components.find((c) => c.contract.id === element)?.contract.name ?? element;
    const props: Record<string, number> = {};
    const contract = project.system.components.find((c) => c.contract.id === element)?.contract;
    const keep = contract ? designProps(contract) : undefined;
    for (const site of list) {
      const design = keep ? Object.fromEntries(Object.entries(site.props).filter(([name]) => keep.has(name))) : site.props;
      const key = formatProps(design, site.spread) || "(defaults)";
      props[key] = (props[key] ?? 0) + 1;
    }
    return { element, name, sites: list.length, props: Object.fromEntries(Object.entries(props).sort((a, b) => b[1] - a[1]).slice(0, 5)) };
  });
  const lookalikes = new Map<string, number>();
  for (const l of report.lookalikes) if (files.has(l.file)) lookalikes.set(l.resolved, (lookalikes.get(l.resolved) ?? 0) + 1);
  const violations: Record<string, number> = {};
  for (const v of report.violations) if (files.has(v.file)) violations[v.rule] = (violations[v.rule] ?? 0) + 1;
  return { route, files: [...files].sort(), elements: elements.sort((a, b) => b.sites - a.sites), lookalikes: [...lookalikes].map(([resolved, n]) => ({ resolved, sites: n })), violations, coverage: coverageOf(report) };
}

export interface SearchHit {
  readonly id: string;
  readonly kind: "component" | "token" | "rule";
  readonly name: string;
  readonly summary: string;
}

export function searchElements(project: Project, tokens: TokenIndex, query: string, limit = 20): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (text: string): number => words.reduce((n, w) => n + (text.toLowerCase().includes(w) ? 1 : 0), 0);
  const system = project.system.config.id;
  const hits: Array<SearchHit & { score: number }> = [
    ...project.system.components.map(({ contract: c }) => ({ id: c.id, kind: "component" as const, name: c.name, summary: c.summary, score: score(`${c.name} ${c.summary} ${Object.entries(c.props).map(([k, v]) => `${k} ${v.type === "enum" ? v.values.join(" ") : ""}`).join(" ")} ${c.guidance.do.join(" ")}`) * 3 })),
    ...project.system.rules.map((r) => ({ id: r.id, kind: "rule" as const, name: r.title, summary: r.agent, score: score(`${r.id} ${r.title} ${r.statement}`) * 2 })),
    ...tokens.tokens.map((t) => ({ id: `youi:${system}/token/${t.id}`, kind: "token" as const, name: t.id, summary: (t.description ?? cssValue(t.type, t.light)).slice(0, 120), score: score(`${t.id} ${t.cssName} ${t.description ?? ""}`) })),
  ];
  return hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _score, ...hit }) => hit);
}

/** A contract trimmed for agents: what to import, which values are legal, how to use it. */
export function componentCard(project: Project, contract: ComponentContract, report?: ScanReport): Record<string, unknown> {
  const props = Object.fromEntries(
    Object.entries(contract.props).map(([name, spec]) => [name, spec.type === "enum" ? { values: spec.values, ...(spec.default ? { default: spec.default } : {}), ...(spec.description ? { note: spec.description } : {}) } : { type: spec.type, ...(spec.required ? { required: true } : {}) }]),
  );
  const sites = report?.usages.filter((u) => u.element === contract.id);
  return {
    id: contract.id,
    name: contract.name,
    version: contract.version,
    status: contract.status,
    summary: contract.summary,
    import: importLine(project, contract),
    ...(contract.source.also.length ? { parts: contract.source.also } : {}),
    props,
    ...(contract.passthrough ? { passthrough: `other <${contract.passthrough}> props pass through` } : {}),
    do: contract.guidance.do,
    dont: contract.guidance.dont,
    a11y: contract.a11y.notes,
    examples: contract.examples,
    rules: contract.rules,
    ...(sites ? { ...(report?.status === "complete" ? { stage: systemStage(sites.length) } : {}), usage: { sites: sites.length, screens: new Set(sites.flatMap((s) => s.routes)).size } } : {}),
  };
}

const UTILITY_PREFIX: Record<string, string> = { color: "bg", radius: "rounded", text: "text", shadow: "shadow", spacing: "p", ease: "ease", font: "font" };

/** A Tailwind theme key as a class an agent can write: color-primary → bg-primary (also text-, border-). */
function utilityExample(key: string): string {
  const [namespace = "", ...rest] = key.split("-");
  return `${UTILITY_PREFIX[namespace] ?? namespace}-${rest.join("-")}`;
}

/** Tokens as a compact table (column names once, then rows); `dark` is empty when it equals `light`. */
export function tokenRows(project: Project, tokens: TokenIndex, group?: string, limit = 60): { columns: string[]; rows: string[][]; total: number; truncated: boolean } {
  const rows = tokens.tokens
    .filter((t) => !group || t.id === group || t.id.startsWith(`${group}.`))
    .map((t) => {
      const light = cssValue(t.type, t.light);
      const dark = cssValue(t.type, t.dark);
      const key = tokens.themeKeys.get(t.id)?.[0];
      const utility = key ? utilityExample(key) : "";
      return [t.id, `--${tokens.prefix}-${t.cssName}`, t.aliasOf ? `{${t.aliasOf}}` : light, dark === light || t.aliasOf ? "" : dark, utility];
    });
  return { columns: ["id", "cssVar", "light", "dark", "utility"], rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
}

/**
 * Rules for agents: what each asks and whether `youi check` actually enforces it. `off` rules are
 * left out entirely; a check this youi cannot run says so instead of claiming enforcement.
 */
export function ruleRows(project: Project): Array<Record<string, unknown>> {
  return project.system.rules.flatMap((r) => {
    const execution = ruleCapability(r);
    if (execution.state === "off") return [];
    return [
      {
        id: r.id,
        title: r.title,
        severity: r.severity,
        enforced: execution.state === "enforced",
        execution: execution.state,
        ...(execution.state === "unsupported" ? { notChecked: execution.reason } : {}),
        do: r.agent,
        ...(r.examples.bad.length ? { bad: r.examples.bad[0] } : {}),
        ...(r.examples.good.length ? { good: r.examples.good[0] } : {}),
      },
    ];
  });
}
