/**
 * `youiyoux report`'s near-duplicate groups, across every project of a repo at once:
 *
 * - Look-alike groups: a shape family's looks built by two or more definitions in different
 *   files. The keeper is the component a shared UI package or design-system folder exports
 *   (`@dub/ui`, `components/ui`, `packages/ui`) for that kind of element, before any app-local or
 *   feature-specific one; a `<select>` group only ever keeps a select. With none, the fix says to
 *   extract one into the shared UI folder the repo already has. A file is never told to import
 *   from a project it cannot import (a shared library from an app), nor from itself.
 * - Same-named copies: a component defined in two or more files of a project with the same or
 *   near-identical structure. Stories, showcase folders and framework route exports never count;
 *   a generic name (`Header`, `Item`) only when the copies are structurally the same.
 *
 * Imports of a workspace package that did not resolve (no node_modules) are matched to the
 * package's own definitions by name, so `<Input>` from `@dub/ui` is a use of packages/ui's Input.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InventoryDefinition, InventoryLook, InventoryReport, InventoryRole } from "@youiyoux/core";
import type { ModuleInfo } from "@youiyoux/scanner";
import { isShowcase, ROUTE_EXPORT, ROUTE_FILE } from "./filters.ts";
import { verifiedImport } from "./imports.ts";
import type { ReportProject } from "./projects.ts";

/** Steps written out in a fix's text; the HTML lists the rest behind "and N more". */
export const STEPS_SHOWN = 5;
const SITES_PER_FINDING = 6;

export interface GroupFinding {
  readonly kind: "near-duplicate";
  readonly project: string;
  readonly title: string;
  readonly detail: string | null;
  readonly count: number;
  readonly sites: ReadonlyArray<{ readonly at: string; readonly file: string; readonly line: number }>;
  /** What to keep (or create), one sentence. */
  readonly lead: string;
  /** One per file to change, in order. */
  readonly steps: readonly string[];
  readonly next: string;
  /** Distinct exported components among the group's definitions (the kept one and the copies); hand-styled elements, CSS classes and file-local components never count. */
  readonly exported: number;
}

/** What phase one keeps of a project's parsed modules, so they can be dropped before grouping. */
export interface ProjectFacts {
  readonly project: ReportProject;
  readonly id: string | null;
  readonly dependencies: ReadonlySet<string>;
  /** Per project-relative file: local name → the workspace package import it binds. */
  readonly packageImports: ReadonlyMap<string, ReadonlyMap<string, { readonly specifier: string; readonly imported: string }>>;
  /** Per project-relative file: JSX tag root → how many times it is rendered. */
  readonly jsxCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Definition ids that are UI components (not route exports, not showcase). */
  readonly eligible: ReadonlySet<string>;
  /** Top-level components (exported or not) whose name another file of the project also declares, with their structure. */
  readonly twins: ReadonlyMap<string, ReadonlyArray<{ readonly file: string; readonly line: number; readonly exported: boolean; readonly structure: readonly string[] }>>;
  /** Directories that hold at least one source file, project-relative. */
  readonly dirs: ReadonlySet<string>;
  /** The nested package a file belongs to (its nearest directory with a package.json; "" for the project's own). */
  readonly packageOf: (file: string) => string;
  readonly importer: (file: string, fromFile: string) => string;
}

type SgNode = ReturnType<ModuleInfo["root"]["root"]>;

export const packageOf = (specifier: string): string => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);

/* ------------------------------------------------------------------ facts */

const STRUCTURE_KINDS: Record<string, (node: SgNode) => string | null> = {
  jsx_opening_element: (n) => `<${n.field("name")?.text() ?? ""}`,
  jsx_self_closing_element: (n) => `<${n.field("name")?.text() ?? ""}/`,
  jsx_attribute: (n) => {
    const name = n.child(0)?.text() ?? "";
    // Class lists are what a component looks like: two with different classes are not copies.
    const value = /^(?:className|class)$/.test(name) ? n.child(n.children().length - 1) : null;
    const classes = value?.kind() === "string" ? value.text().slice(1, -1).split(/\s+/).filter(Boolean).map((c) => `.${c}`) : [];
    return [`@${name}`, ...classes].join(" ");
  },
  call_expression: (n) => {
    const callee = n.field("function");
    const name = callee?.kind() === "member_expression" ? callee.field("property")?.text() : callee?.text();
    return name && name.length < 40 ? `${name}(` : "call(";
  },
  return_statement: () => "return",
  if_statement: () => "if",
  ternary_expression: () => "?:",
  arrow_function: () => "=>",
  jsx_expression: () => "{}",
  binary_expression: (n) => n.child(1)?.text() ?? "op",
};

