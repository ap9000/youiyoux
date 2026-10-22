/**
 * Where candidates come from, and how a fetched item becomes a youi.library/v1 entry.
 *
 *   shadcn      the official registry: /r/index.json (docs links) and the new-york-v4 registry.json
 *   directory   /r/registries.json: every community registry, its URL template and health
 *   community   each listed registry's registry.json, unless the directory says it is unavailable or hidden
 *   headless    Base UI and React Aria llms.txt, Ark's component list, the radix-ui meta-package's
 *               dependencies: only for category names, never as candidates
 *   npm         packages found by searching npm for each concept (see aliases.ts)
 *
 * Every payload is parsed item by item: one malformed item is skipped and counted, never fatal.
 */
import { publicHttps } from "./urls.ts";
import { cleanData, cleanText } from "./text.ts";
import { z } from "zod";
import { LibraryEntry, sha256, type LibraryLicense } from "@youiyoux/core";
import { hasPhrase, normalize, type Concept } from "./aliases.ts";

export const CURATED = ["@coss", "@kibo-ui", "@magicui", "@aceternity"] as const;

export const SHADCN = {
  name: "@shadcn",
  homepage: "https://ui.shadcn.com",
  index: "https://ui.shadcn.com/r/index.json",
  registry: "https://ui.shadcn.com/r/styles/new-york-v4/registry.json",
  directory: "https://ui.shadcn.com/r/registries.json",
  repo: "shadcn-ui/ui",
} as const;

export interface HeadlessCatalog {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly accept: string;
  readonly parse: (body: string) => string[];
}

/* ------------------------------------------------------------------ directory */

const Health = z.object({
  status: z.string(),
  score: z.number().nullish(),
  checkedAt: z.string().datetime({ offset: true }).nullish(),
  hidden: z.boolean().nullish(),
});

const DirectoryRow = z.object({
  name: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/i),
  homepage: z.string().url().nullish(),
  url: z.string().includes("{name}").refine((template) => URL.canParse(registryUrl(template)), "not a URL template"),
  description: z.string().nullish(),
  health: Health.nullish(),
  ranking: z.object({ itemCount: z.number().nullish() }).passthrough().nullish(),
});

export interface DirectoryRegistry {
  readonly name: string;
  readonly homepage: string | null;
  readonly template: string;
  readonly description: string | null;
  readonly health: { readonly status: string; readonly score: number | null; readonly checkedAt: string | null; readonly hidden: boolean };
  readonly itemCount: number | null;
}

/** The directory's rows; rows that do not parse are counted, not fatal. */
export function parseDirectory(value: unknown): { registries: DirectoryRegistry[]; invalid: number } {
  const rows = Array.isArray(value) ? value : [];
  const registries: DirectoryRegistry[] = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = DirectoryRow.safeParse(row);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const r = cleanData(parsed.data);
    registries.push({
      name: r.name.toLowerCase(),
      homepage: r.homepage ?? null,
      template: r.url,
      description: r.description ?? null,
      health: { status: r.health?.status ?? "unknown", score: r.health?.score ?? null, checkedAt: r.health?.checkedAt ?? null, hidden: r.health?.hidden ?? false },
      itemCount: r.ranking?.itemCount ?? null,
    });
  }
  return { registries, invalid };
}

/** Why a registry is not fetched, or null to fetch it: the directory's own word decides. */
export function skipReason(registry: DirectoryRegistry): string | null {
  if (!publicHttps(registryUrl(registry.template)) || (registry.homepage !== null && !publicHttps(registry.homepage))) return "URL must use https on a public host";
  if (registry.name === SHADCN.name) return "the official registry is read from its own index";
  if (registry.health.hidden) return "hidden in the registry directory";
  if (registry.health.status === "unavailable") return "unavailable in the registry directory";
  return null;
}

/** A registry's registry.json, from its item URL template (`https://x.dev/r/{name}.json`). */
export function registryUrl(template: string, item = "registry"): string {
  return template.replace("{name}", item);
}

/* -------------------------------------------------------------------- registry */

const RegistryFile = z.object({ path: z.string(), type: z.string().optional(), content: z.string().optional(), sha256: z.string().nullable().optional(), target: z.string().optional() }).passthrough();

