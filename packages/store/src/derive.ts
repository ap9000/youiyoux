/**
 * What the store derives from youiyoux's own files: an inventory report becomes a run (scan
 * rows, families, looks) and its graph; a project's rules and usage map become `governs` and
 * `used-in` edges. Pure functions: the same input always gives the same rows, so a rebuild
 * from the same files answers exactly as before.
 */
import { createHash } from "node:crypto";
import { SHAPE_DIMENSIONS, type InventoryFamily, type InventoryReport, type RuleSpec, type ScanReport } from "@youiyoux/core";
import type { Graph, GraphEdge, GraphNode, InventoryRun } from "./types.ts";

const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

export const nodeId = {
  family: (inventory: string, id: string, project = "") => `family:${short(inventory)}/${encodeURIComponent(project)}/${id}`,
  file: (project: string, file: string) => `file:${project}:${file}`,
  route: (project: string, route: string) => `route:${project}:${route}`,
  project: (id: string) => `project:${id}`,
  library: (name: string) => `library:${name}`,
  candidate: (id: string) => `candidate:${id}`,
  rule: (id: string, project = "") => `rule:${encodeURIComponent(project)}:${id}`,
  component: (id: string, project = "") => `component:${encodeURIComponent(project)}:${id}`,
};

class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  node(node: GraphNode): string {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    return node.id;
  }
  edge(from: string, to: string, kind: GraphEdge["kind"]): void {
    if (from !== to) this.edges.set(`${from}\0${to}\0${kind}`, { from, to, kind });
  }
  build(): Graph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

const TOLERANCE_KEY = { height: "height", paddingX: "padding", paddingY: "padding", radius: "radius", fontSize: "fontSize", fontWeight: "fontWeight" } as const;

/**
 * Two families of one role are near-duplicates when they come from different kits and every
 * dimension both resolve is within twice the clustering tolerance (they missed one family by
 * a step), with at least two dimensions to compare.
 */
