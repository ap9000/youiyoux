/**
 * UI drift in a change (`youiyoux check --diff`): what the change adds that the project already
 * has a better answer for, each with the concrete fix. Pure: the caller says which lines are
 * added and supplies the inventory, the token index and the library each element comes from.
 *
 * - near-duplicate: a new component that draws a look the project already has (same role,
 *   every shape dimension within the inventory's tolerance) → reuse the existing one.
 * - hardcoded-value: a colour, spacing or radius literal that a token already holds → the token.
 *   A value no token has is not reported here (the raw-color rule still is).
 * - off-library: an import that brings an element in from a library other than the one the
 *   project chose for it → the chosen import.
 *
 * Anything on a line the change did not add is never reported.
 */
import type { SgNode } from "@ast-grep/napi";
import type { InventoryRecipe, InventoryReport } from "@youiyoux/core";
import { readRules, type ResolvedToken } from "@youiyoux/tokens";
import { ARBITRARY, arbitraryTokens, COLOR_FN, colorTokens, dimensionTokens, HEX, offsetToPosition, rawColorsInCss, rawColorsInScript, stringNodes, tokenUtilities, type DimensionKind, type TokenIndex } from "./checks.ts";
import { clusterShapeOf, compatible, shapeDistance } from "./inventory/cluster.ts";
import { hasShape } from "./inventory/style.ts";
import { byPosition, unquote, type ModuleInfo } from "./parse.ts";

export type DriftKind = "near-duplicate" | "hardcoded-value" | "off-library";

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** What was found, in the code's own words (`rounded-[8px]`, `GhostButton`, `@mui/material`). */
  readonly text: string;
  readonly message: string;
  /** The concrete fix: what to write instead. */
  readonly fix: string;
}

export type IsAdded = (file: string, line: number) => boolean;

/* ------------------------------------------------------------ hardcoded values */

const cssVar = (token: ResolvedToken, index: TokenIndex): string => `var(${[...index.byVar].find(([, t]) => t === token)?.[0] ?? `--${index.prefix}-${token.cssName}`})`;
const tokenList = (tokens: readonly ResolvedToken[]): string => tokens.slice(0, 3).map((t) => t.id).join(" or ");

