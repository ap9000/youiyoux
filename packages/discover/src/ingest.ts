/**
 * Library ingestion from a link (`youiyoux library ingest <link>`): a GitHub repository, a
 * published Storybook, a Figma file or a DESIGN.md, read into Library items (youi.library/v1),
 * each sorted into the role its name says, in Discover's concepts (readNeed). Nothing here writes to the Library: the
 * items go to the changes queue as one draft for a person to review (keep, drop, approve).
 *
 * Every request goes through the polite client (public https only, timeouts, rate budgets). A
 * licence is read from evidence (a GitHub repository's licence file) or stays unknown; items a
 * reader could not read, and the cap on how many are read, are said, never dropped silently.
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { LibraryEntry, sha256, type LibraryLicense, type LibrarySourceKind } from "@youiyoux/core";
import { readNeed } from "./aliases.ts";
import type { PoliteClient } from "./http.ts";
import { readDesignMd } from "./ingest-design-md.ts";
import { readFigma } from "./ingest-figma.ts";
import { readGithub } from "./ingest-github.ts";
import { readStorybook } from "./ingest-storybook.ts";
import { nameSlug, sourceSlug, summaryOf } from "./sources.ts";
import { cleanData, cleanText } from "./text.ts";

/** At most this many items from one link; the rest are counted in a note. */
export const INGEST_CAP = 300;

export type IngestLink =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly ref: string | null; readonly path: string | null }
  | { readonly kind: "figma"; readonly key: string }
  | { readonly kind: "design-md"; readonly location: string; readonly local: boolean }
  | { readonly kind: "storybook"; readonly base: string };

export interface IngestSource {
  readonly kind: LibrarySourceKind;
  /** How a person names it: `acme/ui`, `storybook.acme.dev`, `Acme UI (Figma)`. */
  readonly name: string;
  /** Where to see it; null for a local file. */
  readonly url: string | null;
}

export interface IngestResult {
  readonly link: string;
  readonly source: IngestSource;
  readonly license: LibraryLicense;
  readonly fetchedAt: string;
  readonly entries: readonly LibraryEntry[];
  /** What was seen but not read, and why. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** What a reviewer should know: the cap, where the licence came from, what a source cannot say. */
  readonly notes: readonly string[];
}

export interface IngestOptions {
  readonly client: PoliteClient;
  readonly now?: () => Date;
  /** Read local DESIGN.md files (the CLI); a service reading links from a browser never does. */
  readonly allowLocal?: boolean;
  /** FIGMA_TOKEN was given to the client: Figma files can be read. */
  readonly figma?: boolean;
}

/** An ingestion that cannot start or finish: the link, the network or the source, in words. */
export class IngestError extends Error {}

const GITHUB_SHORT = /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([^\s]+))?$/;

/** What a link points at, from its shape alone (nothing is fetched). */
export function classifyLink(link: string, options: { allowLocal?: boolean } = {}): IngestLink {
  const text = link.trim();
  const short = GITHUB_SHORT.exec(text);
  if (short) return { kind: "github", owner: short[1]!, repo: short[2]!, ref: short[3] ?? null, path: null };
  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url) {
    if (/(^|\/)[^/]*\.md$/i.test(text)) {
      if (!options.allowLocal) throw new IngestError(`${text} is a local file: only the CLI reads those (youiyoux library ingest ${text})`);
      return { kind: "design-md", location: resolve(text), local: true };
    }
    throw new IngestError(`"${text}" is not a link: give a GitHub repository (github:owner/repo or its https URL), a Storybook's https URL, a Figma file's URL, or a DESIGN.md (a path or an https URL)`);
  }
  if (url.protocol !== "https:") throw new IngestError(`${url.protocol}//${url.host} is not https: ingestion reads public https links only`);
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "github.com") {
    if (parts.length < 2) throw new IngestError(`${text} names no repository: expected https://github.com/<owner>/<repo>`);
    const [owner, repo, kind, ref, ...rest] = parts as [string, string, string?, string?, ...string[]];
    // A DESIGN.md seen on GitHub is read as one.
    if (kind === "blob" && ref && /\.md$/i.test(rest.at(-1) ?? "")) return { kind: "design-md", location: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`, local: false };
    return { kind: "github", owner, repo: repo.replace(/\.git$/, ""), ref: kind === "tree" && ref ? ref : null, path: kind === "tree" && rest.length > 0 ? rest.join("/") : null };
  }
  if (host === "figma.com" || host.endsWith(".figma.com")) {
    const at = parts.findIndex((p) => p === "design" || p === "file" || p === "proto");
    const key = at >= 0 ? parts[at + 1] : undefined;
    if (!key || !/^[A-Za-z0-9]{10,64}$/.test(key)) throw new IngestError(`${text} names no Figma file: expected https://www.figma.com/design/<file key>/…`);
    return { kind: "figma", key };
  }
  if (/\.md$/i.test(url.pathname)) return { kind: "design-md", location: url.href, local: false };
  // Anything else is read as a Storybook: its index.json says whether it is one.
  const base = `${url.origin}${url.pathname.replace(/\/(?:index\.html|iframe\.html)?$/, "")}`.replace(/\/+$/, "");
  return { kind: "storybook", base };
}

/* ------------------------------------------------------------------ helpers */

