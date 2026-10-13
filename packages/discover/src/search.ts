/**
 * Search the local index by need. A need is read as concepts (aliases.ts) and plain words;
 * each candidate scores on its name, title, categories, description and the packages it is
 * built on (a cmdk-based item is a command menu), then gets a small, bounded lift from its
 * signals, so popularity breaks ties and never outranks a match. Read-only: no fetching.
 */
import { cleanText } from "./text.ts";
import { LIBRARY_SOURCE_KINDS, type LibraryEntry, type LibrarySourceKind } from "@youiyoux/core";
import { z } from "zod";
import { conceptForRole, hasPhrase, normalize, readNeed, type Concept } from "./aliases.ts";
import type { DiscoverIndex } from "./store.ts";

export const DISCOVER_RULE = "Discover candidates are outside references: not in the System, not approved. Never install, import or copy one; to propose one, draft an adoption request (library_request) for a person to decide.";

export const DiscoverConstraints = z.object({
  /** Allowed SPDX licences (`MIT`, `Apache-2.0`); candidates with another or an unknown licence are left out. */
  framework: z.enum(["react", "vue", "svelte", "angular", "solid"]).optional().describe("Prefer this framework; defaults to React"),
  licenses: z.array(z.string().min(1)).optional(),
  /** Keep candidates whose licence is unknown even when `licenses` is set. */
  allowUnknownLicense: z.boolean().optional(),
  sources: z.array(z.enum(LIBRARY_SOURCE_KINDS)).optional(),
  /** Only these registries (`@coss`, `@shadcn`) or `npm`. */
  registries: z.array(z.string().min(1)).optional(),
  kinds: z.array(z.enum(["component", "pattern"])).optional(),
  minWeeklyDownloads: z.number().int().nonnegative().optional(),
  minStars: z.number().int().nonnegative().optional(),
  excludeArchived: z.boolean().optional(),
});
export type DiscoverConstraints = z.infer<typeof DiscoverConstraints>;

export interface SearchOptions {
  readonly role?: string;
  readonly constraints?: DiscoverConstraints;
  readonly limit?: number;
}

export interface DiscoverHit {
  readonly id: string;
  readonly name: string;
  readonly title: string | null;
  readonly kind: LibraryEntry["kind"];
  readonly summary: string;
  readonly source: { readonly kind: LibrarySourceKind | null; readonly name: string; readonly ref: string | null; readonly url: string | null };
  /** An SPDX id, or "unknown" when nothing backs one. */
  readonly license: string;
  readonly signals: { readonly via?: { readonly package: string; readonly weeklyDownloads: number }; readonly weeklyDownloads: number | null; readonly stars: number | null; readonly pushedAt: string | null; readonly archived: boolean | null };
  readonly install: { readonly command: string; readonly npm: readonly string[]; readonly registryDeps: readonly string[]; readonly implicitDeps: readonly string[] } | null;
  readonly score: number;
  /** What matched, for a person to judge the ranking: `name=command`, `depends on cmdk`. */
  readonly why: readonly string[];
}

export interface DiscoverSearch {
  readonly need: string;
  readonly concepts: readonly string[];
  readonly hits: readonly DiscoverHit[];
  /** Candidates that matched, before the limit. */
  readonly matched: number;
  readonly total: number;
  readonly indexBuiltAt: string;
  readonly note: string;
  /** Where this page starts in the ranked matches (store searches page; the JSON index does not). */
  readonly offset?: number;
  /** `all` when --all listings were searched too. */
  readonly scope?: "chosen" | "all";
  /** Matches by role, source, licence and headless/styled, when asked for. */
  readonly facets?: DiscoverFacets;
}

export interface DiscoverFacets {
  readonly role: Readonly<Record<string, number>>;
  readonly source: Readonly<Record<string, number>>;
  readonly licence: Readonly<Record<string, number>>;
  readonly style: Readonly<Record<string, number>>;
}

export interface Fields {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly categories: readonly string[];
  readonly packages: readonly string[];
}

