/**
 * The main-thread side of search. One worker per model; queries resolve by id,
 * and only the latest answer reaches React. If workers are unavailable the same
 * engine runs inline (loaded on demand), so search never silently stops.
 */
import { useEffect, useState } from "react";
import type { Model } from "../data/model.ts";
import { record } from "../lib/perf.ts";
import { toSearchDocs, type SearchDoc } from "./docs.ts";
import type { WorkerRequest, WorkerResponse } from "./worker.ts";

export interface SearchAnswer {
  readonly ids: readonly string[];
  /** Query to answer, including the worker round trip. */
  readonly totalMs: number;
}

interface SearchClient {
  query(query: string): Promise<SearchAnswer>;
}

function inlineClient(docs: readonly SearchDoc[]): SearchClient {
  const engine = import("./engine.ts").then((m) => ({ m, index: m.createIndex(docs) }));
  return {
    async query(query) {
      const started = performance.now();
      const { m, index } = await engine;
      const ids = m.searchIndex(index, query);
      return { ids, totalMs: performance.now() - started };
    },
  };
}

function workerClient(docs: readonly SearchDoc[]): SearchClient {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "youiyoux-search" });
  } catch {
    return inlineClient(docs);
  }
  let fallback: SearchClient | null = null;
  let nextId = 0;
  const pending = new Map<number, { query: string; started: number; resolve: (answer: SearchAnswer) => void }>();
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    request.resolve({ ids: data.ids, totalMs: performance.now() - request.started });
  };
  worker.onerror = () => {
    fallback ??= inlineClient(docs);
    for (const [id, request] of pending) {
      pending.delete(id);
      void fallback.query(request.query).then(request.resolve);
    }
  };
  worker.postMessage({ type: "index", docs } satisfies WorkerRequest);
  return {
    query(query) {
      if (fallback) return fallback.query(query);
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, { query, started: performance.now(), resolve });
        worker.postMessage({ type: "query", id, query } satisfies WorkerRequest);
      });
    },
  };
}

const clients = new WeakMap<Model, SearchClient>();

export function searchClient(model: Model): SearchClient {
  let client = clients.get(model);
  if (!client) {
    client = typeof Worker === "undefined" ? inlineClient(toSearchDocs(model)) : workerClient(toSearchDocs(model));
    clients.set(model, client);
  }
  return client;
}

export interface SearchState {
  /** Matching ids in rank order; null when the query is empty (show everything). */
  readonly ids: readonly string[] | null;
  readonly totalMs: number | null;
}

/** Ranked ids for `query`. Keeps the previous answer until the next one lands, so lists never flash. */
export function useSearch(model: Model | null, query: string): SearchState {
  const [state, setState] = useState<SearchState>({ ids: null, totalMs: null });
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed || !model) {
      setState({ ids: null, totalMs: null });
      return;
    }
    let live = true;
    void searchClient(model)
      .query(trimmed)
      .then((answer) => {
        record("search", answer.totalMs);
        if (live) setState({ ids: answer.ids, totalMs: answer.totalMs });
      });
    return () => {
      live = false;
    };
  }, [model, trimmed]);
  return trimmed && model ? state : { ids: null, totalMs: null };
}
