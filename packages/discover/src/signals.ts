/**
 * Signals: is a candidate used, kept up, and under what licence. Each answer is cached in
 * signals.json with when it was read and reused until its TTL runs out, so repeated syncs
 * spend almost nothing. Budgets cap how much one sync asks for; what is left over stays
 * unknown (null, or licence "unknown"), never guessed.
 *
 *   npm      weekly downloads (api.npmjs.org) and licence and repository (the registry's /latest)
 *            for the main package of each candidate
 *   GitHub   stars, last push, archived and SPDX licence of the candidate's repository.
 *            A registry's repository needs a link both ways: its homepage links to a repository
 *            whose own homepage is that site (coss.com/ui links cosscom/ui, whose homepage is
 *            coss.com), or else a search finds one whose homepage is exactly the registry's.
 *            Either way a lookalike repository is never credited
 */
import { CONCEPTS } from "./aliases.ts";
import { z } from "zod";
import type { LibraryEntry, LibraryLicense } from "@youiyoux/core";
import type { PoliteClient } from "./http.ts";
import { githubRepo, SHADCN, sourceSlug, spdxOrNull } from "./sources.ts";
import type { GithubSignal, NpmSignal, SignalsFile } from "./store.ts";

const HOUR = 3_600_000;
/** A registry with no repository found is asked again after a day: that answer is the one most likely to change. */
export const SIGNAL_TTL = { npmMs: 24 * HOUR, githubMs: 7 * 24 * HOUR, registryRepoMs: 30 * 24 * HOUR, registryRepoMissMs: 24 * HOUR } as const;

export interface SignalBudgets {
  /** npm packages looked up per sync (two requests each). */
  readonly npmPackages: number;
  /** GitHub repository calls per sync; the hourly bucket caps them too. */
  readonly githubRepos: number;
  /** GitHub searches per sync, to find a registry's repository. */
  readonly githubSearches: number;
}

export function defaultBudgets(token: boolean): SignalBudgets {
  return token ? { npmPackages: 400, githubRepos: 600, githubSearches: 30 } : { npmPackages: 200, githubRepos: 50, githubSearches: 10 };
}

/** Only packages that define a component concept can stand for a registry item. */
const DEFINING = new Set(CONCEPTS.flatMap((concept) => concept.packages));

/** The npm package that stands for a candidate: the package itself, or its first dependency that defines a component concept. */
export function keyPackage(entry: LibraryEntry): string | null {
  if (entry.source.kind === "npm") return entry.source.ref ?? entry.name;
  return entry.install?.npm.find((name) => DEFINING.has(name)) ?? null;
}

/** The registry a registry entry came from (`@coss`), or null. */
export function registryOf(entry: LibraryEntry): string | null {
  if (entry.source.kind !== "shadcn-registry" || !entry.source.ref) return null;
  return entry.source.ref.slice(0, entry.source.ref.indexOf("/"));
}

const fresh = (at: string | undefined, ttl: number, now: Date): boolean => Boolean(at) && now.getTime() - Date.parse(at!) < ttl;

/** `https://www.kibo-ui.com/` and `https://kibo-ui.com` are one homepage. */
export function sameHomepage(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (value: string): string | null => {
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return null;
    }
  };
  if (!a || !b) return false;
  const ka = key(a);
  return ka !== null && ka === key(b);
}

/**
 * `https://coss.com` and `https://coss.com/ui` are one site: the same host (less www), with one
 * path inside the other, segment by segment (`/ui` is not inside `/uix`).
 */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const parts = (value: string): { host: string; path: string } | null => {
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      return { host: url.hostname.replace(/^www\./, "").toLowerCase(), path: url.pathname.replace(/\/+$/, "").toLowerCase() };
    } catch {
      return null;
    }
  };
  if (!a || !b) return false;
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb || pa.host !== pb.host) return false;
  const inside = (outer: string, inner: string): boolean => outer === "" || inner === outer || inner.startsWith(`${outer}/`);
  return inside(pa.path, pb.path) || inside(pb.path, pa.path);
}

