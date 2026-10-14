/**
 * Theme fit: how much of an outside component a project's own theme would draw, read from the
 * component's classes and the theme variables its registry item brings, against the project's
 * theme (inventory/theme.ts: Tailwind's defaults, its config, its `@theme` and `:root`).
 *
 * Only what can be measured is said. A `rounded-*` or `text-*` class resolves through the
 * project's own scale, so it is themed, and when the project sets that step itself the value
 * is named. A colour utility is themed when the project defines that colour (`--color-<name>`),
 * and not when it does not (it would draw with no colour). Tailwind palette colours and
 * arbitrary values (`text-[13px]`, `bg-[#fff]`) are fixed, never the project's. The item's
 * most used type size is compared with the project's: `16px type (text-base), project uses
 * 14px (text-sm)`. A variable the item brings that the project lacks is listed too. Anything
 * not measured is not claimed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTheme, readStylesheet, type Theme } from "../inventory/theme.ts";
import { loadInventoryTarget } from "../inventory/target.ts";
import { relativeInside } from "./contain.ts";

export interface ThemeFit {
  /** What draws with the project's own tokens, in plain words. */
  readonly themed: readonly string[];
  /** What could not be themed, and why, in plain words. */
  readonly unthemed: readonly string[];
  /** The item's most used type size and the project's, in px. */
  readonly type: { readonly item: number | null; readonly project: number | null };
  /** The item's most used radius, in px through the project's scale. */
  readonly radius: number | null;
}

export interface FitInput {
  readonly theme: Theme;
  /** The item's code (its files' text). */
  readonly item: readonly string[];
  /** The project's own component code, for the type size it uses most. */
  readonly project: readonly string[];
  /** The registry item's `cssVars` (`theme`, `light`, `dark`). */
  readonly cssVars?: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
}

const SIZES = "xs|sm|base|lg|xl|[2-9]xl";
const RADII = "none|xs|sm|md|lg|xl|2xl|3xl|4xl|full";
const RADIUS_CLASS = new RegExp(`^rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(?:-(${RADII}|\\[[^\\]]+\\]))?$`);
const DEFAULT_RADIUS: Readonly<Record<string, number>> = { xs: 2, sm: 4, DEFAULT: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, "4xl": 32 };
const DEFAULT_TEXT: Readonly<Record<string, number>> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36, "5xl": 48, "6xl": 60 };
/** An arbitrary Tailwind value that is a colour: a hex, a colour function, or a `color:` hint. */
const ARBITRARY_COLOUR = /^[[(](?:#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\(|color:)/i;
const PALETTE = /^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;
const KEYWORDS = new Set(["white", "black", "transparent", "current", "inherit", "none"]);
/** `text-*`, `border-*`, `ring-*`, … that are not colours. */
const NOT_COLOUR = /^(?:text-(?:left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)|border-(?:\d+|x|y|t|r|b|l|s|e|solid|dashed|dotted|double|hidden|none|collapse|separate)(?:-\d+)?|ring-(?:\d+|inset|offset(?:-\d+)?)|outline-(?:\d+|none|hidden|dashed|dotted|double|offset(?:-\d+)?)|shadow-(?:2xs|xs|sm|md|lg|xl|2xl|none|inner)|bg-(?:clip(?:-[a-z]+)?|origin(?:-[a-z]+)?|fixed|local|scroll|no-repeat|repeat.*|cover|contain|auto|center|top|bottom|left|right|blend.*|none|linear.*|radial.*|conic.*|gradient.*)|accent-auto|caret-auto|decoration-(?:\d+|solid|double|dotted|dashed|wavy|auto|from-font|clone|slice)|fill-none|stroke-(?:\d+|none))$/;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Every class-like word in quoted strings of the code, variants (`md:`, `hover:`, `[&_svg]:`) stripped, `!` and opacity kept apart. */
export function classWords(sources: readonly string[]): string[] {
  const words: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      for (const raw of match[2]!.split(/\s+/)) {
        if (!raw || raw.length > 120) continue;
        // The utility after the last variant colon outside brackets.
        let depth = 0;
        let cut = 0;
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (c === "[" || c === "(") depth++;
          else if (c === "]" || c === ")") depth--;
          else if (c === ":" && depth === 0) cut = i + 1;
        }
        const word = raw.slice(cut).replace(/^!|!$/g, "").replace(/^-/, "");
        if (/^[a-z][a-z0-9-]*(?:-\[[^\]]+\]|-\([^)]+\))?(?:\/[\w.[\]]+)?$/.test(word)) words.push(word);
      }
    }
  }
  return words;
}

