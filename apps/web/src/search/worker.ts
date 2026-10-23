/** Search runs off the main thread: the worker owns the index and answers queries by id. */
import type { SearchDoc } from "./docs.ts";
import { createIndex, searchIndex } from "./engine.ts";

export type WorkerRequest = { readonly type: "index"; readonly docs: readonly SearchDoc[] } | { readonly type: "query"; readonly id: number; readonly query: string };
export interface WorkerResponse {
  readonly id: number;
  readonly ids: readonly string[];
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

let index = createIndex([]);

scope.onmessage = ({ data }) => {
  if (data.type === "index") {
    index = createIndex(data.docs);
    return;
  }
  scope.postMessage({ id: data.id, ids: searchIndex(index, data.query) });
};
