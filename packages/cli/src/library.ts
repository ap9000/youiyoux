/** Terminal output for `youiyoux library`: browse ingested items and draft adoption requests. */
import { LIBRARY_RULE, type AdoptionRequest, type LibrarySearch } from "@youiyoux/scanner";
import { padEnd, plural, style } from "./ui.ts";

export function renderLibrarySearch(result: LibrarySearch, query: string): string {
  if (result.total === 0) return [`${style.bold("Library")} ${style.dim("· empty: no sources are connected yet")}`, "", style.dim(`Build with System elements (youiyoux show <component>). ${LIBRARY_RULE}`)].join("\n");
  const header = `${style.bold("Library")} ${style.dim(`· ${plural(result.hits.length, "match", "matches")} for "${query}" in ${plural(result.total, "item")}`)}`;
  const width = Math.max(0, ...result.hits.map((h) => h.id.length));
  const rows = result.hits.map((h) => {
    const swaps = h.swapsWith.length ? style.dim(` · swaps with ${h.swapsWith.map((id) => id.split("/").at(-1)).join(", ")}`) : "";
    return `  ${padEnd(h.id, width)}  ${h.stage === "candidate" ? style.warn("candidate") : style.dim("library  ")}  ${h.summary}${swaps}`;
  });
  return [header, "", ...rows, "", style.dim(LIBRARY_RULE)].join("\n");
}

export function renderAdoptionRequest(request: AdoptionRequest): string {
  const swaps = request.swapsWith.map((s) => `  ${s.name ?? s.element}  ${s.stage === "in-use" ? style.live(`in use · ${plural(s.sites, "site")}`) : style.dim(s.family ? "inventory family" : s.stage === null ? "not in this System" : s.stage === "unknown" ? "usage unknown" : s.stage)}`);
  return [
    `${style.bold("Adoption request")} ${style.dim("· draft, nothing filed")}`,
    "",
    `  ${request.item.id} ${style.dim(`(${request.item.source})`)}`,
    `  ${request.move.from} → ${request.move.to}`,
    `  reason: ${request.reason}`,
    ...(swaps.length ? ["", style.bold("Would swap in for"), ...swaps] : []),
    "",
    request.next,
  ].join("\n");
}
