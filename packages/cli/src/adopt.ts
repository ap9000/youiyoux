/**
 * `youiyoux adopt`: make the product's own UI its design system, inside the product's repo.
 *
 *   youi.config.json           the System, at the product root, so the product is its own design repo
 *   design/components/<name>/  a draft contract per component file; the implementations stay where
 *                              they are (the System's `implementations` names the product's folder)
 *   design/tokens/             the stylesheet's :root (and dark) variables, as DTCG tokens
 *   design/rules/              starter rules, as warnings
 *   design/design.md           the narrative DESIGN.md is generated from
 *
 * The variables move: their declarations leave the stylesheet, which imports the tokens.css sync
 * generates instead, under the same names and values. Values the importer cannot type (calc(),
 * a bare `210 40% 98%`) stay in the stylesheet, listed. `youiyoux system extract` later moves
 * the System into its own repo or package.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { findFiles, readTextOrNull, type ComponentContract, type PropSpec, type RuleSpec, type SystemConfig } from "@youiyoux/core";
import { collectComponents, within, type ComponentFacts } from "@youiyoux/scanner";
import { DL_EXT, importTokens, parseDimension, readRules, type BlockRef, type DtcgToken, type TokenTree } from "@youiyoux/tokens";
import { stringify } from "yaml";
import { GENERATED_MARK } from "./agents.ts";
import { exists, readJson } from "./init.ts";
import { plural } from "./ui.ts";

export interface AdoptOptions {
  readonly root: string;
  /** The folder of the product's own components (default: shadcn's ui alias, else where most components live). */
  readonly componentsDir?: string;
  /** The stylesheet whose :root variables become the tokens (default: shadcn's tailwind.css, else the one with the most). */
  readonly css?: string;
  /** The system id (default: from package.json's name). */
  readonly system?: string;
  /** Take the variables a System generated into the product as the start of the product's own System (it then no longer follows that one). */
  readonly fork?: boolean;
}

export interface AdoptPlan {
  readonly system: SystemConfig;
  readonly componentsDir: string;
  /** Files to write, relative to the product root. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly components: readonly string[];
  readonly support: readonly string[];
  readonly tokens: { readonly stylesheet: string | null; readonly count: number; readonly dark: boolean; readonly left: ReadonlyArray<{ name: string; value: string }> };
  /** The stylesheet as it becomes: its moved declarations gone, the generated tokens imported; null when it is left as it is. */
  readonly stylesheet: { readonly path: string; readonly content: string; readonly moved: number; readonly kept: readonly string[] } | null;
  readonly outputs: { readonly dir: string; readonly cssVarPrefix: string; readonly dark: ReadonlyArray<{ media?: string; selector: string }>; readonly targets: readonly ["css-vars"] };
  readonly tokenSources: readonly string[];
  readonly notes: readonly string[];
  /** Stylesheets youiyoux sync generated from a System this product follows, left to it (without --fork). */
  readonly follows: readonly GeneratedStylesheet[];
  /** The generated stylesheet --fork took the System's values from. */
  readonly forked: GeneratedStylesheet | null;
}

const OUT_DIR = "design/build";
/** Where a dark scheme's variables are written, in the order products write them. */
const DARK_BLOCKS: readonly BlockRef[] = [
  { selector: ".dark" },
  { selector: ":root.dark" },
  { selector: "[data-theme=\"dark\"]" },
  { selector: ":root[data-theme=\"dark\"]" },
  { selector: ":root", outer: "@media (prefers-color-scheme: dark)" },
  { selector: ":root:not([data-theme=\"light\"])", outer: "@media (prefers-color-scheme: dark)" },
];

const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const pascal = (file: string): string => basename(file).replace(/\.[^.]+$/, "").split(/[-_.]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A plain id from a package name (`@acme/web-app` → `web-app`), as init names the project. */
export function slugOf(name: string): string {
  return name.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "") || "app";
}

/**
 * A product-relative path that stays inside the product, through every symlink: the components
 * folder and the stylesheet come from components.json and flags, and adopt reads and rewrites them,
 * so anything leading outside is refused by name.
 */
