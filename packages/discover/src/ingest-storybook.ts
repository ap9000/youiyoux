/**
 * A published Storybook as Library items: its index (index.json from Storybook 7, else
 * stories.json from 6), one item per component title (`Components/Forms/Button`) with its stories
 * named, linked to its docs page or first story. The title's folders become categories; a title
 * under Pages, Templates, Layouts or Patterns is a pattern. A Storybook says nothing of a
 * licence: unknown.
 */
import type { PoliteClient } from "./http.ts";
import { IngestError, itemsOf, type IngestLink, type IngestSource, type ItemInput, type ReaderResult } from "./ingest.ts";

type StorybookTarget = Extract<IngestLink, { kind: "storybook" }>;
type IndexEntry = { id?: unknown; title?: unknown; name?: unknown; type?: unknown; kind?: unknown };

const PATTERN = /^(pages?|templates?|layouts?|patterns?|screens?|examples?)$/i;
const STORIES_LISTED = 6;

export async function readStorybook(target: StorybookTarget, client: PoliteClient, fetchedAt: string): Promise<ReaderResult> {
  let index: { body: string; url: string; sha256: string } | null = null;
  let entries: Record<string, IndexEntry> = {};
  for (const file of ["index.json", "stories.json"]) {
    const url = `${target.base}/${file}`;
    const got = await client.json(url, false);
    if (!got.ok) continue;
    const value = got.value as { entries?: unknown; stories?: unknown };
    const found = (value.entries ?? value.stories) as unknown;
    if (found && typeof found === "object" && !Array.isArray(found)) {
      entries = found as Record<string, IndexEntry>;
      index = { body: got.result.body, url, sha256: got.result.sha256 };
      break;
    }
  }
  if (!index) throw new IngestError(`${target.base} is not a GitHub repository, a Figma file or a DESIGN.md, and serves no Storybook index (index.json or stories.json): nothing to read`);

  // Component titles, with their stories in the index's order; a docs page is where to look first.
  const byTitle = new Map<string, { stories: string[]; first: string | null; docs: string | null }>();
  for (const [key, raw] of Object.entries(entries)) {
    const title = typeof raw.title === "string" ? raw.title : typeof raw.kind === "string" ? raw.kind : null;
    const id = typeof raw.id === "string" ? raw.id : key;
    if (!title) continue;
    const item = byTitle.get(title) ?? { stories: [], first: null, docs: null };
    if (raw.type === "docs") item.docs ??= id;
    else {
      item.first ??= id;
      if (typeof raw.name === "string") item.stories.push(raw.name);
    }
    byTitle.set(title, item);
  }
  const host = new URL(target.base).host;
  const source: IngestSource = { kind: "storybook", name: host, url: target.base };
  const inputs: ItemInput[] = [...byTitle].map(([title, item]) => {
    const parts = title.split("/").map((p) => p.trim()).filter(Boolean);
    const name = parts.at(-1) ?? title;
    const folders = parts.slice(0, -1);
    const page = item.docs ? `?path=/docs/${item.docs}` : item.first ? `?path=/story/${item.first}` : "";
    const stories = item.stories.length === 0 ? "docs only" : `${item.stories.length} ${item.stories.length === 1 ? "story" : "stories"}: ${item.stories.slice(0, STORIES_LISTED).join(", ")}${item.stories.length > STORIES_LISTED ? ", …" : ""}`;
    return {
      kind: folders.some((f) => PATTERN.test(f)) ? "pattern" : "component",
      name,
      title,
      summary: `${title} in ${host}'s Storybook, ${stories}`,
      ref: title,
      url: `${target.base}/${page}`,
      digest: index.sha256,
      categories: folders,
    };
  });
  return {
    source,
    license: "unknown",
    entries: itemsOf(source, "unknown", fetchedAt, inputs),
    skipped: [],
    notes: [`a Storybook: ${index.url}, ${byTitle.size} component title${byTitle.size === 1 ? "" : "s"}`, "licence unknown: a Storybook does not say one, so its items cannot be adopted until the code's licence is found"],
  };
}
