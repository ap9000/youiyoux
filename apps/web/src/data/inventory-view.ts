/**
 * What the Inventory page shows, worked out from its data with no React: the filters and their
 * URL, which chunk files a filter needs, the library or kit each look comes from, a unique plain
 * name per family, counts, the consolidation estimate and the top fixes. The inventory data and
 * its clustering are read, never changed.
 */
import { familyName, ROLE_LABEL, ROLES } from "./inventory.ts";
import type { ChunkLook, DetectReport, InventoryChunk, InventoryExtras, InventoryFamily, InventoryIndex, InventoryRole, InventoryShape } from "./types.ts";

/* ------------------------------------------------------------------------ filters */

export interface Filters {
  /** Element type: one role, or every role. */
  readonly type: InventoryRole | null;
  /** Library or kit id (see LibraryGroup), or every one. */
  readonly lib: string | null;
  readonly project: string | null;
  /** Near-duplicates only. */
  readonly near: boolean;
  /** Search by name or file. */
  readonly q: string;
}

export const NO_FILTERS: Filters = { type: null, lib: null, project: null, near: false, q: "" };

/** `?type=button&lib=css-ui&project=site&near=1&q=toolbar` → filters; unknown roles and projects are dropped. */
export function parseFilters(search: string, index: Pick<InventoryIndex, "projects">): Filters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const type = params.get("type");
  const project = params.get("project");
  return {
    type: type && (ROLES as readonly string[]).includes(type) ? (type as InventoryRole) : null,
    lib: params.get("lib") || null,
    project: project && index.projects.some((p) => p.id === project) ? project : null,
    near: params.get("near") === "1",
    q: (params.get("q") ?? "").trim(),
  };
}

/** Filters → a query string (empty, or starting with `?`), in a fixed order and leaving defaults out. */
export function filtersToSearch(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.lib) params.set("lib", filters.lib);
  if (filters.project) params.set("project", filters.project);
  if (filters.near) params.set("near", "1");
  if (filters.q.trim()) params.set("q", filters.q.trim());
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function activeFilters(filters: Filters): number {
  return [filters.type, filters.lib, filters.project, filters.near || null, filters.q || null].filter((v) => v !== null).length;
}

/**
 * The chunk files a filter needs: one per role and project, so a role or project filter fetches
 * only its own. Library, near-duplicate and search filters need the looks themselves, so they
 * narrow the chunks once loaded.
 */
export function neededChunks(index: Pick<InventoryIndex, "roles">, filters: Pick<Filters, "type" | "project">): string[] {
  return index.roles.filter((r) => !filters.type || r.role === filters.type).flatMap((r) => Object.entries(r.chunks).filter(([project]) => !filters.project || project === filters.project).map(([, file]) => file));
}

/* ---------------------------------------------------------------- library or kit */

/** A library or kit a look comes from, as the filter offers it. */
export interface LibraryGroup {
  /** Stable, for the URL: `plain`, `shadcn`, `radix`, `css-ui`, `css-marketing`. */
  readonly id: string;
  /** For the filter: `shadcn-style`, `.ui-* CSS kit`, `Plain elements`. */
  readonly label: string;
  /** Short, for a family's name: `shadcn-style`, `CSS kit`, `plain`. */
  readonly short: string;
}

