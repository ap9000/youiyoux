import { cleanData as safe } from "@youiyoux/discover";
/** Terminal output for `youi discover`: the sync summary, ranked candidates, and one candidate in full. */
import type { DiscoverSearch, DiscoverShow, SyncSummary } from "@youiyoux/discover";
import { ms, padEnd, plural, style, truncate } from "./ui.ts";

function compact(n: number | null): string {
  if (n === null) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function renderDiscoverSync(summary: SyncSummary): string {
  summary = safe(summary);
  const { entries, registries, requests, signals, licences } = summary;
  const lines = [
    `${style.ok("synced")} ${plural(entries.total, "candidate")} ${style.dim(`· ${entries.official} official · ${entries.community} community · ${entries.npm} npm`)}`,
    `  registries  ${registries.listed} listed · ${registries.fetched} fetched · ${registries.revalidated} unchanged (304) · ${registries.skipped} skipped · ${registries.failed > 0 ? style.warn(`${registries.failed} failed`) : "0 failed"}`,
    `  catalog     ${summary.catalogBytes.toLocaleString("en-US")} bytes · ${summary.selectedSources} selected sources`,
    `  index       ${summary.index.entries} entries · ${summary.index.bytes.toLocaleString("en-US")} bytes · ${summary.index.mirrorsCollapsed} mirrors collapsed`,
    ...summary.warnings.map((warning) => style.warn(`  ! ${warning}`)),
    `  categories  ${summary.categories} names from the headless catalogs`,
    `  signals     npm ${signals.npm.looked} looked up, ${signals.npm.reused} cached${signals.npm.leftUnknown ? `, ${signals.npm.leftUnknown} left unknown` : ""} · GitHub ${signals.github.looked} looked up, ${signals.github.reused} cached${signals.github.leftUnknown ? `, ${signals.github.leftUnknown} left unknown` : ""}${signals.github.rateLimited ? style.warn(" (rate limit reached)") : ""}`,
    `  licences    ${licences.known} with evidence · ${licences.unknown} unknown`,
    style.dim(`  ${plural(requests.sent, "request")} (${requests.revalidated} answered 304, ${requests.cached} cache hits, at most ${requests.maxInFlight} at once) in ${ms(summary.durationMs)}`),
    ...summary.failures.slice(0, 12).map((f) => style.warn(`  ! ${f.id}: ${f.reason}`)),
    ...(summary.failures.length > 12 ? [style.dim(`  …${summary.failures.length - 12} more in health.json`)] : []),
    style.dim(`index → ${summary.cacheDir}`),
  ];
  return lines.join("\n");
}

/** `role command 12 · dialog 3 | source @shadcn 2 · npm 3 | …`: the first few of each facet. */
function facetLine(facets: NonNullable<DiscoverSearch["facets"]>): string {
  const top = (counts: Readonly<Record<string, number>>): string => Object.entries(counts).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(" · ") || "none";
  return `role ${top(facets.role)}  |  source ${top(facets.source)}  |  licence ${top(facets.licence)}  |  ${top(facets.style)}`;
}

export function renderDiscoverSearch(result: DiscoverSearch): string {
  result = safe(result);
  const header = `${style.bold("Discover")} ${style.dim(`· ${plural(result.matched, "match", "matches")} for "${result.need}"${result.concepts.length ? ` (${result.concepts.join(", ")})` : ""} in ${plural(result.total, "candidate")} · index ${result.indexBuiltAt.slice(0, 10)}`)}`;
  const facets = result.facets ? [style.dim(`  ${facetLine(result.facets)}`)] : [];
  if (result.hits.length === 0) return [header, ...facets, "", style.dim("  nothing matched: try another word for it, or run youi discover sync to refresh the index"), "", style.dim(result.note)].join("\n");
  const width = Math.min(40, Math.max(...result.hits.map((h) => (h.source.ref ?? h.name).length)));
  const rows = result.hits.flatMap((h) => {
    const s = h.signals;
    const facts = [h.license === "unknown" ? style.warn("licence unknown") : h.license, s.via ? `${compact(s.via.weeklyDownloads)}/wk via ${s.via.package}` : `${compact(s.weeklyDownloads)}/wk`, `${compact(s.stars)}★`, ...(s.archived ? [style.error("archived")] : [])].join(" · ");
    return [`  ${padEnd(truncate(h.source.ref ?? h.name, 40), width)}  ${truncate(h.summary, 72)}`, `  ${" ".repeat(width)}  ${style.dim(facts)}  ${h.install ? h.install.command : ""}`];
  });
  const from = result.offset ?? 0;
  const more = result.matched > from + result.hits.length ? style.dim(`  ${from + 1}–${from + result.hits.length} of ${result.matched}: --offset ${from + result.hits.length} for more`) : null;
  return [header, ...facets, "", ...rows, ...(more ? ["", more] : []), "", style.dim(`youi discover show <ref> for provenance and dependencies. ${result.note}`)].join("\n");
}

export function renderDiscoverShow(result: DiscoverShow): string {
  result = safe(result);
  const e = result.entry;
  const license = !e.license || e.license === "unknown" ? style.warn("unknown") : `${e.license.spdx} ${style.dim(`(${e.license.evidenceUrl}, ${e.license.verifiedAt.slice(0, 10)})`)}`;
  const s = e.signals;
  const health = e.provenance?.registryHealth;
  return [
    `${style.bold(e.title ?? e.name)} ${style.dim(`· ${e.id}`)}`,
    `  ${e.summary}`,
    "",
    `  source     ${e.source.kind ?? "?"} ${e.source.ref ?? e.source.name}${e.source.url ? style.dim(` ${e.source.url}`) : ""}`,
    `  licence    ${license}`,
    `  signals    ${s?.via ? `${compact(s.via.weeklyDownloads)}/wk via ${s.via.package}` : `${compact(s?.weeklyDownloads ?? null)}/wk`} · ${compact(s?.stars ?? null)}★${s?.repo ? style.dim(` (${s.repo})`) : ""}${s?.pushedAt ? ` · pushed ${s.pushedAt.slice(0, 10)}` : ""}${s?.archived ? ` · ${style.error("archived")}` : ""}`,
    ...(e.install
      ? [
          `  install    ${e.install.command}`,
          `  npm        ${e.install.npm.join(", ") || style.dim("none")}`,
          `  registry   ${e.install.registryDeps.join(", ") || style.dim("none")}`,
          `  implicit   ${e.install.implicitDeps.length ? style.warn(e.install.implicitDeps.join(", ")) : style.dim(e.provenance?.files.some((f) => f.sha256 !== null) ? "none" : "not checked (no file content served)")}`,
        ]
      : []),
    ...(e.categories.length ? [`  categories ${e.categories.join(", ")}`] : []),
    ...(e.provenance
      ? [`  fetched    ${e.provenance.fetchedAt} ${style.dim(`from ${e.provenance.url}, sha256 ${e.provenance.sha256.slice(0, 12)}`)}`, ...(health ? [`  health     ${health.status}${health.score !== null ? ` (${health.score})` : ""} in the registry directory`] : [])]
      : []),
    "",
    style.dim(result.note),
  ].join("\n");
}