function inside(root: string, path: string, what: string): string {
  const normal = posix.normalize(path.split("\\").join("/")).replace(/^\.\//, "").replace(/\/+$/, "");
  if (isAbsolute(normal) || normal === ".." || normal.startsWith("../") || !within(root, resolve(root, normal))) throw new Error(`${what} ${JSON.stringify(path)} leads outside ${root}: adopt reads and writes only inside the product`);
  return normal;
}

/** The names a module exports: `export const|function|class x` and `export { a, b as c }` (type-only exports left out). */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:declare\s+)?(?:const|let|var|function\*?|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]!);
  for (const match of source.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const part of match[1]!.split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      names.add(spec.split(/\s+as\s+/).at(-1)!.trim());
    }
  }
  return [...names];
}

/** cva's `defaultVariants: { variant: "default", size: "sm" }`. */
function defaultVariants(source: string): Record<string, string> {
  const body = /defaultVariants\s*:\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => [m[1]!, m[2]!]));
}

/** Only what is known for certain: enum values read from cva or a union type, children, className and handlers. */
function propsOf(facts: ComponentFacts | undefined, defaults: Record<string, string>): Record<string, PropSpec> {
  const props: Record<string, PropSpec> = {};
  for (const prop of facts?.props ?? []) {
    if (prop.values && prop.values.length > 0) props[prop.name] = { type: "enum", values: [...prop.values], required: false, ...(defaults[prop.name] && prop.values.includes(defaults[prop.name]!) ? { default: defaults[prop.name] } : {}) };
    else if (prop.name === "className") props[prop.name] = { type: "string", required: false, description: "Extra classes, merged last." };
    else if (prop.name === "children") props[prop.name] = { type: "node", required: false };
    else if (/^on[A-Z]/.test(prop.name)) props[prop.name] = { type: "function", required: false };
  }
  return props;
}

/** A stylesheet youiyoux sync wrote, and the System it says it came from (its header: "from the Signal design language v1.0.0"). */
export interface GeneratedStylesheet {
  readonly file: string;
  readonly count: number;
  readonly system: string | null;
  readonly version: string | null;
}

function generatedOf(file: string, css: string): GeneratedStylesheet | null {
  const head = css.slice(0, 400);
  if (!head.includes(GENERATED_MARK)) return null;
  const from = /@generated by youi from the (.+?) design language v(\d+\.\d+\.\d+(?:-[\w.-]+?)?)\./.exec(head);
  return { file, count: rootVariables(css).length, system: from?.[1] ?? null, version: from?.[2] ?? null };
}

/**
 * The stylesheet holding the product's variables: the one asked for, shadcn's, else the one with
 * the most :root variables. One youiyoux sync generated holds a System's values, not the
 * product's own: it is passed over (listed in `generated`, so adopt can say which System the product
 * already follows), unless `fork` takes that System's values as the start of the product's own.
 */
async function stylesheetOf(root: string, asked: string | undefined, fork: boolean): Promise<{ file: string | null; generated: GeneratedStylesheet[]; forked: GeneratedStylesheet | null }> {
  const generated: GeneratedStylesheet[] = [];
  let forked: GeneratedStylesheet | null = null;
  const usable = async (file: string): Promise<boolean> => {
    const css = await readTextOrNull(join(root, file));
    if (css === null) return false;
    const made = generatedOf(file, css);
    if (made && !generated.some((g) => g.file === file)) generated.push(made);
    if (made && fork) forked = made;
    return !made || fork;
  };
  if (asked) {
    if (!(await usable(asked)) && generated.length > 0) throw new Error(`${asked} is generated by youiyoux sync${generated[0]!.system ? ` from ${generated[0]!.system}` : ""}: name the stylesheet the product writes its own variables in, or take that System's values as the product's own with youiyoux adopt --fork`);
    return { file: asked, generated, forked };
  }
  const shadcn = ((await readJson(join(root, "components.json")))?.tailwind as { css?: unknown } | undefined)?.css;
  if (typeof shadcn === "string" && (await usable(shadcn))) return { file: posix.normalize(shadcn), generated, forked };
  let best: { file: string; count: number; made: GeneratedStylesheet | null } | null = null;
  for (const file of await findFiles(root, ["**/*.css"], ["**/build/**", "**/out/**", "**/.next/**", `${OUT_DIR}/**`])) {
    const css = (await readTextOrNull(join(root, file))) ?? "";
    const count = rootVariables(css).length;
    if (count === 0) continue;
    const made = generatedOf(file, css);
    if (made && !generated.some((g) => g.file === file)) generated.push(made);
    if (made && !fork) continue;
    if (!best || count > best.count) best = { file, count, made };
  }
  return { file: best?.file ?? null, generated, forked: best?.made ?? forked };
}

