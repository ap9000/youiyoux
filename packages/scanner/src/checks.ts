/**
 * The rule checks: the built-ins (`check.engine: youi`) and plain ast-grep rules
 * (`check.engine: ast-grep`). Each returns raw findings; runChecks applies rule
 * severity, file globs and `youi-ignore` comments, and reports how every rule ran.
 */
import type { SgNode } from "@ast-grep/napi";
import { matchesAny, type ElementId, type OutputConfig, type RuleRun, type RuleSpec, type Violation } from "@youiyoux/core";
import { cssVariable, parseCssColor, readRules, sameColor, tailwindTheme, type DtcgColor, type ResolvedToken } from "@youiyoux/tokens";
import { AST_GREP_FILE_LANG, ruleCapability } from "./capabilities.ts";
import type { ElementIndex } from "./elements.ts";
import { importSpecifier } from "./project.ts";
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
  return { prefix: output.cssVarPrefix, tokens, byVar: new Map(tokens.map((t) => [cssVariable(output.cssVarPrefix, t.cssName), t])), themeKeys };
}

function isColor(value: unknown): value is DtcgColor {
  return typeof value === "object" && value !== null && "components" in value;
}

/** Colour tokens (not aliases) whose light or dark value is this colour; null when it is not a colour. */
export function colorTokens(literal: string, index: TokenIndex): ResolvedToken[] | null {
  const color = parseCssColor(literal);
  if (!color) return null;
  return index.tokens.filter((t) => t.type === "color" && !t.aliasOf && [t.light, t.dark].some((v) => isColor(v) && sameColor(v, color)));
}

function colorSuggestion(literal: string, index: TokenIndex): string | undefined {
  const matches = colorTokens(literal, index);
  if (!matches) return undefined;
  if (matches.length === 0) return "no token has this value: pick the role it plays (system_get_tokens) or propose a token";
  const listed = matches.slice(0, 3).map((t) => `var(${cssVariable(index.prefix, t.cssName)}) (${t.id})`).join(" or ");
  return `${listed}: same value, check it is the right role`;
}

/* --------------------------------------------------------------- positions */

export function offsetToPosition(text: string, offset: number, start: { line: number; column: number }): { line: number; column: number } {
  const before = text.slice(0, offset);
  const newlines = before.split("\n").length - 1;
  return newlines === 0 ? { line: start.line + 1, column: start.column + offset + 1 } : { line: start.line + newlines + 1, column: offset - before.lastIndexOf("\n") };
}

export function stringNodes(module: ModuleInfo): SgNode[] {
  return module.root.root().findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } });
}

/* --------------------------------------------------------------- raw-color */

export const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
export const COLOR_FN = /\b(?:rgba?|hsla?|oklch)\(\s*-?[\d.]+[^)]*\)/g;

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

export function rawColorsInScript(module: ModuleInfo, index: TokenIndex): Finding[] {
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

export function rawColorsInCss(module: ModuleInfo, index: TokenIndex, isTokenSource: boolean): Finding[] {
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
        findings.push({ file: module.file, line: declaration.line, column, text: `${declaration.property}: ${match[0]}`, message: `Raw colour ${match[0]} in ${declaration.property}; use var(${cssVariable(index.prefix, "…")}).`, ...(suggestion ? { suggestion } : {}) });
      }
    }
  }
  return findings;
}

/* ---------------------------------------------------------- arbitrary-value */

