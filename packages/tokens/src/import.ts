/**
 * Import an existing design system into DTCG 2025.10 token files.
 *
 * Sources: a Google-format DESIGN.md (YAML frontmatter: colors, typography,
 * rounded, spacing) and the CSS custom properties that actually ship. When both
 * name a value, the CSS wins (it is what users see) and any disagreement is
 * reported, never silently resolved.
 */
import { parse as parseYaml } from "yaml";
import { formatCssColor, parseCssColor, sameColor, type DtcgColor } from "./color.ts";
import { customProperties, parseCubicBezier, parseDimension, parseFontFamily, parseShadow, type DtcgDimension } from "./css.ts";

/** `$extensions` namespace for design-language metadata on tokens. */
export const DL_EXT = "dev.designlanguage";

export type TokenTree = { [key: string]: TokenTree | DtcgToken };

export interface DtcgToken {
  readonly $type: string;
  readonly $value: unknown;
  readonly $description?: string;
  readonly $extensions?: Record<string, Record<string, unknown>>;
}

export interface BlockRef {
  readonly selector: string;
  /** Enclosing at-rule prelude, e.g. "@media (prefers-color-scheme: dark)". */
  readonly outer?: string;
}

export interface CssSource {
  readonly css: string;
  readonly prefix: string;
  readonly light: BlockRef;
  readonly dark?: BlockRef;
}

export interface ImportOptions {
  readonly designMd?: string;
  readonly css?: CssSource;
  /** CSS variable name (without prefix) → token path, for names the type alone cannot place. */
  readonly paths?: Readonly<Record<string, string>>;
  /** CSS variable names (without prefix) to leave out, e.g. legacy shims. */
  readonly skip?: readonly string[];
}

export interface ImportReport {
  readonly tokenCount: number;
  /** Token paths whose values came from the shipped CSS. */
  readonly fromCss: readonly string[];
  /** DESIGN.md colour and the shipped CSS disagree. */
  readonly mismatches: ReadonlyArray<{ name: string; mode: "light" | "dark"; designMd: string; css: string }>;
  /** Named in DESIGN.md but absent from the CSS. */
  readonly documentedOnly: readonly string[];
  /** Shipped in the CSS but not named in DESIGN.md's frontmatter. */
  readonly undocumented: readonly string[];
  /** CSS values the importer could not type; left out of the token files. */
  readonly unparsed: ReadonlyArray<{ name: string; value: string }>;
}

export interface ImportResult {
  readonly base: TokenTree;
  readonly dark: TokenTree;
  readonly report: ImportReport;
}

interface DesignMdFrontmatter {
  colors?: Record<string, string>;
  typography?: Record<string, Record<string, string | number>>;
  rounded?: Record<string, string>;
  spacing?: Record<string, string>;
}

function frontmatterOf(designMd: string): DesignMdFrontmatter {
  const match = /^---\n([\s\S]*?)\n---/m.exec(designMd);
  return match ? ((parseYaml(match[1]!) as DesignMdFrontmatter | null) ?? {}) : {};
}

/** `- **Frame Grey** (ground, #efefef / #0b0b0b): the frame …` → { ground: "Frame Grey: the frame …" }. */
function proseDescriptions(designMd: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of designMd.matchAll(/^- \*\*(.+?)\*\* \(([a-z][a-z0-9-]*)[ ,)][^\n]*?\):\s*(.+)$/gm)) {
    const sentence = match[3]!.split(/(?<=\.)\s/)[0]!.replace(/\*\*/g, "");
    found.set(match[2]!, `${match[1]}: ${sentence}`.slice(0, 200));
  }
  return found;
}

function setToken(tree: TokenTree, path: string, token: DtcgToken): void {
  const segments = path.split(".");
  let node = tree;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (next === undefined) node[segment] = {};
    node = node[segment] as TokenTree;
  }
  node[segments.at(-1)!] = token;
}

function defaultCssName(path: string): string {
  return path.replace(/\./g, "-");
}

interface TypedValue {
  readonly type: string;
  readonly value: unknown;
}