/** The custom properties a stylesheet declares in top-level :root blocks: name (without `--`) and value. */
function rootVariables(css: string): Array<{ name: string; value: string }> {
  return readRules(css).filter((r) => r.preludes.length === 1 && r.preludes[0] === ":root").flatMap((r) => r.declarations).filter((d) => d.property.startsWith("--") && !d.property.startsWith("---")).map((d) => ({ name: d.property.slice(2), value: d.value }));
}

/** First words that name what a variable is, not whose it is: never read as a prefix (`--color-ink`, shadcn's `--sidebar-primary`). */
const NOT_A_PREFIX = new Set(["color", "colors", "bg", "fg", "radius", "rounded", "font", "text", "shadow", "space", "spacing", "size", "ease", "easing", "duration", "motion", "z", "leading", "tracking", "border", "ring", "chart", "sidebar", "background", "foreground", "primary", "secondary", "muted", "accent", "destructive", "card", "popover", "input", "typography", "brand", "gray", "grey", "neutral"]);

/** The prefix nearly every variable shares (`so` for `--so-accent`, `--so-ink`): at least 80% of them and three or more; else none. */
export function commonPrefix(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) if (name.includes("-")) counts.set(name.split("-")[0]!, (counts.get(name.split("-")[0]!) ?? 0) + 1);
  const [word, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return count >= 3 && count >= names.length * 0.8 && /^[a-z][a-z0-9]*$/.test(word) && !NOT_A_PREFIX.has(word) ? word : "";
}