/** GitHub's own pages, which look like `owner/repo` links but are not repositories. */
const NOT_OWNERS = new Set(["about", "apps", "collections", "contact", "enterprise", "explore", "features", "login", "marketplace", "orgs", "pricing", "settings", "site", "sponsors", "topics"]);

/** The GitHub repositories a page links to, most-linked first. */
export function linkedRepos(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = match[1]!;
    const repo = match[2]!.replace(/\.git$/, "").replace(/\.+$/, "");
    if (NOT_OWNERS.has(owner.toLowerCase()) || !repo || repo.startsWith(".")) continue;
    names.push(`${owner}/${repo}`);
  }
  return byUse(names);
}

const GithubRepoBody = z.object({
  full_name: z.string(),
  html_url: z.string(),
  stargazers_count: z.number().int().nonnegative(),
  pushed_at: z.string().nullable(),
  archived: z.boolean(),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
  homepage: z.string().nullish(),
});

const GithubSearchBody = z.object({ items: z.array(z.object({ full_name: z.string(), homepage: z.string().nullish() }).passthrough()) });

export interface RegistryHome {
  readonly name: string;
  readonly homepage: string | null;
  /** How many candidates it gave: registries with more are looked up first. */
  readonly items: number;
}

export interface SignalReport {
  npm: { looked: number; reused: number; failed: number; leftUnknown: number };
  github: { looked: number; reused: number; failed: number; leftUnknown: number; searches: number; rateLimited: boolean };
}