const declarations = new WeakMap<ModuleInfo, Map<string, SgNode>>();

/** The declaration of `name` in `module`: its function, arrow function or class (the first, outermost one). */
function declarationOf(module: ModuleInfo, name: string): SgNode | null {
  let found = declarations.get(module);
  if (!found) {
    found = new Map();
    for (const node of module.root.root().findAll({ rule: { any: [{ kind: "function_declaration" }, { kind: "variable_declarator" }, { kind: "class_declaration" }] } })) {
      const key = node.field("name")?.text();
      if (key && !found.has(key)) found.set(key, node);
    }
    declarations.set(module, found);
  }
  return found.get(name) ?? null;
}

/** A definition's structure as a token list: tags, attribute names, calls and control flow, no literals. */
export function structureOf(module: ModuleInfo, name: string): string[] | null {
  const declaration = declarationOf(module, name);
  if (!declaration) return null;
  const tokens: string[] = [];
  const visit = (node: SgNode): void => {
    const token = STRUCTURE_KINDS[String(node.kind())]?.(node);
    if (token) tokens.push(...token.split(" "));
    for (const child of node.children()) visit(child);
  };
  visit(declaration);
  return tokens;
}

/** Dice coefficient over token trigrams: 1 for the same structure, 0 for nothing in common. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  const grams = (tokens: readonly string[]): Map<string, number> => {
    const found = new Map<string, number>();
    for (let i = 0; i + 2 < tokens.length || (i === 0 && tokens.length > 0); i++) {
      const key = tokens.slice(i, i + 3).join(" ");
      found.set(key, (found.get(key) ?? 0) + 1);
      if (tokens.length < 3) break;
    }
    return found;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  let total = 0;
  for (const [key, n] of ga) {
    shared += Math.min(n, gb.get(key) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * shared) / total;
}

/* -------------------------------------------------------------- the repo */