export const PLAIN: LibraryGroup = { id: "plain", label: "Plain elements", short: "plain" };
const RADIX_ID = "radix";
/** Radix packages that draw nothing of their own (Slot passes props through): not counted as Radix. */
const RADIX_UTILITIES = new Set(["@radix-ui/react-slot", "@radix-ui/react-compose-refs", "@radix-ui/react-primitive"]);
/** Roles to the detect report's element types. */
const DETECT_TYPE: Readonly<Partial<Record<InventoryRole, string>>> = { button: "button", "link-as-button": "button", input: "input", card: "card", badge: "badge", dialog: "dialog", tabs: "tabs" };

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const slug = (text: string): string => text.toLowerCase().replace(/\.[a-z]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Sorts each look into a library or kit: no kit → plain elements; a folder of cva() components →
 * shadcn-style (named as `youi detect` names shadcn, when its report lists it); a stylesheet kit →
 * a CSS kit by its class prefix (`.ui-*`) or file; and, as well, Radix when its component wraps a
 * Radix primitive (the extras' primitive sites) or the detect report credits Radix for its type.
 */
export class Libraries {
  private readonly kits: ReadonlyMap<string, InventoryExtras["kits"][number]>;
  private readonly shadcnName: string;
  private readonly radixName: string;
  /** Project → files that use a Radix primitive. */
  private readonly radixFiles = new Map<string, Set<string>>();
  private readonly detectRadix: ReadonlySet<string>;

  constructor(extras: Pick<InventoryExtras, "kits" | "primitives"> | null, detect: DetectReport | null = null) {
    this.kits = new Map((extras?.kits ?? []).map((k) => [k.id, k]));
    const named = (id: string): string | undefined => detect?.libraries.find((l) => l.id === id)?.name;
    this.shadcnName = named("shadcn") ?? "shadcn-style";
    this.radixName = named("radix") ?? "Radix";
    for (const p of extras?.primitives ?? []) {
      if (!p.package.startsWith("@radix-ui/") || RADIX_UTILITIES.has(p.package)) continue;
      const files = this.radixFiles.get(p.project) ?? new Set<string>();
      for (const site of p.sites) files.add(site.file);
      this.radixFiles.set(p.project, files);
    }
    this.detectRadix = new Set((detect?.elements ?? []).filter((e) => e.library === RADIX_ID || e.also.includes(RADIX_ID)).map((e) => e.type));
  }

  /** The kit's own group: plain, shadcn-style or a CSS kit. */
  primary(kit: string | null): LibraryGroup {
    if (kit === null) return PLAIN;
    const known = this.kits.get(kit);
    const path = known?.path ?? kit.slice(kit.indexOf(":") + 1);
    const cssFile = known ? known.kind === "class-kit" : /\.(?:s?css|less)$/.test(path);
    if (!cssFile) return { id: "shadcn", label: this.shadcnName, short: this.shadcnName };
    const prefix = known?.prefix?.replace(/-$/, "");
    return prefix ? { id: `css-${slug(prefix)}`, label: `.${prefix}-* CSS kit`, short: "CSS kit" } : { id: `css-${slug(baseName(path))}`, label: `${baseName(path)} CSS kit`, short: "CSS kit" };
  }

  /** Every group a look counts in: its kit's, plus Radix when its component is built on Radix. */
  of(look: Pick<ChunkLook, "kit" | "tag">, project: string, role: InventoryRole): LibraryGroup[] {
    const primary = this.primary(look.kit);
    return this.isRadix(look, project, role, primary) ? [primary, this.radix()] : [primary];
  }

  radix(): LibraryGroup {
    return { id: RADIX_ID, label: this.radixName, short: this.radixName };
  }

  private isRadix(look: Pick<ChunkLook, "kit" | "tag">, project: string, role: InventoryRole, primary: LibraryGroup): boolean {
    if (look.kit === null || primary.id !== "shadcn") return false;
    const kit = this.kits.get(look.kit);
    const member = kit?.members.find((m) => m.name === look.tag);
    if (member && this.radixFiles.get(project)?.has(member.file)) return true;
    const type = DETECT_TYPE[role];
    return type !== undefined && this.detectRadix.has(type);
  }
}

/* ------------------------------------------------------------------- families */

/** A family as the page shows it: the report's family plus what its loaded looks say. */
export interface FamilyView {
  readonly family: InventoryFamily;
  /** The group most of its looks come from: its cell on the wall and its name's last part. */
  readonly primary: LibraryGroup;
  /** Every group any of its looks comes from (the library filter matches any). */
  readonly libs: readonly LibraryGroup[];
  /** Its loaded looks, with their project. */
  readonly looks: ReadonlyArray<ChunkLook & { project: string }>;
  /** Unique across the page. */
  readonly name: string;
  readonly uses: number;
  readonly projects: number;
  /** Storybook stories drawn beside its uses (never counted among them). */
  readonly stories: number;
  /** Only stories have its shape: no use in any project does. */
  readonly authored: boolean;
}

/** The report's order, which family ids number (button-1, button-2, …). */
const familyOrder = (a: InventoryFamily, b: InventoryFamily): number => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1));

