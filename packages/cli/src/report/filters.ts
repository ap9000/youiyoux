/** Report-only noise filters. The diff checker and inventory keep their own policies. */
import type { InventoryDefinition } from "@youiyoux/core";
import { hardcodedValues, type ModuleInfo, type TokenIndex } from "@youiyoux/scanner";
import type { ResolvedToken } from "@youiyoux/tokens";

export const SHOWCASE_GLOBS = ["**/{__stories__,.storybook,storybook,storybook-static,example,examples,demo,demos,playground,showcase,showcases}/**", "**/*.stories.*", "**/*.story.*"];
export const isShowcase = (file: string): boolean => /(?:^|\/)(?:__stories__|\.?storybook|storybook-static|examples?|demos?|playground|showcases?)(?:\/|$)|\.(?:stories|story)\./i.test(file.replaceAll("\\", "/"));

/** Framework route exports (Next.js handlers and metadata) and route convention files: never UI components to group. */
export const ROUTE_EXPORT = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|generateMetadata|generateStaticParams|generateViewport|metadata|viewport)$/;
export const ROUTE_FILE = /(?:^|\/)(?:page|layout|route|loading|error|global-error|not-found|template|default)\.[jt]sx?$/;

export function uiDefinition(definition: InventoryDefinition, modules: ReadonlyMap<string, ModuleInfo>): boolean {
  if (isShowcase(definition.file)) return false;
  if (definition.kind !== "react") return true;
  if (ROUTE_EXPORT.test(definition.name)) return false;
  const module = modules.get(definition.file);
  if (!module || module.jsx.length === 0) return false;
  if (ROUTE_FILE.test(definition.file) && module.exports.some((e) => e.kind === "local" && e.name === "default" && (e.local === definition.name || definition.name === "default"))) return false;
  // Check the actual declaration, rather than another component's JSX in the same module.
  return module.jsx.some((jsx) => {
    let node = jsx.node.parent();
    while (node) {
      if (["function_declaration", "variable_declarator", "class_declaration"].includes(String(node.kind())) && node.field("name")?.text() === definition.name) return true;
      node = node.parent();
    }
    return false;
  });
}

/** Blank var() including nested fallbacks, preserving offsets and newlines for the parser. */
function maskFunctions(source: string, pattern: RegExp): string {
  const chars = source.split("");
  for (const match of source.matchAll(pattern)) {
    let depth = 1;
    let end = match.index! + match[0].length;
    for (; end < source.length && depth > 0; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")") depth--;
    }
    for (let i = match.index!; i < end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  }
  return chars.join("");
}

