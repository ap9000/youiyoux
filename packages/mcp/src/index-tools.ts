/**
 * The index_* tools' answers: a few plain lines each (about ten), read from the store's graph.
 * Lists show their first few items and say how many more there are.
 */
import type { RuleCovers, SwapImpact, WhereUsed } from "@youiyoux/store";

const SHOWN = 6;

function list(label: string, items: readonly string[]): string {
  if (items.length === 0) return `${label}: none`;
  const more = items.length - SHOWN;
  return `${label}: ${items.slice(0, SHOWN).join(", ")}${more > 0 ? `, … (+${more} more)` : ""}`;
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

export function whereUsedText(where: WhereUsed, scannedAt: string | null): string {
  return [
    `${where.family}${where.role ? ` (${where.role})` : ""}: ${plural(where.looks, "look")} in ${plural(where.files.length, "file")} on ${plural(where.routes.length, "route")}`,
    list("files", where.files),
    list("routes", where.routes),
    list("near-duplicates", where.nearDuplicates),
    `from the inventory ${where.source}${scannedAt ? `, scanned ${scannedAt}` : ""}`,
  ].join("\n");
}

export function swapImpactText(swap: SwapImpact, note: string): string {
  const [first, ...twins] = swap.families;
  return [
    `Swapping ${swap.candidate} in for ${swap.family}: ${swap.listed ? "listed as a could-replace candidate (it plays the family's role)" : "not a listed candidate for this family (no could-replace link)"}`,
    `families: ${first ? `${first.id} (${plural(first.looks, "look")})` : swap.family}${twins.length ? `, near-duplicates ${twins.map((t) => `${t.id} (${plural(t.looks, "look")})`).join(", ")}` : ""}`,
    `${plural(swap.looks, "look")} to change in ${plural(swap.files.length, "file")} on ${plural(swap.routes.length, "route")}`,
    list("files", swap.files),
    list("routes", swap.routes),
    list("other candidates", swap.otherCandidates),
    note,
  ].join("\n");
}

export function ruleCoversText(covers: RuleCovers, detail: { title?: string; severity?: string; files?: readonly string[] } = {}): string {
  return [
    `${covers.rule}${detail.title ? ` (${detail.title}${detail.severity ? `, ${detail.severity}` : ""})` : ""} governs ${covers.components.length ? covers.components.join(", ") : "no component directly"}`,
    ...(detail.files?.length ? [`checks files matching ${detail.files.join(", ")}`] : []),
    `used in ${plural(covers.files.length, "file")} on ${plural(covers.routes.length, "route")}`,
    list("files", covers.files),
    list("routes", covers.routes),
  ].join("\n");
}
