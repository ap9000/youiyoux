/**
 * App-wide data: the catalog model (loaded at startup) and the usage index
 * (loaded on first need). Each is a tiny external store read with
 * useSyncExternalStore, so any screen can read it without a provider.
 */
import { useSyncExternalStore } from "react";
import { DataError, loadCatalog, loadManifest, loadUsage, pruneCache } from "./load.ts";
import { buildModel, type Model } from "./model.ts";
import { indexUsage, type UsageIndex } from "./usage.ts";

export type Resource<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly message: string };

interface Loader<T> {
  get(): Resource<T>;
  start(): void;
  retry(): void;
  subscribe(listener: () => void): () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof DataError) return error.message;
  if (error instanceof Error) return `Could not read the snapshot: ${error.message}`;
  return "Could not read the snapshot.";
}

function createLoader<T>(load: () => Promise<T>): Loader<T> {
  let state: Resource<T> = { status: "idle" };
  const listeners = new Set<() => void>();
  const set = (next: Resource<T>): void => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const start = (): void => {
    if (state.status === "loading" || state.status === "ready") return;
    set({ status: "loading" });
    load().then(
      (value) => set({ status: "ready", value }),
      (error: unknown) => set({ status: "error", message: messageOf(error) }),
    );
  };
  return {
    get: () => state,
    start,
    retry: () => {
      state = { status: "idle" };
      start();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const modelLoader = createLoader(async (): Promise<Model> => {
  const manifest = await loadManifest();
  const system = manifest.systems[0];
  if (!system) throw new DataError("The snapshot names no design system. Rebuild it with `pnpm data`.");
  const catalog = await loadCatalog(system.catalog);
  void pruneCache(manifest).catch(() => undefined);
  return buildModel(catalog, manifest);
});

const usageLoader = createLoader(async (): Promise<UsageIndex> => {
  const manifest = await loadManifest();
  const files = manifest.systems.flatMap((system) => system.usage.map((u) => u.file));
  return indexUsage(await Promise.all(files.map(loadUsage)));
});

export const startModel = (): void => modelLoader.start();
export const retryModel = (): void => modelLoader.retry();
export const startUsage = (): void => usageLoader.start();
export const retryUsage = (): void => usageLoader.retry();

export function useModelState(): Resource<Model> {
  return useSyncExternalStore(modelLoader.subscribe, modelLoader.get);
}

/** The usage index; reading it starts the (small, cached) load. */
export function useUsageState(): Resource<UsageIndex> {
  const state = useSyncExternalStore(usageLoader.subscribe, usageLoader.get);
  if (state.status === "idle") queueMicrotask(startUsage);
  return state;
}
