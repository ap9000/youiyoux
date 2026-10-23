/**
 * Ingest drafts as data: what a link held (`youiyoux library ingest`), read by the service
 * itself and fixed once the draft exists, and the items a reviewer keeps. A save may only change
 * which items are kept: no client can edit an item, its source or its licence. Approving writes
 * one Library file per kept item (`library/<source>/<name>.library.json`), at stage library: a
 * reference, never a System element. Pure; no I/O.
 */
import { LibraryEntry, sha256, stableStringify } from "@youiyoux/core";
import type { IngestDraftContent } from "./api.ts";
import { libraryPath, renderLibraryEntry } from "./library-drafts.ts";

/** The content as it will be kept: the kept ids in the reading's order, each once. */
export function normalizeIngestContent(content: IngestDraftContent): IngestDraftContent {
  const keep = new Set(content.keep);
  return { reading: content.reading, keep: content.reading.entries.map((e) => e.id).filter((id) => keep.has(id)) };
}

export function ingestDigest(content: IngestDraftContent): string {
  return sha256(stableStringify(normalizeIngestContent(content)));
}

export const keptEntries = (content: IngestDraftContent): LibraryEntry[] => {
  const keep = new Set(content.keep);
  return content.reading.entries.filter((e) => keep.has(e.id));
};

export function validateIngestContent(content: IngestDraftContent): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const sources = new Set(content.reading.entries.map((e) => e.source.name));
  if (sources.size > 1) problems.push(`items come from ${sources.size} sources; one link is one source`);
  for (const entry of content.reading.entries) {
    const parsed = LibraryEntry.safeParse(entry);
    if (!parsed.success) problems.push(`${entry.id ?? "an item"}: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (ids.has(entry.id)) problems.push(`${entry.id} is listed twice`);
    ids.add(entry.id);
    if (entry.stage !== "library") problems.push(`${entry.id}: an ingested item is a reference (stage library), not ${entry.stage}`);
    try {
      libraryPath(entry.id);
    } catch (error: unknown) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const unknown = content.keep.filter((id) => !ids.has(id));
  if (unknown.length > 0) problems.push(`keep: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in this reading`);
  if (keptEntries(content).length === 0) problems.push("keep at least one item, or discard the draft");
  return problems;
}

/** One line for the queue and history: `ingest 12 of 14 items from acme/ui into the Library`. */
export function describeIngest(content: IngestDraftContent): string {
  const kept = keptEntries(content).length;
  const all = content.reading.entries.length;
  return `ingest ${kept === all ? `${all}` : `${kept} of ${all}`} item${all === 1 ? "" : "s"} from ${content.reading.source.name} into the Library`;
}

/** The Library files approving writes: one per kept item, by path. */
export function ingestFiles(content: IngestDraftContent, existing: (path: string) => string | null): Record<string, string> {
  return Object.fromEntries(keptEntries(content).map((entry) => {
    const path = libraryPath(entry.id);
    return [path, renderLibraryEntry({ entry, request: "save", reason: "", swapsWith: [] }, existing(path))];
  }));
}

export function ingestSlug(content: IngestDraftContent): string {
  return (content.reading.source.name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/\.+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "link");
}