/** Families from the loaded chunks, each with its looks, groups and a unique name. */
export function familyViews(chunks: readonly InventoryChunk[], libraries: Libraries): FamilyView[] {
  const families = new Map<string, InventoryFamily>();
  const looks = new Map<string, Array<ChunkLook & { project: string }>>();
  const groups = new Map<string, Map<string, { group: LibraryGroup; looks: number; primary: boolean }>>();
  for (const chunk of chunks) {
    for (const family of chunk.families) families.set(family.id, family);
    for (const look of chunk.looks) {
      if (look.family === null) continue;
      const list = looks.get(look.family) ?? [];
      list.push({ ...look, project: chunk.project });
      looks.set(look.family, list);
      const tally = groups.get(look.family) ?? new Map();
      libraries.of(look, chunk.project, chunk.role).forEach((group, i) => {
        const entry = tally.get(group.id) ?? { group, looks: 0, primary: false };
        entry.looks++;
        entry.primary ||= i === 0;
        tally.set(group.id, entry);
      });
      groups.set(look.family, tally);
    }
  }
  const sorted = [...families.values()].sort(familyOrder);
  const base = sorted.map((family) => {
    const tally = [...(groups.get(family.id)?.values() ?? [])];
    // Without loaded looks (a project filter), the family's own kits say where it comes from.
    const fallback = (family.sides.length > 0 ? family.sides.map((s) => s.kit) : [null]).map((kit) => libraries.primary(kit));
    const primary = tally.filter((t) => t.primary).sort((a, b) => b.looks - a.looks)[0]?.group ?? fallback[0]!;
    const libs = tally.length > 0 ? tally.map((t) => t.group) : fallback;
    return { family, primary, libs: uniqueGroups(libs), looks: looks.get(family.id) ?? [], uses: family.looks, projects: family.projects.length, stories: family.stories ?? 0, authored: family.authored === true };
  });
  const names = uniqueNames(base.map((v) => ({ id: v.family.id, family: v.family, kit: v.primary })));
  return base.map((v) => ({ ...v, name: names.get(v.family.id)! }));
}

function uniqueGroups(groups: readonly LibraryGroup[]): LibraryGroup[] {
  const seen = new Map<string, LibraryGroup>();
  for (const g of groups) if (!seen.has(g.id)) seen.set(g.id, g);
  return [...seen.values()];
}

const px = (n: number | null): string | null => (n === null ? null : `${n}px`);

/**
 * A plain name per family, unique on the page: role, height and radius (familyName), then its
 * kit (`Button · 32px · radius 8 · CSS kit`); when two still match, the first of padding, text
 * size, weight, kit, project that tells them apart, and the id as a last resort.
 */
export function uniqueNames(items: ReadonlyArray<{ id: string; family: Pick<InventoryFamily, "role" | "shape" | "projects">; kit: LibraryGroup }>): Map<string, string> {
  const extras: Array<(item: (typeof items)[number]) => string | null> = [
    ({ family: { shape } }) => (shape.paddingX === null && shape.paddingY === null ? null : `padding ${shape.paddingY ?? "?"}/${shape.paddingX ?? "?"}`),
    ({ family: { shape } }) => (shape.fontSize === null ? null : `${px(shape.fontSize)} text`),
    ({ family: { shape } }) => (shape.fontWeight === null ? null : `weight ${shape.fontWeight}`),
    ({ kit }) => (kit.label !== kit.short ? kit.label : null),
    ({ family }) => family.projects.join(" + "),
  ];
  const names = new Map(items.map((item) => [item.id, `${familyName(item.family)} · ${item.kit.short}`]));
  const collisions = (): Array<(typeof items)[number][]> => {
    const byName = new Map<string, Array<(typeof items)[number]>>();
    for (const item of items) byName.set(names.get(item.id)!, [...(byName.get(names.get(item.id)!) ?? []), item]);
    return [...byName.values()].filter((group) => group.length > 1);
  };
  for (const group of collisions()) {
    // The first detail that differs within the group is added to each of its names.
    const detail = extras.find((extra) => new Set(group.map(extra)).size > 1);
    for (const item of group) {
      const part = detail?.(item);
      names.set(item.id, part ? `${names.get(item.id)} · ${part}` : names.get(item.id)!);
    }
  }
  for (const group of collisions()) for (const item of group) names.set(item.id, `${names.get(item.id)} · ${item.id}`);
  return names;
}

