/**
 * Live screens: the product's app running in a frame on the Screens canvas, talking to the hub
 * through the live bridge it loads in development (scanner's bridge.ts, served by the local
 * service at BRIDGE_PATH). These are the messages either way, and the line the app adds to load
 * the bridge.
 */

export const BRIDGE_VERSION = 1;
/** Where the hub's local service serves the bridge. */
export const BRIDGE_PATH = "/api/live/bridge.js";

export interface LiveFrame {
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

/** A component under the pointer as the bridge saw it: its box in page pixels and its JSX call's frames. */
export interface LiveRawPlace {
  readonly name: string;
  readonly owner: string | null;
  readonly frames: readonly LiveFrame[];
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly depth: number;
  /** Plain HTML React did not create: its tag. */
  readonly html?: string;
}

/** Where the framed page is: its path and query, scroll, viewport and whole size, in CSS pixels. */
export interface LiveView {
  readonly path: string;
  readonly scroll: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly page: { readonly width: number; readonly height: number };
}

export type BridgeMessage =
  | (LiveView & { readonly youiyoux: typeof BRIDGE_VERSION; readonly type: "view" })
  | (LiveView & { readonly youiyoux: typeof BRIDGE_VERSION; readonly type: "at"; readonly id: number; readonly react: boolean; readonly dev: boolean; readonly places: readonly LiveRawPlace[] });

/** A message from the bridge, or null for anything else. */
export function bridgeMessage(data: unknown): BridgeMessage | null {
  const message = data as Partial<BridgeMessage> | null;
  if (!message || typeof message !== "object" || message.youiyoux !== BRIDGE_VERSION) return null;
  if (typeof message.path !== "string" || typeof message.scroll?.x !== "number" || typeof message.page?.height !== "number") return null;
  if (message.type === "view") return message as BridgeMessage;
  if (message.type === "at" && typeof message.id === "number" && Array.isArray(message.places)) return message as BridgeMessage;
  return null;
}

/**
 * The line the app adds, in code that runs in the browser, to load the bridge from this hub: only
 * on this machine and only when the hub frames it, so a production build that keeps it does nothing.
 */
export function bridgeSnippet(hubOrigin: string): string {
  return [
    "// Live screens in the youiyoux hub: loads only on this machine, inside the hub.",
    'if (window.parent !== window && /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) {',
    `  document.head.append(Object.assign(document.createElement("script"), { src: ${JSON.stringify(`${hubOrigin}${BRIDGE_PATH}`)} }));`,
    "}",
  ].join("\n");
}

/** The captured screen a path shows: the route whose address it is, ignoring a trailing slash and the query. */
export function routeAt(screens: ReadonlyArray<{ readonly route: string; readonly path: string }>, path: string): string | null {
  const bare = (p: string): string => p.split(/[?#]/, 1)[0]!.replace(/(.)\/+$/, "$1");
  return screens.find((s) => s.path === path)?.route ?? screens.find((s) => bare(s.path) === bare(path))?.route ?? null;
}
