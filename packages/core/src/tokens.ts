/**
 * youi.tokens/v1: the token files a design repo keeps (DTCG 2025.10 format), with two
 * first-class youi types DTCG does not define yet:
 *
 * - `spring`: physical motion, `{ stiffness, damping, mass, velocity? }` (the parameters
 *   iOS, Android, Reanimated and Framer Motion share). The build lowers it to a CSS
 *   `linear()` easing with its settle duration, and to the config object native code takes.
 * - `focusRing`: the keyboard focus indicator, `{ color, width, offset, style }`, lowered
 *   to an `outline` shorthand plus its offset.
 *
 * Every other type follows the DTCG 2025.10 spec. Any value, or any part of a composite
 * value, may be an alias (`{color.brand}`). `validateTokenSets` checks a resolver's sets
 * together: each value against its type, every alias resolving to a token, no cycles.
 */
import { z } from "zod";

/** `{group.token}`: a reference to another token's value. */
export const TOKEN_ALIAS = /^\{([^{}]+)\}$/;
const ALIAS_MESSAGE = "expected an alias like {color.brand}";
export const TokenAlias = z.string().regex(TOKEN_ALIAS, ALIAS_MESSAGE);

/** Allow an alias anywhere a value (or a part of a composite value) is expected. */
const orAlias = <T extends z.ZodType>(schema: T) => z.union([schema, TokenAlias]);

const COLOR_SPACES = ["srgb", "srgb-linear", "hsl", "hwb", "lab", "lch", "oklab", "oklch", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020", "xyz-d65", "xyz-d50"] as const;

export const ColorValue = z.object({
  colorSpace: z.enum(COLOR_SPACES),
  components: z.array(z.union([z.number(), z.literal("none")])).length(3),
  alpha: z.number().min(0).max(1).optional(),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a 6-digit #hex fallback").optional(),
});

export const DimensionValue = z.object({ value: z.number(), unit: z.enum(["px", "rem"]) });
export const DurationValue = z.object({ value: z.number().min(0), unit: z.enum(["ms", "s"]) });
export const CubicBezierValue = z
  .tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()])
  .describe("[x1, y1, x2, y2]; x1 and x2 between 0 and 1");
/**
 * A font family name reaches generated CSS (`font-family`, the typography shorthand), so it may
 * hold only letters, digits, spaces and hyphens: no quotes, semicolons, braces, backslashes,
 * angle brackets or control characters that could close the value and add a declaration.
 */
const FAMILY = String.raw`[\p{L}\p{M}\p{N} -]*[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} -]*`;
export const FONT_FAMILY_NAME = new RegExp(`^${FAMILY}$`, "u");
/** The string form may list several families, separated by commas. */
export const FONT_FAMILY_LIST = new RegExp(`^${FAMILY}(?:,${FAMILY})*$`, "u");
const FAMILY_MESSAGE = "a font family name may hold only letters, digits, spaces and hyphens (no quotes, semicolons, braces, backslashes, angle brackets or control characters)";
export const FontFamilyValue = z.union([
  z.string().regex(FONT_FAMILY_LIST, `${FAMILY_MESSAGE}; separate families with commas`),
  z.array(z.string().regex(FONT_FAMILY_NAME, `${FAMILY_MESSAGE}; one family per entry`)).min(1),
]);
const FONT_WEIGHT_NAMES = ["thin", "hairline", "extra-light", "ultra-light", "light", "normal", "regular", "book", "medium", "semi-bold", "demi-bold", "bold", "extra-bold", "ultra-bold", "black", "heavy", "extra-black", "ultra-black"] as const;
export const FontWeightValue = z.union([z.number().min(1).max(1000), z.enum(FONT_WEIGHT_NAMES)]);

const LINE_STYLES = ["solid", "dashed", "dotted", "double", "groove", "ridge", "outset", "inset"] as const;
export const StrokeStyleValue = z.union([
  z.enum(LINE_STYLES),
  z.object({ dashArray: z.array(orAlias(DimensionValue)).min(1), lineCap: z.enum(["round", "butt", "square"]) }),
]);

export const BorderValue = z.object({ color: orAlias(ColorValue), width: orAlias(DimensionValue), style: orAlias(StrokeStyleValue) });

export const TransitionValue = z.object({ duration: orAlias(DurationValue), delay: orAlias(DurationValue), timingFunction: orAlias(CubicBezierValue) });

export const ShadowLayer = z.object({
  color: orAlias(ColorValue),
  offsetX: orAlias(DimensionValue),
  offsetY: orAlias(DimensionValue),
  blur: orAlias(DimensionValue),
  spread: orAlias(DimensionValue),
  inset: z.boolean().optional(),
});
export const ShadowValue = z.union([ShadowLayer, z.array(ShadowLayer).min(1)]);

export const GradientValue = z.array(z.object({ color: orAlias(ColorValue), position: orAlias(z.number().min(0).max(1)) })).min(1);

