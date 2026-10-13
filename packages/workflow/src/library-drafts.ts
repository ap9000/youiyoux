/**
 * Library drafts as data: a Discover candidate saved to the Library (stage `library`) or put up
 * for adoption (stage `candidate`), validated as youi.library/v1, and the file a review branch
 * writes for it (`library/<source>/<name>.library.json`). An adoption request for an item whose
 * licence is unknown is refused, in plain words: nothing backs its licence, so it cannot be
 * adopted, only kept as a reference. Pure; no I/O.
 */
import { isFamilyId, LIBRARY_DIR, LibraryEntry, parseId, sha256, stableStringify } from "@youiyoux/core";
import type { LibraryDraftContent } from "./api.ts";

const SCHEMA_REF = "../../schema/youi.library.schema.json";

/** The request as it will be written: trimmed, swaps listed once, the entry at its request's stage. */
export function normalizeLibraryContent(content: LibraryDraftContent): LibraryDraftContent {
  const swapsWith = [...new Set(content.swapsWith.map((s) => s.trim()).filter(Boolean))];
  const stage = content.request === "adopt" ? "candidate" : "library";
  return { entry: { ...content.entry, stage, swapsWith }, request: content.request, reason: content.reason.trim(), swapsWith };
}

export function libraryDigest(content: LibraryDraftContent): string {
  return sha256(stableStringify(normalizeLibraryContent(content)));
}

/** `lib:coss/component/command` → `library/coss/command.library.json`. */
export function libraryPath(id: string): string {
  const match = /^lib:([a-z][a-z0-9-]*)\/(?:component|token|pattern)\/([a-z0-9][a-z0-9.-]*)$/.exec(id);
  if (!match || match[2]!.includes("..")) throw new Error(`not a Library id: ${id}`);
  return `${LIBRARY_DIR}/${match[1]}/${match[2]}.library.json`;
}

export function librarySlug(content: LibraryDraftContent): string {
  return (content.entry.id.replace(/^lib:/, "").replace(/\/(?:component|token|pattern)\//, "-").replace(/[^a-z0-9.-]+/g, "-").replace(/\.+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "item");
}

const licenceOf = (content: LibraryDraftContent): string => (content.entry.license && content.entry.license !== "unknown" ? content.entry.license.spdx : "unknown");

/** Why an adoption request cannot be filed for this item, or null when it can. */
export function adoptionRefusal(content: Pick<LibraryDraftContent, "entry" | "request">): string | null {
  if (content.request !== "adopt") return null;
  if (!content.entry.license || content.entry.license === "unknown") return `${content.entry.name}'s licence is unknown: nothing backs one, so it cannot be adopted. Save it to the Library as a reference, or find its licence first.`;
  return null;
}

export interface LibraryContext {
  readonly componentIds: ReadonlySet<string>;
}

export function validateLibraryContent(content: LibraryDraftContent, context: LibraryContext): string[] {
  const normal = normalizeLibraryContent(content);
  const problems: string[] = [];
  const parsed = LibraryEntry.safeParse(normal.entry);
  // Swaps are checked below, in plainer words.
  if (!parsed.success) problems.push(...parsed.error.issues.filter((i) => i.path[0] !== "swapsWith").map((i) => `entry.${i.path.map(String).join(".") || "item"}: ${i.message}`));
  const refusal = adoptionRefusal(normal);
  if (refusal) problems.push(`request: ${refusal}`);
  if (normal.request === "adopt" && normal.reason.length === 0) problems.push("reason: say why the System needs it");
  for (const target of normal.swapsWith) {
    if (isFamilyId(target)) continue;
    const id = parseId(target);
    if (!id) problems.push(`swapsWith: ${target} is neither an inventory family (button-1) nor a System element`);
    else if (!context.componentIds.has(target)) problems.push(`swapsWith: no System element ${target}`);
  }
  return problems;
}

/** The file a review branch writes: the entry, keys in schema order, with a `$schema` reference. */
export function renderLibraryEntry(content: LibraryDraftContent, existing: string | null): string {
  const normal = normalizeLibraryContent(content);
  const entry = LibraryEntry.parse(normal.entry);
  const { $schema: _drop, ...rest } = entry;
  let schemaRef = SCHEMA_REF;
  if (existing) {
    try {
      schemaRef = ((JSON.parse(existing) as { $schema?: unknown }).$schema as string | undefined) ?? SCHEMA_REF;
    } catch {
      schemaRef = SCHEMA_REF;
    }
  }
  return `${JSON.stringify({ $schema: schemaRef, ...rest }, null, 2)}\n`;
}

/** One line for the queue and history: `save @coss/command to the Library` / `request adoption of @shadcn/command`. */
export function describeLibrary(content: LibraryDraftContent): string {
  const name = content.entry.source.ref ?? content.entry.name;
  const swaps = content.swapsWith.length ? ` for ${content.swapsWith.join(", ")}` : "";
  return content.request === "adopt" ? `request adoption of ${name}${swaps} (licence ${licenceOf(content)})` : `save ${name} to the Library${swaps}`;
}
