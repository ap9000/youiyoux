/**
 * A detected element as a draft Library item (youi.library/v1): seen on a site, likely from a
 * library. Only types are imported, so the hub can draft items in the browser without zod;
 * callers that write the draft anywhere validate it with LibraryEntry first.
 */
import type { DetectElement, DetectLibrary, DetectReport } from "./detect.ts";
import type { LibraryEntry } from "./hierarchy.ts";

/** `www.Example.com` → `example-com`; a slug that would start with a digit gets `site-`. */
export function sourceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "site";
  return /^[a-z]/.test(slug) ? slug : `site-${slug}`;
}

function nameSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * `lib:<site-slug>/component/<library>-<element>`, summarised as "Seen on <site>, likely <library>".
 * `ingestedAt` is when the item was drafted; it defaults to now.
 */
export function draftLibraryItem(report: Pick<DetectReport, "target" | "pages" | "libraries">, element: Pick<DetectElement, "type" | "library" | "page" | "confidence">, ingestedAt = new Date().toISOString()): LibraryEntry {
  const site = report.target.name;
  const library: Pick<DetectLibrary, "id" | "name"> = report.libraries.find((l) => l.id === element.library) ?? { id: element.library, name: element.library };
  const url = element.page ?? report.pages.find((p) => p.status === "ok")?.url ?? (report.target.kind === "site" ? report.target.inputs[0] : undefined);
  const summary = `Seen on ${site}, likely ${library.name}`;
  return {
    schema: "youi.library/v1",
    id: `lib:${sourceSlug(site)}/component/${nameSlug(`${library.id}-${element.type}`)}`,
    name: `${library.name} ${capital(element.type)}`,
    kind: "component",
    stage: "library",
    summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
    source: { name: site, ...(url && /^https?:\/\//.test(url) ? { url } : {}), ingestedAt },
    categories: [element.type, `detected:${element.confidence}`],
    swapsWith: [],
  };
}