/** Element kinds a keeper must match: inputs, selects and text areas are not interchangeable. */
type Kind = InventoryRole | "select" | "textarea";
const kindOfTag = (role: InventoryRole, tag: string): Kind => (role !== "input" ? role : tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input");
const kindOfName = (role: InventoryRole, name: string): Kind => (role !== "input" ? role : /Select|Combobox|Picker|Dropdown|Listbox/.test(name) ? "select" : /Textarea|TextArea/.test(name) ? "textarea" : "input");
const KIND_WORDS: Record<Kind, [string, string]> = {
  button: ["button", "buttons"], "link-as-button": ["link styled as a button", "links styled as buttons"], input: ["input", "inputs"], select: ["select", "selects"], textarea: ["text area", "text areas"],
  card: ["card", "cards"], badge: ["badge", "badges"], dialog: ["dialog", "dialogs"], tabs: ["tab set", "tab sets"],
};
const EXTRACT_NAMES: Record<Kind, string> = { button: "Button", "link-as-button": "ButtonLink", input: "Input", select: "Select", textarea: "Textarea", card: "Card", badge: "Badge", dialog: "Dialog", tabs: "Tabs" };
/** The general-purpose name for a kind (`Input`, `UIButton`), as opposed to a feature's (`InlineBadgePopoverInput`). */
const GENERIC: Record<Kind, RegExp> = {
  button: /^(?:Base|Ui|UI)?Button$/, "link-as-button": /^(?:ButtonLink|LinkButton)$/, input: /^(?:Base|Ui|UI|Text)?Input$/, select: /^(?:Base|Ui|UI|Native)?Select$/,
  textarea: /^(?:Base|Ui|UI)?(?:Textarea|TextArea)$/, card: /^(?:Base|Ui|UI)?Card$/, badge: /^(?:Badge|Pill|Tag|Chip)$/, dialog: /^(?:Dialog|Modal)$/, tabs: /^(?:Tabs|TabsList|TabsTrigger|Tab)$/,
};
/** A design-system folder inside a project. */
const DS_FOLDER = /(?:^|\/)(?:components\/ui|design-system|ui-kit)\//;
/** A workspace package that is a UI library by name: `@dub/ui`, `twenty-ui`, `@acme/design-system`. */
const UI_PACKAGE = /(?:^|[/@-])(?:ui|design-system|ds|components|primitives|ui-kit)$/i;
/** Names a component may carry in two unrelated places without being a copy. */
const GENERIC_NAMES = new Set(["App", "Root", "Layout", "Page", "Header", "Footer", "Nav", "Navbar", "Navigation", "Sidebar", "Content", "Container", "Wrapper", "Section", "Title", "Subtitle", "Heading", "Description", "Label", "Item", "List", "ListItem", "Row", "Column", "Cell", "Logo", "Icon", "Loading", "Loader", "Spinner", "Skeleton", "Empty", "EmptyState", "Error", "ErrorBoundary", "Provider", "Providers", "Main", "Body", "Text", "Link", "Image", "Avatar", "Separator", "Divider", "Toolbar", "Actions", "Menu", "MenuItem", "Form", "Field", "Fields", "Step", "Steps", "Preview", "Placeholder", "Default", "Component", "View", "Panel", "Overlay", "Trigger", "Hero", "Card", "Button", "Input", "Modal", "Dialog", "Table", "Tabs", "Badge", "Tooltip", "Popover", "Chart", "Grid", "Stack", "Box", "Flex", "Shell", "Frame", "Template", "Children", "Context", "Head", "Meta", "Script", "Document"]);
const ICON_FOLDER = /(?:^|\/)icons?\//;
const SVG_TAGS = new Set(["svg", "path", "g", "circle", "rect", "line", "polyline", "polygon", "ellipse", "defs", "clipPath", "linearGradient", "radialGradient", "stop", "mask", "use", "symbol", "title"]);
const NEAR_IDENTICAL = 0.5;
const MIN_STRUCTURE = 6;
const GENERIC_IDENTICAL = 0.85;

interface Def {
  readonly def: InventoryDefinition;
  readonly project: ReportProject;
  readonly facts: ProjectFacts;
  /** 3: a UI package's; 2: a design-system folder's or a kit's; 1: another shared package's; 0: an app's own. */
  readonly tier: number;
}

/** What a look is built with: a definition, or a hand-styled element where it sits. */
interface Version {
  readonly id: string;
  readonly facts: ProjectFacts;
  /** Project-relative. */
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: "component" | "class" | "element";
  readonly tag: string;
  readonly def: Def | null;
}

export interface GroupInput {
  readonly inventory: InventoryReport;
  readonly facts: readonly ProjectFacts[];
  readonly lines: { site(at: string, file: string, line: number): Promise<{ at: string; code?: string }> };
}

const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`;
const repoPath = (dir: string, file: string): string => (dir === "." ? file : `${dir}/${file}`);
const kebab = (name: string): string => name.replace(/[a-z0-9](?=[A-Z])/g, "$&-").toLowerCase();

function shapeWords(shape: InventoryReport["families"][number]["shape"]): string {
  const { height, paddingX, radius, fontSize } = shape;
  return [height !== null ? `${height}px high` : null, paddingX !== null ? `${paddingX}px side padding` : null, radius !== null ? (radius === 9999 ? "pill-shaped" : `${radius}px corners`) : null, fontSize !== null ? `${fontSize}px text` : null].filter(Boolean).join(", ");
}

export async function nearDuplicateGroups(input: GroupInput): Promise<GroupFinding[]> {
  const { inventory, facts } = input;
  const byId = new Map(facts.flatMap((f) => (f.id ? [[f.id, f] as const] : [])));
  const byName = new Map(facts.flatMap((f) => (f.project.name ? [[f.project.name, f] as const] : [])));
  // Who imports each workspace package, by its evidence in the code or a declared dependency.
  const importers = new Map<string, Set<string>>();
  for (const f of facts) {
    const names = new Set([...f.dependencies].filter((d) => byName.has(d)));
    for (const imports of f.packageImports.values()) for (const { specifier } of imports.values()) names.add(packageOf(specifier));
    for (const name of names) if (name !== f.project.name) importers.set(name, (importers.get(name) ?? new Set()).add(f.project.dir));
  }
  const importedBy = (f: ProjectFacts): number => (f.project.name ? (importers.get(f.project.name)?.size ?? 0) : 0);
  const uiPackage = (f: ProjectFacts): boolean => importedBy(f) > 0 && UI_PACKAGE.test(f.project.name ?? f.project.dir);
  const canImport = (from: ProjectFacts, to: ProjectFacts): boolean => from === to || (to.project.name !== null && (importers.get(to.project.name)?.has(from.project.dir) ?? false));

  const defs = new Map<string, Def>();
  for (const def of inventory.definitions) {
    const f = byId.get(def.project);
    if (!f || isShowcase(def.file)) continue;
    const tier = uiPackage(f) ? 3 : def.kit !== null || DS_FOLDER.test(def.file) ? 2 : importedBy(f) > 0 ? 1 : 0;
    defs.set(def.id, { def, project: f.project, facts: f, tier });
  }
  // A package's components by exported name, for imports that did not resolve.
  const exported = new Map<string, Def>();
  for (const d of defs.values()) {
    const key = `${d.facts.project.dir}\0${d.def.name}`;
    if (d.def.kind === "react" && (!exported.has(key) || d.def.file.length < exported.get(key)!.def.file.length)) exported.set(key, d);
  }
  const packageDef = (f: ProjectFacts, name: string): Def | null => exported.get(`${f.project.dir}\0${name}`) ?? null;
  // Uses by definition: looks that resolved to it, and JSX uses of an unresolved package import of it.
  const usage = new Map<string, number>();
  const specifiers = new Map<string, Map<string, number>>();
  for (const f of facts) {
    for (const [file, imports] of f.packageImports) {
      const counts = f.jsxCounts.get(file);
      for (const [local, { specifier, imported }] of imports) {
        const pkg = byName.get(packageOf(specifier));
        const d = pkg && pkg !== f ? packageDef(pkg, imported) : null;
        if (!d) continue;
        usage.set(d.def.id, (usage.get(d.def.id) ?? 0) + (counts?.get(local) ?? 0));
        const seen = specifiers.get(d.def.id) ?? new Map<string, number>();
        seen.set(specifier, (seen.get(specifier) ?? 0) + 1);
        specifiers.set(d.def.id, seen);
      }
    }
  }

  const production = inventory.looks.filter((l) => !l.story && !isShowcase(l.file) && byId.has(l.project));
  const versionOf = (l: InventoryLook): Version | null => {
    const f = byId.get(l.project)!;
    if (l.recipe?.kind === "component") {
      const id = `${l.project}:${l.recipe.file}#${l.recipe.export}`;
      const d = defs.get(id) ?? null;
      if (d ? !d.facts.eligible.has(id) : isShowcase(l.recipe.file)) return null;
      return { id, facts: byId.get(d?.def.project ?? l.project) ?? f, file: l.recipe.file, line: d?.def.line ?? 1, name: l.recipe.export, kind: "component", tag: l.recipe.tag, def: d };
    }
    if (l.source === "component" && !l.definition) {
      // `<Input>` imported from a workspace package that did not resolve: that package's Input.
      const local = l.tag.split(".")[0]!;
      const bound = f.packageImports.get(l.file)?.get(local);
      const pkg = bound ? byName.get(packageOf(bound.specifier)) : undefined;
      const d = pkg && pkg !== f ? packageDef(pkg, l.tag.includes(".") ? l.tag.split(".").at(-1)! : bound!.imported) : null;
      return d ? { id: d.def.id, facts: d.facts, file: d.def.file, line: d.def.line, name: d.def.name, kind: "component", tag: l.tag, def: d } : null;
    }
    if (l.source !== "intrinsic") return null;
    const member = l.definition ? defs.get(l.definition) : undefined;
    if (member) return { id: member.def.id, facts: member.facts, file: member.def.file, line: member.def.line, name: member.def.kind === "class" ? `.${member.def.name.replace(/^\./, "")}` : member.def.name, kind: member.def.kind === "class" ? "class" : "component", tag: l.tag, def: member };
    return { id: `${l.project}:${l.file}:${l.line}:${l.column}`, facts: f, file: l.file, line: l.line, name: `<${l.tag}>`, kind: "element", tag: l.tag, def: null };
  };
  const looksOf = new Map<string, Array<{ look: InventoryLook; version: Version }>>();
  for (const look of production) {
    const version = versionOf(look);
    if (!version) continue;
    if (version.kind !== "element") usage.set(version.id, (usage.get(version.id) ?? 0) + (look.recipe?.kind === "component" ? 1 : 0));
    if (look.family) looksOf.set(look.family, [...(looksOf.get(look.family) ?? []), { look, version }]);
  }
  // An icon named for what it pictures (nucleo's TextArea, UiCard) is not that component.
  const isIcon = (d: Def): boolean => ICON_FOLDER.test(d.def.file) || [...(d.facts.jsxCounts.get(d.def.file)?.keys() ?? [])].every((tag) => SVG_TAGS.has(tag));
  const kindOf = (role: InventoryRole, v: Version): Kind => (v.kind === "element" ? kindOfTag(role, v.tag) : kindOfName(role, v.name));
  const generic = (kind: Kind, name: string): number => Number(GENERIC[kind].test(name));
  const shared = (v: Version): number => Number((v.def?.tier ?? 0) >= 2);
  // One stable rank: shared before app-local, the general name before a feature's, then the most used.
  const rank = (kind: Kind) => (a: Version, b: Version): number =>
    shared(b) - shared(a) || generic(kind, b.name) - generic(kind, a.name) || (b.def?.tier ?? 0) - (a.def?.tier ?? 0) || (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || a.id.localeCompare(b.id);
  // The repo's shared general-purpose component for a kind of element, wherever it lives.
  const sharedFor = (role: InventoryRole, kind: Kind): Version | null => {
    const found: Version[] = [];
    for (const d of defs.values()) {
      // Only a general-purpose one: a nav's ContentLinkCard or a rich-text editor is no keeper for every card or text area.
      if (d.tier < 2 || d.def.role !== role || d.def.kind !== "react" || !d.facts.eligible.has(d.def.id) || !GENERIC[kind].test(d.def.name) || isIcon(d)) continue;
      found.push({ id: d.def.id, facts: d.facts, file: d.def.file, line: d.def.line, name: d.def.name, kind: "component", tag: d.def.name, def: d });
    }
    return found.sort(rank(kind))[0] ?? null;
  };

  /** How `copy` imports `keeper`: the package name the code already uses, the project's alias, or a relative path. */
  const importText = async (keeper: Version, copyFacts: ProjectFacts, copyFile: string): Promise<string> => {
    if (copyFacts !== keeper.facts) {
      const seen = [...(specifiers.get(keeper.id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (seen) return `import { ${keeper.name} } from "${seen}"`;
      return `export it from ${keeper.facts.project.name} and import it from there`;
    }
    const specifier = await verifiedImport(keeper.facts.project.root, keeper.file, copyFile, keeper.facts.importer(keeper.file, copyFile));
    return specifier ? `import { ${keeper.name} } from "${specifier}"` : `reuse ${keeper.name} from ${repoPath(keeper.facts.project.dir, keeper.file)}`;
  };

  /** Where a shared component that does not exist yet goes: the UI package or design-system folder the repo already has. */
  const extractTarget = (kind: Kind, copies: readonly Version[]): { name: string; facts: ProjectFacts; file: string; viaPackage: boolean; where: string; shared: boolean } => {
    const name = EXTRACT_NAMES[kind];
    const fileIn = (f: ProjectFacts, dir: string): string => {
      for (let n = 1; ; n++) {
        const file = `${dir ? `${dir}/` : ""}${kebab(name)}${n === 1 ? "" : `-${n}`}.tsx`;
        if (![...defs.values()].some((d) => d.facts === f && d.def.file === file)) return file;
      }
    };
    const owners = [...new Set(copies.map((c) => c.facts))];
    const packages = facts.filter((f) => uiPackage(f) && owners.every((o) => canImport(o, f)));
    const pkg = packages.sort((a, b) => importedBy(b) - importedBy(a))[0];
    if (pkg) {
      // The folder most of its components live in.
      const folders = new Map<string, number>();
      for (const d of defs.values()) {
        if (d.facts !== pkg || !d.def.role) continue;
        const folder = d.def.file.slice(0, Math.max(0, d.def.file.lastIndexOf("/")));
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
      }
      const dir = [...folders].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? "src";
      return { name, facts: pkg, file: fileIn(pkg, dir), viaPackage: owners.some((o) => o !== pkg), where: `${pkg.project.name}, the shared UI package`, shared: true };
    }
    const main = owners.sort((a, b) => copies.filter((c) => c.facts === b).length - copies.filter((c) => c.facts === a).length)[0]!;
    const existing = [...main.dirs];
    const pick = (pattern: RegExp): string | undefined => existing.filter((d) => pattern.test(d)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    const shared = pick(/(?:^|\/)components\/ui$/) ?? pick(/(?:^|\/)(?:design-system|ui-kit)$/) ?? pick(/(?:^|\/)(?:components|ui)\/(?:shared|common)$|(?:^|\/)(?:shared|common)\/components$/) ?? pick(/(?:^|\/)components$/) ?? pick(/(?:^|\/)ui$/);
    const dir = shared ?? commonDir(copies.filter((c) => c.facts === main).map((c) => c.file));
    return { name, facts: main, file: fileIn(main, dir), viaPackage: false, where: shared !== undefined ? "the shared UI folder" : "the folder its copies share", shared: shared !== undefined };
  };

  const findings: GroupFinding[] = [];
  const sameNamed = await sameNamedGroups(facts, defs, usage, importText);
  const reported = new Set(sameNamed.flatMap((g) => g.ids));
  // Keepers first, so no fix deletes a component another group keeps.
  type Plan = { family: InventoryReport["families"][number]; kind: Kind; members: Array<{ look: InventoryLook; version: Version }>; sides: Version[]; keeper: Version | null };
  const plans: Plan[] = [];
  for (const family of inventory.families) {
    if (family.authored || Object.values(family.shape).every((v) => v === null)) continue;
    const all = looksOf.get(family.id) ?? [];
    for (const kind of new Set(all.map((m) => kindOf(family.role, m.version)))) {
      const members = all.filter((m) => kindOf(family.role, m.version) === kind);
      const sides = [...new Map(members.map((m) => [m.version.id, m.version])).values()].sort(rank(kind));
      // Two or more distinct definitions in different files; uses of one component never make a group.
      if (new Set(sides.map((v) => `${v.facts.project.dir}\0${v.file}`)).size < 2) continue;
      const own = sides.find((v) => v.kind === "component") ?? sides.find((v) => v.kind === "class") ?? null;
      // A shared general-purpose component before a shared feature's (RichTextToolbarButton), and either before an app's own.
      const general = sharedFor(family.role, kind);
      // With no shared one, an app's own component is kept only when the repo has no shared UI folder to extract into.
      const keeper = own && shared(own) && (generic(kind, own.name) || !general || !generic(kind, general.name)) ? own : (general ?? (own && !extractTarget(kind, sides).shared ? own : null));
      plans.push({ family, kind, members, sides, keeper });
    }
  }
  const keepers = new Set(plans.flatMap((p) => (p.keeper ? [p.keeper.id] : [])));
  const assigned = new Set<string>();
  for (const { family, kind, members, sides, keeper: kept } of plans) {
    const extract = kept ? null : extractTarget(kind, sides);
    const keeperFacts = kept?.facts ?? extract!.facts;
    const keeperFile = repoPath(keeperFacts.project.dir, kept?.file ?? extract!.file);
    const keeperName = kept?.name ?? extract!.name;
    const path = (v: Version): string => repoPath(v.facts.project.dir, v.file);
    const keeperPackage = keeperFacts.packageOf(kept?.file ?? extract!.file);
    const copies = sides.filter((v) => v.id !== kept?.id && !assigned.has(v.id) && !reported.has(v.id) && path(v) !== keeperFile && (v.kind === "element" || !keepers.has(v.id)) && canImport(v.facts, keeperFacts) && (v.facts !== keeperFacts || v.facts.packageOf(v.file) === keeperPackage));
    if (copies.length === 0 || (!extract && new Set([keeperFile, ...copies.map(path)]).size < 2)) continue;
    const byFile = new Map<string, Version[]>();
    for (const copy of [...copies].sort((a, b) => path(a).localeCompare(path(b)) || a.line - b.line)) byFile.set(path(copy), [...(byFile.get(path(copy)) ?? []), copy]);
    const steps: string[] = [];
    for (const [file, list] of byFile) {
      const use = kept ? await importText(kept, list[0]!.facts, list[0]!.file) : extract!.viaPackage && list[0]!.facts !== extract!.facts ? `import it from "${extract!.facts.project.name}" once it is exported there` : "import it from the new file";
      // One step per file: its hand-styled elements together, then each component; a class copy reads differently.
      const actions: string[] = [];
      for (const tag of new Set(list.filter((v) => v.kind === "element").map((v) => v.name))) {
        const at = list.filter((v) => v.kind === "element" && v.name === tag).map((v) => v.line);
        actions.push(`replace the hand-styled ${tag}${at.length > 1 ? "s" : ""} at line${at.length > 1 ? "s" : ""} ${at.join(", ")} with ${keeperName}`);
      }
      for (const v of list.filter((c) => c.kind === "component")) {
        // A differently named copy keeps what it does and stops restyling its own element.
        const named = v.name === "default" ? "its default export" : v.name;
        actions.push(v.name === keeperName ? `remove its own ${v.name} and use the kept one` : `build ${named} on ${keeperName} instead of restyling its own element`);
      }
      if (actions.length > 0) steps.push(`In ${file}, ${actions.join("; ")} (${use})`);
      for (const v of list.filter((c) => c.kind === "class")) steps.push(`In ${file}, ${v.name} copies ${keeperName}'s shape: use ${keeperName} where ${v.name} is used`);
    }
    for (const copy of copies) assigned.add(copy.id);
    const copyIds = new Set(copies.map((v) => v.id));
    const counted = members.filter((m) => copyIds.has(m.version.id));
    const home = [...counted.reduce((n, m) => n.set(m.version.facts, (n.get(m.version.facts) ?? 0) + 1), new Map<ProjectFacts, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? keeperFacts;
    const where = keeperFacts.project.name && importedBy(keeperFacts) > 0 ? `${keeperFacts.project.name}, ${keeperFile}` : keeperFile;
    const lead = kept ? `Keep ${keeperName} (${where})` : `Create ${keeperName} in ${keeperFile} (a new file in ${extract!.where}) with this shape`;
    const [one, many] = KIND_WORDS[kind];
    // A component Version is an exported one (an inventory definition or a recipe's export); elements and classes are not.
    const components = new Set([kept, ...copies].flatMap((v) => (v?.kind === "component" ? [v.id] : []))).size;
    findings.push(finding(home.project.dir, `${plural(members.length, one, many)} look the same (${shapeWords(family.shape)}) but are built ${sides.length} ways`, counted.length,
      [...copies].sort((a, b) => path(a).localeCompare(path(b)) || a.line - b.line).slice(0, SITES_PER_FINDING).map((v) => ({ at: `${path(v)}:${v.line}`, file: path(v), line: v.line })), lead, steps, components));
  }
  findings.push(...sameNamed.map((g) => g.finding));
  return findings.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

function finding(project: string, title: string, count: number, sites: GroupFinding["sites"], lead: string, steps: readonly string[], exported: number): GroupFinding {
  const shown = steps.slice(0, STEPS_SHOWN);
  const more = steps.length > shown.length ? `; and ${plural(steps.length - shown.length, "more file")} (listed in the report)` : "";
  return { kind: "near-duplicate", project, title, detail: null, count, sites, lead, steps, next: `${lead}. ${shown.join(". ")}${more}`, exported };
}

function commonDir(files: readonly string[]): string {
  const parts = files.map((f) => f.split("/").slice(0, -1));
  const common: string[] = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0]![i]); i++) common.push(parts[0]![i]!);
  return common.join("/");
}

type Twin = ProjectFacts["twins"] extends ReadonlyMap<string, ReadonlyArray<infer T>> ? T : never;

/** Components defined in two or more files of one project with the same or near-identical structure, and exported ones that share a name. */
async function sameNamedGroups(facts: readonly ProjectFacts[], defs: ReadonlyMap<string, Def>, usage: ReadonlyMap<string, number>, importText: (keeper: Version, facts: ProjectFacts, file: string) => Promise<string>): Promise<Array<{ ids: string[]; finding: GroupFinding }>> {
  const found: Array<{ ids: string[]; finding: GroupFinding }> = [];
  for (const f of facts) {
    // Copies in separate nested packages (a design package beside the app) are not one component; each package's own are.
    const twins = [...f.twins].flatMap(([name, list]) => [...Map.groupBy(list, (t) => f.packageOf(t.file)).values()].map((same) => [name, same] as const));
    for (const [name, list] of twins) {
      if (list.length < 2) continue;
      const threshold = GENERIC_NAMES.has(name) ? GENERIC_IDENTICAL : NEAR_IDENTICAL;
      const idOf = (file: string): string => `${f.id}:${file}#${name}`;
      // Exported first, then the most used, shared before app-local, the shorter path: that one is kept.
      const tier = (file: string): number => defs.get(idOf(file))?.tier ?? 0;
      const ordered = [...list].sort((a, b) => Number(b.exported) - Number(a.exported) || (usage.get(idOf(b.file)) ?? 0) - (usage.get(idOf(a.file)) ?? 0) || tier(b.file) - tier(a.file) || a.file.length - b.file.length || a.file.localeCompare(b.file));
      // Copies by single link: each joins a group when it is near-identical to any member.
      const group = ordered.map((_, i) => i);
      const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i]!)));
      const score = new Map<string, number>();
      for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
        const value = similarity(ordered[i]!.structure, ordered[j]!.structure);
        score.set(`${i}:${j}`, value);
        if (value >= threshold) group[root(j)] = root(i);
      }
      const clusters = new Map<number, number[]>();
      ordered.forEach((_, i) => clusters.set(root(i), [...(clusters.get(root(i)) ?? []), i]));
      const singles: number[] = [];
      for (const members of clusters.values()) {
        if (members.length < 2) {
          singles.push(members[0]!);
          continue;
        }
        const [keep, ...copies] = members.map((i) => ordered[i]!);
        const same = members.every((i, n) => members.slice(n + 1).every((j) => (score.get(`${i}:${j}`) ?? 0) >= 0.97));
        found.push(await sameNamed(f, name, keep!, copies, same ? "same" : "near"));
      }
      // Exported components that only share a name (a specific one, never `Header`): one name, two components.
      const exported = singles.map((i) => ordered[i]!).filter((d) => d.exported);
      if (!GENERIC_NAMES.has(name) && exported.length >= 2) found.push(await sameNamed(f, name, exported[0]!, exported.slice(1), "different"));
    }
  }
  async function sameNamed(f: ProjectFacts, name: string, keep: Twin, copies: readonly Twin[], how: "same" | "near" | "different"): Promise<{ ids: string[]; finding: GroupFinding }> {
    const dir = f.project.dir;
    const idOf = (file: string): string => `${f.id}:${file}#${name}`;
    const keeperFile = repoPath(dir, keep.file);
    const keeper: Version = { id: idOf(keep.file), facts: f, file: keep.file, line: keep.line, name, kind: "component", tag: name, def: defs.get(idOf(keep.file)) ?? null };
    const steps: string[] = [];
    for (const copy of copies) {
      const use = keep.exported ? await importText(keeper, f, copy.file) : `export it from ${keeperFile} first`;
      steps.push(how === "different" ? `In ${repoPath(dir, copy.file)}, rename its ${name} for what it does, or build it on the one in ${keeperFile} if they should match` : `In ${repoPath(dir, copy.file)}, delete its ${name} and use the kept one (${use})`);
    }
    const lead = how === "same" ? `Keep ${name} (${keeperFile})` : how === "near" ? `Keep one ${name} (${keeperFile}) that takes what differs as props` : `Keep ${name} (${keeperFile}) as the one ${name}`;
    const sites = [keep, ...copies].slice(0, SITES_PER_FINDING).map((d) => ({ at: `${repoPath(dir, d.file)}:${d.line}`, file: repoPath(dir, d.file), line: d.line }));
    const title = how === "different" ? `${name} is defined in ${copies.length + 1} files as different components` : `${name} is defined in ${copies.length + 1} files with ${how === "same" ? "the same" : "near-identical"} structure`;
    return { ids: [keep, ...copies].map((d) => idOf(d.file)), finding: finding(dir, title, copies.length, sites, lead, steps, [keep, ...copies].filter((d) => d.exported).length) };
  }
  return found;
}

