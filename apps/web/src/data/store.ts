/**
 * App-wide data: the catalog model (loaded at startup) and the usage index
 * (loaded on first need). Each is a tiny external store read with
 * useSyncExternalStore, so any screen can read it without a provider.
 *
 * Both are read from one pinned manifest, so the catalog and the usage map always
 * come from the same snapshot generation. Under `youi ui --watch` a new generation
 * is loaded in full and then swapped in for both at once.
 */
import { useSyncExternalStore } from "react";
import { DataError, loadCatalog, loadManifest, loadUsage, pruneCache } from "./load.ts";
import type { Manifest } from "./types.ts";
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
  /** Swap in a value loaded elsewhere (a newer snapshot generation). */
  replace(value: T): void;
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
    replace: (value) => set({ status: "ready", value }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* ------------------------------------------------------------- live snapshots */

export interface LiveState {
  /** The manifest on screen (its `live` block says how and when it was produced). */
  readonly manifest: Manifest | null;
  /** Set when the newest generation could not be loaded; the previous one stays on screen. */
  readonly error: string | null;
}

let live: LiveState = { manifest: null, error: null };
const liveListeners = new Set<() => void>();
const setLive = (next: LiveState): void => {
  live = next;
  liveListeners.forEach((listener) => listener());
};

/** The manifest every loader reads; a failed fetch is not pinned, so a retry fetches again. */
let pinned: Promise<Manifest> | null = null;
function pinnedManifest(): Promise<Manifest> {
  pinned ??= loadManifest().catch((error: unknown) => {
    pinned = null;
    throw error;
  });
  return pinned;
}

async function modelFor(manifest: Manifest): Promise<Model> {
  const system = manifest.systems[0];
  if (!system) throw new DataError("The snapshot names no design system. Rebuild it with `pnpm data`.");
  const catalog = await loadCatalog(system.catalog);
  void pruneCache(manifest).catch(() => undefined);
  return buildModel(catalog, manifest);
}

async function usageFor(manifest: Manifest): Promise<UsageIndex> {
  const files = manifest.systems.flatMap((system) => system.usage.map((u) => u.file));
  return indexUsage(await Promise.all(files.map(loadUsage)));
}

const modelLoader = createLoader(async (): Promise<Model> => {
  const manifest = await pinnedManifest();
  const model = await modelFor(manifest);
  setLive({ manifest, error: null });
  return model;
});
const usageLoader = createLoader(async (): Promise<UsageIndex> => usageFor(await pinnedManifest()));

let refreshing: Promise<void> | null = null;
let again = false;

/**
 * Load the newest generation in full (manifest, catalog and, if it was in use, the usage
 * map), then swap it in everywhere at once. Updates that arrive mid-load coalesce into one
 * more load. A failure keeps the current generation on screen and says so.
 */
export function refreshSnapshot(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      try {
        const manifest = await loadManifest();
        const usageInUse = usageLoader.get().status !== "idle";
        const [model, usage] = await Promise.all([modelFor(manifest), usageInUse ? usageFor(manifest) : null]);
        pinned = Promise.resolve(manifest);
        modelLoader.replace(model);
        if (usage) usageLoader.replace(usage);
        setLive({ manifest, error: null });
      } catch (error: unknown) {
        setLive({ ...live, error: messageOf(error) });
      }
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function useLiveState(): LiveState {
  return useSyncExternalStore(
    (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    () => live,
  );
}

// `youi ui --watch`: the dev server announces each new snapshot generation.
if (import.meta.hot) import.meta.hot.on("youi:snapshot", () => void refreshSnapshot());

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
