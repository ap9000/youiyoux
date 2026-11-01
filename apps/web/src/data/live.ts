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

/** A prop value a live edit sets: what a contract's enum, string, boolean and number props take. */
export type LiveValue = string | number | boolean;

/** One component's values now, and whether the page can edit it (`editable`, else `why`). */
export interface LiveProps {
  readonly editable: boolean;
  readonly why: string | null;
  readonly found: boolean;
  readonly props: Readonly<Record<string, LiveValue | null>>;
  /** Its text, when its children are text. */
  readonly text: string | null;
}

/** An answer about one component (`props`), or to an edit (`edited`), by the id it was asked with. */
export type BridgeReply =
  | (LiveProps & { readonly youiyoux: typeof BRIDGE_VERSION; readonly type: "props"; readonly id: number })
  | { readonly youiyoux: typeof BRIDGE_VERSION; readonly type: "edited"; readonly id: number; readonly ok: boolean; readonly why: string | null };

/** A message from the bridge about the page, or null for anything else. */
export function bridgeMessage(data: unknown): BridgeMessage | null {
  const message = data as Partial<BridgeMessage> | null;
  if (!message || typeof message !== "object" || message.youiyoux !== BRIDGE_VERSION) return null;
  if (typeof message.path !== "string" || typeof message.scroll?.x !== "number" || typeof message.page?.height !== "number") return null;
  if (message.type === "view") return message as BridgeMessage;
  if (message.type === "at" && typeof message.id === "number" && Array.isArray(message.places)) return message as BridgeMessage;
  return null;
}

/** A reply from the bridge about one component, or null for anything else. */
export function bridgeReply(data: unknown): BridgeReply | null {
  const reply = data as Partial<Record<string, unknown>> | null;
  if (!reply || typeof reply !== "object" || reply["youiyoux"] !== BRIDGE_VERSION || typeof reply["id"] !== "number") return null;
  if (reply["type"] === "props" && typeof reply["editable"] === "boolean" && typeof reply["found"] === "boolean" && reply["props"] && typeof reply["props"] === "object") return reply as unknown as BridgeReply;
  if (reply["type"] === "edited" && typeof reply["ok"] === "boolean") return reply as unknown as BridgeReply;
  return null;
}

/** Talking to one live screen's bridge about the component picked on it. */
export interface LiveHandle {
  /** Its values now for these props, its text, and whether the page can edit it. */
  ask(props: readonly string[]): Promise<LiveProps>;
  /** Props set (and text) on it, in place; kept set until reset. */
  edit(set: Readonly<Record<string, LiveValue>>, text: string | null): Promise<{ ok: boolean; why: string | null }>;
  /** Every edit undone on the page. */
  reset(): void;
  /** The edits let go without undoing them: the code now says the same. */
  forget(): void;
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

/**
 * Live editing needs the bridge before React loads, so React hands it the way to change props: the
 * line in the page's head, in development (an app on Vite adds youiyoux's plugin instead).
 */
export function bridgeHead(hubOrigin: string): string {
  return `<script src=${JSON.stringify(`${hubOrigin}${BRIDGE_PATH}`)}></script>`;
}

/** The same for an app on Vite: in vite.config, only while it serves in development. */
export function vitePlugin(hubOrigin: string): string {
  return ['import { youiyoux } from "youiyoux/vite";', "", "export default defineConfig({", `  plugins: [youiyoux({ hub: ${JSON.stringify(hubOrigin)} }), /* …the app's own plugins */],`, "});"].join("\n");
}

/** The captured screen a path shows: the route whose address it is, ignoring a trailing slash and the query. */
export function routeAt(screens: ReadonlyArray<{ readonly route: string; readonly path: string }>, path: string): string | null {
  const bare = (p: string): string => p.split(/[?#]/, 1)[0]!.replace(/(.)\/+$/, "$1");
  return screens.find((s) => s.path === path)?.route ?? screens.find((s) => bare(s.path) === bare(path))?.route ?? null;
}
