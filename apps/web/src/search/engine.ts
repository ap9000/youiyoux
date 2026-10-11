/** The search engine (MiniSearch). Loaded only by the worker, the inline fallback, tests and the benchmark. */
import MiniSearch, { type Options, type SearchOptions } from "minisearch";
import type { SearchDoc } from "./docs.ts";

const FUZZY_MIN_LENGTH = 4;
const FUZZY_DISTANCE = 0.2;

export const INDEX_OPTIONS: Options<SearchDoc> = {
  idField: "id",
  fields: ["name", "key", "summary", "text"],
  storeFields: [],
};

export const SEARCH_OPTIONS: SearchOptions = {
  boost: { name: 4, key: 2, summary: 1, text: 0.5 },
  prefix: true,
  fuzzy: (term) => (term.length >= FUZZY_MIN_LENGTH ? FUZZY_DISTANCE : false),
  combineWith: "AND",
};

export function createIndex(docs: readonly SearchDoc[]): MiniSearch<SearchDoc> {
  const index = new MiniSearch<SearchDoc>(INDEX_OPTIONS);
  index.addAll([...docs]);
  return index;
}

export function searchIndex(index: MiniSearch<SearchDoc>, query: string): string[] {
  return index.search(query, SEARCH_OPTIONS).map((result) => String(result.id));
}