const RegistryItem = z
  .object({
    implicitDeps: z.array(z.string()).optional(),
    itemSha256: z.string().optional(),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
    type: z.string(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    dependencies: z.array(z.string()).nullish(),
    devDependencies: z.array(z.string()).nullish(),
    registryDependencies: z.array(z.string()).nullish(),
    files: z.array(RegistryFile).nullish(),
    categories: z.array(z.string()).nullish(),
    meta: z.record(z.string(), z.unknown()).nullish(),
    docs: z.string().nullish(),
  })
  .passthrough();
export type RegistryItem = z.infer<typeof RegistryItem>;

/** Item types offered as candidates: components and blocks people use; examples, styles, themes and fonts are not. */
const CANDIDATE_TYPES: Readonly<Record<string, LibraryEntry["kind"]>> = { "registry:ui": "component", "registry:component": "component", "registry:hook": "component", "registry:block": "pattern" };

export function isCandidate(item: RegistryItem): boolean {
  return item.type in CANDIDATE_TYPES;
}

/** A registry.json's items (`{ items: [] }`, or the official index's bare array). */
export function parseRegistryItems(value: unknown): { items: RegistryItem[]; invalid: number } {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : null;
  if (!rows) return { items: [], invalid: 0 };
  const items: RegistryItem[] = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = RegistryItem.safeParse(row);
    if (parsed.success) {
      const item = parsed.data;
      const digest = item.itemSha256 ?? sha256(JSON.stringify(item));
      items.push(cleanData({ ...item, itemSha256: digest, files: item.files?.map((file) => ({ ...file, sha256: file.sha256 ?? (file.content === undefined ? null : sha256(file.content)) })) }));
    }
    else invalid++;
  }
  return { items, invalid };
}

export function looksLikeRegistry(value: unknown): boolean {
  return Array.isArray(value) || Boolean(value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items));
}

/** `react-day-picker@latest` → `react-day-picker`; `@scope/pkg@1` → `@scope/pkg`. */
export function packageName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at > 0 ? spec.slice(0, at) : spec;
}