export const ARBITRARY = /(?<=^|[\s"'`])(?:[a-z0-9-]+:)*!?(-?[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-\[([^\]\s]+)\]/g;
const COLOR_UTILITIES = /^(bg|text|border(-[trblxy])?|ring|outline|fill|stroke|divide|decoration|caret|accent|from|via|to|placeholder)$/;
const RADIUS_UTILITY = /^rounded(-[a-z]{1,2})?$/;
/** Padding, margin and gap utilities: the ones a spacing token sets. */
export const SPACING_UTILITY = /^-?(p[xytrblse]?|m[xytrblse]?|gap(-[xy])?|space-[xy])$/;

export function themeKeyToUtility(utility: string, key: string): string | null {
  const [namespace, ...rest] = key.split("-");
  const name = rest.join("-");
  if (namespace === "color" && COLOR_UTILITIES.test(utility)) return `${utility}-${name}`;
  if (namespace === "radius" && RADIUS_UTILITY.test(utility)) return `${utility}-${name}`;
  if (namespace === "spacing" && SPACING_UTILITY.test(utility)) return `${utility}-${name}`;
  if (namespace === "shadow" && utility === "shadow") return `shadow-${name}`;
  if (namespace === "text" && utility === "text" && !key.includes("--")) return `text-${name}`;
  return null;
}

/** A dimension token's light value in px (rem at 16px), or null. */
export function tokenPx(token: ResolvedToken): number | null {
  const value = token.light as { value?: unknown; unit?: unknown } | null;
  if (token.type !== "dimension" || typeof value?.value !== "number") return null;
  return value.unit === "rem" ? value.value * 16 : value.unit === "px" ? value.value : null;
}

/** What a length sets: a radius or a spacing (padding, margin, gap) token. */
export type DimensionKind = "radius" | "spacing";
const TOKEN_GROUPS: Record<DimensionKind, RegExp> = { radius: /^(radius|radii|rounded)\./, spacing: /^(space|spacing)\./ };

/** Radius or spacing tokens whose value is exactly `px`. */
export function dimensionTokens(kind: DimensionKind, px: number, index: TokenIndex): ResolvedToken[] {
  return index.tokens.filter((t) => TOKEN_GROUPS[kind].test(t.id) && tokenPx(t) === px);
}

/** The kind of token a Tailwind utility's length is, or null. */
export const utilityDimension = (utility: string): DimensionKind | null => (RADIUS_UTILITY.test(utility) ? "radius" : SPACING_UTILITY.test(utility) ? "spacing" : null);

/** The tokens an arbitrary utility value copies: `rounded-[8px]` → radius.control, `var(--demo-x)` → that token. */
export function arbitraryTokens(utility: string, value: string, index: TokenIndex): ResolvedToken[] {
  const viaVar = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (viaVar) {
    const token = index.byVar.get(viaVar[1]!);
    return token ? [token] : [];
  }
  const px = /^(\d*\.?\d+)px$/.exec(value);
  if (!px) return [];
  const n = Number(px[1]);
  if (utility === "text") return index.tokens.filter((t) => t.type === "typography" && (t.light as { fontSize: { value: number } }).fontSize.value === n);
  const kind = utilityDimension(utility);
  return kind ? dimensionTokens(kind, n, index) : [];
}

/** Theme utilities that read the token (`rounded-control`), in the project's Tailwind theme. */
export function tokenUtilities(utility: string, tokens: readonly ResolvedToken[], index: TokenIndex): string[] {
  return [...new Set(tokens.flatMap((t) => (index.themeKeys.get(t.id) ?? []).map((key) => themeKeyToUtility(utility, key)).filter((u): u is string => u !== null)))];
}

function arbitraryValues(module: ModuleInfo, index: TokenIndex): Finding[] {
  const findings: Finding[] = [];
  for (const node of stringNodes(module)) {
    const text = node.text();
    const start = node.range().start;
    for (const match of text.matchAll(ARBITRARY)) {
      const [whole, utility, value] = match as unknown as [string, string, string];
      if (value.startsWith("#")) continue;
      const suggestions = tokenUtilities(utility, arbitraryTokens(utility, value, index), index);
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

function lookalikes(analysis: ModuleAnalysis, elements: ElementIndex, config: { componentsDir: string; importFrom?: string }): Finding[] {
  return analysis.lookalikes.map((site) => {
    const contract = elements.contracts.get(site.resembles);
    return {
      file: site.file,
      line: site.line,
      column: site.column,
      text: `<${site.local}>`,
      message: `${site.local} here is ${site.resolved}, not the design-system ${contract?.name ?? site.resembles}.`,
      suggestion: `import { ${contract?.name ?? site.local} } from "${importSpecifier(config, site.file, contract?.source.file)}"`,
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
  /** How code imports the owned components; default: a relative path to componentsDir. */
  readonly importFrom?: string;
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

const MAX_MATCH_TEXT = 120;

function astGrepFindings(rule: RuleSpec, module: ModuleInfo): Finding[] {
  if (rule.check.engine !== "ast-grep" || module.lang !== AST_GREP_FILE_LANG[rule.check.language]) return [];
  return module.root.root().findAll({ rule: rule.check.rule }).map((node) => {
    const { line, column } = node.range().start;
    const text = node.text().split("\n")[0]!;
    return { file: module.file, line: line + 1, column: column + 1, text: text.length > MAX_MATCH_TEXT ? `${text.slice(0, MAX_MATCH_TEXT - 1)}…` : text, message: rule.title, suggestion: rule.agent };
  });
}

function findingsFor(rule: RuleSpec, module: ModuleInfo, input: CheckInput): Finding[] {
  if (rule.check.engine === "ast-grep") return astGrepFindings(rule, module);
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
      return analysis ? lookalikes(analysis, input.elements, input) : [];
  }
}

export interface CheckOutput {
  readonly violations: Violation[];
  readonly suppressed: number;
  /** How each rule ran: a rule that should have run but could not makes the result incomplete. */
  readonly checks: RuleRun[];
}

/** Runs one rule over every module its globs match. A check that throws is reported, never read as clean. */
function runRule(rule: RuleSpec, input: CheckInput, out: { violations: Violation[]; suppressed: number }): RuleRun {
  const execution = ruleCapability(rule);
  if (execution.state === "off" || execution.state === "advisory") return { rule: rule.id, state: execution.state };
  if (execution.state === "unsupported") return { rule: rule.id, state: "unsupported", reason: execution.reason };
  let findings = 0;
  for (const module of input.modules.values()) {
    if (module.file.startsWith(`${input.generatedDir}/`) || !matchesAny(module.file, rule.files)) continue;
    let found: Finding[];
    try {
      found = findingsFor(rule, module, input);
    } catch (error: unknown) {
      return { rule: rule.id, state: "error", reason: `${module.file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    for (const finding of found) {
      if (suppressed(module, finding.line, rule.id)) out.suppressed++;
      else {
        out.violations.push({ rule: rule.id, severity: rule.severity as Violation["severity"], ...finding });
        findings++;
      }
    }
  }
  return { rule: rule.id, state: "ran", findings };
}

export function runChecks(input: CheckInput): CheckOutput {
  const out = { violations: [] as Violation[], suppressed: 0 };
  const checks = input.rules.map((rule) => runRule(rule, input, out));
  return { violations: out.violations, suppressed: out.suppressed, checks };
}

/** True when a rule that should have run did not: its zero findings are not a pass. */
export function failedChecks(checks: readonly RuleRun[]): RuleRun[] {
  return checks.filter((c) => c.state === "unsupported" || c.state === "error");
}
