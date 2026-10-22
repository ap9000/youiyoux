/**
 * Gaps (`youiyoux gaps`, the hub's Library > Gaps): for each kind of element Discover knows, how
 * each inventoried project has it. In the System when the System has a component named for it;
 * from a library when the project imports, or declares in package.json, a package built for it;
 * hand-built when only its own components are named for it (or, for the inventory's roles, it
 * styles native elements as one); missing when it has none and the standard kit has one. What is
 * hand-built or missing gets the licensed candidates from the local Discover index, and kinds
 * hand-built in more than one project are listed once, as worth adding to the System.
 *
 * Names are read as Discover reads a need: `DatePicker` and `date-input.tsx` are a date picker;
 * a component ends with the kind's name (`ConfirmDialog`, `UserAvatar`), never only contains it
 * (`DialogContent` is a part, not another dialog).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { copyleft, type GapCandidate, type GapConcept, type GapsProject, type GapsReport, type InventoryReport, type InventoryRole } from "@youiyoux/core";
import { CONCEPTS, conceptForRole, normalize, type Concept } from "./aliases.ts";
import { searchCatalog } from "./catalog.ts";
import type { Store } from "@youiyoux/store";

/** The kinds the standard kit has (shadcn/ui's set): a project without one of these is missing it. */
export const STANDARD_KIT = ["button", "input", "card", "badge", "dialog", "alert", "drawer", "menu", "popover", "tooltip", "tabs", "avatar", "accordion", "table", "carousel", "slider", "switch", "checkbox", "radio", "select", "otp", "progress", "skeleton", "spinner", "sidebar", "navigation", "breadcrumb", "pagination", "command", "toast", "date-picker", "combobox", "chart"] as const;

/** Names too plain to mean the kind at the end of a longer name (`PasswordHint` is not a tooltip). */
const ONLY_EXACT = new Set(["hint", "tile", "range", "loading", "picker", "tree", "graph", "plot", "editor", "cta", "notice", "steps", "tag", "toggle", "meter", "command", "banner", "popup", "pager", "loader", "navigation", "chip", "pill"]);

/** The inventory's roles as kinds: a link styled as a button is a button. */
const ROLE_CONCEPT: Readonly<Record<InventoryRole, string>> = { button: "button", "link-as-button": "button", input: "input", card: "card", badge: "badge", dialog: "dialog", tabs: "tabs" };

const CANDIDATES = 3;
const DEFINITIONS_SHOWN = 5;

/** The kind a component's name says it is, by its whole name or the name it ends with, longest first. */
export function conceptOfName(name: string): Concept | undefined {
  const words = normalize(name.replace(/\.[a-z]+$/, ""));
  if (!words) return undefined;
  const phrases = CONCEPTS.flatMap((concept) => concept.names.map((n) => ({ concept, name: normalize(n) }))).sort((a, b) => b.name.length - a.name.length);
  return phrases.find((p) => words === p.name || (!ONLY_EXACT.has(p.name) && ` ${words}`.endsWith(` ${p.name}`)))?.concept;
}

/** The kind a package is built for: listed for it, or named for it (`@radix-ui/react-tabs`, `react-day-picker`). */
export function conceptOfPackage(pkg: string): Concept | undefined {
  const listed = CONCEPTS.find((c) => c.packages.includes(pkg));
  if (listed) return listed;
  const last = pkg.split("/").at(-1)!.replace(/^react-/, "");
  return conceptForRole(last);
}

/** Each project's declared packages (dependencies and devDependencies), from the package.json at its root, by project id; one with none readable is left out. */
export function declaredPackages(roots: ReadonlyMap<string, string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [id, root] of roots) {
    const file = join(root, "package.json");
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      found[id] = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].sort();
    } catch {
      // Unreadable: its dependencies stay unread, and the report says so.
    }
  }
  return found;
}

export interface GapsSource {
  readonly inventory: InventoryReport;
  /** The System the projects follow, with its component names; null when they follow none. */
  readonly system: { readonly name: string; readonly components: readonly string[] } | null;
  /** Each project's declared packages (dependencies and devDependencies), by inventory project id; absent: not read. */
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly now?: Date;
}

interface Tally {
  system: Set<string>;
  packages: Set<string>;
  definitions: Array<{ name: string; file: string; line: number }>;
  uses: number;
  files: Set<string>;
}

const fresh = (): Tally => ({ system: new Set(), packages: new Set(), definitions: [], uses: 0, files: new Set() });

/** The licensed candidates for a kind, the ones that do not oblige you to share your code first. */
async function candidatesFor(store: Store, concept: Concept): Promise<GapCandidate[]> {
  const { hits } = await searchCatalog(store, concept.names[0]!, { role: concept.id, limit: 12 });
  return hits
    .filter((hit) => hit.license !== "unknown")
    .map((hit) => ({ id: hit.id, name: hit.name, source: hit.source.name, licence: hit.license, copyleft: copyleft(hit.license), install: hit.install?.command ?? null }))
    .sort((a, b) => Number(a.copyleft) - Number(b.copyleft))
    .slice(0, CANDIDATES);
}

