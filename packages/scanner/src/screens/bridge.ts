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
 * It also edits a component in place for the hub (live-edit.ts): its current props and text,
 * props set and kept set, and every edit undone. That needs React's renderer, which React hands to
 * the hook the bridge leaves only when the bridge loads first: in the page's head, before the app.
 *
 * It answers only a parent on this machine (`localhost`, `127.0.0.1`, `[::1]`) that said hello,
 * and only that parent's origin: a site elsewhere that frames the app learns nothing. Unframed it
 * does nothing at all.
 */
import { liveEdits, type LiveValue } from "./live-edit.ts";
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

/** What the hub asks about one component (`{ type: "props", id, name, box, ask }`): its values now, and whether it can be edited. */
export interface BridgeProps {
  readonly youiyoux: typeof BRIDGE_VERSION;
  readonly type: "props";
  readonly id: number;
  readonly editable: boolean;
  readonly why: string | null;
  readonly found: boolean;
  readonly props: Readonly<Record<string, LiveValue | null>>;
  readonly text: string | null;
}

/** The answer to an edit (`{ type: "edit", id, name, box, set, text }`); `{ type: "reset" }` undoes them all, `{ type: "forget" }` lets them go as they are. */
export interface BridgeEdited {
  readonly youiyoux: typeof BRIDGE_VERSION;
  readonly type: "edited";
  readonly id: number;
  readonly ok: boolean;
  readonly why: string | null;
}

/** The longest value or text an edit carries. */
export const EDIT_TEXT_MAX = 2000;

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
  // First, while the page is still loading when the bridge is in its head: the hook React hands its renderer to.
  const edits = (${liveEdits.toString()})();
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
    if (event.origin !== hub) return;
    const isBox = (b) => !!b && ["x", "y", "width", "height"].every((k) => Number.isFinite(b[k]));
    const isName = (n) => typeof n === "string" && n.length > 0 && n.length <= 200;
    const isKey = (k) => typeof k === "string" && /^[A-Za-z_$][\\w$]{0,63}$/.test(k) && k !== "children" && k !== "key" && k !== "ref" && !k.startsWith("dangerously");
    const isValue = (v) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= ${EDIT_TEXT_MAX});
    if (data.type === "reset") return void edits.reset();
    if (data.type === "forget") return void edits.forget();
    if (!Number.isInteger(data.id)) return;
    if (data.type === "props" && isName(data.name) && isBox(data.box) && Array.isArray(data.ask) && data.ask.length <= 50 && data.ask.every(isKey)) {
      const ready = edits.ready();
      const read = edits.read(data.name, data.box, data.ask);
      return send({ youiyoux: V, type: "props", id: data.id, editable: ready.editable, why: ready.why, ...read });
    }
    if (data.type === "edit" && isName(data.name) && isBox(data.box) && data.set && typeof data.set === "object" && Object.keys(data.set).length <= 20 && Object.entries(data.set).every(([k, v]) => isKey(k) && isValue(v)) && (data.text === null || (typeof data.text === "string" && data.text.length <= ${EDIT_TEXT_MAX}))) {
      const done = edits.edit(data.name, data.box, data.set, data.text);
      return send({ youiyoux: V, type: "edited", id: data.id, ok: done.ok, why: done.why });
    }
    if (data.type !== "at" || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
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