/** Filters a family list; the role and project filters also apply to what was loaded for them. */
export function matches(view: FamilyView, filters: Filters): boolean {
  if (filters.type && view.family.role !== filters.type) return false;
  if (filters.project && !view.family.projects.includes(filters.project)) return false;
  if (filters.lib && !view.libs.some((g) => g.id === filters.lib)) return false;
  if (filters.near && !view.family.nearDuplicate) return false;
  const q = filters.q.trim().toLowerCase();
  if (q) {
    const files = [...view.looks.map((l) => `${l.project}:${l.file}`), ...view.family.examples.map((e) => `${e.project}:${e.file}`)];
    if (![view.name, view.family.id, ...files].some((text) => text.toLowerCase().includes(q))) return false;
  }
  return true;
}

export function filterFamilies(views: readonly FamilyView[], filters: Filters): FamilyView[] {
  return views.filter((v) => matches(v, filters));
}

/* ------------------------------------------------------------------------ counts */

/** A filter option with how many families it would show; null while that is still being counted. */
export interface FilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count: number | null;
}

const narrows = (filters: Filters): boolean => filters.lib !== null || filters.near || filters.q.trim() !== "";

/**
 * Each option's count with every other filter applied. Types and projects come from the index
 * while nothing that needs the looks is on; otherwise from the loaded chunks, and null (still
 * counting) for an option whose chunks are not loaded.
 */
export function filterCounts(index: InventoryIndex, views: readonly FamilyView[], filters: Filters, loaded: (file: string) => boolean, libraries: Libraries) {
  const covered = (f: Pick<Filters, "type" | "project">): boolean => neededChunks(index, f).every(loaded);
  const count = (f: Filters): number => filterFamilies(views, f).length;
  const indexCount = (role: InventoryRole | null, project: string | null): number => {
    if (!project) return index.roles.filter((r) => !role || r.role === role).reduce((n, r) => n + r.families, 0);
    return index.roles.filter((r) => !role || r.role === role).reduce((n, r) => n + (r.cells[project]?.families ?? 0), 0);
  };
  const types: Array<FilterOption<InventoryRole>> = index.roles.map((r) => {
    const f = { ...filters, type: r.role };
    return { value: r.role, label: ROLE_LABEL[r.role], count: !narrows(filters) ? indexCount(r.role, filters.project) : covered(f) ? count(f) : null };
  });
  const projects: Array<FilterOption<string>> = index.projects.map((p) => {
    const f = { ...filters, project: p.id };
    return { value: p.id, label: p.id, count: !narrows(filters) ? indexCount(filters.type, p.id) : covered(f) ? count(f) : null };
  });
  // Libraries, near-duplicates and search need the looks of every role and project in scope.
  const ready = covered(filters);
  const groups = new Map<string, LibraryGroup>();
  for (const v of views) for (const g of v.libs) if (!groups.has(g.id)) groups.set(g.id, g);
  // A library the URL names but no loaded look has, so it can still be cleared.
  if (filters.lib && !groups.has(filters.lib)) groups.set(filters.lib, filters.lib === RADIX_ID ? libraries.radix() : { id: filters.lib, label: filters.lib, short: filters.lib });
  const libs: Array<FilterOption<string>> = [...groups.values()].sort(groupOrder).map((g) => ({ value: g.id, label: g.label, count: ready ? count({ ...filters, lib: g.id }) : null }));
  return {
    types,
    projects,
    libs,
    near: ready ? count({ ...filters, near: true }) : null,
    /** The "All" option of each filter: that filter off, the others on. */
    all: {
      type: !narrows(filters) ? indexCount(null, filters.project) : covered({ ...filters, type: null }) ? count({ ...filters, type: null }) : null,
      project: !narrows(filters) ? indexCount(filters.type, null) : covered({ ...filters, project: null }) ? count({ ...filters, project: null }) : null,
      lib: ready ? count({ ...filters, lib: null }) : null,
    },
  };
}