/** Phase one's facts from a project's parsed modules: package imports, JSX counts, structures. */
export function factsOf(project: ReportProject, id: string | null, modules: readonly ModuleInfo[], eligible: ReadonlySet<string>, workspaceNames: ReadonlySet<string>, dependencies: ReadonlySet<string>, files: readonly string[], importer: ProjectFacts["importer"]): ProjectFacts {
  const packageImports = new Map<string, Map<string, { specifier: string; imported: string }>>();
  const jsxCounts = new Map<string, Map<string, number>>();
  // Top-level components by name: PascalCase declarations of a module with JSX, outside showcase folders and route conventions.
  const declared = new Map<string, ModuleInfo[]>();
  for (const module of modules) {
    const imports = new Map<string, { specifier: string; imported: string }>();
    for (const binding of module.imports) {
      if (binding.typeOnly || binding.specifier.startsWith(".")) continue;
      const pkg = packageOf(binding.specifier);
      if (workspaceNames.has(pkg) && pkg !== project.name) imports.set(binding.local, { specifier: binding.specifier, imported: binding.imported });
    }
    if (imports.size > 0) packageImports.set(module.file, imports);
    if (module.jsx.length > 0 && !isShowcase(module.file)) {
      const routeFile = ROUTE_FILE.test(module.file);
      const defaults = new Set(module.exports.flatMap((e) => (e.kind === "local" && e.name === "default" ? [e.local] : [])));
      for (const name of module.declarations) {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || ROUTE_EXPORT.test(name) || (routeFile && defaults.has(name))) continue;
        declared.set(name, [...(declared.get(name) ?? []), module]);
      }
    }
    if (module.jsx.length > 0) {
      const counts = new Map<string, number>();
      for (const element of module.jsx) counts.set(element.tag.split(".")[0]!, (counts.get(element.tag.split(".")[0]!) ?? 0) + 1);
      jsxCounts.set(module.file, counts);
    }
  }
  const twins = new Map<string, Array<{ file: string; line: number; exported: boolean; structure: string[] }>>();
  for (const [name, list] of declared) {
    if (list.length < 2) continue;
    const found = list.flatMap((module) => {
      const declaration = declarationOf(module, name);
      const structure = declaration ? structureOf(module, name) : null;
      // A component renders JSX; too little structure cannot make two definitions copies of each other.
      if (!declaration || !structure || structure.length < MIN_STRUCTURE || !structure.some((t) => t.startsWith("<"))) return [];
      return [{ file: module.file, line: declaration.range().start.line + 1, exported: module.exports.some((e) => e.kind === "local" && e.local === name && e.name !== "default"), structure }];
    });
    if (found.length >= 2) twins.set(name, found);
  }
  const dirs = new Set<string>();
  for (const file of files) for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
    if (dirs.has(file.slice(0, at))) break;
    dirs.add(file.slice(0, at));
  }
  const roots = [...dirs].filter((dir) => existsSync(join(project.root, dir, "package.json"))).sort((a, b) => b.length - a.length);
  const nested = (file: string): string => roots.find((dir) => file.startsWith(`${dir}/`)) ?? "";
  return { project, id, dependencies, packageImports, jsxCounts, eligible, twins, dirs, importer, packageOf: nested };
}