export const TypographyValue = z.object({
  fontFamily: orAlias(FontFamilyValue),
  fontSize: orAlias(DimensionValue),
  fontWeight: orAlias(FontWeightValue),
  letterSpacing: orAlias(DimensionValue).optional(),
  /** DTCG 2025.10 says a number (a multiple of the font size); a dimension is accepted for older files. */
  lineHeight: orAlias(z.union([z.number().min(0), DimensionValue])),
});

/** youi: a damped spring, as motion libraries configure one. Settles from 0 to 1. */
export const SpringValue = z.object({
  /** Spring constant k: higher is snappier. */
  stiffness: z.number().positive(),
  /** Damping coefficient c: 2·√(k·m) is critically damped; less overshoots. */
  damping: z.number().min(0),
  mass: z.number().positive(),
  /** Initial velocity, in the distance per second the motion covers (0 to 1); defaults to 0. */
  velocity: z.number().optional(),
});

/** youi: the keyboard focus indicator, drawn as an outline at an offset from the element. */
export const FocusRingValue = z.object({
  color: orAlias(ColorValue),
  width: orAlias(DimensionValue),
  /** Distance from the element's edge; negative draws the ring inside. */
  offset: orAlias(DimensionValue),
  style: orAlias(z.enum(["solid", "dashed", "dotted", "double"])),
});

/** Every token type youi validates, with the schema its `$value` must match. */
export const TOKEN_VALUE_SCHEMAS = {
  color: ColorValue,
  dimension: DimensionValue,
  fontFamily: FontFamilyValue,
  fontWeight: FontWeightValue,
  duration: DurationValue,
  cubicBezier: CubicBezierValue,
  number: z.number(),
  strokeStyle: StrokeStyleValue,
  border: BorderValue,
  transition: TransitionValue,
  shadow: ShadowValue,
  gradient: GradientValue,
  typography: TypographyValue,
  spring: SpringValue,
  focusRing: FocusRingValue,
} as const;

export type TokenType = keyof typeof TOKEN_VALUE_SCHEMAS;
export const TOKEN_TYPES = Object.keys(TOKEN_VALUE_SCHEMAS) as TokenType[];

export type ColorValue = z.infer<typeof ColorValue>;
export type DimensionValue = z.infer<typeof DimensionValue>;
export type DurationValue = z.infer<typeof DurationValue>;
export type SpringValue = z.infer<typeof SpringValue>;
export type FocusRingValue = z.infer<typeof FocusRingValue>;

export function isTokenType(type: unknown): type is TokenType {
  return typeof type === "string" && type in TOKEN_VALUE_SCHEMAS;
}

/** The schema for a token's whole `$value`: its type's value, or an alias. */
export function tokenValueSchema(type: TokenType): z.ZodType {
  return orAlias(TOKEN_VALUE_SCHEMAS[type]);
}

const TOKEN_META = {
  $description: z.string().optional(),
  $extensions: z.record(z.string(), z.unknown()).optional(),
  $deprecated: z.union([z.boolean(), z.string()]).optional(),
};

/** One typed token per type, for the published JSON Schema (editors validate as you type). */
const TypedTokens = TOKEN_TYPES.map((type) => z.object({ $type: z.literal(type), $value: tokenValueSchema(type), ...TOKEN_META }).strict());
/** A token that takes its type from an enclosing group: its value is checked by `validateTokenSets`. */
const UntypedToken = z.object({ $value: z.unknown(), ...TOKEN_META }).strict();

type TokenNode = { [key: string]: unknown };
const TokenGroup: z.ZodType<TokenNode> = z.lazy(() =>
  z
    .object({ $type: z.enum(TOKEN_TYPES as [TokenType, ...TokenType[]]).optional(), $value: z.never().optional(), ...TOKEN_META, $schema: z.string().optional() })
    .catchall(z.union([...TypedTokens, UntypedToken, TokenGroup] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])),
);

/** A DTCG token file: nested groups whose leaves are tokens (`$value`, with `$type` here or on a group). */
export const TokenDocument = TokenGroup.describe("youi.tokens/v1: a DTCG 2025.10 token file, plus the youi types spring and focusRing");

/* ------------------------------------------------------------------ validation */

export interface TokenSource {
  /** The file, for messages. */
  readonly file: string;
  readonly document: unknown;
}

export interface FlatToken {
  readonly path: string;
  readonly type: string | undefined;
  readonly value: unknown;
  readonly file: string;
}

/** Token names may not start with `$` or hold `{`, `}` or `.` (DTCG). */
const NAME = /^[^${}.][^{}.]*$/;
/** youi: a path segment becomes part of a CSS variable name, so letters, digits, hyphens and underscores only. */
export const CSS_SAFE_NAME = /^[\p{L}\p{N}_-]+$/u;