/** Most-used first, then by name: the budget goes where it informs the most candidates. */
function byUse(names: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

async function pool<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  // The client caps concurrency; this only keeps the promise count bounded.
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

const encodePackage = (name: string): string => name.replace("/", "%2F");

export async function refreshSignals(entries: readonly LibraryEntry[], registries: readonly RegistryHome[], previous: SignalsFile, client: PoliteClient, now: Date, budgets: SignalBudgets): Promise<{ signals: SignalsFile; report: SignalReport }> {
  const npm: Record<string, NpmSignal> = { ...previous.npm };
  const github: Record<string, GithubSignal> = { ...previous.github };
  const registryRepos: Record<string, { repo: string | null; checkedAt: string }> = { ...previous.registryRepos };
  const report: SignalReport = { npm: { looked: 0, reused: 0, failed: 0, leftUnknown: 0 }, github: { looked: 0, reused: 0, failed: 0, leftUnknown: 0, searches: 0, rateLimited: false } };
  const at = now.toISOString();

  // npm-only candidates already carry downloads and licence from the search that found them.
  for (const entry of entries) {
    if (entry.source.kind !== "npm" || !entry.source.ref) continue;
    const prior = npm[entry.source.ref];
    if (fresh(prior?.fetchedAt, SIGNAL_TTL.npmMs, now)) continue;
    npm[entry.source.ref] = { weeklyDownloads: entry.signals?.weeklyDownloads ?? null, license: entry.license && entry.license !== "unknown" ? entry.license.spdx : null, repo: entry.signals?.repo ?? null, fetchedAt: entry.provenance?.fetchedAt ?? at };
  }

  const packages = byUse(entries.flatMap((e) => (e.source.kind === "npm" ? [] : [keyPackage(e)].filter((p): p is string => p !== null))));
  const stale = packages.filter((name) => {
    if (npm[name]?.failedAt) return true;
    if (fresh(npm[name]?.fetchedAt, SIGNAL_TTL.npmMs, now)) {
      report.npm.reused++;
      return false;
    }
    return true;
  });
  const npmTodo = stale.slice(0, budgets.npmPackages);
  report.npm.leftUnknown = stale.length - npmTodo.length;
  await pool(npmTodo, async (name) => {
    const [downloads, latest] = await Promise.all([client.json(`https://api.npmjs.org/downloads/point/last-week/${name}`), client.json(`https://registry.npmjs.org/${encodePackage(name)}/latest`)]);
    report.npm.looked++;
    const count = downloads.ok ? (downloads.value as { downloads?: unknown } | null)?.downloads : null;
    const validDownloads = typeof count === "number" && Number.isFinite(count) && count >= 0;
    const validLatest = latest.ok && latest.value !== null && typeof latest.value === "object" && (latest.value as { name?: unknown }).name === name;
    if (!downloads.ok || !latest.ok || !validDownloads || !validLatest) {
      // A malformed successful HTTP response is not a successful lookup either.
      if (downloads.ok && !validDownloads) client.cache.delete(`https://api.npmjs.org/downloads/point/last-week/${name}`);
      if (latest.ok && !validLatest) client.cache.delete(`https://registry.npmjs.org/${encodePackage(name)}/latest`);
      npm[name] = { weeklyDownloads: null, license: null, repo: null, fetchedAt: "", failedAt: at };
      report.npm.failed++;
      return;
    }
    const meta = latest.ok ? (latest.value as { license?: unknown; repository?: unknown }) : null;
    const repository = typeof meta?.repository === "string" ? meta.repository : (meta?.repository as { url?: unknown } | undefined)?.url;
    npm[name] = { weeklyDownloads: typeof count === "number" ? count : null, license: spdxOrNull(meta?.license), repo: githubRepo(typeof repository === "string" ? repository : null), fetchedAt: at };
  });

  // Registries' repositories: the official one is known; the rest are found from their homepage's
  // links, else searched for, most items first.
  registryRepos[SHADCN.name] = { repo: SHADCN.repo, checkedAt: at };
  const known = (name: string): boolean => {
    const prior = registryRepos[name];
    return fresh(prior?.checkedAt, prior?.repo ? SIGNAL_TTL.registryRepoMs : SIGNAL_TTL.registryRepoMissMs, now);
  };
  const unsearched = [...registries].filter((r) => r.name !== SHADCN.name && r.homepage && !known(r.name)).sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
  // Homepage lookups spend the repository budget; searches have their own.
  const spend = { repoCalls: budgets.githubRepos };
  for (const registry of unsearched) {
    const linked = await homepageRepo(registry.homepage!, client, github, at, report, spend);
    if (linked) {
      registryRepos[registry.name] = { repo: linked, checkedAt: at };
      continue;
    }
    if (report.github.searches >= budgets.githubSearches || !client.hasBudget("github-search")) continue;
    const query = `${sourceSlug(registry.name).replace(/-ui$/, "")} in:name`;
    const result = await client.json(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`);
    report.github.searches++;
    if (!result.ok) {
      if (result.reason === "rate-limited") report.github.rateLimited = true;
      continue;
    }
    const parsed = GithubSearchBody.safeParse(result.value);
    const match = parsed.success ? parsed.data.items.find((item) => sameHomepage(item.homepage, registry.homepage)) : undefined;
    registryRepos[registry.name] = { repo: match?.full_name ?? null, checkedAt: at };
  }

  const usedRegistries = new Set(entries.map(registryOf).filter((r): r is string => r !== null));
  const registryRepoNames = [...usedRegistries].map((r) => registryRepos[r]?.repo).filter((r): r is string => Boolean(r));
  const packageRepos = byUse(entries.flatMap((e) => {
    const pkg = keyPackage(e);
    const repo = e.source.kind === "npm" ? (e.signals?.repo ?? (pkg ? npm[pkg]?.repo : null)) : pkg ? npm[pkg]?.repo : null;
    return repo ? [repo] : [];
  }));
  const repos = [...new Set([...registryRepoNames, ...packageRepos])];
  const repoStale = repos.filter((repo) => {
    if (fresh(github[repo]?.fetchedAt, SIGNAL_TTL.githubMs, now)) {
      report.github.reused++;
      return false;
    }
    return true;
  });
  const repoTodo = repoStale.slice(0, spend.repoCalls);
  await pool(repoTodo, async (repo) => {
    if (!client.hasBudget("github-core")) return;
    const result = await client.json(`https://api.github.com/repos/${repo}`);
    report.github.looked++;
    if (!result.ok) {
      if (result.reason === "rate-limited") report.github.rateLimited = true;
      else if (result.status === 404) github[repo] = { found: false, repo, htmlUrl: null, stars: null, pushedAt: null, archived: null, spdx: null, fetchedAt: at };
      else report.github.failed++;
      return;
    }
    const parsed = GithubRepoBody.safeParse(result.value);
    if (!parsed.success) {
      report.github.failed++;
      return;
    }
    github[repo] = githubSignal(parsed.data, at);
  });
  report.github.leftUnknown = repos.filter((repo) => !github[repo]).length;
  return { signals: { npm, github, registryRepos }, report };
}

function githubSignal(body: z.infer<typeof GithubRepoBody>, at: string): GithubSignal {
  return { found: true, repo: body.full_name, htmlUrl: body.html_url, stars: body.stargazers_count, pushedAt: body.pushed_at, archived: body.archived, spdx: spdxOrNull(body.license?.spdx_id), fetchedAt: at };
}

/** Repositories tried per registry homepage, most-linked first. */
const HOMEPAGE_REPOS = 3;

/**
 * The repository a registry's homepage links to and that names that site as its own homepage,
 * or null. The page is read once for its links and never kept; each repository looked at is
 * cached as a GitHub signal, so the later lookup is not asked again.
 */
async function homepageRepo(homepage: string, client: PoliteClient, github: Record<string, GithubSignal>, at: string, report: SignalReport, spend: { repoCalls: number }): Promise<string | null> {
  const page = await client.get(homepage, "text/html");
  client.cache.delete(homepage);
  if (!page.ok) return null;
  for (const repo of linkedRepos(page.body).slice(0, HOMEPAGE_REPOS)) {
    if (spend.repoCalls <= 0 || !client.hasBudget("github-core")) return null;
    spend.repoCalls--;
    const result = await client.json(`https://api.github.com/repos/${repo}`);
    report.github.looked++;
    if (!result.ok) {
      if (result.reason === "rate-limited") report.github.rateLimited = true;
      continue;
    }
    const parsed = GithubRepoBody.safeParse(result.value);
    if (!parsed.success || !sameSite(parsed.data.homepage, homepage)) continue;
    github[parsed.data.full_name] = githubSignal(parsed.data, at);
    return parsed.data.full_name;
  }
  return null;
}

/** The candidate's repository: its registry's, or its package's. */
function repoOf(entry: LibraryEntry, signals: SignalsFile): string | null {
  const registry = registryOf(entry);
  if (registry) return signals.registryRepos[registry]?.repo ?? null;
  const pkg = keyPackage(entry);
  return entry.signals?.repo ?? (pkg ? (signals.npm[pkg]?.repo ?? null) : null);
}

/**
 * Fill each entry's signals and licence from the cache. A registry item's licence is its
 * registry repository's SPDX licence; an npm package's is its own. No evidence: "unknown".
 */
export function applySignals(entry: LibraryEntry, signals: SignalsFile): LibraryEntry {
  const pkg = keyPackage(entry);
  const npm = pkg ? signals.npm[pkg] : undefined;
  const repo = repoOf(entry, signals);
  const gh = repo ? signals.github[repo] : undefined;
  let license: LibraryLicense = entry.license ?? "unknown";
  if (entry.source.kind === "npm") {
    if (license === "unknown" && npm?.license) license = { spdx: npm.license, evidenceUrl: entry.source.url ?? `https://www.npmjs.com/package/${pkg}`, verifiedAt: npm.fetchedAt };
  } else if (gh?.found && gh.spdx && gh.htmlUrl) license = { spdx: gh.spdx, evidenceUrl: gh.htmlUrl, verifiedAt: gh.fetchedAt };
  return {
    ...entry,
    license,
    signals: {
      weeklyDownloads: entry.source.kind === "npm" ? npm?.weeklyDownloads ?? entry.signals?.weeklyDownloads ?? null : null,
      ...(entry.source.kind !== "npm" && pkg && npm?.weeklyDownloads != null ? { via: { package: pkg, weeklyDownloads: npm.weeklyDownloads } } : {}),
      stars: gh?.found ? gh.stars : null,
      pushedAt: gh?.found ? gh.pushedAt : null,
      archived: gh?.found ? gh.archived : null,
      package: pkg,
      repo: gh?.found ? gh.repo : repo,
    },
  };
}