const GROUP_RANK = ["shadcn", RADIX_ID];
function groupOrder(a: LibraryGroup, b: LibraryGroup): number {
  const rank = (g: LibraryGroup): number => (GROUP_RANK.includes(g.id) ? GROUP_RANK.indexOf(g.id) : g.id === PLAIN.id ? 99 : 2);
  return rank(a) - rank(b) || a.label.localeCompare(b.label);
}

/** A role's families in cells by library or kit, in a fixed order; a cell with no family is left out. */
export function kitCells(views: readonly FamilyView[]): Array<{ group: LibraryGroup; families: FamilyView[] }> {
  const cells = new Map<string, { group: LibraryGroup; families: FamilyView[] }>();
  for (const v of views) {
    const cell = cells.get(v.primary.id) ?? { group: v.primary, families: [] };
    cell.families.push(v);
    cells.set(v.primary.id, cell);
  }
  return [...cells.values()].filter((c) => c.families.length > 0).sort((a, b) => groupOrder(a.group, b.group));
}

/* ---------------------------------------------------------- consolidation and fixes */

type Tolerance = InventoryIndex["tolerance"];
const DIMENSIONS: ReadonlyArray<[keyof InventoryShape, keyof Tolerance]> = [
  ["height", "height"],
  ["paddingX", "padding"],
  ["paddingY", "padding"],
  ["radius", "radius"],
  ["fontSize", "fontSize"],
  ["fontWeight", "fontWeight"],
];

/** True when two shapes are within one tolerance step on every dimension both know. */
export function withinStep(a: InventoryShape, b: InventoryShape, tolerance: Tolerance): boolean {
  return DIMENSIONS.every(([dimension, tol]) => {
    const x = a[dimension];
    const y = b[dimension];
    return x === null || y === null || Math.abs(x - y) <= tolerance[tol];
  });
}

/**
 * How many families there could be: each near-duplicate is already one family whose sides
 * fold into one component, and same-role families whose usual shapes sit within one tolerance
 * step of each other (every pair) fold together. An estimate, not a re-clustering.
 */
export function consolidation(views: readonly FamilyView[], tolerance: Tolerance): { families: number; estimate: number; folds: string[][] } {
  const groups: FamilyView[][] = [];
  for (const view of [...views].sort((a, b) => b.uses - a.uses)) {
    const group = groups.find((g) => g[0]!.family.role === view.family.role && g.every((other) => withinStep(other.family.shape, view.family.shape, tolerance)));
    if (group) group.push(view);
    else groups.push([view]);
  }
  return { families: views.length, estimate: groups.length, folds: groups.filter((g) => g.length > 1).map((g) => g.map((v) => v.family.id)) };
}

/** The near-duplicates most worth fixing: built more than once, most uses first. */
export function topFixes(views: readonly FamilyView[], n = 3): FamilyView[] {
  return views.filter((v) => v.family.nearDuplicate).sort((a, b) => b.uses - a.uses || b.family.sides.length - a.family.sides.length).slice(0, n);
}

/* ------------------------------------------------------------- one family's sides */

type Side = InventoryFamily["sides"][number];

/** A near-duplicate's two biggest sides, the pair its compare card shows. */
export function compareSides(family: InventoryFamily): [Side, Side] | null {
  const sides = [...family.sides].sort((a, b) => b.looks - a.looks);
  return sides.length >= 2 ? [sides[0]!, sides[1]!] : null;
}

/** The shape most of a side's looks have; the family's own when none is loaded. */
export function sideShape(side: Side, looks: ReadonlyArray<ChunkLook & { project: string }>, fallback: InventoryShape): InventoryShape {
  const mine = looks.filter((l) => l.project === side.project && l.kit === side.kit);
  const tally = new Map<string, { shape: InventoryShape; n: number }>();
  for (const look of mine) {
    const key = JSON.stringify(look.shape);
    const entry = tally.get(key) ?? { shape: look.shape, n: 0 };
    entry.n++;
    tally.set(key, entry);
  }
  return [...tally.values()].sort((a, b) => b.n - a.n)[0]?.shape ?? fallback;
}

