/**
 * The live bridge: a script an app loads in development so the hub can show it running on the
 * Screens canvas and comment on its components there.
 *
 * The hub frames the app at a screen's address and talks to this script with `postMessage`. It
 * reads the page the same way `youiyoux screens capture` does (`locateInPage`: every React
 * component, its box and its JSX call's frames) and answers two things: where the page is (its
 * path, scroll and size, also sent unasked when they change) and which components are under a
 * point. Frames go back to the hub as the browser saw them; the hub's local service maps them to
 * a file and line with the app's source maps, as capture does.
 *
 * It answers only a parent on this machine (`localhost`, `127.0.0.1`, `[::1]`) that said hello,
 * and only that parent's origin: a site elsewhere that frames the app learns nothing. Unframed it
 * does nothing at all.
 */
import { locateInPage, MAX_PLACES, type RawPlace } from "./locate.ts";

/** Where the hub's local service serves the bridge (packages/workflow http.ts). */
export const BRIDGE_PATH = "/api/live/bridge.js";
/** Every message either way carries `youiyoux: BRIDGE_VERSION`. */
export const BRIDGE_VERSION = 1;
/** The origins the bridge answers: a hub on this machine. */
export const LOOPBACK_PARENT = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
/** Components answered per point, smallest first. */
export const AT_MOST = 8;

/** Where the framed page is: sent on hello, and again when its path, scroll or size changes. */
export interface BridgeView {
  readonly youiyoux: typeof BRIDGE_VERSION;
  readonly type: "view";
  /** The path and query the page is on. */
  readonly path: string;
  readonly scroll: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly page: { readonly width: number; readonly height: number };
}

/** The components under a point the hub asked about (`{ type: "at", id, x, y }`, viewport pixels). */
export interface BridgeAt extends Omit<BridgeView, "type"> {
  readonly type: "at";
  readonly id: number;
  /** React was found on the page, and kept the stacks a development build keeps. */
  readonly react: boolean;
  readonly dev: boolean;
  /** Boxes in page pixels, smallest first. */
  readonly places: readonly RawPlace[];
}

/** The bridge as a script, self-contained: what the service serves at BRIDGE_PATH. */
export function liveBridge(): string {
  return `/* youiyoux live bridge v${BRIDGE_VERSION}: answers a youiyoux hub on this machine that frames this page; nothing else. */
(() => {
  "use strict";
  if (window.parent === window || window.__youiyouxBridge) return;
  window.__youiyouxBridge = ${BRIDGE_VERSION};
  const V = ${BRIDGE_VERSION};
  const LOOPBACK = ${LOOPBACK_PARENT.toString()};
  const locate = ${locateInPage.toString()};
  let hub = null;
  let found = null;
  const stale = () => { found = null; };
  const view = () => ({ youiyoux: V, type: "view", path: location.pathname + location.search, scroll: { x: scrollX, y: scrollY }, viewport: { width: innerWidth, height: innerHeight }, page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
  const send = (message) => { if (hub) window.parent.postMessage(message, hub); };
  let last = "";
  const tell = () => {
    const now = view();
    const key = JSON.stringify([now.path, now.scroll, now.viewport, now.page]);
    if (key === last) return;
    last = key;
    send(now);
  };
  let queued = false;
  const soon = () => {
    stale();
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; tell(); });
  };
  new MutationObserver(soon).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener("scroll", soon, { passive: true, capture: true });
  addEventListener("resize", soon);
  addEventListener("popstate", soon);
  addEventListener("message", (event) => {
    if (event.source !== window.parent || !LOOPBACK.test(event.origin)) return;
    const data = event.data;
    if (!data || data.youiyoux !== V) return;
    if (data.type === "hello") {
      hub = event.origin;
      last = "";
      tell();
      return;
    }
    if (event.origin !== hub || data.type !== "at" || !Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isInteger(data.id)) return;
    if (!found) found = locate(${MAX_PLACES}, 6);
    const x = data.x + scrollX;
    const y = data.y + scrollY;
    const places = found.places
      .filter((p) => x >= p.box.x && y >= p.box.y && x <= p.box.x + p.box.width && y <= p.box.y + p.box.height)
      .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height || b.depth - a.depth)
      .slice(0, ${AT_MOST});
    send({ ...view(), type: "at", id: data.id, react: found.react, dev: found.dev, places });
  });
})();
`;
}
