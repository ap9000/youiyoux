/**
 * App-wide data: the catalog model (loaded at startup) and the usage index
 * (loaded on first need). Each is a tiny external store read with
 * useSyncExternalStore, so any screen can read it without a provider.
 *
 * Both are read from one pinned manifest, so the catalog and the usage map always
 * come from the same snapshot generation. Under `youiyoux ui --watch` a new generation
 * is loaded in full and then swapped in for both at once.
 */
import { useSyncExternalStore } from "react";
import type { InventorySource } from "./inventory-source.ts";
import type { GapsReport } from "@youiyoux/core";
import { DataError, absoluteDataUrl, loadCatalog, loadDetect, loadGaps, loadInventory, loadInventoryPart, loadManifest, loadUsage, pruneCache } from "./load.ts";
import type { DetectReport, InventoryChunk, InventoryExtras, Manifest } from "./types.ts";
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

/**
 * The inventory the manifest names, or null when the snapshot has none: its index now, each
 * chunk when the page asks. A snapshot older than the split names the whole file; it is split
 * in memory.
 */
async function inventoryFor(manifest: Manifest): Promise<InventorySource | null> {
  if (!manifest.inventory) return null;
  const [loaded, { createSource, memorySource }] = await Promise.all([loadInventory(manifest.inventory), import("./inventory-source.ts")]);
  if (loaded.schema === "youi.inventory/v1") return memorySource(loaded);
  return createSource(loaded, (file) => (file.startsWith("inventory.extras.") ? loadInventoryPart<InventoryExtras>(file, "youiyoux.inventory-extras/v1") : loadInventoryPart<InventoryChunk>(file, "youiyoux.inventory-chunk/v1")), absoluteDataUrl);
}

const inventoryLoader = createLoader(async (): Promise<InventorySource | null> => inventoryFor(await pinnedManifest()));

/** The detect report the snapshot carries (`youiyoux ui --detect`), or null when it has none. */
const detectFor = async (manifest: Manifest): Promise<DetectReport | null> => (manifest.detect ? loadDetect(manifest.detect.file) : null);
const detectLoader = createLoader(async (): Promise<DetectReport | null> => detectFor(await pinnedManifest()));

/** The gaps the snapshot carries (with an inventory), or null when it has none. */
const gapsFor = async (manifest: Manifest): Promise<GapsReport | null> => (manifest.gaps ? loadGaps(manifest.gaps) : null);
const gapsLoader = createLoader(async (): Promise<GapsReport | null> => gapsFor(await pinnedManifest()));

/** The Discover listings file the snapshot carries for a static host, or null (read only when the query endpoint is absent). */
export async function discoverListingsFile(): Promise<string | null> {
  return (await pinnedManifest()).discover ?? null;
}

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
        const inventoryInUse = inventoryLoader.get().status !== "idle";
        const detectInUse = detectLoader.get().status !== "idle";
        const gapsInUse = gapsLoader.get().status !== "idle";
        const [model, usage, inventory, detect, gaps] = await Promise.all([modelFor(manifest), usageInUse ? usageFor(manifest) : null, inventoryInUse ? inventoryFor(manifest) : undefined, detectInUse ? detectFor(manifest) : undefined, gapsInUse ? gapsFor(manifest) : undefined]);
        pinned = Promise.resolve(manifest);
        modelLoader.replace(model);
        if (usage) usageLoader.replace(usage);
        if (inventory !== undefined) inventoryLoader.replace(inventory);
        if (detect !== undefined) detectLoader.replace(detect);
        if (gaps !== undefined) gapsLoader.replace(gaps);
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

// `youiyoux ui --watch`: the dev server announces each new snapshot generation; the built hub's own
// server (scripts/hub-server.ts) sends the same on the event stream index.html names.
if (import.meta.hot) import.meta.hot.on("youi:snapshot", () => void refreshSnapshot());
else if (typeof document !== "undefined") {
  const events = document.querySelector<HTMLMetaElement>('meta[name="youi-live"]')?.content;
  if (events) new EventSource(events).addEventListener("snapshot", () => void refreshSnapshot());
}

export const startModel = (): void => modelLoader.start();
export const retryModel = (): void => modelLoader.retry();
export const startUsage = (): void => usageLoader.start();
export const retryUsage = (): void => usageLoader.retry();
export const retryDetect = (): void => detectLoader.retry();

export function useModelState(): Resource<Model> {
  return useSyncExternalStore(modelLoader.subscribe, modelLoader.get);
}

export const retryInventory = (): void => inventoryLoader.retry();
export const retryGaps = (): void => gapsLoader.retry();

/** A loader's state; reading it starts the load. */
function useLazy<T>(loader: Loader<T>): Resource<T> {
  const state = useSyncExternalStore(loader.subscribe, loader.get);
  if (state.status === "idle") queueMicrotask(() => loader.start());
  return state;
}

/** The inventory's index and parts (null when the snapshot has none). */
export const useInventoryState = (): Resource<InventorySource | null> => useLazy(inventoryLoader);

/** The detect report. Ready with null when the snapshot has none. */
export const useDetectState = (): Resource<DetectReport | null> => useLazy(detectLoader);

/** The gaps report. Ready with null when the snapshot has none. */
export const useGapsState = (): Resource<GapsReport | null> => useLazy(gapsLoader);

/** The usage index (a small, cached load). */
export const useUsageState = (): Resource<UsageIndex> => useLazy(usageLoader);