/** `text-` in `text-[#c62828]`: the utility a literal at `column` sits in, or null. */
function utilityBefore(lineText: string, column: number): string | null {
  return /(?:^|[\s"'`:])!?(-?[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-\[$/.exec(lineText.slice(0, column - 1))?.[1] ?? null;
}

function colorFindings(module: ModuleInfo, index: TokenIndex, isTokenSource: boolean, added: IsAdded): DriftFinding[] {
  const raw = module.lang === "css" ? rawColorsInCss(module, index, isTokenSource) : isTokenSource ? [] : rawColorsInScript(module, index);
  const lines = module.source.split("\n");
  const findings: DriftFinding[] = [];
  for (const found of raw) {
    if (!added(found.file, found.line)) continue;
    const literal = [...found.text.matchAll(HEX), ...found.text.matchAll(COLOR_FN)].at(-1)?.[0] ?? found.text;
    const tokens = colorTokens(literal, index);
    if (!tokens || tokens.length === 0) continue;
    const utility = module.lang === "tsx" ? utilityBefore(lines[found.line - 1] ?? "", found.column) : null;
    const utilities = utility ? tokenUtilities(utility, tokens, index) : [];
    const fix = utilities.length > 0 ? `use ${utilities.slice(0, 2).join(" or ")} (${tokenList(tokens)})` : `use ${tokens.slice(0, 2).map((t) => cssVar(t, index)).join(" or ")} (${tokenList(tokens)})`;
    findings.push({ kind: "hardcoded-value", file: found.file, line: found.line, column: found.column, text: utility ? `${utility}-[${literal}]` : literal, message: `Hardcoded colour ${literal}: the token ${tokenList(tokens)} has this value. Check it plays that role.`, fix });
  }
  return findings;
}

function arbitraryFindings(module: ModuleInfo, index: TokenIndex, added: IsAdded): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const node of stringNodes(module)) {
    const text = node.text();
    const start = node.range().start;
    for (const match of text.matchAll(ARBITRARY)) {
      const [whole, utility, value] = match as unknown as [string, string, string];
      if (value.startsWith("#") || /^(?:(?:rgb|hsl)a?|oklch)\(/.test(value)) continue; // colours: colorFindings
      const offset = match.index! + whole.indexOf(`${utility}-[`);
      const at = offsetToPosition(text, offset, start);
      if (!added(module.file, at.line)) continue;
      const tokens = arbitraryTokens(utility, value, index);
      if (tokens.length === 0) continue;
      const utilities = tokenUtilities(utility, tokens, index);
      const kind = /^-?rounded/.test(utility) ? "radius" : utility === "text" ? "type" : "spacing";
      const fix = utilities.length > 0 ? `use ${utilities.slice(0, 2).join(" or ")} (${tokenList(tokens)}, ${cssVar(tokens[0]!, index)})` : `use ${utility}-[${cssVar(tokens[0]!, index)}] (${tokenList(tokens)})`;
      findings.push({ kind: "hardcoded-value", file: module.file, ...at, text: `${utility}-[${value}]`, message: `Hardcoded ${kind} ${utility}-[${value}]: the token ${tokenList(tokens)} has this value.`, fix });
    }
  }
  return findings;
}

const CSS_DIMENSIONS: ReadonlyArray<[RegExp, DimensionKind]> = [
  [/^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/, "radius"],
  [/^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(row-|column-)?gap$/, "spacing"],
];

function cssDimensionFindings(module: ModuleInfo, index: TokenIndex, isTokenSource: boolean, added: IsAdded): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const lines = module.source.split("\n");
  for (const rule of readRules(module.source)) {
    for (const declaration of rule.declarations) {
      if (!added(module.file, declaration.line) || (isTokenSource && declaration.property.startsWith("--"))) continue;
      const kind = CSS_DIMENSIONS.find(([pattern]) => pattern.test(declaration.property))?.[1];
      if (!kind) continue;
      const matched: ResolvedToken[] = [];
      const value = declaration.value.replace(/(^|[\s(,])(-?)(\d*\.?\d+)px\b/g, (whole, lead: string, sign: string, n: string) => {
        const token = dimensionTokens(kind, Number(n), index)[0];
        if (!token || Number(n) === 0) return whole;
        matched.push(token);
        return `${lead}${sign ? `calc(-1 * ${cssVar(token, index)})` : cssVar(token, index)}`;
      });
      if (matched.length === 0) continue;
      const column = Math.max(1, (lines[declaration.line - 1] ?? "").indexOf(declaration.property) + 1);
      const ids = [...new Set(matched.map((t) => t.id))];
      findings.push({ kind: "hardcoded-value", file: module.file, line: declaration.line, column, text: `${declaration.property}: ${declaration.value}`, message: `Hardcoded ${kind} in ${declaration.property}: ${ids.join(", ")} ${ids.length === 1 ? "has" : "have"} this value.`, fix: `use ${declaration.property}: ${value} (${ids.join(", ")})` });
    }
  }
  return findings;
}

/** Colours, spacing and radii on added lines that a token already holds. */
export function hardcodedValues(module: ModuleInfo, index: TokenIndex, options: { isTokenSource: boolean; added: IsAdded }): DriftFinding[] {
  const { isTokenSource, added } = options;
  const found = [...colorFindings(module, index, isTokenSource, added), ...(module.lang === "tsx" ? arbitraryFindings(module, index, added) : []), ...(module.lang === "css" ? cssDimensionFindings(module, index, isTokenSource, added) : [])];
  return found.sort(byPosition);
}

/* ------------------------------------------------------------ near-duplicates */

type Look = InventoryReport["looks"][number];
type Definition = InventoryReport["definitions"][number];

export interface NearDuplicateInput {
  /** One project's inventory of the working tree (the change included). */
  readonly inventory: InventoryReport;
  readonly added: IsAdded;
  /** How `fromFile` imports `file` (the project's own convention: an alias, or a relative path). */
  readonly importOf: (file: string, fromFile: string) => string;
}

const classesOf = (recipe: InventoryRecipe | undefined): Set<string> => new Set(recipe?.classes ?? []);
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const c of a) if (b.has(c)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Lexicographic: true when `a` ranks before `b`. */
function before(a: readonly number[], b: readonly number[]): boolean {
  const i = a.findIndex((v, n) => v !== b[n]);
  return i >= 0 && a[i]! < b[i]!;
}

const jsxValue = (value: string | number | boolean): string => (typeof value === "string" ? JSON.stringify(value) : `{${String(value)}}`);

function describeShape(look: Look): string {
  const { height, paddingX, radius, fontSize } = look.shape;
  const parts = [height !== null ? `${height}px high` : null, paddingX !== null ? `${paddingX}px side padding` : null, radius !== null ? `${radius}px radius` : null, fontSize !== null ? `${fontSize}px text` : null].filter(Boolean);
  return parts.join(", ");
}

/** The existing look a person should reuse, written as they would write it. */
export function reuseOf(look: Look, definitions: ReadonlyMap<string, Definition>, importOf: NearDuplicateInput["importOf"], fromFile: string): { name: string; fix: string } {
  const recipe = look.recipe;
  if (recipe?.kind === "component") {
    const variants = definitions.get(look.definition ?? "")?.variants ?? {};
    const props = Object.entries(recipe.props).filter(([key, value]) => key in variants && variants[key]!.includes(String(value)));
    const attributes = props.map(([key, value]) => ` ${key}=${jsxValue(value)}`).join("");
    return { name: `${recipe.export}${attributes}`, fix: `use <${recipe.export}${attributes}> from "${importOf(recipe.file, fromFile)}"` };
  }
  const classes = recipe?.classes ?? [];
  const tag = recipe?.tag ?? look.tag;
  const kitMember = look.definition ? definitions.get(look.definition) : undefined;
  if (kitMember?.kind === "class") return { name: `.${kitMember.name}`, fix: `use the .${kitMember.name} class from ${look.kit ?? kitMember.file}` };
  return { name: `<${tag}>`, fix: `reuse the <${tag}${classes.length > 0 ? ` className="${classes.join(" ")}"` : ""}> at ${look.file}:${look.line}, or make that one shared component` };
}

/**
 * New definitions (on an added line) whose looks match an existing look of the same role from
 * outside the change. Definitions composing existing components are reuse, not duplicates.
 * One finding per new definition, at its definition, naming what to reuse.
 */
export function nearDuplicates(input: NearDuplicateInput): DriftFinding[] {
  const { inventory, added, importOf } = input;
  const definitions = new Map(inventory.definitions.map((d) => [d.id, d]));
  const fresh = inventory.definitions.filter((d) => added(d.file, d.line));
  if (fresh.length === 0) return [];
  const freshIds = new Set(fresh.map((d) => d.id));
  // A definition's body runs to the next definition in its file.
  const ends = new Map<string, number>();
  for (const definition of fresh) {
    const next = inventory.definitions.filter((d) => d.file === definition.file && d.line > definition.line).map((d) => d.line);
    ends.set(definition.id, next.length > 0 ? Math.min(...next) : Number.POSITIVE_INFINITY);
  }
  const inside = (look: Look, definition: Definition): boolean => look.file === definition.file && look.line >= definition.line && look.line < ends.get(definition.id)!;
  const isNew = (look: Look): boolean => added(look.file, look.line) || (look.definition !== null && freshIds.has(look.definition)) || fresh.some((d) => inside(look, d));
  const existing = inventory.looks.filter((l) => hasShape(l.shape) && !isNew(l));

  const findings: DriftFinding[] = [];
  for (const definition of fresh) {
    // Composition reuses an existing component; only newly implemented roots count.
    let root = definition.root;
    const seen = new Set([definition.id]);
    while (root?.kind === "definition" && freshIds.has(root.id) && !seen.has(root.id)) {
      seen.add(root.id);
      root = definitions.get(root.id)?.root;
    }
    if (root?.kind === "primitive" || (root?.kind === "definition" && definitions.has(root.id) && !freshIds.has(root.id))) continue;
    // Compare its own root before nested elements or sites that render it.
    const own = inventory.looks.filter((l) => hasShape(l.shape) && inside(l, definition) && l.definition !== definition.id);
    const roots = inventory.looks.filter((l) => hasShape(l.shape) && inside(l, definition) && l.definition === definition.id);
    const looks = roots.length > 0 ? roots : own.length > 0 ? own : inventory.looks.filter((l) => hasShape(l.shape) && l.definition === definition.id);
    let best: { look: Look; mine: Look; rank: number[] } | null = null;
    for (const mine of looks) {
      const shape = clusterShapeOf(mine);
      const mineClasses = classesOf(mine.recipe);
      for (const other of existing) {
        if (other.role !== mine.role || !compatible(shape, clusterShapeOf(other))) continue;
        // Prefer a component to import, then the closest shape, then the most classes in common (colour lives there).
        const rank = [other.recipe?.kind === "component" ? 0 : 1, shapeDistance(shape, clusterShapeOf(other)), -overlap(mineClasses, classesOf(other.recipe))];
        if (!best || before(rank, best.rank)) best = { look: other, mine, rank };
      }
    }
    if (!best) continue;
    const reuse = reuseOf(best.look, definitions, importOf, definition.file);
    findings.push({
      kind: "near-duplicate",
      file: definition.file,
      line: definition.line,
      column: 1,
      text: definition.name,
      message: `${definition.name} is a new ${best.mine.role} that looks like the existing ${reuse.name} (${best.look.file}:${best.look.line}): ${describeShape(best.mine)}. Confirm it is the same role; if so, reuse the existing one instead of adding a component.`,
      fix: reuse.fix,
    });
  }
  return findings.sort(byPosition);
}

/* ---------------------------------------------------------------- off-library */

/** What an import brings in: the library it belongs to and the element types it supplies. */
export interface ImportClass {
  readonly library: string;
  /** The library as people name it (MUI, Radix). */
  readonly label: string;
  readonly types: readonly string[];
}

/** The project's choice for one element type, and the import that uses it. */
export interface ChosenLibrary {
  readonly library: string;
  /** `the System's Button (youi:demo/component/button)`, `Radix (3 imports)`. */
  readonly label: string;
  /** What to write instead, in a given file: `import { Button } from "@/components/ui"`. */
  readonly fix: (fromFile: string) => string;
}

export interface OffLibraryInput {
  readonly added: IsAdded;
  readonly classify: (specifier: string, names: readonly string[]) => ImportClass | null;
  /** Chosen library per element type (button, dialog, …). */
  readonly chosen: ReadonlyMap<string, ChosenLibrary>;
  /** Files that may import anything: the owned implementations wrap their libraries. */
  readonly exempt?: (file: string) => boolean;
}

function importedNames(statement: SgNode): string[] {
  const clause = statement.find({ rule: { kind: "import_clause" } });
  if (!clause || /^import\s+type\b/.test(statement.text())) return [];
  const names: string[] = [];
  for (const child of clause.children()) {
    if (child.kind() === "identifier") names.push("default");
    if (child.kind() === "namespace_import") names.push("*");
    if (child.kind() === "named_imports") {
      for (const specifier of child.findAll({ rule: { kind: "import_specifier" } })) {
        if (/^type\s/.test(specifier.text())) continue;
        names.push((specifier.field("name") ?? specifier).text());
      }
    }
  }
  return names;
}

/** Added imports that bring an element in from a library other than the project's choice for it. */
export function offLibraryImports(module: ModuleInfo, input: OffLibraryInput): DriftFinding[] {
  if (module.lang === "css" || input.exempt?.(module.file)) return [];
  const findings: DriftFinding[] = [];
  for (const statement of module.root.root().findAll({ rule: { kind: "import_statement" } })) {
    const { line, column } = statement.range().start;
    if (!input.added(module.file, line + 1)) continue;
    const source = statement.field("source");
    if (!source) continue;
    const specifier = unquote(source.text());
    const names = importedNames(statement);
    const found = names.length > 0 ? input.classify(specifier, names) : null;
    if (!found) continue;
    for (const type of found.types) {
      const chosen = input.chosen.get(type);
      if (!chosen || chosen.library === found.library) continue;
      findings.push({
        kind: "off-library",
        file: module.file,
        line: line + 1,
        column: column + 1,
        text: specifier,
        message: `This imports a ${type} from ${found.label} (${specifier}); this project's ${type}s come from ${chosen.label}.`,
        fix: chosen.fix(module.file),
      });
      break;
    }
  }
  return findings;
}