const ORDER: Record<GapConcept["status"], number> = { "hand-built": 0, missing: 1, library: 2, system: 3 };
const KIT_ORDER = new Map<string, number>(STANDARD_KIT.map((id, i) => [id, i]));

/** Gaps for every project of an inventory; `store` is the Discover index, or null when it is not synced. */
export async function buildGaps(source: GapsSource, store: Store | null): Promise<GapsReport> {
  const { inventory } = source;
  const systemByConcept = new Map<string, string[]>();
  for (const name of source.system?.components ?? []) {
    const concept = conceptOfName(name);
    if (concept) systemByConcept.set(concept.id, [...(systemByConcept.get(concept.id) ?? []), name]);
  }
  const candidates = new Map<string, Promise<GapCandidate[]>>();
  const offer = (concept: Concept): Promise<GapCandidate[]> | null => {
    if (!store) return null;
    let found = candidates.get(concept.id);
    if (!found) candidates.set(concept.id, (found = candidatesFor(store, concept)));
    return found;
  };

  const projects: GapsProject[] = [];
  for (const project of inventory.projects) {
    const tallies = new Map<string, Tally>();
    const tally = (id: string): Tally => {
      let t = tallies.get(id);
      if (!t) tallies.set(id, (t = fresh()));
      return t;
    };
    for (const [id, names] of systemByConcept) for (const name of names) tally(id).system.add(name);
    for (const primitive of inventory.primitives.filter((p) => p.project === project.id)) {
      const concept = conceptOfPackage(primitive.package);
      if (concept) tally(concept.id).packages.add(primitive.package);
    }
    for (const pkg of source.dependencies[project.id] ?? []) {
      const concept = CONCEPTS.find((c) => c.packages.includes(pkg));
      if (concept) tally(concept.id).packages.add(pkg);
    }
    // The project's own components named for a kind, and every look they render.
    const ownConcept = new Map<string, string>();
    for (const definition of inventory.definitions.filter((d) => d.project === project.id)) {
      const concept = conceptOfName(definition.name);
      if (!concept) continue;
      ownConcept.set(definition.id, concept.id);
      const t = tally(concept.id);
      t.definitions.push({ name: definition.name, file: definition.file, line: definition.line });
      t.files.add(definition.file);
    }
    for (const look of inventory.looks.filter((l) => l.project === project.id && !l.story)) {
      const id = look.definition ? ownConcept.get(look.definition) : look.source === "intrinsic" ? ROLE_CONCEPT[look.role] : undefined;
      if (!id) continue;
      const t = tally(id);
      t.uses += 1;
      t.files.add(look.file);
    }

    const concepts: GapConcept[] = [];
    for (const concept of CONCEPTS) {
      const t = tallies.get(concept.id) ?? fresh();
      const hand = t.definitions.length > 0 || t.uses > 0;
      const status: GapConcept["status"] | null = t.system.size ? "system" : t.packages.size ? "library" : hand ? "hand-built" : KIT_ORDER.has(concept.id) ? "missing" : null;
      if (!status) continue;
      const offered = status === "hand-built" || status === "missing" ? offer(concept) : null;
      concepts.push({
        concept: concept.id,
        name: concept.names[0]!,
        status,
        system: [...t.system].sort(),
        packages: [...t.packages].sort(),
        definitions: t.definitions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, DEFINITIONS_SHOWN),
        count: t.definitions.length,
        uses: t.uses,
        files: t.files.size,
        candidates: offered ? await offered : status === "hand-built" || status === "missing" ? null : [],
      });
    }
    concepts.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.status === "hand-built" ? b.uses - a.uses || b.count - a.count : 0) || (KIT_ORDER.get(a.concept) ?? 99) - (KIT_ORDER.get(b.concept) ?? 99) || a.concept.localeCompare(b.concept));
    projects.push({ id: project.id, complete: project.status === "complete", dependencies: source.dependencies[project.id] ? "read" : "unread", concepts });
  }

  const across = new Map<string, { name: string; projects: string[]; uses: number }>();
  for (const project of projects) {
    for (const c of project.concepts.filter((c) => c.status === "hand-built")) {
      const entry = across.get(c.concept) ?? { name: c.name, projects: [], uses: 0 };
      entry.projects.push(project.id);
      entry.uses += c.uses;
      across.set(c.concept, entry);
    }
  }
  return {
    schema: "youi.gaps/v1",
    generatedAt: (source.now ?? new Date()).toISOString(),
    system: source.system?.name ?? null,
    discover: store ? "synced" : "not-synced",
    kit: [...STANDARD_KIT],
    projects,
    across: [...across].filter(([, e]) => e.projects.length > 1).map(([concept, e]) => ({ concept, ...e })).sort((a, b) => b.uses - a.uses || a.concept.localeCompare(b.concept)),
  };
}