const fieldCache = new WeakMap<LibraryEntry, Fields>();
export function fieldsOf(entry: LibraryEntry): Fields {
  const hit = fieldCache.get(entry);
  if (hit) return hit;
  const fields = {
    name: normalize(entry.name.replace(/^@[^/]+\//, "")),
    title: normalize(entry.title ?? ""),
    description: normalize(entry.summary),
    categories: entry.categories.map(normalize),
    packages: entry.install?.npm ?? [],
  };
  fieldCache.set(entry, fields);
  return fields;
}

const W = { nameExact: 10, nameHas: 6, titleExact: 9, titleHas: 5, category: 4, dependsOn: 6, description: 3 } as const;

/** The best a concept scores on a candidate, plus a little for every other field that agrees. */
export function conceptScore(concept: Concept, f: Fields, why: string[]): number {
  const names = concept.names.map(normalize);
  const scores: Array<[number, string]> = [];
  const exact = names.find((n) => f.name === n);
  if (exact) scores.push([W.nameExact, `name=${exact}`]);
  else {
    const has = names.find((n) => hasPhrase(f.name, n));
    if (has) scores.push([W.nameHas, `name~${has}`]);
  }
  const titleExact = names.find((n) => f.title === n);
  if (titleExact) scores.push([W.titleExact, `title=${titleExact}`]);
  else {
    const has = names.find((n) => hasPhrase(f.title, n));
    if (has) scores.push([W.titleHas, `title~${has}`]);
  }
  const category = f.categories.find((c) => c === normalize(concept.id) || names.includes(c));
  if (category) scores.push([W.category, `category ${category}`]);
  const dep = concept.packages.find((p) => f.packages.includes(p)) ?? f.packages.find((p) => names.includes(normalize(p)));
  if (dep) scores.push([W.dependsOn, `depends on ${dep}`]);
  const said = names.find((n) => hasPhrase(f.description, n));
  if (said) scores.push([W.description, `says ${said}`]);
  if (scores.length === 0) return 0;
  scores.sort((a, b) => b[0] - a[0]);
  why.push(...scores.map(([, w]) => w));
  return scores[0]![0] + 0.5 * (scores.length - 1);
}

function wordScore(word: string, f: Fields, why: string[]): number {
  if (hasPhrase(f.name, word)) return why.push(`name~${word}`), 3;
  if (hasPhrase(f.title, word)) return why.push(`title~${word}`), 2;
  if (f.categories.some((c) => hasPhrase(c, word)) || hasPhrase(f.description, word)) return why.push(`says ${word}`), 1;
  return 0;
}

const KIND_WEIGHT: Readonly<Record<LibraryEntry["kind"], number>> = { component: 1, pattern: 0.85, token: 0.7 };

/** At most +3 for popularity and upkeep, down to -2 for an archived repository: never more than half a name match. */
export function signalBoost(entry: LibraryEntry): number {
  const s = entry.signals;
  let boost = 0;
  const downloads = s?.weeklyDownloads ?? s?.via?.weeklyDownloads;
  if (downloads) boost += Math.min(1.5, Math.log10(downloads + 1) / 5) * (entry.source.kind === "npm" ? 1 : 0.25);
  if (s?.stars) boost += Math.min(1, Math.log10(s.stars + 1) / 5);
  const health = entry.provenance?.registryHealth;
  if (health?.score != null) boost += Math.max(0, Math.min(1, health.score / 100)) * 0.25;
  if (entry.license && entry.license !== "unknown") boost += 0.25;
  if (s?.archived) boost -= 2;
  return Math.max(-2, Math.min(3, boost));
}

export function registryName(entry: LibraryEntry): string {
  if (entry.source.kind === "npm") return "npm";
  const ref = entry.source.ref ?? "";
  return ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : entry.source.name;
}

export function passes(entry: LibraryEntry, c: DiscoverConstraints | undefined): boolean {
  if (!c) return true;
  if (c.licenses?.length) {
    const spdx = entry.license && entry.license !== "unknown" ? entry.license.spdx : null;
    if (spdx === null ? !c.allowUnknownLicense : !c.licenses.some((l) => l.toLowerCase() === spdx.toLowerCase())) return false;
  }
  if (c.sources?.length && !(entry.source.kind && c.sources.includes(entry.source.kind))) return false;
  if (c.registries?.length && !c.registries.map((r) => r.toLowerCase()).includes(registryName(entry).toLowerCase())) return false;
  if (c.kinds?.length && !c.kinds.includes(entry.kind as "component" | "pattern")) return false;
  if (c.minWeeklyDownloads !== undefined && (entry.signals?.weeklyDownloads ?? -1) < c.minWeeklyDownloads) return false;
  if (c.minStars !== undefined && (entry.signals?.stars ?? -1) < c.minStars) return false;
  if (c.excludeArchived && entry.signals?.archived) return false;
  return true;
}

/** Does the candidate play this role? The role's concept must match it; a role no concept knows is matched as words. */
export function playsRole(role: string, f: Fields): boolean {
  const concept = conceptForRole(role);
  if (concept) return conceptScore(concept, f, []) > 0;
  const n = normalize(role);
  return hasPhrase(f.name, n) || f.categories.some((c) => hasPhrase(c, n));
}

export function hitOf(entry: LibraryEntry, score: number, why: readonly string[]): DiscoverHit {
  return {
    id: entry.id,
    name: entry.name,
    title: entry.title ?? null,
    kind: entry.kind,
    summary: entry.summary,
    source: { kind: entry.source.kind ?? null, name: entry.source.name, ref: entry.source.ref ?? null, url: entry.source.url ?? null },
    license: entry.license && entry.license !== "unknown" ? entry.license.spdx : "unknown",
    signals: { ...(entry.signals?.via ? { via: entry.signals.via } : {}), weeklyDownloads: entry.signals?.weeklyDownloads ?? null, stars: entry.signals?.stars ?? null, pushedAt: entry.signals?.pushedAt ?? null, archived: entry.signals?.archived ?? null },
    install: entry.install ? { command: entry.install.command, npm: entry.install.npm, registryDeps: entry.install.registryDeps, implicitDeps: entry.install.implicitDeps } : null,
    score: Math.round(score * 100) / 100,
    why,
  };
}

export function isIconEntry(entry: LibraryEntry): boolean {
  return /(?:^|[\s/_-])icons?(?:$|[\s/_-])/i.test([entry.name, ...entry.categories, entry.source.name].join(" "));
}

function frameworkOf(entry: LibraryEntry): string {
  const deps = [...(entry.install?.npm ?? []), ...(entry.install?.implicitDeps ?? [])].join(" ");
  const paths = entry.provenance?.files.map((file) => file.path).join(" ") ?? "";
  if (/\bvue\b|\.vue\b/i.test(`${deps} ${paths}`)) return "vue";
  if (/\bsvelte\b|\.svelte\b/i.test(`${deps} ${paths}`)) return "svelte";
  if (/@angular\//.test(deps)) return "angular";
  if (/\bsolid-js\b/.test(deps)) return "solid";
  return "react";
}

export interface Ranked {
  readonly need: string;
  readonly concepts: readonly string[];
  /** Best first: score, then id. */
  readonly scored: ReadonlyArray<{ readonly entry: LibraryEntry; readonly score: number; readonly why: readonly string[] }>;
}

/** Score candidates for a need, best first. The one ranking: the JSON index and the store both use it. */
export function rankEntries(entries: Iterable<LibraryEntry>, need: string, options: Omit<SearchOptions, "limit"> = {}): Ranked {
  need = cleanText(need);
  const read = readNeed(need);
  const scored: Array<{ entry: LibraryEntry; score: number; why: string[] }> = [];
  for (const entry of entries) {
    if (!passes(entry, options.constraints)) continue;
    const f = fieldsOf(entry);
    if (options.role && !playsRole(options.role, f)) continue;
    const why: string[] = [];
    let text = 0;
    for (const concept of read.concepts) text += conceptScore(concept, f, why);
    for (const word of read.words) text += wordScore(word, f, why);
    if (text <= 0) continue;
    let suitability = 1;
    if (isIconEntry(entry)) { suitability *= 0.3; why.push("icon set"); }
    const framework = frameworkOf(entry);
    if (framework !== (options.constraints?.framework ?? "react")) {
      suitability *= 0.3;
      why.push(`framework ${framework}`);
    }
    scored.push({ entry, score: (text * KIND_WEIGHT[entry.kind] + signalBoost(entry)) * suitability, why });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return { need, concepts: read.concepts.map((c) => c.id), scored };
}

export function searchIndex(index: DiscoverIndex, need: string, options: SearchOptions = {}): DiscoverSearch {
  const ranked = rankEntries(index.entries, need, options);
  return {
    need: ranked.need,
    concepts: ranked.concepts,
    hits: ranked.scored.slice(0, options.limit ?? 10).map((s) => hitOf(s.entry, s.score, s.why)),
    matched: ranked.scored.length,
    total: index.entries.length,
    indexBuiltAt: index.builtAt,
    note: DISCOVER_RULE,
  };
}

export interface DiscoverShow {
  readonly entry: LibraryEntry;
  readonly indexBuiltAt: string;
  readonly note: string;
}

/** One candidate in full, by lib: id or registry ref (`@coss/command`, an npm name). */
export function showCandidate(index: DiscoverIndex, query: string): DiscoverShow {
  const q = cleanText(query).trim();
  const entry = index.entries.find((e) => e.id === q) ?? index.entries.find((e) => e.source.ref === q) ?? index.entries.find((e) => e.source.kind === "shadcn-registry" && e.source.ref === `@shadcn/${q}`);
  if (!entry) throw new Error(`no Discover candidate "${q}": pass a lib: id or a ref (@coss/command) from youi discover / discover_search`);
  return { entry, indexBuiltAt: index.builtAt, note: DISCOVER_RULE };
}