/** Where a length goes among the tokens: radii as radius, a type style's parts (`typography-label-font-size`) as typography; the rest stays space. */
function lengthPath(name: string, value: string): string | null {
  if (parseDimension(value) === null && !/^var\(/.test(value)) return null;
  if (/radius/.test(name)) return `radius.${name.replace(/^radius-(?=.)/, "")}`;
  if (/^typography-/.test(name)) return `typography.${name.slice("typography-".length)}`;
  if (/^(?:text|font)-|-(?:font-size|line-height|letter-spacing|font-weight)$/.test(name)) return `typography.${name}`;
  return null;
}

/** Tokens' variable names (without `--`) in a tree. */
function variableNames(tree: TokenTree, path: string[] = []): string[] {
  return Object.entries(tree).flatMap(([key, node]) => {
    if (key.startsWith("$")) return [];
    if (node && typeof node === "object" && "$value" in node) {
      const css = ((node as DtcgToken).$extensions?.[DL_EXT] as { css?: string } | undefined)?.css;
      return [css ?? [...path, key].join("-")];
    }
    return variableNames(node as TokenTree, [...path, key]);
  });
}

/**
 * The stylesheet without the moved declarations, importing the generated tokens. A declaration is
 * taken out of its line, also when the line holds several (`--ground: #efefef; --paper: #fff;`);
 * a line left empty goes, and so does a block (or an @media) left holding nothing. Only the :root
 * block and the dark blocks given are changed. `kept` names what could not be taken out alone (a
 * declaration sharing its line with a selector): it stays, with the same value. Nothing moved is null.
 */
function moveDeclarations(css: string, blocks: readonly BlockRef[], moved: ReadonlySet<string>, importPath: string): { content: string; moved: number; kept: string[] } | null {
  const rules = readRules(css).filter((r) => blocks.some((b) => r.preludes.at(-1) === b.selector && (b.outer ? r.preludes.length === 2 && r.preludes[0] === b.outer : r.preludes.length === 1)));
  if (rules.length === 0) return null;
  const lines = css.split("\n");
  const byLine = new Map<number, Set<string>>();
  for (const rule of rules) for (const d of rule.declarations) if (moved.has(d.property.slice(2))) byLine.set(d.line - 1, (byLine.get(d.line - 1) ?? new Set()).add(d.property));
  let count = 0;
  const kept: string[] = [];
  const drop = new Set<number>();
  for (const [index, properties] of byLine) {
    const segments = lines[index]!.split(";");
    const left = segments.filter((segment) => {
      const property = /^\s*(--[\w-]+)\s*:/.exec(segment)?.[1];
      if (property === undefined || !properties.has(property)) return true;
      properties.delete(property);
      count++;
      return false;
    });
    kept.push(...[...properties].map((p) => p.slice(2)));
    const text = left.join(";");
    if (text.trim() === "") drop.add(index);
    else lines[index] = /^\s/.test(text) || index === 0 ? text : `${lines[index]!.match(/^\s*/)![0]}${text.trimStart()}`;
  }
  if (count === 0) return null;
  let content = lines.filter((_, i) => !drop.has(i)).join("\n");
  for (const block of blocks) content = content.replace(new RegExp(`(^|\\n)[ \\t]*${block.selector.replace(/[.[\]()"=:]/g, "\\$&")}\\s*\\{\\s*\\}[ \\t]*(?=\\n|$)`, "g"), "");
  // An @media left holding nothing goes too.
  for (const outer of new Set(blocks.flatMap((b) => (b.outer ? [b.outer] : [])))) content = content.replace(new RegExp(`(^|\\n)[ \\t]*${outer.replace(/[.[\]()"=:]/g, "\\$&")}\\s*\\{\\s*\\}[ \\t]*(?=\\n|$)`, "g"), "");
  const statement = `@import "${importPath}";`;
  const imports = [...content.matchAll(/^@import[^;]*;[ \t]*$/gm)];
  const at = imports.length > 0 ? imports.at(-1)!.index! + imports.at(-1)![0].length : 0;
  content = at > 0 ? `${content.slice(0, at)}\n${statement}${content.slice(at)}` : `${statement}\n${content}`;
  return { content: content.replace(/\n{3,}/g, "\n\n"), moved: count, kept: [...new Set(kept)].sort() };
}

export async function planAdoption(options: AdoptOptions): Promise<AdoptPlan> {
  const root = options.root;
  const pkg = await readJson(join(root, "package.json"));
  const name = typeof pkg?.name === "string" ? pkg.name : basename(root);
  const id = options.system ?? slugOf(name);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`"${id}" cannot be a system id: use lowercase letters, digits and hyphens, starting with a letter (--system <id>)`);
  const notes: string[] = [];

  const facts = await collectComponents(root);
  const chosen = options.componentsDir ?? facts.shadcnUi ?? (await uiFolder(root)) ?? facts.componentsDir;
  const componentsDir = chosen ? inside(root, chosen, "the components folder") : null;
  if (!componentsDir || !(await exists(join(root, componentsDir)))) throw new Error("no folder of components found: pass --components <dir> (the folder your app imports its UI components from)");
  const inDir = (file: string): boolean => posix.dirname(file) === componentsDir;
  const files = (await findFiles(root, [`${componentsDir}/*.{ts,tsx,js,jsx}`])).filter((f) => !/^index\./.test(posix.basename(f)) && !/\.(test|spec|stories|d)\.[^.]+$/.test(f));
  const byFile = new Map<string, ComponentFacts[]>();
  for (const c of facts.components) if (c.definition.kind === "react" && inDir(c.definition.file)) byFile.set(c.definition.file, [...(byFile.get(c.definition.file) ?? []), c]);

  const out: Array<{ path: string; content: string }> = [];
  const components: string[] = [];
  const support: string[] = [];
  const RULES = ["color.no-raw-color", "tokens.no-arbitrary-values", "components.canonical-import"].map((r) => `youi:${id}/rule/${r}`);
  for (const file of files) {
    const defined = (byFile.get(file) ?? []).filter((c) => /^[A-Z]/.test(c.export));
    const source = await readFile(join(root, file), "utf8");
    if (defined.length === 0) {
      support.push(posix.basename(file));
      continue;
    }
    const main = defined.find((c) => c.export === pascal(file)) ?? defined[0]!;
    const folder = kebab(main.export);
    // The name becomes a folder and an id: anything but letters and digits is left out, by name.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(folder)) {
      notes.push(`${file}: ${main.export} has no contract (its name is not plain letters and digits); write one by hand`);
      continue;
    }
    const exportsOf = exportedNames(source);
    const sites = main.sites.length;
    const contract: ComponentContract = {
      schema: "youi.component/v1",
      id: `youi:${id}/component/${folder}`,
      name: main.export,
      version: "0.1.0",
      status: "draft",
      summary: `The product's own ${main.export} (${file}), used at ${sites} ${sites === 1 ? "site" : "sites"}.`.slice(0, 200),
      source: { file: posix.basename(file), export: main.export, also: defined.filter((c) => c !== main).map((c) => c.export) },
      platforms: facts.dependencies.includes("react-native") && !facts.dependencies.includes("react-dom") ? ["ios", "android"] : ["web"],
      props: propsOf(main, defaultVariants(source)),
      tokens: {},
      a11y: { notes: [] },
      rules: RULES,
      guidance: { do: [], dont: [] },
      examples: [],
      aliases: exportsOf.filter((n) => !/^[A-Z]/.test(n)),
      owners: [],
    };
    out.push({ path: `design/components/${folder}/${folder}.contract.json`, content: json(contract) });
    components.push(main.export);
  }
  if (components.length === 0) throw new Error(`${componentsDir} exports no React components: pass --components <dir> (the folder your app imports its UI components from)`);

  // Tokens: the stylesheet's variables, light and dark, under their own names (less the prefix nearly all of them share).
  const found = await stylesheetOf(root, options.css, options.fork === true);
  const stylesheet = found.file ? inside(root, found.file, "the stylesheet") : null;
  const css = stylesheet ? await readTextOrNull(join(root, stylesheet)) : null;
  if (stylesheet && css === null) throw new Error(`${stylesheet} does not exist (--css <file>: the stylesheet that defines your :root variables)`);
  // Every place the product writes its dark values (a class toggle and the OS setting, often both): all move, and all are generated.
  const darkBlocks = css ? DARK_BLOCKS.filter((b) => readRules(css).some((r) => r.preludes.at(-1) === b.selector && (b.outer ? r.preludes.length === 2 && r.preludes[0] === b.outer : r.preludes.length === 1) && r.declarations.some((d) => d.property.startsWith("--")))) : [];
  const darkBlock = darkBlocks[0];
  const variables = css ? rootVariables(css) : [];
  const prefix = commonPrefix(variables.map((v) => v.name));
  const full = (name: string): string => (prefix ? `${prefix}-${name}` : name);
  const own = variables.filter((v) => !prefix || v.name.startsWith(`${prefix}-`)).map((v) => ({ name: prefix ? v.name.slice(prefix.length + 1) : v.name, value: v.value }));
  const unprefixed = variables.filter((v) => prefix && !v.name.startsWith(`${prefix}-`)).map((v) => v.name);
  if (unprefixed.length > 0) notes.push(`${plural(unprefixed.length, "variable")} without the --${prefix}- prefix stay in ${stylesheet}: ${unprefixed.slice(0, 4).map((n) => `--${n}`).join(", ")}${unprefixed.length > 4 ? ", …" : ""}`);
  const paths = Object.fromEntries(own.flatMap((v) => (lengthPath(v.name, v.value) ? [[v.name, lengthPath(v.name, v.value)!]] : [])));
  const imported = css ? importTokens({ css: { css, prefix, light: { selector: ":root" }, ...(darkBlock ? { dark: darkBlock } : {}) }, paths }) : null;
  const tokenCount = imported?.report.fromCss.length ?? 0;
  const hasDark = Boolean(imported && Object.keys(imported.dark).length > 0);
  out.push({ path: `design/tokens/${id}.tokens.json`, content: json(imported?.base ?? {}) });
  if (hasDark) out.push({ path: `design/tokens/${id}.dark.tokens.json`, content: json(imported!.dark) });
  out.push({
    path: `design/tokens/${id}.resolver.json`,
    content: json({
      $schema: "https://www.designtokens.org/schemas/2025.10/resolver.json",
      name,
      version: "2025.10",
      description: `${name}'s tokens, adopted from ${stylesheet ?? "no stylesheet"}.`,
      sets: { base: { sources: [{ $ref: `${id}.tokens.json` }] } },
      ...(hasDark ? { modifiers: { theme: { contexts: { light: [], dark: [{ $ref: `${id}.dark.tokens.json` }] }, default: "light" } } } : {}),
      resolutionOrder: [{ $ref: "#/sets/base" }, ...(hasDark ? [{ $ref: "#/modifiers/theme" }] : [])],
    }),
  });
  if (!stylesheet) notes.push("no stylesheet defines :root variables, so the System has no tokens yet: add them to design/tokens");
  const left = (imported?.report.unparsed ?? []).map((l) => ({ ...l, name: full(l.name) }));

  const moved = new Set(imported ? variableNames(imported.base).map(full) : []);
  const importPath = stylesheet ? relative(dirname(join(root, stylesheet)), join(root, OUT_DIR, "tokens.css")).split("\\").join("/") : "";
  const moving = css && moved.size > 0 ? moveDeclarations(css, [{ selector: ":root" }, ...darkBlocks], moved, importPath.startsWith(".") ? importPath : `./${importPath}`) : null;
  // A forked file is the product's own from now on: it loses the header that told sync it may rewrite it.
  const rewritten = moving && found.forked ? { ...moving, content: moving.content.split("\n").filter((line) => !line.includes(GENERATED_MARK) && !/^\/\* Built with Terrazzo/.test(line)).join("\n") } : moving;
  if (found.forked) notes.push(`forked from ${found.forked.system ?? "the System"}${found.forked.version ? ` v${found.forked.version}` : ""}: this product's System starts from the ${found.forked.count} variables it generated into ${found.forked.file}, and the product no longer follows ${found.forked.system ?? "it"}`);
  if (css && moved.size > 0 && !rewritten) notes.push(`${stylesheet}'s variables were copied, not moved (their blocks are nested or share lines): import ${OUT_DIR}/tokens.css from it and remove them by hand`);
  // Other blocks that set variables (themes as html.dark, html.peach; never Tailwind's @theme): left to the stylesheet, so the System holds :root's values (and dark's) only.
  const read = [":root", ...darkBlocks.map((b) => [b.outer, b.selector].filter(Boolean).join(" > "))];
  const others = css ? [...new Set(readRules(css).filter((r) => !read.includes(r.preludes.join(" > ")) && !r.preludes.at(-1)!.startsWith("@") && r.declarations.some((d) => d.property.startsWith("--"))).map((r) => r.preludes.join(" > ").replace(/\s+/g, " ")))] : [];
  if (others.length > 0) notes.push(`${plural(others.length, "other block")} in ${stylesheet} set${others.length === 1 ? "s" : ""} variables too and stay${others.length === 1 ? "s" : ""} there, as ${others.length === 1 ? "it was" : "they were"} (${others.slice(0, 4).join(" · ")}${others.length > 4 ? " · …" : ""}): the System holds the :root${darkBlocks.length > 0 ? " and dark" : ""} values only`);
  if (rewritten && rewritten.kept.length > 0) notes.push(`${plural(rewritten.kept.length, "variable")} ${rewritten.kept.length === 1 ? "stays" : "stay"} in ${stylesheet} too, written where adopt cannot take them out alone (beside a selector): ${rewritten.kept.slice(0, 4).map((n) => `--${n}`).join(", ")}${rewritten.kept.length > 4 ? ", …" : ""}; they hold the same values, so remove them by hand`);

  for (const [rule, content] of starterRules(id, componentsDir)) out.push({ path: `design/rules/${rule}.rule.yaml`, content });
  out.push({
    path: "design/design.md",
    content: `# ${name}\n\nThe design system of ${name}, adopted from its own code: the components in \`${componentsDir}\` and the variables ${stylesheet ? `\`${stylesheet}\`` : "its stylesheet"} defined. Write here what each colour and component is for and the rules people follow; agents read it in DESIGN.md.\n`,
  });

  const system: SystemConfig = {
    id,
    name,
    version: "0.1.0",
    description: `${name}'s own components and tokens, adopted with youiyoux adopt.`,
    tokens: `design/tokens/${id}.resolver.json`,
    ...(hasDark ? { themeModifier: { name: "theme", light: "light", dark: "dark" } } : {}),
    components: "design/components",
    implementations: componentsDir,
    support,
    rules: "design/rules",
    design: "design/design.md",
  };
  out.unshift({ path: "youi.config.json", content: json({ schema: "youi.config/v1", name, systems: [system] }) });
  return {
    system,
    componentsDir,
    files: out,
    components,
    support,
    tokens: { stylesheet, count: tokenCount, dark: hasDark, left },
    stylesheet: rewritten && stylesheet ? { path: stylesheet, ...rewritten } : null,
    outputs: { dir: OUT_DIR, cssVarPrefix: prefix, dark: darkBlocks.map((b) => ({ ...(b.outer ? { media: b.outer.replace(/^@media\s+/, "") } : {}), selector: b.selector })), targets: ["css-vars"] },
    tokenSources: stylesheet ? [stylesheet] : [],
    notes,
    follows: found.generated.filter((g) => g.file !== found.forked?.file),
    forked: found.forked,
  };
}

