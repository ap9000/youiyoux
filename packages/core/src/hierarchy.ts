/**
 * The tool's two halves, and the one path an element takes between them.
 *
 *   System   approved elements: the contracts, tokens and rules products build with. Every
 *            contract in a system is adopted; it is in use once a scanned project uses it.
 *   Library  everything ingested from outside (other systems, kits, references), kept to
 *            browse, categorize and propose as a swap for a System element. Nothing in the
 *            Library is built with.
 *
 *   library → candidate → adopted → in-use
 *
 * `library` and `candidate` live in the Library; `adopted` and `in-use` in the System. Only a
 * person moves an element across that line (candidate → adopted), and `in-use` is never
 * declared: it is read off the usage map. Library ids (`lib:…`) and System ids (`youi:…`) never
 * overlap, so an id alone says which side an element is on.
 */
import { join } from "node:path";
import { z } from "zod";
import { DefinitionError, findFiles, readDefinition } from "./files.ts";
import { ElementId } from "./ids.ts";

export const ELEMENT_STAGES = ["library", "candidate", "adopted", "in-use"] as const;
export const ElementStage = z.enum(ELEMENT_STAGES);
export type ElementStage = z.infer<typeof ElementStage>;

const LIBRARY_STAGES = ["library", "candidate"] as const satisfies readonly ElementStage[];

/** A System element's stage, from how many scanned sites use it. */
export function systemStage(sites: number): "adopted" | "in-use" {
  return sites > 0 ? "in-use" : "adopted";
}

type StageActor = "agent" | "person" | "scan";

interface StageMove {
  readonly from: ElementStage;
  readonly to: ElementStage;
  /** Who may make this move. */
  readonly by: readonly StageActor[];
  readonly means: string;
}

/** Every legal move. Anything not listed (library → adopted, an agent adopting, …) is refused. */
const STAGE_MOVES: readonly StageMove[] = [
  { from: "library", to: "candidate", by: ["agent", "person"], means: "Request adoption: proposes the item as a System element or a swap for one." },
  { from: "candidate", to: "library", by: ["person"], means: "Decline the request: the item stays in the Library." },
  { from: "candidate", to: "adopted", by: ["person"], means: "Approve: the item joins the System with a contract, tokens and rules." },
  { from: "adopted", to: "in-use", by: ["scan"], means: "A scanned project uses it." },
  { from: "in-use", to: "adopted", by: ["scan"], means: "No scanned project uses it any more." },
];

export function canMove(from: ElementStage, to: ElementStage, actor: StageActor): boolean {
  return STAGE_MOVES.some((move) => move.from === from && move.to === to && move.by.includes(actor));
}

/* ------------------------------------------------------------------ MCP tools */

/** Every tool the youiyoux MCP server exposes, named for the side it reads; the server registers exactly these. */
export const MCP_TOOLS = ["system_search", "system_get_component", "system_get_tokens", "system_get_rules", "system_where_used", "system_screen_bom", "system_check", "system_plan", "library_search", "library_request"] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

/* -------------------------------------------------------------- youi.library/v1 */

export const LIBRARY_KINDS = ["component", "token", "pattern"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

const LIBRARY_ID_PATTERN = /^lib:([a-z][a-z0-9-]*)\/(component|token|pattern)\/([a-z0-9][a-z0-9.\-]*)$/;

/** `lib:<source>/<kind>/<name>`: a Library item, never a System element. */
export const LibraryId = z.string().regex(LIBRARY_ID_PATTERN, "expected lib:<source>/<kind>/<name>");
export type LibraryId = z.infer<typeof LibraryId>;

export function isLibraryId(id: string): boolean {
  return id.trim().startsWith("lib:");
}

export const LibraryEntry = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.library/v1"),
  id: LibraryId,
  name: z.string().min(1),
  kind: z.enum(LIBRARY_KINDS),
  /** Only Library stages: an adopted item becomes a System contract and leaves the Library. */
  stage: z.enum(LIBRARY_STAGES).default("library"),
  summary: z.string().min(1).max(200),
  source: z.object({ name: z.string().min(1), url: z.string().url().optional(), ingestedAt: z.string().datetime({ offset: true }) }),
  categories: z.array(z.string().min(1)).default([]),
  /** System elements this item could be swapped in for. */
  swapsWith: z.array(ElementId).default([]),
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;

/** Library items live beside the systems, at `library/<source>/<name>.library.json`. */
export const LIBRARY_DIR = "library";

export interface Library {
  readonly entries: readonly LibraryEntry[];
}

/** Load and validate the Library. No directory means an empty Library, not an error. */
export async function loadLibrary(root: string): Promise<Library> {
  const files = await findFiles(root, [`${LIBRARY_DIR}/**/*.library.json`]);
  const entries = await Promise.all(files.map((file) => readDefinition(join(root, file), LibraryEntry, root)));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`duplicate library id ${entry.id}`);
    seen.add(entry.id);
  }
  if (problems.length > 0) throw new DefinitionError(LIBRARY_DIR, problems);
  return { entries };
}