const value = (n: number | null, unit = "px"): string => (n === null ? "?" : n === 9999 && unit === "px" ? "pill" : `${n}${unit}`);

/** The compare card's table: each attribute for side A and B, and whether they differ. */
export function attributeRows(a: { shape: InventoryShape; uses: number; projects: readonly string[] }, b: { shape: InventoryShape; uses: number; projects: readonly string[] }): Array<{ label: string; a: string; b: string; differs: boolean }> {
  const padding = (s: InventoryShape): string => `${value(s.paddingY)} ${value(s.paddingX)}`;
  const rows: Array<[string, string, string]> = [
    ["Height", value(a.shape.height), value(b.shape.height)],
    ["Padding", padding(a.shape), padding(b.shape)],
    ["Radius", value(a.shape.radius), value(b.shape.radius)],
    ["Font size", value(a.shape.fontSize), value(b.shape.fontSize)],
    ["Weight", value(a.shape.fontWeight, ""), value(b.shape.fontWeight, "")],
    ["Uses", String(a.uses), String(b.uses)],
    ["Projects", a.projects.join(", "), b.projects.join(", ")],
  ];
  return rows.map(([label, x, y]) => ({ label, a: x, b: y, differs: x !== y }));
}

/** `13 uses · 4 projects · 3 stories`, or `Only in Storybook · 2 stories` for a family no use has. */
export function usesLabel(view: Pick<FamilyView, "uses" | "projects" | "stories" | "authored">): string {
  const stories = `${view.stories} ${view.stories === 1 ? "story" : "stories"}`;
  if (view.authored) return `Only in Storybook · ${stories}`;
  return `${view.uses} ${view.uses === 1 ? "use" : "uses"} · ${view.projects} ${view.projects === 1 ? "project" : "projects"}${view.stories > 0 ? ` · ${stories}` : ""}`;
}

/** Where a look is used: `project` + repo-relative `file:line` + its routes, from the family's examples (routes go by file). Stories are not uses (storyRows). */
export function usageRows(view: Pick<FamilyView, "family" | "looks">): Array<{ key: string; project: string; place: string; routes: string[] }> {
  const routes = new Map<string, string[]>();
  for (const e of [...view.family.examples, ...view.family.sides.flatMap((s) => s.examples)]) if (!routes.has(`${e.project}:${e.file}`)) routes.set(`${e.project}:${e.file}`, e.routes);
  return view.looks
    .filter((l) => !l.story)
    .sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .map((l) => ({ key: l.id, project: l.project, place: `${l.file}:${l.line}`, routes: routes.get(`${l.project}:${l.file}`) ?? [] }));
}

/** Its Storybook stories: `title / name`, with the story's `file:line`. */
export function storyRows(view: Pick<FamilyView, "looks">): Array<{ key: string; project: string; story: string; place: string }> {
  return view.looks
    .filter((l) => l.story)
    .sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file) || a.line - b.line)
    .map((l) => ({ key: l.id, project: l.project, story: `${l.story!.title} / ${l.story!.name}`, place: `${l.file}:${l.line}` }));
}

/* --------------------------------------------------------------------- the sheet */

/** Pixels per millisecond: a quick downward flick past this closes the sheet wherever it is. */
export const FLICK_VELOCITY = 0.11;
/** Or dragged down past this share of its height. */
export const DISMISS_SHARE = 1 / 3;

/** Whether a bottom sheet dragged `distance` px down (of `height`) at `velocity` px/ms on release should close. */
export function shouldDismiss({ distance, height, velocity }: { distance: number; height: number; velocity: number }): boolean {
  if (distance <= 0) return false;
  return velocity > FLICK_VELOCITY || distance > height * DISMISS_SHARE;
}

/** Slider position (0–100) from a pointer x within a box. */
export function sliderPercent(x: number, left: number, width: number): number {
  if (width <= 0) return 50;
  return Math.round(Math.min(100, Math.max(0, ((x - left) / width) * 100)) * 10) / 10;
}

/** The top layer's clip: what is left of the handle shows the layer below. */
export function clipInset(percent: number): string {
  return `inset(0 0 0 ${percent}%)`;
}
