/**
 * The registries behind Discover, for someone who does not know their names: shadcn's registry
 * directory as the Discover cache keeps it (`/__youi/query?kind=registries`), and the fetch of
 * every registry's listings (`/__youi/discover-every`) that Discover's Every registry searches.
 * Both are the hub's own server's; a static host has neither, and says so.
 */

export interface RegistryRow {
  readonly name: string;
  readonly homepage: string | null;
  readonly description: string | null;
  /** Items the directory counts in it, or null when it gives none. */
  readonly itemCount: number | null;
  /** official: shadcn's own; source: one of your sources; listed: among every registry's listings; available: not fetched yet. */
  readonly state: "official" | "source" | "listed" | "available";
  /** Its listings in the local index, or null when none are. */
  readonly listed: number | null;
}

export interface RegistryPage {
  readonly total: number;
  readonly offset: number;
  readonly rows: readonly RegistryRow[];
  /** Registries left out: hidden, unavailable, or not on public https. */
  readonly left: number;
  /** Icon sets left out. */
  readonly icons: number;
  /** When every registry's listings were last fetched; null: never. */
  readonly every: string | null;
}

export type RegistrySort = "items" | "name";

/** What `/__youi/discover-every` answers. */
export interface EveryStatus {
  readonly state: "none" | "running" | "ready" | "failed";
  readonly done: number;
  readonly total: number;
  readonly listings: number | null;
  readonly failed: number;
  readonly fetchedAt: string | null;
  readonly error: string | null;
}

/** The hub's own server is not here (a static host): what to run instead. */
export const NO_SERVER = "This needs the hub running on your machine: youiyoux ui (its own server reads the registry directory).";

const isJson = (response: Response): boolean => (response.headers.get("content-type") ?? "").includes("application/json");

/** One page of the directory's registries, narrowed by words, most items first or by name. */
export async function fetchRegistries(options: { readonly q?: string; readonly sort?: RegistrySort; readonly offset?: number; readonly limit?: number }, init: { signal?: AbortSignal } = {}): Promise<RegistryPage> {
  const params = new URLSearchParams({ kind: "registries", limit: String(options.limit ?? 48) });
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.sort && options.sort !== "items") params.set("sort", options.sort);
  if (options.offset) params.set("offset", String(options.offset));
  const response = await fetch(`${import.meta.env.BASE_URL}__youi/query?${params}`, { cache: "no-store", ...(init.signal ? { signal: init.signal } : {}) }).catch((error: unknown) => {
    if ((error as { name?: string }).name === "AbortError") throw error;
    return null;
  });
  const body = response && isJson(response) ? ((await response.json().catch(() => null)) as (RegistryPage & { error?: string }) | null) : null;
  if (!response || !body) throw new Error(NO_SERVER);
  if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error ?? `The registry list did not load (HTTP ${response.status}).`);
  return body;
}

/** How far every registry's listings are; null on a static host. */
export async function everyStatus(init: { signal?: AbortSignal } = {}): Promise<EveryStatus | null> {
  const response = await fetch(`${import.meta.env.BASE_URL}__youi/discover-every`, { cache: "no-store", ...(init.signal ? { signal: init.signal } : {}) }).catch((error: unknown) => {
    if ((error as { name?: string }).name === "AbortError") throw error;
    return null;
  });
  if (!response || !isJson(response)) return null;
  const body = (await response.json().catch(() => null)) as (EveryStatus & { error?: string }) | null;
  if (!body || typeof body.state !== "string") return null;
  return body;
}

/** Start fetching every registry's listings (or join the fetch already running). */
export async function startEvery(): Promise<EveryStatus> {
  const response = await fetch(`${import.meta.env.BASE_URL}__youi/discover-every`, { method: "POST", cache: "no-store" }).catch(() => null);
  const body = response && isJson(response) ? ((await response.json().catch(() => null)) as (EveryStatus & { error?: string }) | null) : null;
  if (!response || !body) throw new Error(NO_SERVER);
  if (!response.ok || typeof body.state !== "string") throw new Error(body.error ?? `It did not start (HTTP ${response.status}).`);
  return body;
}