const IMPORT = /(?:\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?|\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
/** Always present where a registry item lands, so never reported as missing. */
const AMBIENT = new Set(["react", "react-dom"]);

/** The npm packages a file imports (bare specifiers, by package), in first-seen order. */
export function importedPackages(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(IMPORT)) {
    const spec = match[1]!;
    if (/^(\.|\/|@\/|~\/|#|node:)/.test(spec) || spec.startsWith("@/")) continue;
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (name && !AMBIENT.has(name)) found.add(name);
  }
  return [...found];
}

/** Packages the item's code imports without declaring them: what an install would silently need. */
export function implicitDeps(item: RegistryItem): string[] {
  if (item.implicitDeps) return item.implicitDeps;
  const declared = new Set([...(item.dependencies ?? []), ...(item.devDependencies ?? [])].map(packageName));
  const found = new Set<string>();
  for (const file of item.files ?? []) if (file.content) for (const name of importedPackages(file.content)) if (!declared.has(name)) found.add(name);
  return [...found].sort();
}

/* ----------------------------------------------------------------------- ids */

/** A source slug for lib: ids (`@kibo-ui` → `kibo-ui`, `@000h` → `r-000h`). */
export function sourceSlug(name: string): string {
  const slug = name.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `r-${slug || "x"}`;
}

export function nameSlug(name: string): string {
  const slug = name.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return slug || "item";
}

function summaryOf(...texts: Array<string | null | undefined>): string {
  const text = texts.map((t) => cleanText(t ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).find((t) => t.length > 0) ?? "";
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/* -------------------------------------------------------------------- entries */

export interface RegistrySource {
  readonly name: string;
  readonly homepage: string | null;
  /** The registry.json the items were read from. */
  readonly url: string;
  readonly fetchedAt: string;
  readonly official: boolean;
  readonly health: DirectoryRegistry["health"] | null;
}

/** Category names an item is known by: its own, and any headless category its name is. */
function categoriesOf(item: RegistryItem, headless: ReadonlyMap<string, readonly string[]>): string[] {
  const own = (item.categories ?? []).map((c) => c.toLowerCase());
  const name = normalize(item.name).replace(/ /g, "-");
  return [...new Set([...own, ...(headless.has(name) ? [name] : [])])];
}

/** The official registry's docs page for an item, from /r/index.json's links. */
export function docsLinks(indexItems: readonly RegistryItem[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const item of indexItems) {
    const meta = item.meta as { links?: Record<string, { docs?: unknown }> } | undefined;
    const docs = meta?.links?.radix?.docs ?? Object.values(meta?.links ?? {})[0]?.docs;
    if (typeof docs === "string" && /^https?:\/\//.test(docs)) links.set(item.name, docs);
  }
  return links;
}

export function registryEntry(source: RegistrySource, item: RegistryItem, headless: ReadonlyMap<string, readonly string[]>, docs?: string): LibraryEntry {
  const kind = CANDIDATE_TYPES[item.type] ?? "component";
  const ref = `${source.name}/${item.name}`;
  const files = (item.files ?? []).map((f) => ({ path: f.path, sha256: f.sha256 ?? (f.content === undefined ? null : sha256(f.content)) }));
  return cleanData({
    schema: "youi.library/v1",
    id: `lib:${sourceSlug(source.name)}/${kind}/${nameSlug(item.name)}`,
    name: item.name,
    ...(item.title ? { title: item.title } : source.official ? { title: item.name.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ") } : {}),
    kind,
    stage: "library",
    summary: summaryOf(item.description, item.title, `${item.name} from ${source.official ? "shadcn/ui" : source.name}`),
    source: { name: source.official ? "shadcn/ui" : source.name, ...(httpUrl(docs ?? source.homepage) ? { url: (docs ?? source.homepage)! } : {}), ingestedAt: source.fetchedAt, kind: "shadcn-registry", ref },
    categories: categoriesOf(item, headless),
    swapsWith: [],
    provenance: { fetchedAt: source.fetchedAt, url: source.url, sha256: item.itemSha256 ?? sha256(JSON.stringify(item)), files, registryHealth: source.health ? { status: source.health.status, score: source.health.score, checkedAt: source.health.checkedAt } : null },
    license: "unknown",
    install: {
      command: `npx shadcn add ${source.official ? item.name : ref}`,
      npm: [...new Set((item.dependencies ?? []).map(packageName))],
      registryDeps: [...new Set(item.registryDependencies ?? [])],
      implicitDeps: implicitDeps(item),
    },
    signals: { weeklyDownloads: null, stars: null, pushedAt: null, archived: null, package: null, repo: null },
  });
}

function httpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ headless */

const kebab = (name: string): string => normalize(name).replace(/ /g, "-");

/** `- [Alert Dialog](https://base-ui.com/react/components/alert-dialog.md): …` under its Components section. */
function baseUiComponents(body: string): string[] {
  return [...body.matchAll(/^- \[([^\]]+)\]\(https?:\/\/[^)]*\/react\/components\/[^)]+\)/gm)].map((m) => kebab(m[1]!));
}

/** React Aria's top-level component pages are PascalCase (`[DatePicker](DatePicker.md)`); guides, hooks and blog posts are not. */
function reactAriaComponents(body: string): string[] {
  return [...body.matchAll(/^- \[([A-Z][A-Za-z]+)\]\(([A-Z][A-Za-z]+)\.md\)/gm)].filter((m) => m[1] === m[2] && !/Provider$/.test(m[1]!)).map((m) => kebab(m[1]!));
}

function arkComponents(body: string): string[] {
  const value = JSON.parse(body) as unknown;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map(kebab) : [];
}

/** Radix internals the meta-package also depends on: plumbing, not components. */
const RADIX_INTERNAL = /^(primitive|context|presence|portal|popper|collection|compose-refs|direction|dismissable-layer|focus-guards|focus-scope|roving-focus|arrow|id|slot|use-.*|visually-hidden|accessible-icon)$/;

function radixComponents(body: string): string[] {
  const deps = Object.keys(((JSON.parse(body) as { dependencies?: Record<string, string> }).dependencies ?? {}));
  return deps.filter((d) => d.startsWith("@radix-ui/react-")).map((d) => d.slice("@radix-ui/react-".length)).filter((n) => !RADIX_INTERNAL.test(n));
}

export const HEADLESS: readonly HeadlessCatalog[] = [
  { id: "base-ui", name: "Base UI", url: "https://base-ui.com/llms.txt", accept: "text/plain", parse: baseUiComponents },
  { id: "react-aria", name: "React Aria", url: "https://react-aria.adobe.com/llms.txt", accept: "text/plain", parse: reactAriaComponents },
  { id: "ark", name: "Ark UI", url: "https://ark-ui.com/api/types/react", accept: "application/json", parse: arkComponents },
  { id: "radix", name: "Radix", url: "https://registry.npmjs.org/radix-ui/latest", accept: "application/json", parse: radixComponents },
];

/** Category name → the headless libraries that have it. */
export function mergeCategories(found: ReadonlyArray<{ id: string; names: readonly string[] }>): Map<string, string[]> {
  const categories = new Map<string, string[]>();
  for (const { id, names } of found) for (const name of names) categories.set(name, [...new Set([...(categories.get(name) ?? []), id])]);
  return new Map([...categories].sort(([a], [b]) => a.localeCompare(b)));
}

/* ------------------------------------------------------------------------ npm */

export const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search";

export function npmSearchUrl(concept: Concept, size = 5): string {
  return `${NPM_SEARCH}?text=${encodeURIComponent(`${concept.names[0]} react`)}&size=${size}`;
}

const NpmSearchObject = z
  .object({
    package: z.object({ name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i), version: z.string().optional(), description: z.string().nullish(), keywords: z.array(z.string()).nullish(), license: z.string().nullish(), links: z.object({ npm: z.string().nullish(), repository: z.string().nullish(), homepage: z.string().nullish() }).passthrough().nullish() }).passthrough(),
    downloads: z.object({ weekly: z.number().nullish() }).passthrough().nullish(),
  })
  .passthrough();
export type NpmSearchObject = z.infer<typeof NpmSearchObject>;

export function parseNpmSearch(value: unknown): NpmSearchObject[] {
  const objects = (value as { objects?: unknown } | null)?.objects;
  return Array.isArray(objects) ? objects.flatMap((o) => (NpmSearchObject.safeParse(o).success ? [cleanData(NpmSearchObject.parse(o))] : [])) : [];
}

/** Only well-formed SPDX expressions count as a licence (`MIT`, `(MIT OR Apache-2.0)`); anything else is unknown. */
export function spdxOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || /^(UNLICENSED|NOASSERTION|NONE)$/i.test(v) || /^SEE LICENSE/i.test(v)) return null;
  return /^\(?[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*\)?$/.test(v) ? v : null;
}

/** `git+https://github.com/pacocoursey/cmdk.git` → `pacocoursey/cmdk`. */
export function githubRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Does this npm result answer the concept, by its name, description or keywords? */
function answers(object: NpmSearchObject, concept: Concept): boolean {
  const text = normalize([object.package.name, object.package.description ?? "", ...(object.package.keywords ?? [])].join(" "));
  return concept.packages.includes(object.package.name) || concept.names.some((name) => hasPhrase(text, normalize(name)));
}

export const MIN_WEEKLY_DOWNLOADS = 1000;

/** npm-only candidates: results that answer the concept and are used (≥ 1000 weekly downloads). */
export function npmCandidates(concept: Concept, objects: readonly NpmSearchObject[]): NpmSearchObject[] {
  return objects.filter((o) => (o.downloads?.weekly ?? 0) >= MIN_WEEKLY_DOWNLOADS && answers(o, concept));
}

export function npmEntry(object: NpmSearchObject, concepts: readonly Concept[], searchUrl: string, fetchedAt: string): LibraryEntry {
  const pkg = object.package;
  const spdx = spdxOrNull(pkg.license);
  const page = pkg.links?.npm && httpUrl(pkg.links.npm) ? pkg.links.npm : `https://www.npmjs.com/package/${pkg.name}`;
  const license: LibraryLicense = spdx ? { spdx, evidenceUrl: page, verifiedAt: fetchedAt } : "unknown";
  return cleanData({
    schema: "youi.library/v1",
    id: `lib:npm/component/${nameSlug(pkg.name.replace("/", "-"))}`,
    name: pkg.name,
    kind: "component",
    stage: "library",
    summary: summaryOf(pkg.description, `${pkg.name} on npm`),
    source: { name: "npm", url: page, ingestedAt: fetchedAt, kind: "npm", ref: pkg.name },
    categories: [...new Set([...concepts.map((c) => c.id), ...(pkg.keywords ?? []).slice(0, 8).map((k) => k.toLowerCase())])],
    swapsWith: [],
    provenance: { fetchedAt, url: searchUrl, sha256: sha256(JSON.stringify(pkg)), files: [], registryHealth: null },
    license,
    install: { command: `npm install ${pkg.name}`, npm: [pkg.name], registryDeps: [], implicitDeps: [] },
    signals: { weeklyDownloads: object.downloads?.weekly ?? null, stars: null, pushedAt: null, archived: null, package: pkg.name, repo: githubRepo(pkg.links?.repository) },
  });
}

