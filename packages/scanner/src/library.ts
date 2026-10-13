/**
 * Library queries, shared by the CLI and the MCP server. The Library is for browsing and
 * proposing only: a hit is never something to import, and a request is a draft for a
 * person to approve, not a change.
 */
import { canMove, isFamilyId, isLibraryId, systemStage, type ElementStage, type Library, type LibraryEntry, type ScanReport } from "@youiyoux/core";
import type { Project } from "./project.ts";
import type { ScanResult } from "./scan.ts";

export const LIBRARY_RULE = "Library items are references, not building blocks: never import, copy or restyle code from one. Build with System elements; to use a Library item, request its adoption and let a person decide.";

export interface LibraryHit {
  readonly id: string;
  readonly name: string;
  readonly kind: LibraryEntry["kind"];
  readonly stage: LibraryEntry["stage"];
  readonly summary: string;
  readonly source: string;
  readonly categories: readonly string[];
  readonly swapsWith: readonly string[];
}

export interface LibrarySearch {
  readonly hits: readonly LibraryHit[];
  readonly total: number;
  readonly note: string;
}

function hitOf(entry: LibraryEntry): LibraryHit {
  return { id: entry.id, name: entry.name, kind: entry.kind, stage: entry.stage, summary: entry.summary, source: entry.source.name, categories: entry.categories, swapsWith: entry.swapsWith };
}

export function searchLibrary(library: Library, query: string, limit = 20): LibrarySearch {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (e: LibraryEntry): number => words.reduce((n, w) => n + ([e.id, e.name, e.summary, e.source.name, ...e.categories].join(" ").toLowerCase().includes(w) ? 1 : 0), 0);
  const hits = library.entries
    .map((entry) => ({ entry, score: score(entry) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => hitOf(h.entry));
  const note = library.entries.length === 0 ? `The Library is empty: no sources are connected yet. Build with System elements (system_search). ${LIBRARY_RULE}` : LIBRARY_RULE;
  return { hits, total: library.entries.length, note };
}

export function findLibraryEntry(library: Library, query: string): LibraryEntry | null {
  const q = query.trim().toLowerCase();
  return library.entries.find((e) => e.id === query.trim() || e.name.toLowerCase() === q) ?? null;
}

export interface AdoptionRequest {
  readonly request: "adopt";
  readonly status: "draft";
  readonly item: LibraryHit;
  readonly move: { readonly from: ElementStage; readonly to: ElementStage };
  readonly reason: string;
  /** The System elements it would be swapped in for, with their live usage. */
  readonly swapsWith: readonly SwapTarget[];
  readonly next: string;
}

/**
 * `stage` is null when the element is not in this System, and "unknown" when the scan cannot say whether it is used.
 * `family` marks an inventory family (`button-2`): a look the project builds, not a System element, so it has no stage.
 */
export interface SwapTarget {
  readonly element: string;
  readonly name: string | null;
  readonly stage: ElementStage | "unknown" | null;
  readonly sites: number;
  readonly family?: true;
}

/** Usage is only read off a complete scan, and only components are counted in the usage map. */
function usageStage(report: ScanReport, element: string): Pick<SwapTarget, "stage" | "sites"> {
  const sites = report.usages.filter((u) => u.element === element).length;
  return { stage: report.status === "complete" ? systemStage(sites) : "unknown", sites };
}

function swapTarget(project: Project, scan: Pick<ScanResult, "report" | "tokens">, element: string): SwapTarget {
  if (isFamilyId(element)) return { element, name: null, stage: null, sites: 0, family: true };
  const contract = project.system.components.find((c) => c.contract.id === element)?.contract;
  if (contract) return { element, name: contract.name, ...usageStage(scan.report, element) };
  const tokenPrefix = `youi:${project.system.config.id}/token/`;
  const token = element.startsWith(tokenPrefix) ? scan.tokens.tokens.find((t) => t.id === element.slice(tokenPrefix.length)) : undefined;
  const name = token?.id ?? project.system.rules.find((r) => r.id === element)?.title ?? null;
  return { element, name, stage: name === null ? null : "unknown", sites: 0 };
}

/**
 * Draft a request to adopt a Library item into the System. Nothing is written or filed:
 * the agent puts the draft in its summary or pull request, and a person decides.
 */
export function adoptionRequest(project: Project, library: Library, query: string, reason: string, scan: Pick<ScanResult, "report" | "tokens">): AdoptionRequest {
  const entry = findLibraryEntry(library, query);
  if (!entry) {
    const known = library.entries.length === 0 ? "the Library is empty: no sources are connected yet" : `known: ${library.entries.slice(0, 10).map((e) => e.id).join(", ")}`;
    throw new Error(`no Library item "${query}"; ${known}`);
  }
  if (!canMove(entry.stage, "candidate", "agent")) throw new Error(`${entry.id} is at stage ${entry.stage}, where an agent cannot request adoption: a candidate's request is already waiting for a person`);
  const swapsWith = entry.swapsWith.map((element) => swapTarget(project, scan, element));
  return {
    request: "adopt",
    status: "draft",
    item: hitOf(entry),
    move: { from: entry.stage, to: "candidate" },
    reason,
    swapsWith,
    next: `Put this draft in your summary or pull request for a person to approve. Until it is adopted, do not import, copy or build with ${entry.id}; keep building with System elements${swapsWith.length ? ` (${swapsWith.map((s) => s.name ?? s.element).join(", ")})` : ""}.`,
  };
}

/** Refuse a Library id where a System element is expected, saying what to do instead. */
export function assertSystemQuery(query: string): void {
  if (isLibraryId(query)) throw new Error(`${query.trim()} is a Library item, not a System element, so it cannot be built with. Use a System element (system_search), or request adoption with library_request.`);
}