/** Every token in a file, with its type resolved through enclosing groups. Problems with the tree's shape are reported, not thrown. */
export function flattenTokens(source: TokenSource, problems: string[] = []): FlatToken[] {
  const tokens: FlatToken[] = [];
  const walk = (node: unknown, path: string[], inherited: string | undefined): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      problems.push(`${source.file}: ${path.join(".") || "(root)"}: expected a group or a token (an object)`);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = typeof record.$type === "string" ? record.$type : inherited;
    if ("$value" in record) {
      tokens.push({ path: path.join("."), type, value: record.$value, file: source.file });
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key.startsWith("$")) continue;
      if (!NAME.test(key)) {
        problems.push(`${source.file}: ${[...path, key].join(".")}: a token or group name cannot start with $ or contain {, } or .`);
        continue;
      }
      if (!CSS_SAFE_NAME.test(key)) {
        problems.push(`${source.file}: ${[...path, key].join(".")}: a token or group name becomes a CSS variable name, so it may hold only letters, digits, hyphens and underscores`);
        continue;
      }
      walk(child, [...path, key], type);
    }
  };
  walk(source.document, [], undefined);
  return tokens;
}

/** Aliases a value reads: the whole value, or parts of a composite (`{font.sans}` in a typography). */
export function aliasesIn(value: unknown): string[] {
  if (typeof value === "string") {
    const match = TOKEN_ALIAS.exec(value);
    return match ? [match[1]!] : [];
  }
  if (Array.isArray(value)) return value.flatMap(aliasesIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(aliasesIn);
  return [];
}

type Issue = { readonly code: string; readonly path: readonly PropertyKey[]; readonly message: string; readonly errors?: readonly (readonly Issue[])[] };

/** A union (value or alias) reports every branch; follow the branch that got furthest into the value. */
function flattenIssue(issue: Issue, base: readonly PropertyKey[]): Array<{ path: PropertyKey[]; message: string }> {
  const path = [...base, ...issue.path];
  if (issue.code === "invalid_union" && issue.errors) {
    const deeper = issue.errors.find((branch) => branch.some((i) => i.path.length > 0 || i.code === "invalid_union"));
    if (deeper) return deeper.flatMap((i) => flattenIssue(i, path));
    // A branch that took the value's type but refused its content (a font family with a quote) says why.
    const refused = issue.errors.find((branch) => branch.every((i) => i.code !== "invalid_type" && i.message !== ALIAS_MESSAGE));
    if (refused) return refused.flatMap((i) => flattenIssue(i, path));
    return [{ path, message: "expected a value of this type, or an alias like {group.token}" }];
  }
  return [{ path, message: issue.message }];
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => flattenIssue(issue as Issue, [])).map(({ path, message }) => `${path.length ? `$value.${path.map(String).join(".")}` : "$value"}: ${message}`);
}

/** Problems with one token's `$value` for its type, or none. */
export function tokenValueProblems(type: string | undefined, value: unknown): string[] {
  if (type === undefined) return ["no $type (on the token or an enclosing group)"];
  if (!isTokenType(type)) return [`unknown $type "${type}"; expected one of ${TOKEN_TYPES.join(", ")}`];
  if (tokenValueSchema(type).safeParse(value).success) return [];
  // A union of value-or-alias reports both branches; the value branch (which fails too) says what is wrong.
  return describeIssues(TOKEN_VALUE_SCHEMAS[type].safeParse(value).error!);
}

/**
 * Validate the token files a resolver reads, together (later sets override earlier ones, so a
 * token may appear in several). Each problem names the file and the token path.
 */
export function validateTokenSets(sources: readonly TokenSource[]): string[] {
  const problems: string[] = [];
  const all = sources.flatMap((source) => flattenTokens(source, problems));
  const types = new Map<string, string | undefined>();
  for (const token of all) {
    for (const problem of tokenValueProblems(token.type, token.value)) problems.push(`${token.file}: ${token.path}: ${problem}`);
    if (token.type !== undefined && types.has(token.path) && types.get(token.path) !== token.type) problems.push(`${token.file}: ${token.path}: $type ${token.type} differs from ${types.get(token.path)} in another set`);
    if (!types.has(token.path)) types.set(token.path, token.type);
  }
  const edges = new Map<string, Set<string>>();
  for (const token of all) {
    for (const target of aliasesIn(token.value)) {
      if (!types.has(target)) {
        problems.push(`${token.file}: ${token.path}: alias {${target}} names no token`);
        continue;
      }
      // A whole-value alias must point at a token of the same type.
      if (typeof token.value === "string" && token.type !== undefined && types.get(target) !== token.type) problems.push(`${token.file}: ${token.path}: alias {${target}} is a ${types.get(target)}, not a ${token.type}`);
      edges.set(token.path, (edges.get(token.path) ?? new Set()).add(target));
    }
  }
  for (const cycle of findCycles(edges)) problems.push(`alias cycle: ${cycle.join(" → ")}`);
  return problems;
}

/** Each alias cycle once, as the path that closes it. */
function findCycles(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, "open");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === "open") cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of [...edges.keys()].sort()) if (!state.has(node)) visit(node);
  return cycles;
}