function typeLiteral(value: string): TypedValue | null {
  const color = parseCssColor(value);
  if (color) return { type: "color", value: color };
  const shadow = parseShadow(value);
  if (shadow && shadow.length > 0 && /\d/.test(value) && value.includes(" ")) return { type: "shadow", value: shadow };
  const bezier = parseCubicBezier(value);
  if (bezier) return { type: "cubicBezier", value: bezier };
  const dimension = parseDimension(value);
  if (dimension) return { type: "dimension", value: dimension };
  return null;
}

const GROUP_BY_TYPE: Record<string, string> = { color: "color", shadow: "shadow", cubicBezier: "easing", dimension: "space" };

function emEtc(value: string | number | undefined, fontSize: DtcgDimension): DtcgDimension | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (text.endsWith("em")) return { value: Math.round(Number(text.slice(0, -2)) * fontSize.value * 1000) / 1000, unit: "px" };
  return parseDimension(text) ?? undefined;
}

function lineHeightOf(value: string | number | undefined, fontSize: DtcgDimension): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const px = parseDimension(value);
  return px ? Math.round((px.value / fontSize.value) * 10_000) / 10_000 : Number(value);
}

function importTypography(fm: DesignMdFrontmatter, base: TokenTree): string[] {
  const families = new Map<string, string>();
  const paths: string[] = [];
  for (const [name, spec] of Object.entries(fm.typography ?? {})) {
    const familyText = String(spec.fontFamily ?? "");
    const familyId = /mono/i.test(familyText) ? "font.mono" : "font.sans";
    families.set(familyId, familyText);
    const fontSize = parseDimension(String(spec.fontSize ?? "")) ?? { value: 16, unit: "px" as const };
    const letterSpacing = emEtc(spec.letterSpacing, fontSize);
    const value = {
      fontFamily: `{${familyId}}`,
      fontSize,
      fontWeight: Number(spec.fontWeight ?? 400),
      lineHeight: lineHeightOf(spec.lineHeight, fontSize) ?? 1.5,
      ...(letterSpacing ? { letterSpacing } : {}),
    };
    const original = Object.fromEntries(Object.entries(spec).filter(([k]) => k === "lineHeight" || k === "letterSpacing" || k === "fontFeature"));
    setToken(base, `typography.${name}`, { $type: "typography", $value: value, ...(Object.keys(original).length ? { $extensions: { [DL_EXT]: { source: original } } } : {}) });
    paths.push(`typography.${name}`);
  }
  for (const [id, text] of families) {
    setToken(base, id, { $type: "fontFamily", $value: parseFontFamily(text) });
    paths.push(id);
  }
  return paths;
}

function importDimensions(record: Record<string, string> | undefined, group: string, base: TokenTree, taken: Set<string>): string[] {
  const paths: string[] = [];
  for (const [name, raw] of Object.entries(record ?? {})) {
    const dimension = parseDimension(String(raw));
    const path = `${group}.${name}`;
    if (!dimension || taken.has(path)) continue;
    setToken(base, path, { $type: "dimension", $value: dimension });
    paths.push(path);
  }
  return paths;
}

interface CssEntry {
  readonly name: string;
  readonly light: string;
  readonly dark: string | undefined;
}

function cssEntries(source: CssSource, skip: ReadonlySet<string>): CssEntry[] {
  const strip = (map: Map<string, { value: string }>): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [prop, decl] of map) if (prop.startsWith(`--${source.prefix}-`)) out.set(prop.slice(source.prefix.length + 3), decl.value);
    return out;
  };
  const light = strip(customProperties(source.css, source.light.selector, source.light.outer));
  const dark = source.dark ? strip(customProperties(source.css, source.dark.selector, source.dark.outer)) : new Map<string, string>();
  return [...light].filter(([name]) => !skip.has(name)).map(([name, value]) => ({ name, light: value, dark: dark.get(name) }));
}

function aliasTarget(value: string, prefix: string): string | null {
  return new RegExp(`^var\\(--${prefix}-([a-z0-9-]+)\\)$`).exec(value.trim())?.[1] ?? null;
}

