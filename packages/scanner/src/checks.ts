/**
 * The built-in rule checks (`check.engine: youi`). Each returns raw findings;
 * runChecks applies rule severity, file globs and `youi-ignore` comments.
 */
import type { SgNode } from "@ast-grep/napi";
import { matchesAny, type ElementId, type OutputConfig, type RuleSpec, type Violation } from "@youiyoux/core";
import { parseCssColor, readRules, sameColor, tailwindTheme, type DtcgColor, type ResolvedToken } from "@youiyoux/tokens";
import type { ElementIndex } from "./elements.ts";
import type { ModuleInfo } from "./parse.ts";
import type { LocalUsage, ModuleAnalysis } from "./usage.ts";

type Finding = Omit<Violation, "rule" | "severity">;

/* ------------------------------------------------------------------ tokens */

export interface TokenIndex {
  readonly prefix: string;
  readonly tokens: readonly ResolvedToken[];
  readonly byVar: ReadonlyMap<string, ResolvedToken>;
  /** Token id → Tailwind theme keys that read it (project map first). */
  readonly themeKeys: ReadonlyMap<string, readonly string[]>;
}

export function buildTokenIndex(tokens: readonly ResolvedToken[], output: OutputConfig): TokenIndex {
  const themeKeys = new Map<string, string[]>();
  const mapped = new Set(Object.keys(output.tailwind.map));
  const entries = [...tailwindTheme(tokens, output)].sort(([a], [b]) => Number(!mapped.has(a)) - Number(!mapped.has(b)));
  for (const [key, entry] of entries) if (entry.token) themeKeys.set(entry.token, [...(themeKeys.get(entry.token) ?? []), key]);
  return { prefix: output.cssVarPrefix, tokens, byVar: new Map(tokens.map((t) => [`--${output.cssVarPrefix}-${t.cssName}`, t])), themeKeys };
}

function isColor(value: unknown): value is DtcgColor {
  return typeof value === "object" && value !== null && "components" in value;
}

function colorSuggestion(literal: string, index: TokenIndex): string | undefined {
  const color = parseCssColor(literal);
  if (!color) return undefined;
  const matches = index.tokens.filter((t) => t.type === "color" && !t.aliasOf && [t.light, t.dark].some((v) => isColor(v) && sameColor(v, color)));
  if (matches.length === 0) return "no token has this value: pick the role it plays (youi_get_tokens) or propose a token";
  const listed = matches.slice(0, 3).map((t) => `var(--${index.prefix}-${t.cssName}) (${t.id})`).join(" or ");
  return `${listed}: same value, check it is the right role`;
}

/* --------------------------------------------------------------- positions */

function offsetToPosition(text: string, offset: number, start: { line: number; column: number }): { line: number; column: number } {
  const before = text.slice(0, offset);
  const newlines = before.split("\n").length - 1;
  return newlines === 0 ? { line: start.line + 1, column: start.column + offset + 1 } : { line: start.line + newlines + 1, column: offset - before.lastIndexOf("\n") };
}

function stringNodes(module: ModuleInfo): SgNode[] {
  return module.root.root().findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } });
}

/* --------------------------------------------------------------- raw-color */

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
const COLOR_FN = /\b(?:rgba?|hsla?)\(\s*-?[\d.]+[^)]*\)/g;

/** Attributes whose strings are fragments, ids or URLs, never colours (`href="#fade"`). */
const NON_COLOR_ATTRIBUTES = new Set(["href", "to", "id", "htmlFor", "key", "name", "src", "action", "formAction", "aria-controls", "aria-describedby", "aria-labelledby"]);
const CSS_VALUE_BEFORE = /(?:\d(?:px|rem|em|%)?|\b(?:solid|dashed|dotted|double|inset|transparent|currentColor))\s+$/;