const tally = (values: readonly string[]): Array<[string, number]> => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const textSizes = (words: readonly string[]): string[] => words.flatMap((w) => new RegExp(`^text-(${SIZES}|\\[[^\\]]+\\])$`).exec(w)?.[1] ?? []);
const textPx = (theme: Theme, key: string): number | null => (key.startsWith("[") ? theme.length(key.slice(1, -1), 16) : (theme.length(`var(--text-${key})`, 16) ?? DEFAULT_TEXT[key] ?? null));
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** How an item's classes and variables fit a project's theme. */
export function themeFit({ theme, item, project, cssVars }: FitInput): ThemeFit {
  const words = classWords(item);
  const themed: string[] = [];
  const unthemed: string[] = [];

  // Radius: each step it uses, through the project's own scale.
  const radii = tally(words.flatMap((w) => {
    const match = RADIUS_CLASS.exec(w);
    return match ? [match[1] ?? "DEFAULT"] : [];
  }));
  let radius: number | null = null;
  for (const [key] of radii) {
    if (key === "full" || key === "none") continue;
    if (key.startsWith("[")) {
      unthemed.push(`rounded-${key} is a fixed radius (${key.slice(1, -1)}), not one of your tokens`);
      continue;
    }
    const value = theme.length(`var(--radius-${key})`) ?? DEFAULT_RADIUS[key] ?? null;
    radius ??= value;
    const fallback = DEFAULT_RADIUS[key];
    if (value === null) unthemed.push(`rounded-${key}: your theme has no --radius-${key}`);
    else if (fallback !== undefined && value !== fallback) themed.push(`rounded-${key} draws with your --radius-${key}: ${px(value)} (Tailwind's default is ${px(fallback)})`);
    else themed.push(`rounded-${key}: ${px(value)}, from your radius scale`);
  }

  // Type: the size it uses most, against the size the project uses most.
  const itemSizes = tally(textSizes(words));
  const projectSizes = tally(textSizes(classWords(project)).filter((k) => !k.startsWith("[")));
  for (const [key] of itemSizes) if (key.startsWith("[")) unthemed.push(`text-${key} is a fixed size, not one of your type steps`);
  const itemMain = itemSizes.find(([k]) => !k.startsWith("["))?.[0] ?? null;
  const projectMain = projectSizes[0]?.[0] ?? null;
  const itemPx = itemMain ? textPx(theme, itemMain) : null;
  const projectPx = projectMain ? textPx(theme, projectMain) : null;
  if (itemPx !== null && projectPx !== null && itemPx !== projectPx) unthemed.push(`${px(itemPx)} type (text-${itemMain}), project uses ${px(projectPx)} (text-${projectMain})`);
  else if (itemPx !== null) themed.push(`${px(itemPx)} type (text-${itemMain})${projectPx !== null ? ", as your project uses" : ", from your type scale"}`);
  const sans = theme.variable("--font-sans");
  if (sans && !words.some((w) => /^font-(?:sans|serif|mono|\[)/.test(w))) themed.push(`type face: your --font-sans (${sans.split(",")[0]!.trim().replace(/^["']|["']$/g, "")})`);

  // Colours: by name, themed when the project defines it.
  const colours = new Map<string, Set<string>>();
  const fixed = new Set<string>();
  for (const word of words) {
    const match = /^(bg|text|border(?:-[xytrblse])?|ring-offset|ring|outline|fill|stroke|placeholder|caret|accent|decoration|divide|from|via|to|shadow)-(.+?)(?:\/[\w.[\]]+)?$/.exec(word);
    if (!match || NOT_COLOUR.test(word.replace(/\/.*$/, ""))) continue;
    const name = match[2]!;
    if (match[1] === "text" && new RegExp(`^(?:${SIZES})$`).test(name)) continue;
    if (KEYWORDS.has(name) || /^\d/.test(name)) continue;
    if (name.startsWith("[") || name.startsWith("(")) {
      // An arbitrary value is a colour only when it reads as one (`[#0a0a0a]`, `[oklch(…)]`, `[color:…]`); `ring-[3px]` is a width.
      if (ARBITRARY_COLOUR.test(name)) fixed.add(word.replace(/\/.*$/, ""));
      continue;
    }
    if (PALETTE.test(name)) {
      fixed.add(word.replace(/\/.*$/, ""));
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
    colours.set(name, (colours.get(name) ?? new Set()).add(word.replace(/\/.*$/, "")));
  }
  const yours: string[] = [];
  const missing: Array<[string, string[]]> = [];
  for (const [name, uses] of [...colours].sort(([a], [b]) => a.localeCompare(b))) {
    if (theme.variable(`--color-${name}`) !== undefined) yours.push(name);
    else missing.push([name, [...uses].sort()]);
  }
  if (yours.length > 0) themed.push(`colours: your ${yours.join(", ")}`);
  for (const [name, uses] of missing) unthemed.push(`${uses.join(", ")}: your theme has no --color-${name}, so ${uses.length === 1 ? "it draws" : "they draw"} with no colour`);
  if (fixed.size > 0) unthemed.push(`${[...fixed].sort().join(", ")}: ${fixed.size === 1 ? "a fixed colour" : "fixed colours"}, not your tokens`);

  // Variables the item brings with it.
  const brought = new Map<string, string[]>();
  for (const [scope, vars] of Object.entries(cssVars ?? {})) for (const name of Object.keys(vars ?? {})) brought.set(name, [...(brought.get(name) ?? []), scope]);
  const lacking = [...brought].filter(([name]) => theme.variable(`--${name}`) === undefined && theme.variable(`--color-${name}`) === undefined);
  if (lacking.length > 0) unthemed.push(`it brings its own ${lacking.map(([name, scopes]) => `--${name} (${scopes.join(" and ")})`).join(", ")}: your theme has ${lacking.length === 1 ? "no such variable" : "none of these"}, so ${lacking.length === 1 ? "it would be" : "they would be"} added on install`);
  const shared = brought.size - lacking.length;
  if (shared > 0) themed.push(`${plural(shared, "variable")} it brings ${shared === 1 ? "is" : "are"} already yours`);

  return { themed, unthemed, type: { item: itemPx, project: projectPx }, radius };
}

/**
 * A project's theme and its component code, read from disk the way `youiyoux inventory` reads it
 * (its stylesheets, its Tailwind config statically, never run). Files outside the root are not read.
 */
export async function projectTheme(root: string): Promise<{ theme: Theme; sources: string[] }> {
  const target = await loadInventoryTarget(root);
  const files = target.files.filter((f) => !("refused" in relativeInside(root, f)));
  const sheets = await Promise.all(files.filter((f) => f.endsWith(".css")).map(async (f) => readStylesheet(f, await readFile(join(root, f), "utf8").catch(() => ""))));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const theme = await buildTheme(root, sheets, Boolean(pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss));
  const sources = await Promise.all(files.filter((f) => /\.(?:tsx|jsx)$/.test(f)).slice(0, 400).map((f) => readFile(join(root, f), "utf8").catch(() => "")));
  return { theme, sources };
}