export const withoutVariables = (source: string): string => maskFunctions(source, /\bvar\s*\(/g);

/** A token named for one component (`--button-gap`, `--card-radius`), as opposed to the general scale (`--spacing-2`, `--radius-md`). */
const COMPONENT_WORDS = /^(?:button|btn|input|field|card|badge|chip|pill|tag|dialog|modal|popover|tooltip|toast|tabs?|nav|navbar|sidebar|header|footer|menu|dropdown|select|checkbox|radio|switch|toggle|slider|avatar|table|panel|sheet|drawer|banner|alert|hero|form|icon|kbd|callout|accordion|toolbar)$/;
/** A token named for a screen or context (`--so-phone-row`, `--spacing-mobile-gap`): right only there. */
const CONTEXT_WORDS = /^(?:phone|mobile|tablet|desktop|wide|narrow|compact|print|touch|landscape|portrait)$/;
/** Steps of a scale: `sm`, `2xl`, `4`, `0.5`, `full`, or the bare group (`--radius`). */
const SCALE_STEP = /^(?:\d+(?:\.\d+)?|\d*x*[sl]|\dx[sl]|sm|md|lg|base|full|none|default|px|half)$/i;
const GROUP_WORDS = new Set(["space", "spacing", "radius", "radii", "rounded", "color", "colour", "colors", "size", "gap"]);
export const componentOf = (token: ResolvedToken): string | null => token.cssName.split("-").find((part) => COMPONENT_WORDS.test(part)) ?? null;

/** How often each custom property is read (`var(--x)` outside another token's definition), and which files define or read it. */
export interface TokenUsage {
  readonly count: ReadonlyMap<string, number>;
  readonly byFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** Properties defined as another one (`--radius-md: var(--so-radius-md)`): the source is the token, these point at it. */
  readonly aliases?: ReadonlySet<string>;
}

export function tokenUsage(modules: readonly ModuleInfo[]): TokenUsage {
  const count = new Map<string, number>();
  const byFile = new Map<string, Set<string>>();
  const aliases = new Set<string>();
  for (const module of modules) {
    if (!module.source.includes("--")) continue;
    const names = new Set<string>();
    for (const declaration of module.source.split(/[;{}]/)) {
      const defined = /^\s*(--[\w-]+)\s*:\s*(var\(\s*--[\w-]+\s*\)\s*$)?/.exec(declaration);
      if (defined) {
        names.add(defined[1]!);
        if (defined[2]) aliases.add(defined[1]!);
      }
      else for (const [, name] of declaration.matchAll(/var\(\s*(--[\w-]+)/g)) {
        names.add(name!);
        count.set(name!, (count.get(name!) ?? 0) + 1);
      }
    }
    if (names.size > 0) byFile.set(module.file, names);
  }
  return { count, byFile, aliases };
}

/** 2: the general scale (`--so-space-sm`, `--radius`); 1: a role (`--color-primary`); 0: one component's or one screen's (`--so-phone-row`, `--radius-card`). */
export function genericity(token: ResolvedToken, prefix: string | null): number {
  const parts = token.cssName.split("-").filter(Boolean);
  const rest = parts.filter((part, i) => !(i === 0 && part === prefix) && !GROUP_WORDS.has(part));
  if (rest.some((part) => COMPONENT_WORDS.test(part) || CONTEXT_WORDS.test(part))) return 0;
  return rest.every((part) => SCALE_STEP.test(part)) ? 2 : 1;
}

/** A short first segment most tokens share (`so` in `--so-space-sm`): a namespace, not a word of the name. */
function prefixOf(tokens: readonly ResolvedToken[]): string | null {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const first = token.cssName.split("-")[0]!;
    if (first.length <= 3 && token.cssName.includes("-")) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return best && n >= tokens.length / 4 ? best : null;
}

/**
 * The tokens a file's hardcoded values may be matched against, best first: a value's own group
 * only, the general scale before a role's name, a token this file already defines or reads before
 * one it does not, a source token before an alias of it, then the most read. A component's or screen's own token (`--spacing-phone-row`,
 * `--radius-card`) only when no general token of its group has that value and the file is that
 * component's (gap 8px in a list suggests --so-space-sm, never --so-phone-row).
 */
export function scaleTokens(index: TokenIndex, file: string, usage: TokenUsage = { count: new Map(), byFile: new Map() }): TokenIndex {
  const value = (t: ResolvedToken): string => `${t.id.split(".")[0]}\0${JSON.stringify(t.light)}`;
  const prefix = prefixOf(index.tokens);
  const rank = new Map(index.tokens.map((t) => [t, genericity(t, prefix)]));
  const general = new Set(index.tokens.filter((t) => rank.get(t)! > 0).map(value));
  const path = file.toLowerCase();
  const local = usage.byFile.get(file) ?? new Set<string>();
  const varOf = new Map([...index.byVar].map(([name, t]) => [t, name]));
  const cssName = (t: ResolvedToken): string => varOf.get(t) ?? `--${t.cssName}`;
  const tokens = index.tokens.filter((t) => {
    if (rank.get(t)! > 0) return true;
    const component = componentOf(t);
    return component !== null && !general.has(value(t)) && new RegExp(`(?:^|[/._-])${component}s?(?:[/._-]|$)`).test(path);
  });
  const score = (t: ResolvedToken): number[] => [rank.get(t)!, Number(local.has(cssName(t))), Number(!usage.aliases?.has(cssName(t))), usage.count.get(cssName(t)) ?? 0, -t.cssName.length];
  const higher = (a: number[], b: number[]): number => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
    return 0;
  };
  const sorted = tokens.map((t) => ({ t, s: score(t) })).sort((a, b) => higher(a.s, b.s) || a.t.cssName.localeCompare(b.t.cssName)).map(({ t }) => t);
  return { ...index, tokens: sorted };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function reportTokens(module: ModuleInfo, tokens: TokenIndex, usage?: TokenUsage) {
  if (isShowcase(module.file) || (module.lang !== "css" && module.jsx.length === 0)) return [];
  // Reparse a masked copy, so fallback colours never enter hardcodedValues in the first place.
  const { parseModule } = await import("@youiyoux/scanner");
  let source = withoutVariables(module.source);
  if (module.lang !== "css") {
    // Colours code computes or picks from are not styling: gradients in scripts (a colour picker's
    // hue strip) and swatch lists (`["#ef4444", "#f97316"]`).
    source = maskFunctions(source, /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/gi);
    source = source.replace(/(?<=[[,]\s*)(["'`])(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)\n]*\))\1(?=\s*[,\]])/g, (literal) => " ".repeat(literal.length));
  }
  const clean = source === module.source ? module : await parseModule(module.file, source);
  if (!clean) return [];
  const index = scaleTokens(tokens, module.file, usage);
  return hardcodedValues(clean, index, { isTokenSource: module.lang === "css", added: () => true }).filter((f) => {
    if (/\bvar\(/.test(f.text)) return false;
    // The value matched; the token's group must match what the value styles too.
    const kind = /^Hardcoded (colour|radius|spacing|type)\b/.exec(f.message)?.[1];
    const groups = kind === "colour" ? /^(color|colour)\./ : kind === "radius" ? /^(radius|radii|rounded)\./ : kind === "spacing" ? /^(space|spacing)\./ : /^(type|typography|fontSize)\./;
    const named = index.tokens.filter((t) => new RegExp(`[\\s(]${escape(t.id)}(?=[\\s,)]|$)`).test(f.fix));
    return named.length > 0 && named.every((t) => groups.test(t.id));
  });
}

/** Captions expose only a tag/component and class lists unless code was explicitly requested. */
export function publicLook(caption: string): string {
  const name = /^(?:<)?([\w.$:-]+)/.exec(caption)?.[1] ?? "Component";
  const classes = [...caption.matchAll(/\bclass(?:Name)?=("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => `class=${m[1]}`);
  return [name, ...classes].join(" ");
}