function hexInContext(text: string, index: number, match: string): boolean {
  if (text.trim().replace(/^["'`]|["'`]$/g, "").trim() === match) return true;
  const before = text.slice(Math.max(0, index - 24), index);
  if (before.endsWith("[")) return true;
  if (/[:(,]\s*$/.test(before)) return true;
  // `1px solid #f00`, `0 1px 2px #000`: a colour after a length or border style.
  if (CSS_VALUE_BEFORE.test(before)) return true;
  return /[;{]/.test(text) && /\s$/.test(before);
}

function attributeName(node: SgNode): string | null {
  const parent = node.parent();
  const attribute = parent?.kind() === "jsx_attribute" ? parent : parent?.parent()?.kind() === "jsx_attribute" ? parent.parent() : null;
  return attribute?.children()[0]?.text() ?? null;
}

function rawColorsInScript(module: ModuleInfo, index: TokenIndex): Finding[] {
  const findings: Finding[] = [];
  for (const node of stringNodes(module)) {
    const attribute = attributeName(node);
    if (attribute !== null && (NON_COLOR_ATTRIBUTES.has(attribute) || attribute.startsWith("data-"))) continue;
    const original = node.text();
    const text = original.replace(/\$\{[^}]*\}/g, (s) => " ".repeat(s.length));
    const start = node.range().start;
    const add = (match: RegExpMatchArray): void => {
      const literal = original.slice(match.index!, match.index! + match[0].length);
      const suggestion = colorSuggestion(literal, index);
      findings.push({ file: module.file, ...offsetToPosition(text, match.index!, start), text: literal, message: `Raw colour ${literal}; use a colour token.`, ...(suggestion ? { suggestion } : {}) });
    };
    for (const match of text.matchAll(HEX)) if (hexInContext(text, match.index!, match[0])) add(match);
    for (const match of text.matchAll(COLOR_FN)) add(match);
  }
  return findings;
}

function rawColorsInCss(module: ModuleInfo, index: TokenIndex, isTokenSource: boolean): Finding[] {
  const findings: Finding[] = [];
  const lines = module.source.split("\n");
  for (const rule of readRules(module.source)) {
    for (const declaration of rule.declarations) {
      if (isTokenSource && declaration.property.startsWith("--")) continue;
      const value = declaration.value.replace(/url\([^)]*\)/g, "");
      for (const match of [...value.matchAll(HEX), ...value.matchAll(COLOR_FN)]) {
        const lineText = lines[declaration.line - 1] ?? "";
        const column = Math.max(1, lineText.indexOf(match[0]) + 1);
        const suggestion = colorSuggestion(match[0], index);
        findings.push({ file: module.file, line: declaration.line, column, text: `${declaration.property}: ${match[0]}`, message: `Raw colour ${match[0]} in ${declaration.property}; use var(--${index.prefix}-…).`, ...(suggestion ? { suggestion } : {}) });
      }
    }
  }
  return findings;
}

/* ---------------------------------------------------------- arbitrary-value */

const ARBITRARY = /(?<=^|[\s"'`])(?:[a-z0-9-]+:)*!?(-?[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-\[([^\]\s]+)\]/g;
const COLOR_UTILITIES = /^(bg|text|border(-[trblxy])?|ring|outline|fill|stroke|divide|decoration|caret|accent|from|via|to|placeholder)$/;

function themeKeyToUtility(utility: string, key: string): string | null {
  const [namespace, ...rest] = key.split("-");
  const name = rest.join("-");
  if (namespace === "color" && COLOR_UTILITIES.test(utility)) return `${utility}-${name}`;
  if (namespace === "radius" && /^rounded(-[a-z]{1,2})?$/.test(utility)) return `${utility}-${name}`;
  if (namespace === "shadow" && utility === "shadow") return `shadow-${name}`;
  if (namespace === "text" && utility === "text" && !key.includes("--")) return `text-${name}`;
  return null;
}

function suggestUtility(utility: string, value: string, index: TokenIndex): string[] {
  const viaVar = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  let candidates: ResolvedToken[] = [];
  if (viaVar) {
    const token = index.byVar.get(viaVar[1]!);
    candidates = token ? [token] : [];
  } else {
    const px = /^(\d*\.?\d+)px$/.exec(value);
    if (!px) return [];
    const n = Number(px[1]);
    if (/^rounded/.test(utility)) candidates = index.tokens.filter((t) => t.id.startsWith("radius.") && (t.light as { value: number }).value === n);
    if (utility === "text") candidates = index.tokens.filter((t) => t.type === "typography" && (t.light as { fontSize: { value: number } }).fontSize.value === n);
  }
  const suggestions = candidates.flatMap((t) => (index.themeKeys.get(t.id) ?? []).map((key) => themeKeyToUtility(utility, key)).filter((u): u is string => u !== null));
  return [...new Set(suggestions)];
}

function arbitraryValues(module: ModuleInfo, index: TokenIndex): Finding[] {
  const findings: Finding[] = [];
  for (const node of stringNodes(module)) {
    const text = node.text();
    const start = node.range().start;
    for (const match of text.matchAll(ARBITRARY)) {
      const [whole, utility, value] = match as unknown as [string, string, string];
      if (value.startsWith("#")) continue;
      const suggestions = suggestUtility(utility, value, index);
      if (suggestions.length === 0) continue;
      const offset = match.index! + whole.indexOf(`${utility}-[`);
      findings.push({ file: module.file, ...offsetToPosition(text, offset, start), text: `${utility}-[${value}]`, message: `Arbitrary value ${utility}-[${value}] copies a token.`, suggestion: suggestions.slice(0, 3).join(" or ") });
    }
  }
  return findings;
}

/* ---------------------------------------------------- native / props / lookalike */

interface NativeOptions {
  elements?: Record<string, ElementId>;
  allowInputTypes?: string[];
}

function nativeElements(analysis: ModuleAnalysis, options: NativeOptions, elements: ElementIndex): Finding[] {
  const map = options.elements ?? {};
  return analysis.natives.flatMap((site) => {
    const element = map[site.tag];
    if (!element || elements.isOwned(site.file)) return [];
    const type = site.props.type;
    if (site.tag === "input" && type && "literal" in type && (options.allowInputTypes ?? []).includes(String(type.literal))) return [];
    const name = elements.contracts.get(element)?.name ?? element;
    return [{ file: site.file, line: site.line, column: site.column, text: `<${site.tag}>`, message: `Native <${site.tag}> styled by hand; render ${name} (${element}).`, suggestion: `<${name}>` }];
  });
}

function propValues(usages: readonly LocalUsage[], elements: ElementIndex): Finding[] {
  const findings: Finding[] = [];
  for (const usage of usages) {
    const contract = elements.contracts.get(usage.element);
    if (!contract || (usage.kind === "render" && usage.export !== contract.source.export) || usage.kind === "reference") continue;
    for (const [prop, value] of Object.entries(usage.props)) {
      const spec = contract.props[prop];
      if (spec?.type !== "enum" || !("literal" in value)) continue;
      if (spec.values.includes(String(value.literal))) continue;
      findings.push({ file: usage.file, line: usage.line, column: usage.column, text: `${prop}="${value.literal}"`, message: `${contract.name} has no ${prop}="${value.literal}".`, suggestion: `one of: ${spec.values.join(", ")}` });
    }
  }
  return findings;
}

function lookalikes(analysis: ModuleAnalysis, elements: ElementIndex, componentsDir: string): Finding[] {
  return analysis.lookalikes.map((site) => {
    const contract = elements.contracts.get(site.resembles);
    return {
      file: site.file,
      line: site.line,
      column: site.column,
      text: `<${site.local}>`,
      message: `${site.local} here is ${site.resolved}, not the design-system ${contract?.name ?? site.resembles}.`,
      suggestion: `import { ${contract?.name ?? site.local} } from "${componentsDir}"`,
    };
  });
}

/* --------------------------------------------------------------------- runner */

export interface CheckInput {
  readonly modules: ReadonlyMap<string, ModuleInfo>;
  readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
  readonly elements: ElementIndex;
  readonly tokens: TokenIndex;
  readonly rules: readonly RuleSpec[];
  readonly componentsDir: string;
  readonly tokenSources: readonly string[];
  /** Generated output dir: never checked (it is the token source's copy). */
  readonly generatedDir: string;
}

const linesOf = new WeakMap<ModuleInfo, string[]>();

function suppressed(module: ModuleInfo, line: number, ruleId: string): boolean {
  const slug = ruleId.slice(ruleId.indexOf("/rule/") + 6);
  let lines = linesOf.get(module);
  if (!lines) {
    lines = module.source.split("\n");
    linesOf.set(module, lines);
  }
  // The finding's own line, or the line above only when that line is nothing but a comment:
  // a trailing comment on unrelated code must not silence the next line.
  const above = lines[line - 2] ?? "";
  const candidates = [lines[line - 1], /^\s*(?:\/\/|\/\*|\{\s*\/\*|\*)/.test(above) ? above : undefined];
  return candidates.some((text) => {
    const match = text ? /youi-ignore(?:\s+([a-z0-9.-]+))?/.exec(text) : null;
    return match !== null && (!match[1] || match[1] === slug);
  });
}

function findingsFor(rule: RuleSpec, module: ModuleInfo, input: CheckInput): Finding[] {
  if (rule.check.engine !== "youi") return [];
  const analysis = input.analyses.get(module.file);
  const options = rule.check.options as NativeOptions;
  switch (rule.check.id) {
    case "raw-color":
      if (module.lang === "css") return rawColorsInCss(module, input.tokens, matchesAny(module.file, input.tokenSources));
      return matchesAny(module.file, input.tokenSources) ? [] : rawColorsInScript(module, input.tokens);
    case "arbitrary-value":
      return module.lang === "tsx" ? arbitraryValues(module, input.tokens) : [];
    case "native-element":
      return analysis ? nativeElements(analysis, options, input.elements) : [];
    case "prop-values":
      return analysis ? propValues(analysis.usages, input.elements) : [];
    case "lookalike-component":
      return analysis ? lookalikes(analysis, input.elements, input.componentsDir) : [];
  }
}

export function runChecks(input: CheckInput): { violations: Violation[]; suppressed: number } {
  const violations: Violation[] = [];
  let silenced = 0;
  for (const module of input.modules.values()) {
    if (module.file.startsWith(`${input.generatedDir}/`)) continue;
    for (const rule of input.rules) {
      if (rule.severity === "off" || !matchesAny(module.file, rule.files)) continue;
      for (const finding of findingsFor(rule, module, input)) {
        if (suppressed(module, finding.line, rule.id)) silenced++;
        else violations.push({ rule: rule.id, severity: rule.severity, ...finding });
      }
    }
  }
  return { violations, suppressed: silenced };
}