export function nearDuplicatePairs(families: readonly InventoryFamily[], tolerance: InventoryReport["tolerance"]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < families.length; i++) {
    for (let j = i + 1; j < families.length; j++) {
      const a = families[i]!;
      const b = families[j]!;
      if (a.role !== b.role) continue;
      if (a.kits.length > 0 && b.kits.length > 0 && a.kits.every((k) => b.kits.includes(k)) && b.kits.every((k) => a.kits.includes(k))) continue;
      let compared = 0;
      let close = true;
      for (const dimension of SHAPE_DIMENSIONS) {
        const x = a.shape[dimension];
        const y = b.shape[dimension];
        if (x === null || y === null) continue;
        compared++;
        if (Math.abs(x - y) > 2 * tolerance[TOLERANCE_KEY[dimension]]) close = false;
      }
      if (close && compared >= 2) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

/** An inventory report as one run. `source` names where it came from (the inventory file). */
export function inventoryRun(report: InventoryReport, source: string): InventoryRun {
  const run = `${report.generatedAt}#${short(`${source}\0${report.generatedAt}`).slice(0, 8)}`;
  const g = new GraphBuilder();
  const familyNode = (id: string, project: string) => g.node({ id: nodeId.family(source, id, project), kind: "family", ref: id, project });
  for (const family of report.families) for (const project of family.projects) familyNode(family.id, project);
  // Storybook stories are authored states, not uses: no edges, rows or counts come from them.
  const uses = report.looks.filter((l) => !l.story);
  for (const look of uses) {
    if (!look.family) continue;
    const file = g.node({ id: nodeId.file(look.project, look.file), kind: "file", ref: `${look.project}:${look.file}` });
    g.edge(familyNode(look.family, look.project), file, "used-in");
    for (const route of look.routes) g.edge(file, g.node({ id: nodeId.route(look.project, route), kind: "route", ref: `${look.project}:${route}` }), "used-in");
  }
  for (const [a, b] of nearDuplicatePairs(report.families, report.tolerance)) {
    const projects = report.families.find((f) => f.id === a)!.projects.filter((p) => report.families.find((f) => f.id === b)!.projects.includes(p));
    for (const project of projects) {
      g.edge(familyNode(a, project), familyNode(b, project), "near-duplicate-of");
      g.edge(familyNode(b, project), familyNode(a, project), "near-duplicate-of");
    }
  }
  for (const primitive of report.primitives) g.edge(g.node({ id: nodeId.project(primitive.project), kind: "project", ref: primitive.project }), g.node({ id: nodeId.library(primitive.package), kind: "library", ref: primitive.package }), "uses-library");
  for (const kit of report.kits) g.edge(g.node({ id: nodeId.project(kit.project), kind: "project", ref: kit.project }), g.node({ id: nodeId.library(kit.id), kind: "library", ref: kit.id }), "uses-library");

  const roles = (project: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const look of uses) if (look.project === project) counts[look.role] = (counts[look.role] ?? 0) + 1;
    return counts;
  };
  return {
    run,
    source,
    scannedAt: report.generatedAt,
    projects: report.projects.map((p) => {
      const families = report.families.filter((f) => f.projects.includes(p.id));
      return { project: p.id, root: p.root, commit: p.commit, status: p.status, files: p.files, looks: uses.filter((l) => l.project === p.id).length, families: families.length, nearDuplicates: families.filter((f) => f.nearDuplicate).length, roles: roles(p.id) };
    }),
    families: report.families.map((f) => ({ id: f.id, role: f.role, looks: f.looks, nearDuplicate: f.nearDuplicate, projects: f.projects, kits: f.kits, shape: f.shape })),
    looks: uses.map((l) => ({ id: l.id, project: l.project, role: l.role, file: l.file, line: l.line, column: l.column, tag: l.tag, kit: l.kit, family: l.family, routes: l.routes, shape: l.shape })),
    graph: g.build(),
  };
}

export interface ProjectGraphInput {
  readonly project: string;
  readonly rules: readonly Pick<RuleSpec, "id" | "title" | "statement" | "agent" | "check" | "severity">[];
  readonly components: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The usage map's sites (`youiyoux scan`), as much of them as the graph needs. */
  readonly usage: { readonly usages: ReadonlyArray<Pick<ScanReport["usages"][number], "element" | "file"> & { readonly routes: readonly string[] }> } | null;
}

/** Every string inside a value (rule options name the components they map to). */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** The components a rule governs: those its options name, those its words name, and every component for the contract-wide checks. */
export function governedComponents(rule: ProjectGraphInput["rules"][number], components: ProjectGraphInput["components"]): string[] {
  if (rule.severity === "off") return [];
  if (rule.check.engine === "youi" && (rule.check.id === "prop-values" || rule.check.id === "lookalike-component")) return components.map((c) => c.id);
  const named = new Set(rule.check.engine === "youi" ? strings(rule.check.options) : []);
  const words = `${rule.title} ${rule.statement} ${rule.agent}`;
  return components.filter((c) => named.has(c.id) || new RegExp(`(?:^|[^A-Za-z0-9])<?${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9])`).test(words)).map((c) => c.id);
}

/** A project's rules and usage map as a graph: rule governs component, component used-in file, file used-in route. */
export function projectGraph(input: ProjectGraphInput): Graph {
  const g = new GraphBuilder();
  const names = new Map(input.components.map((c) => [c.id, c.name]));
  const component = (id: string) => g.node({ id: nodeId.component(id, input.project), kind: "component", ref: names.get(id) ?? id, project: input.project });
  for (const rule of input.rules) {
    const node = g.node({ id: nodeId.rule(rule.id, input.project), kind: "rule", ref: rule.id, project: input.project });
    for (const id of governedComponents(rule, input.components)) g.edge(node, component(id), "governs");
  }
  for (const site of input.usage?.usages ?? []) {
    const file = g.node({ id: nodeId.file(input.project, site.file), kind: "file", ref: `${input.project}:${site.file}` });
    g.edge(component(site.element), file, "used-in");
    for (const route of site.routes) g.edge(file, g.node({ id: nodeId.route(input.project, route), kind: "route", ref: `${input.project}:${route}` }), "used-in");
  }
  return g.build();
}
