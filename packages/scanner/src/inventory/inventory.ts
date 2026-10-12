/**
 * `youi inventory`: every UI element across one or more projects, with no design system.
 * Each project is read on its own (collect.ts); looks are then grouped per role across all of
 * them by resolved shape (cluster.ts), and the flags compare definitions across projects.
 */
import { relative } from "node:path";
import { INVENTORY_ROLES, SHAPE_DIMENSIONS, type InventoryFamily, type InventoryFlag, type InventoryLook, type InventoryReport, type InventoryShape } from "@youiyoux/core";
import { SCANNER_VERSION } from "../identity.ts";
import { clusterShapeOf, clusterShapes, compareShapes, DEFAULT_TOLERANCE, type ClusterShape, type Tolerance } from "./cluster.ts";
import { collectProject, type ProjectInventory } from "./collect.ts";
import { hasShape } from "./style.ts";
import { loadInventoryTarget, type TargetGlobs } from "./target.ts";

export interface InventoryOptions extends TargetGlobs {
  readonly tolerance?: Tolerance;
  /** Examples kept per family and per side. */
  readonly examples?: number;
  /** Where relative project roots are reported from (default: the current directory). */
  readonly cwd?: string;
}

const EXAMPLES = 5;
const SIDE_EXAMPLES = 3;

type Look = Omit<InventoryLook, "family">;

const shapeKey = (shape: ClusterShape): string => `${SHAPE_DIMENSIONS.map((d) => shape[d] ?? "?").join("/")}${shape.fixedHeight ? "" : "~"}`;
const plainShape = ({ fixedHeight: _, ...shape }: ClusterShape): InventoryShape => shape;
const byPlace = (a: Look, b: Look): number => a.project.localeCompare(b.project) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
const example = (look: Look): InventoryFamily["examples"][number] => ({ project: look.project, file: look.file, line: look.line, column: look.column, tag: look.tag, routes: look.routes });

/** Up to `count` items taking one from each list in turn, so every side of a family shows. */
function roundRobin<T>(lists: readonly (readonly T[])[], count: number): T[] {
  const picked: T[] = [];
  for (let i = 0; picked.length < count && lists.some((l) => l.length > i); i++) for (const list of lists) if (i < list.length && picked.length < count) picked.push(list[i]!);
  return picked;
}

/** Families for one role across every project: complete-link over distinct shapes. */
export function familiesOf(role: InventoryLook["role"], looks: readonly Look[], tolerance: Tolerance = DEFAULT_TOLERANCE, projectOrder: readonly string[] = [], examples = EXAMPLES): Array<{ family: InventoryFamily; members: Look[] }> {
  const byShape = new Map<string, { shape: ClusterShape; looks: Look[] }>();
  for (const look of looks) {
    const shape = clusterShapeOf(look);
    const key = shapeKey(shape);
    const entry = byShape.get(key) ?? { shape, looks: [] };
    entry.looks.push(look);
    byShape.set(key, entry);
  }
  const distinct = [...byShape.values()].sort((a, b) => compareShapes(a.shape, b.shape));
  const groups = clusterShapes(distinct.map((d) => d.shape), "complete", tolerance).map((indexes) => indexes.map((i) => distinct[i]!));
  const rank = (project: string): number => (projectOrder.includes(project) ? projectOrder.indexOf(project) : projectOrder.length);
  const families = groups.map((group) => {
    const members = group.flatMap((g) => g.looks).sort((a, b) => rank(a.project) - rank(b.project) || byPlace(a, b));
    const common = [...group].sort((a, b) => b.looks.length - a.looks.length || compareShapes(a.shape, b.shape))[0]!;
    const range = Object.fromEntries(
      SHAPE_DIMENSIONS.map((d) => {
        const values = group.map((g) => g.shape[d]).filter((v): v is number => v !== null);
        return [d, values.length > 0 ? [Math.min(...values), Math.max(...values)] : null];
      }),
    ) as InventoryFamily["range"];
    const sideKeys = new Map<string, Look[]>();
    for (const look of members) sideKeys.set(`${look.project}\0${look.kit ?? ""}`, [...(sideKeys.get(`${look.project}\0${look.kit ?? ""}`) ?? []), look]);
    // Project order, then each project's kits before its hand-styled looks.
    const sideLists = [...sideKeys.values()].sort((a, b) => rank(a[0]!.project) - rank(b[0]!.project) || Number(a[0]!.kit === null) - Number(b[0]!.kit === null) || (a[0]!.kit ?? "").localeCompare(b[0]!.kit ?? ""));
    const sides = sideLists.map((side) => ({ project: side[0]!.project, kit: side[0]!.kit, looks: side.length, examples: side.slice(0, SIDE_EXAMPLES).map(example) }));
    const projects = [...new Set(members.map((l) => l.project))];
    const kits = [...new Set(members.flatMap((l) => (l.kit ? [l.kit] : [])))].sort();
    const kitValues = new Set(members.map((l) => l.kit));
    const family: InventoryFamily = {
      id: "",
      role,
      shape: plainShape(common.shape),
      range,
      looks: members.length,
      shapes: new Set(group.map((g) => shapeKey(plainShape(g.shape)))).size,
      projects,
      kits,
      examples: roundRobin(sideLists, examples).map(example),
      nearDuplicate: projects.length > 1 || kitValues.size > 1,
      sides,
    };
    return { family, members };
  });
  families.sort((a, b) => b.family.looks - a.family.looks || compareShapes(a.family.shape, b.family.shape));
  families.forEach((f, i) => (f.family.id = `${role}-${i + 1}`));
  return families;
}