export interface ItemInput {
  readonly kind: LibraryEntry["kind"];
  readonly name: string;
  readonly title?: string;
  readonly summary: string;
  /** The source's own name for it: a path, a story title, a Figma key. */
  readonly ref: string;
  /** Where to see this item; none for a local file, whose path is never written into the Library. */
  readonly url: string | null;
  /** What the item was read from, digested. */
  readonly digest: string;
  readonly files?: ReadonlyArray<{ path: string; sha256: string | null }>;
  /** Categories the source gives (a Storybook title's folders, a token group). */
  readonly categories?: readonly string[];
  readonly install?: LibraryEntry["install"];
}

/** Items for one source: ids unique within it (`button`, `button-2`), roles added to each item's categories. */
export function itemsOf(source: IngestSource, license: LibraryLicense, fetchedAt: string, inputs: readonly ItemInput[]): LibraryEntry[] {
  const used = new Set<string>();
  const slug = sourceSlug(source.name.replace(/\//g, "-"));
  return inputs.map((input) => {
    const base = `lib:${slug}/${input.kind}/${nameSlug(input.name)}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const draft: LibraryEntry = {
      schema: "youi.library/v1",
      id,
      name: input.name,
      ...(input.title && input.title !== input.name ? { title: input.title } : {}),
      kind: input.kind,
      stage: "library",
      summary: summaryOf(input.summary, `${input.name} from ${source.name}`),
      source: { name: source.name, ...(input.url ? { url: input.url } : {}), ingestedAt: fetchedAt, kind: source.kind, ref: input.ref },
      categories: [...new Set((input.categories ?? []).map((c) => c.toLowerCase()).filter(Boolean))],
      swapsWith: [],
      ...(input.url ? { provenance: { fetchedAt, url: input.url, sha256: input.digest, files: [...(input.files ?? [])], registryHealth: null } } : {}),
      license,
      ...(input.install ? { install: input.install } : {}),
    };
    // The role its name says, the longest phrase first (Alert Dialog is a dialog); the title when the name says none. A description is not read: it mentions other things.
    // `ComboBox` reads as "combo box"; run together it is "combobox", as the concept spells it.
    const named = readNeed(input.name).concepts.length > 0 ? readNeed(input.name).concepts : readNeed(input.name.replace(/[^A-Za-z0-9]+/g, "").toLowerCase()).concepts;
    const roles = input.kind === "token" ? [] : (named.length > 0 ? named : input.title ? readNeed(input.title).concepts : []).map((c) => c.id);
    return LibraryEntry.parse({ ...draft, categories: [...new Set([...roles, ...draft.categories])] });
  });
}

/** `button.tsx`, `date-picker.vue`, `AlertDialog.tsx` → `Button`, `Date Picker`, `Alert Dialog`. */
export function displayName(file: string): string {
  const stem = basename(file).replace(/\.[^.]+$/, "");
  return stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

export const digestOf = (value: unknown): string => sha256(typeof value === "string" ? value : JSON.stringify(value));

/** Fetched JSON, or an IngestError saying what failed where. */
export async function fetchJson(client: PoliteClient, url: string, what: string): Promise<unknown> {
  const got = await client.json(url, false);
  if (!got.ok) throw new IngestError(`could not read ${what} (${url}): ${got.status === 404 ? "not found" : got.message}`);
  // Cleaned where it arrives, before a reader splits or joins anything: a control sequence cut in two is not caught later.
  return cleanData(got.value);
}

export async function fetchText(client: PoliteClient, url: string, what: string): Promise<{ body: string; sha256: string; fetchedAt: string }> {
  const got = await client.get(url, "text/plain, text/markdown, */*");
  if (!got.ok) throw new IngestError(`could not read ${what} (${url}): ${got.status === 404 ? "not found" : got.message}`);
  return { body: cleanText(got.body), sha256: got.sha256, fetchedAt: got.fetchedAt };
}

/** Read one link into Library items. Nothing is written. */
export async function ingestLink(link: string, options: IngestOptions): Promise<IngestResult> {
  const now = options.now ?? (() => new Date());
  const target = classifyLink(link, options);
  const fetchedAt = now().toISOString();
  const result = await (target.kind === "github"
    ? readGithub(target, options.client, fetchedAt)
    : target.kind === "storybook"
      ? readStorybook(target, options.client, fetchedAt)
      : target.kind === "figma"
        ? (options.figma ? readFigma(target, options.client, fetchedAt) : Promise.reject(new IngestError("a Figma file is read through Figma's API: set FIGMA_TOKEN to a personal access token that can read the file (Figma > Settings > Security > Personal access tokens)")))
        : readDesignMd(target, options.client, fetchedAt, (path) => readFile(path, "utf8")));
  const over = result.entries.length - INGEST_CAP;
  // Every string a source served (a title, a name, a path, a reason) without terminal controls, as Discover keeps its listings.
  return cleanData({
    ...result,
    link: link.trim(),
    fetchedAt,
    entries: result.entries.slice(0, INGEST_CAP),
    notes: [...result.notes, ...(over > 0 ? [`${over} more item${over === 1 ? "" : "s"} not read: at most ${INGEST_CAP} come from one link`] : [])],
  });
}

export type ReaderResult = Pick<IngestResult, "source" | "license" | "entries" | "skipped" | "notes">;
