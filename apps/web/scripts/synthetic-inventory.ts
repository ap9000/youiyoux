/**
 * A synthetic inventory of any size, for measuring that the Inventory page's first paint does
 * not grow with the library: the fixtures' looks repeated across generated files, each copy a
 * little taller (so families multiply, as in a real library) and with its own label (so every
 * copy is its own specimen), then grouped into families the way `youi inventory` groups them.
 */
import type { InventoryLook, InventoryReport } from "@youiyoux/core";

type Look = Omit<InventoryLook, "family">;
type FamiliesOf = (role: InventoryLook["role"], looks: readonly Look[], tolerance: InventoryReport["tolerance"], projectOrder: readonly string[]) => Array<{ family: InventoryReport["families"][number]; members: Look[] }>;

const HEIGHT_STEPS = 24;

export function synthesizeInventory(base: InventoryReport, size: number, familiesOf: FamiliesOf): InventoryReport {
  const looks: Look[] = [];
  for (let i = 0; looks.length < size; i++) {
    const { family: _, ...look } = base.looks[i % base.looks.length]!;
    const copy = Math.floor(i / base.looks.length);
    const step = (copy % HEIGHT_STEPS) * 2;
    const file = copy === 0 ? look.file : look.file.replace(/(\.\w+)$/, `.gen${copy}$1`);
    looks.push({
      ...look,
      id: `${look.project}:${file}:${look.line}:${look.column}`,
      file,
      shape: { ...look.shape, height: look.shape.height === null ? null : look.shape.height + step },
      ...(look.recipe?.label && copy > 0 ? { recipe: { ...look.recipe, label: `${look.recipe.label} ${copy}` } } : {}),
    });
  }
  const projectOrder = base.projects.map((p) => p.id);
  const familyOf = new Map<string, string>();
  const families: InventoryReport["families"] = [];
  for (const role of [...new Set(base.looks.map((l) => l.role))]) {
    const shaped = looks.filter((l) => l.role === role && Object.values(l.shape).some((v) => v !== null));
    for (const { family, members } of familiesOf(role, shaped, base.tolerance, projectOrder)) {
      families.push(family);
      for (const member of members) familyOf.set(member.id, family.id);
    }
  }
  const all = looks.map((l) => ({ ...l, family: familyOf.get(l.id) ?? null }));
  return {
    ...base,
    looks: all,
    families,
    summary: { looks: all.length, clustered: all.filter((l) => l.family !== null).length, unshaped: all.filter((l) => l.family === null).length, notClustered: all.reduce((n, l) => n + l.responsive.length + l.states.length, 0) },
  };
}