/** A folder named components/ui at any depth (where shadcn/ui puts them: `src/browser/components/ui`), the one with the most component files. */
async function uiFolder(root: string): Promise<string | null> {
  const counts = new Map<string, number>();
  for (const file of await findFiles(root, ["**/components/ui/*.{tsx,jsx}"], ["**/build/**", "**/out/**", "**/.next/**"])) counts.set(posix.dirname(file), (counts.get(posix.dirname(file)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? null;
}

/** Warnings to begin with, so an existing product's check passes while its debt is visible. */
function starterRules(id: string, componentsDir: string): Array<[string, string]> {
  const rule = (spec: Omit<RuleSpec, "schema" | "rollout" | "governs" | "fixable"> & Record<string, unknown>): string => stringify({ schema: "youi.rule/v1", ...spec });
  return [
    ["color.no-raw-color", rule({
      id: `youi:${id}/rule/color.no-raw-color`,
      title: "No raw colours",
      severity: "warn",
      statement: "Colour comes from the tokens. Never write a hex, rgb(), hsl() or oklch() literal in a component, class name, inline style or stylesheet; only the token source may define colour values.",
      rationale: "A literal colour cannot follow the dark scheme or a token change, and it hides from every audit.",
      agent: "Never hard-code a colour: use the token utilities (bg-primary, text-muted-foreground) or the variables (var(--primary)); look up the role with system_get_tokens.",
      check: { engine: "youi", id: "raw-color", options: {} },
      files: ["**/*.{ts,tsx,css}"],
    } as never)],
    ["tokens.no-arbitrary-values", rule({
      id: `youi:${id}/rule/tokens.no-arbitrary-values`,
      title: "Use token utilities, not arbitrary values",
      severity: "warn",
      statement: "When a token holds a value, use its utility instead of a Tailwind arbitrary value.",
      rationale: "An arbitrary value copies a token's value once; it does not follow when the token changes.",
      agent: "Prefer token utilities over [arbitrary] values; youiyoux check names the utility.",
      check: { engine: "youi", id: "arbitrary-value", options: {} },
      files: ["**/*.tsx"],
    } as never)],
    ["components.canonical-import", rule({
      id: `youi:${id}/rule/components.canonical-import`,
      title: "Render the System's component, not a lookalike",
      severity: "warn",
      statement: `A component named like one of the System's (Button, Input, Card) must be the one in ${componentsDir}. A second one with the same name splits the System in two.`,
      rationale: "Two Buttons drift apart: a fix to one never reaches the other.",
      agent: `Import components only from ${componentsDir}; never define or import another component with one of their names.`,
      check: { engine: "youi", id: "lookalike-component", options: {} },
      files: ["**/*.tsx"],
    } as never)],
  ];
}