function flagsOf(projects: readonly ProjectInventory[]): InventoryFlag[] {
  const flags: InventoryFlag[] = [];
  const byName = new Map<string, ProjectInventory["definitions"]>();
  for (const project of projects) {
    for (const definition of project.definitions) {
      if (definition.kind === "class") continue;
      byName.set(definition.name, [...(byName.get(definition.name) ?? []), definition]);
    }
  }
  for (const [name, definitions] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (new Set(definitions.map((d) => `${d.project}:${d.file}`)).size < 2) continue;
    flags.push({ kind: "duplicate-definition", name, locations: definitions.map((d) => ({ project: d.project, file: d.file, line: d.line, kit: d.kit })) });
  }
  for (const project of projects) {
    for (const [file, imports] of [...project.kitImports].sort(([a], [b]) => a.localeCompare(b))) {
      for (const role of INVENTORY_ROLES) {
        const same = imports.filter((i) => i.role === role);
        // Two kits or more make the flag; it then lists every import statement, once each.
        if (new Set(same.map((i) => i.kit)).size < 2) continue;
        const statements = new Map<string, { kit: string; names: string[]; specifier: string; line: number }>();
        for (const { kit, name, specifier, line } of same) {
          const key = `${specifier}\0${line}\0${kit}`;
          const entry = statements.get(key) ?? { kit, names: [], specifier, line };
          if (!entry.names.includes(name)) entry.names.push(name);
          statements.set(key, entry);
        }
        const entries = [...statements.values()].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier) || a.kit.localeCompare(b.kit));
        flags.push({ kind: "mixed-kits", project: project.id, file, role, imports: entries.map(({ kit, names, specifier, line }) => ({ kit, name: names.join(", "), specifier, line })) });
      }
    }
  }
  return flags;
}

/** Inventory every directory in `dirs` (one project each) and group their looks together. */
export async function buildInventory(dirs: readonly string[], options: InventoryOptions = {}): Promise<InventoryReport> {
  const started = performance.now();
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const cwd = options.cwd ?? process.cwd();
  const targets = [];
  const ids = new Set<string>();
  for (const dir of dirs) {
    const target = await loadInventoryTarget(dir, { ...(options.include ? { include: options.include } : {}), ...(options.exclude ? { exclude: options.exclude } : {}) });
    let id = target.id;
    for (let n = 2; ids.has(id); n++) id = `${target.id}-${n}`;
    ids.add(id);
    targets.push({ ...target, id, label: relative(cwd, target.root) || "." });
  }
  const projects = await Promise.all(targets.map(collectProject));
  const looks = projects.flatMap((p) => p.looks);
  const familyOf = new Map<string, string>();
  const families: InventoryFamily[] = [];
  for (const role of INVENTORY_ROLES) {
    const shaped = looks.filter((l) => l.role === role && hasShape(l.shape));
    for (const { family, members } of familiesOf(role, shaped, tolerance, targets.map((t) => t.id), options.examples)) {
      families.push(family);
      for (const member of members) familyOf.set(member.id, family.id);
    }
  }
  const allLooks = looks.map((look) => ({ ...look, family: familyOf.get(look.id) ?? null }));
  return {
    schema: "youi.inventory/v1",
    scanner: SCANNER_VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    tolerance,
    projects: projects.map((p) => ({ id: p.id, root: p.target.label, commit: p.commit, status: p.failed.length > 0 ? "partial" : "complete", files: p.target.files.length, routes: p.target.routeSource, failed: p.failed, warnings: p.warnings })),
    definitions: projects.flatMap((p) => p.definitions),
    kits: projects.flatMap((p) => p.kits),
    primitives: projects.flatMap((p) => p.primitives),
    looks: allLooks,
    families,
    flags: flagsOf(projects),
    summary: {
      looks: allLooks.length,
      clustered: allLooks.filter((l) => l.family !== null).length,
      unshaped: allLooks.filter((l) => l.family === null).length,
      notClustered: allLooks.reduce((n, l) => n + l.responsive.length + l.states.length, 0),
    },
  };
}