export function importTokens(options: ImportOptions): ImportResult {
  const fm = options.designMd ? frontmatterOf(options.designMd) : {};
  const descriptions = options.designMd ? proseDescriptions(options.designMd) : new Map<string, string>();
  const base: TokenTree = {};
  const dark: TokenTree = {};
  const fromCss: string[] = [];
  const unparsed: Array<{ name: string; value: string }> = [];
  const mismatches: Array<{ name: string; mode: "light" | "dark"; designMd: string; css: string }> = [];
  const mdColors = fm.colors ?? {};
  const mdColorNames = new Set(Object.keys(mdColors).filter((k) => !k.endsWith("-dark")));
  const cssNames = new Set<string>();

  if (options.css) {
    const source = options.css;
    const entries = cssEntries(source, new Set(options.skip ?? []));
    const pathOf = new Map<string, string>();
    const typed = new Map<string, TypedValue>();
    for (const entry of entries) {
      const literal = typeLiteral(entry.light);
      if (literal) typed.set(entry.name, literal);
    }
    for (const entry of entries) {
      const target = aliasTarget(entry.light, source.prefix);
      const type = typed.get(entry.name)?.type ?? (target ? typed.get(target)?.type : undefined);
      if (!type) {
        unparsed.push({ name: entry.name, value: entry.light });
        continue;
      }
      pathOf.set(entry.name, options.paths?.[entry.name] ?? `${GROUP_BY_TYPE[type]}.${entry.name}`);
      typed.set(entry.name, typed.get(entry.name) ?? { type, value: null });
    }
    for (const entry of entries) {
      const path = pathOf.get(entry.name);
      if (!path) continue;
      cssNames.add(entry.name);
      const { type } = typed.get(entry.name)!;
      const target = aliasTarget(entry.light, source.prefix);
      const lightValue = target ? `{${pathOf.get(target) ?? target}}` : typed.get(entry.name)!.value;
      const extensions = defaultCssName(path) === entry.name ? undefined : { [DL_EXT]: { css: entry.name } };
      const description = descriptions.get(entry.name);
      setToken(base, path, { $type: type, $value: lightValue, ...(description ? { $description: description } : {}), ...(extensions ? { $extensions: extensions } : {}) });
      fromCss.push(path);
      if (entry.dark !== undefined && entry.dark !== entry.light && !aliasTarget(entry.dark, source.prefix)) {
        const darkValue = typeLiteral(entry.dark);
        if (darkValue) setToken(dark, path, { $type: type, $value: darkValue.value });
        else unparsed.push({ name: `${entry.name} (dark)`, value: entry.dark });
      }
      for (const mode of ["light", "dark"] as const) {
        const md = mdColors[mode === "light" ? entry.name : `${entry.name}-dark`];
        const css = mode === "light" ? entry.light : entry.dark;
        const mdColor = md ? parseCssColor(String(md)) : null;
        const cssColor = css ? parseCssColor(css) : null;
        if (mdColor && cssColor && !sameColor(mdColor, cssColor)) mismatches.push({ name: entry.name, mode, designMd: String(md), css: css! });
      }
    }
  } else {
    for (const name of mdColorNames) {
      const color = parseCssColor(String(mdColors[name]));
      if (!color) continue;
      setToken(base, `color.${name}`, { $type: "color", $value: color, ...(descriptions.get(name) ? { $description: descriptions.get(name)! } : {}) });
      const darkColor = parseCssColor(String(mdColors[`${name}-dark`] ?? ""));
      if (darkColor && !sameColor(color as DtcgColor, darkColor)) setToken(dark, `color.${name}`, { $type: "color", $value: darkColor });
    }
  }

  const taken = new Set(fromCss);
  const shapePaths = [...importDimensions(fm.rounded, "radius", base, taken), ...importDimensions(fm.spacing, "space", base, taken)];
  const typePaths = importTypography(fm, base);
  const documentedOnly = options.css ? [...mdColorNames].filter((n) => !cssNames.has(n)).sort() : [];
  const undocumented = options.css ? [...cssNames].filter((n) => !mdColorNames.has(n)).sort() : [];
  return {
    base,
    dark,
    report: { tokenCount: fromCss.length + shapePaths.length + typePaths.length + (options.css ? 0 : mdColorNames.size), fromCss, mismatches, documentedOnly, undocumented, unparsed },
  };
}

/** Human-readable CSS for a DTCG colour, for reports. */
export function describeColor(value: unknown): string {
  return typeof value === "object" && value !== null && "colorSpace" in value ? formatCssColor(value as DtcgColor) : String(value);
}
