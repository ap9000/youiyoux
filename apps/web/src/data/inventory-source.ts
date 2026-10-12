/**
 * The Inventory page's data: the index, loaded with the page, and the files it names (a chunk
 * per project and role, the extras), each fetched once, on first need. Each file's state is a
 * tiny external store, so a role section re-renders when its chunks arrive.
 */
import { useEffect, useSyncExternalStore } from "react";
import { splitInventory, type SplitSpecimens } from "./inventory-split.ts";
import type { Resource } from "./store.ts";
import type { InventoryChunk, InventoryExtras, InventoryIndex, InventoryReport } from "./types.ts";

type Part = InventoryChunk | InventoryExtras;

export interface InventorySource {
  readonly index: InventoryIndex;
  /** The state of a file the index names; reading it does not start a load. */
  get(file: string): Resource<Part>;
  /** Start loading a file (once). */
  load(file: string): void;
  subscribe(listener: () => void): () => void;
  /** The URL a specimen frame links a project's stylesheet by. */
  cssUrl(file: string): string;
}

const IDLE: Resource<never> = { status: "idle" };

export function createSource(index: InventoryIndex, fetchPart: (file: string) => Promise<Part>, cssUrl: (file: string) => string, preloaded: ReadonlyMap<string, Part> = new Map()): InventorySource {
  const states = new Map<string, Resource<Part>>([...preloaded].map(([file, value]) => [file, { status: "ready", value }]));
  const listeners = new Set<() => void>();
  const set = (file: string, state: Resource<Part>): void => {
    states.set(file, state);
    listeners.forEach((listener) => listener());
  };
  return {
    index,
    get: (file) => states.get(file) ?? IDLE,
    load(file) {
      const state = states.get(file);
      if (state && state.status !== "error") return;
      set(file, { status: "loading" });
      fetchPart(file).then(
        (value) => set(file, { status: "ready", value }),
        (error: unknown) => set(file, { status: "error", message: error instanceof Error ? error.message : String(error) }),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cssUrl,
  };
}

/**
 * A whole youi.inventory/v1 report, split in memory with every file ready: a snapshot made
 * before the split, and tests. Stylesheets get `data:` URLs.
 */
export function memorySource(report: InventoryReport, specimens: Readonly<Record<string, SplitSpecimens>> = {}): InventorySource {
  let n = 0;
  const { index, files } = splitInventory(report, specimens, (stem, ext) => `${stem}.${++n}.${ext}`);
  const parts = new Map(files.filter((f) => f.name.endsWith(".json")).map((f) => [f.name, JSON.parse(f.text) as Part]));
  const css = new Map(files.filter((f) => f.name.endsWith(".css")).map((f) => [f.name, `data:text/css;charset=utf-8,${encodeURIComponent(f.text)}`]));
  return createSource(index, (file) => Promise.reject(new Error(`${file} is not in this inventory`)), (file) => css.get(file) ?? "", parts);
}

/** Several files' states at once; `enabled` starts their loads. */
export function useParts<T extends Part>(source: InventorySource, files: readonly string[], enabled: boolean): Array<Resource<T>> {
  const key = files.join("\0");
  // Re-render when any of the files changes state; the states themselves are read below.
  useSyncExternalStore(source.subscribe, () => files.map((f) => source.get(f).status).join("|"));
  useEffect(() => {
    if (enabled) for (const file of key.split("\0").filter(Boolean)) source.load(file);
  }, [enabled, key, source]);
  return files.map((f) => source.get(f) as Resource<T>);
}
