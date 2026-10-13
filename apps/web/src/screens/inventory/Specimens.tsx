/**
 * Specimen tiles: each look drawn for real. A tile is an iframe at a fixed desk width (1280px,
 * so the project's breakpoints see a desktop) holding the look's static HTML, linked to its
 * project's one stylesheet for the hub's colour scheme, scaled and centred to fit the tile. No
 * shadow roots: they would drop the sheet's `@font-face` and `:root` rules. The frame runs no
 * script (sandboxed, same origin only so its box can be measured).
 *
 * Lazy by design: a frame mounts only when its tile nears the scroll area and unmounts when it
 * is far; at most MAX_RENDERING frames load at once, the rest wait their turn; at most
 * MAX_MOUNTED are mounted at all, visible tiles first; a strip of more than VIRTUALISE_AT tiles
 * is virtualised. Without a stylesheet or a specimen, a tile draws the look's measured shape
 * instead, and so does a near tile waiting for room to mount its frame.
 *
 * A state strip (StateStrip) is one such frame with the look five times, each cell forcing a state
 * (default, hover, focus, pressed, disabled) through the twins the scanner added to the sheet.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Scheme } from "../../app/theme.tsx";
import type { InventoryShape, Specimen } from "../../data/types.ts";
import { useWide } from "./Sheet.tsx";

export const DESK_WIDTH = 1280;
export const FRAME_HEIGHT = 480;
/** The specimen's offset inside the frame, so a shadow or ring is not cut off. */
export const MARGIN = 32;
export const TILE_HEIGHT = 88;
/** A wall tile's specimen, drawn larger. */
export const LARGE_TILE_HEIGHT = 136;
const TILE_PAD = 10;
export const MAX_RENDERING = 6;
/** Frames mounted at once, loading or drawn (FrameBudget). */
export const MAX_MOUNTED = 48;
export const VIRTUALISE_AT = 100;
const TILE_MIN_WIDTH = 136;
const ROW_HEIGHT = TILE_HEIGHT + 40;
/** Below md, Try it and Done sit under the specimen (44px and a 4px gap), not over it. */
const TRY_BAR_HEIGHT = 48;
const VIRTUAL_ROWS_VISIBLE = 3.5;

/* ---------------------------------------------------------------- near the viewport */

/** The element the Inventory page scrolls in; IntersectionObserver measures nearness against it. */
export const ScrollRoot = createContext<Element | null>(null);

/**
 * True when the element is within `near` of the scroll area; false again only once it is
 * beyond `far`, so a tile at the edge does not mount and unmount as it moves. Without
 * IntersectionObserver everything is near.
 */
export function useNearViewport(ref: RefObject<Element | null>, near = "600px", far = "1800px"): boolean {
  const root = useContext(ScrollRoot);
  const [isNear, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const enter = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root, rootMargin: near });
    const leave = new IntersectionObserver((entries) => entries.every((e) => !e.isIntersecting) && setNear(false), { root, rootMargin: far });
    enter.observe(element);
    leave.observe(element);
    return () => {
      enter.disconnect();
      leave.disconnect();
    };
  }, [ref, root, near, far]);
  return isNear;
}

/** True while the element is in the scroll area itself (no margin): visible tiles keep their frames first. */
function useInView(ref: RefObject<Element | null>): boolean {
  const root = useContext(ScrollRoot);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { root, rootMargin: "0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, root]);
  return inView;
}

/* -------------------------------------------------------------- at most six at once */

type Grant = () => void;

/** Frames allowed to load at the same time; the others queue in the order they asked. */
export class FrameQueue {
  private readonly limit: number;
  private readonly active = new Set<object>();
  private waiting: Array<{ id: object; grant: Grant }> = [];

  constructor(limit = MAX_RENDERING) {
    this.limit = limit;
  }

  get rendering(): number {
    return this.active.size;
  }

  request(id: object, grant: Grant): void {
    if (this.active.has(id) || this.waiting.some((w) => w.id === id)) return;
    if (this.active.size < this.limit) {
      this.active.add(id);
      grant();
    } else this.waiting.push({ id, grant });
  }

  release(id: object): void {
    this.active.delete(id);
    this.waiting = this.waiting.filter((w) => w.id !== id);
    while (this.active.size < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.active.add(next.id);
      next.grant();
    }
  }
}

export const frameQueue = new FrameQueue();

/**
 * A frame's turn: granted once a slot is free; `done` frees it (the frame stays mounted). Each
 * effect run asks with a token of its own and its cleanup gives that token's slot back and goes
 * back to waiting, so a grant for an earlier run (StrictMode mounts, unmounts and mounts again)
 * is never taken for a later one, and no frame renders without a slot.
 */
function useFrameSlot(wanted: boolean, queue: FrameQueue = frameQueue): { granted: boolean; rendering: boolean; done: () => void } {
  const [state, setState] = useState<"waiting" | "rendering" | "done">("waiting");
  const token = useRef<object | null>(null);
  useEffect(() => {
    if (!wanted) return;
    const mine = {};
    token.current = mine;
    queue.request(mine, () => {
      if (token.current === mine) setState((s) => (s === "waiting" ? "rendering" : s));
    });
    return () => {
      if (token.current === mine) token.current = null;
      queue.release(mine);
      setState("waiting");
    };
  }, [wanted, queue]);
  const done = useCallback(() => {
    const mine = token.current;
    if (mine === null) return;
    queue.release(mine);
    setState((s) => (s === "rendering" ? "done" : s));
  }, [queue]);
  return { granted: wanted && state !== "waiting", rendering: wanted && state === "rendering", done };
}

/* ------------------------------------------------------- a bounded number mounted */

/**
 * How many specimen frames may be mounted at once, whether loading or drawn. Visible tiles come
 * first, then tiles that already hold a frame (so frames do not churn), then the others in the
 * order they came near; past the limit a tile shows its shape until there is room.
 */
export class FrameBudget {
  private readonly limit: number;
  private readonly entries = new Map<object, { visible: boolean; touched: number; mounted: boolean; set: (mounted: boolean) => void }>();
  private clock = 0;

  constructor(limit = MAX_MOUNTED) {
    this.limit = limit;
  }

  get mounted(): number {
    return [...this.entries.values()].filter((e) => e.mounted).length;
  }

  join(id: object, visible: boolean, set: (mounted: boolean) => void): void {
    this.entries.set(id, { visible, touched: ++this.clock, mounted: false, set });
    this.settle();
  }

  see(id: object, visible: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.visible === visible) return;
    entry.visible = visible;
    if (visible) entry.touched = ++this.clock;
    this.settle();
  }

  leave(id: object): void {
    if (this.entries.delete(id)) this.settle();
  }

  /** Visible first, then those mounted, then first come; the first `limit` are mounted. */
  private settle(): void {
    const ranked = [...this.entries.values()].sort((a, b) => Number(b.visible) - Number(a.visible) || Number(b.mounted) - Number(a.mounted) || a.touched - b.touched);
    // Unmount before mounting, so the count never passes the limit even for a moment.
    const keep = new Set(ranked.slice(0, this.limit));
    for (const entry of ranked) {
      if (entry.mounted && !keep.has(entry)) {
        entry.mounted = false;
        entry.set(false);
      }
    }
    for (const entry of keep) {
      if (!entry.mounted) {
        entry.mounted = true;
        entry.set(true);
      }
    }
  }
}

export const frameBudget = new FrameBudget();

/** Whether this near tile may mount its frame now (see FrameBudget); StrictMode-safe like useFrameSlot. */
function useFrameBudget(near: boolean, visible: boolean, budget: FrameBudget = frameBudget): boolean {
  const [mounted, setMounted] = useState(false);
  const token = useRef<object | null>(null);
  useEffect(() => {
    if (!near) return;
    const mine = {};
    token.current = mine;
    budget.join(mine, false, (value) => {
      if (token.current === mine) setMounted(value);
    });
    return () => {
      if (token.current === mine) token.current = null;
      budget.leave(mine);
      setMounted(false);
    };
  }, [near, budget]);
  useEffect(() => {
    if (token.current) budget.see(token.current, visible);
  }, [visible, near, budget]);
  return near && mounted;
}

/* ------------------------------------------------------------------------- tiles */

export interface Tile {
  readonly key: string;
  readonly project: string;
  readonly specimen: Specimen | null;
  /** The project's stylesheet for the current scheme; null when none was built. */
  readonly css: string | null;
  readonly shape: InventoryShape;
  readonly count: number;
  readonly place: string;
  /** Its specimen's id in its project, which Try it asks the hub's server to bundle. */
  readonly specimenId?: string | null;
  /** A bundle already built for it (a Discover preview): Try it runs this script instead of asking for one. */
  readonly script?: string | null;
}

/** Where the hub serves a frame's files from, as a CSP source: its origin (`http://localhost:5173`), or its scheme for a file. */
function hubSource(css: string): string {
  try {
    const url = new URL(css, typeof document === "undefined" ? undefined : document.baseURI);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
  } catch {
    return "'self'";
  }
}

/**
 * The policy every specimen frame (static, state strip, Try it, Discover preview) runs under:
 * scripts, sheets and fonts from the hub only, images inline only, and no requests of its own,
 * so outside code drawn in a frame (a Discover candidate) cannot send anything anywhere, and a
 * `url()` in a sheet or style attribute fetches nothing.
 */
export function framePolicy(css: string): string {
  const hub = hubSource(css);
  return `default-src 'none'; script-src ${hub}; style-src ${hub} 'unsafe-inline'; font-src ${hub} data:; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
}

/** The `<html>` opening and `<head>` every specimen document shares: its policy, the hub's scheme, one stylesheet link. */
export function documentHead(css: string, scheme: Scheme): string {
  const escaped = css.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const dark = scheme === "dark";
  return `<!doctype html><html lang="en"${dark ? ' class="dark"' : ""} data-theme="${scheme}" style="color-scheme:${scheme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${framePolicy(css).replace(/"/g, "&quot;")}"><link rel="stylesheet" href="${escaped}">`;
}

/** The document a frame shows: static HTML and one stylesheet link, no script. */
export function frameDocument(html: string, css: string, scheme: Scheme): string {
  return `${documentHead(css, scheme)}</head><body><div id="youi-specimen" style="display:inline-block;margin:${MARGIN}px">${html}</div></body></html>`;
}

/* ----------------------------------------------------------------- the state strip */

/**
 * The states a strip draws, left to right. A cell's class forces its state through the twins the
 * scanner adds to every project sheet (packages/scanner/src/specimens/states.ts, STATE_CLASSES).
 */
export const STATES = [
  { id: "default", label: "Default", className: null },
  { id: "hover", label: "Hover", className: "youi-state-hover" },
  { id: "focus", label: "Focus", className: "youi-state-focus" },
  { id: "pressed", label: "Pressed", className: "youi-state-active" },
  { id: "disabled", label: "Disabled", className: "youi-state-disabled" },
] as const;

const CONTROL = "button, input, select, textarea, fieldset, optgroup, option";
const INTERACTIVE = `${CONTROL}, a, [role], [tabindex]`;

/**
 * The specimen as it is when disabled: `disabled` on its form controls, `aria-disabled="true"`
 * and Radix's `data-disabled` on them, on links and widgets and on its top elements. Set on a
 * `<template>` copy here, before the frame gets it, since the frame runs no script.
 */
export function disabledHtml(html: string): string {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  for (const element of [...content.children, ...content.querySelectorAll(INTERACTIVE)]) {
    if (element.matches(CONTROL)) element.setAttribute("disabled", "");
    element.setAttribute("aria-disabled", "true");
    element.setAttribute("data-disabled", "");
  }
  return template.innerHTML;
}

/**
 * The same specimen five times, one cell per state, in equal columns (an inline grid of `1fr`
 * columns is as wide as its widest cell five times), so the hub can label each column. Each cell
 * is a containing block of its own, so a `fixed` look stays in its cell. No script.
 */
export function stateStripDocument(html: string, css: string, scheme: Scheme): string {
  const cells = STATES.map((state) => `<div class="youi-state-cell${state.className ? ` ${state.className}` : ""}" data-youi-state="${state.id}" style="display:flex;align-items:center;justify-content:center;padding:16px;contain:layout">${state.id === "disabled" ? disabledHtml(html) : html}</div>`).join("");
  return `${documentHead(css, scheme)}</head><body><div id="youi-specimen" style="display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;align-items:center;margin:${MARGIN}px">${cells}</div></body></html>`;
}

type Box = { x: number; y: number; width: number; height: number };

/** The box every visible element of the specimen covers, in frame pixels; `own`: the root's own box (a strip, whose columns the hub labels). */
function specimenBox(doc: Document, own = false): Box | null {
  const root = doc.getElementById("youi-specimen");
  if (!root) return null;
  if (own) {
    const rect = root.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** How far a box is scaled down to fit a tile, padding kept; never up. */
const fitScale = (box: Box, width: number, height: number): number => Math.min(1, (width - 2 * TILE_PAD) / box.width, (height - 2 * TILE_PAD) / box.height);

/** The frame's transform that centres `box` (frame pixels) in a tile `width` by `height`, scaled to fit. */
export function fitTransform(box: Box, width: number, height: number): string {
  const w = width || TILE_MIN_WIDTH;
  const scale = fitScale(box, w, height);
  const x = w / 2 - (box.x + box.width / 2) * scale;
  const y = height / 2 - (box.y + box.height / 2) * scale;
  return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(4)})`;
}

interface FrameProps {
  /** The frame's document (frameDocument or stateStripDocument). */
  srcDoc: string;
  scheme: Scheme;
  near: boolean;
  height: number;
  onBlank?: () => void;
  /** A strip: fit the root's own box, and say where it was placed in the tile (x and width, tile pixels). */
  strip?: (placed: { x: number; width: number }) => void;
  /** The page's own background, once read (a live frame, whose page the hub cannot read, fills its tile with it). */
  onBackground?: (paint: string | undefined) => void;
}

function SpecimenFrame({ srcDoc, scheme, near, height, onBlank, strip, onBackground }: FrameProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const slot = useFrameSlot(near);
  const [transform, setTransform] = useState<string | null>(null);
  const [background, setBackground] = useState<string | undefined>(undefined);
  useLayoutEffect(() => setTransform(null), [srcDoc]);

  const place = (): void => {
    const doc = frameRef.current?.contentDocument;
    const tile = boxRef.current;
    const box = doc ? specimenBox(doc, strip !== undefined) : null;
    if (!tile || !box) {
      setTransform(`translate(${TILE_PAD}px, ${TILE_PAD}px)`);
      slot.done();
      // Laid out at the desk width, and nothing in it has a box: the look is hidden there.
      if (doc && !box && doc.documentElement.getBoundingClientRect().width > 0) onBlank?.();
      return;
    }
    // The page's own background fills the whole tile, not just the moved frame.
    const view = doc!.defaultView;
    const paint = [doc!.body, doc!.documentElement].map((e) => view?.getComputedStyle(e).backgroundColor).find((c) => c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)");
    setBackground(paint);
    onBackground?.(paint);
    const width = tile.clientWidth || TILE_MIN_WIDTH;
    setTransform(fitTransform(box, width, height));
    const scale = fitScale(box, width, height);
    strip?.({ x: width / 2 - (box.width / 2) * scale, width: box.width * scale });
    slot.done();
  };

  const onLoad = (): void => {
    const fonts = frameRef.current?.contentDocument?.fonts;
    if (fonts) void fonts.ready.then(place, place);
    else place();
  };

  return (
    <div ref={boxRef} className="absolute inset-0" style={{ background }}>
      {slot.granted && (
        <iframe
          ref={frameRef}
          title="Specimen"
          aria-hidden
          tabIndex={-1}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={onLoad}
          data-rendering={slot.rendering || undefined}
          data-placed={transform !== null || undefined}
          className={clsx("pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-transparent", transform === null && "opacity-0")}
          style={{ width: DESK_WIDTH, height: FRAME_HEIGHT, transform: transform ?? undefined, colorScheme: scheme }}
        />
      )}
    </div>
  );
}

/** The look's measured shape, drawn as a box: what is left when nothing renders it (or, `waiting`, until its frame may mount). */
export function ShapeBox({ shape, caption = "shape only", tileHeight = TILE_HEIGHT }: { shape: InventoryShape; caption?: string; tileHeight?: number }) {
  const height = shape.height ?? (shape.fontSize !== null ? Math.round(shape.fontSize * 1.5 + 2 * (shape.paddingY ?? 0)) : 32);
  const scale = Math.min(1, (tileHeight - 2 * TILE_PAD - 14) / height);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1" data-testid="shape-box">
      <span
        className="inline-flex items-center border border-dashed border-line-strong text-faint"
        style={{ height: height * scale, paddingInline: (shape.paddingX ?? 12) * scale, borderRadius: Math.min(shape.radius ?? 0, 9999), fontSize: (shape.fontSize ?? 14) * scale, fontWeight: shape.fontWeight ?? undefined }}
      >
        Aa
      </span>
      <span className="text-caption text-faint">{caption}</span>
    </div>
  );
}

/* ------------------------------------------------------------ Try it: one live tile */

/** The live frame (try-live.tsx), its own chunk: fetched on the first Try it, never for the first paint. */
const LiveFrame = lazy(() => import("./try-live.tsx").then((m) => ({ default: m.LiveFrame })));

/** The one live tile on the page: starting another ends it. */
let live: { id: object; end: () => void } | null = null;

export function startLive(id: object, end: () => void): void {
  const previous = live;
  live = { id, end };
  if (previous && previous.id !== id) previous.end();
}

export function stopLive(id: object): void {
  if (live?.id === id) live = null;
}

type LiveState = { status: "static"; failure: string | null } | { status: "loading" | "live" };

/**
 * A tile's Try it: start (ending any other live tile), end (Done, Escape, scrolling away, or
 * another tile starting) and fail (a sentence; the static specimen stays). Escape anywhere in the
 * page ends it; pressed inside the tile, it ends only Try it, not the drawer around it.
 */
function useLive(near: boolean, container: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<LiveState>({ status: "static", failure: null });
  const token = useRef<object>({});
  const button = useRef<HTMLButtonElement>(null);
  const active = state.status !== "static";
  const end = useCallback((failure: string | null = null) => {
    stopLive(token.current);
    setState({ status: "static", failure });
  }, []);
  const start = (): void => {
    startLive(token.current, () => setState({ status: "static", failure: null }));
    setState({ status: "loading" });
  };
  const ready = useCallback(() => setState((s) => (s.status === "loading" ? { status: "live" } : s)), []);
  useEffect(() => {
    if (active && !near) end();
  }, [active, near, end]);
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const inside = container.current?.contains(event.target as Node) ?? false;
      if (inside) {
        event.stopPropagation();
        event.preventDefault();
      }
      end();
      if (inside) button.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, end, container]);
  useEffect(() => () => stopLive(token.current), []);
  return { state, start, ready, end, button };
}

interface SpecimenTileProps {
  tile: Tile;
  scheme: Scheme;
  /** small: a strip of looks; large: a wall tile or a compare card. */
  size?: "small" | "large";
  /** A list item in a strip; a plain box anywhere else. */
  as?: "li" | "div";
  /** The project and file:line under the specimen. */
  caption?: boolean;
  className?: string;
  /** Called when the specimen's frame loads and nothing in it has a box at the desk width. */
  onBlank?: () => void;
  /** Offer Try it on a component look: its own code, live, in a sandboxed frame. */
  tryIt?: boolean;
  /** The box's own background, for a tile drawn in a scheme the hub is not in (a Discover preview's light and dark). */
  backdrop?: string;
}

/**
 * One look drawn: its frame (or its shape) in a box, sharing the near-viewport mounting, the
 * six-at-once queue and the 48-frame budget with every other specimen on the page. A component
 * look can offer Try it: on click (and only then) its code is bundled by the hub's server and
 * the tile swaps to a live frame (try-live.tsx) until Done, Escape or scrolling away.
 */
export function SpecimenTile({ tile, scheme, size = "small", as: Tag = "li", caption = true, className, onBlank, tryIt = false, backdrop }: SpecimenTileProps) {
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref);
  const visible = useInView(ref);
  const drawn = tile.specimen !== null && tile.css !== null;
  const mounted = useFrameBudget(drawn && near, visible);
  const height = size === "large" ? LARGE_TILE_HEIGHT : TILE_HEIGHT;
  const tryable = tryIt && drawn && tile.specimen!.kind === "component" && (!!tile.specimenId || !!tile.script);
  const { state, start, ready, end, button } = useLive(near, ref);
  const [background, setBackground] = useState<string | undefined>(undefined);
  const staticFrame: ReactNode = !drawn ? <ShapeBox shape={tile.shape} tileHeight={height} /> : mounted ? <SpecimenFrame srcDoc={frameDocument(tile.specimen!.html, tile.css!, scheme)} scheme={scheme} near={near} height={height} onBlank={onBlank} onBackground={tryable ? setBackground : undefined} /> : near ? <ShapeBox shape={tile.shape} caption="waiting" tileHeight={height} /> : null;
  const label = `${tile.project} ${tile.place}`;
  return (
    <Tag ref={ref as RefObject<never>} className={clsx("min-w-0 space-y-1", className)} data-tile={tile.key} data-kind={drawn ? tile.specimen!.kind : "shape"} data-frame={drawn && near ? (mounted ? "mounted" : "waiting") : undefined} data-live={state.status !== "static" ? state.status : undefined}>
      {/* Try it and Done sit over the box's corner on a desk; on a phone, where a 44px button would cover the look, below it. */}
      <div className="relative">
        <div className="relative overflow-hidden rounded-md border border-line bg-sunken" style={{ height, background: backdrop }}>
          {tryable && state.status !== "static" ? (
            <Suspense fallback={staticFrame}>
              <LiveFrame project={tile.project} specimen={tile.specimenId ?? ""} script={tile.script ?? null} html={tile.specimen!.html} css={tile.css!} scheme={scheme} height={height} background={background} fallback={staticFrame} onReady={ready} onEnd={() => (end(), button.current?.focus())} onFail={(sentence) => end(sentence)} />
            </Suspense>
          ) : (
            staticFrame
          )}
        </div>
        {tryable && (
          <div className="flex justify-end max-md:pt-1" data-try-bar="">
            <button
              ref={button}
              type="button"
              onClick={() => (state.status === "static" ? start() : (end(), button.current?.focus()))}
              aria-label={state.status === "static" ? `Try ${label} live` : `Done trying ${label}`}
              aria-busy={state.status === "loading" || undefined}
              className="z-10 inline-flex h-6 items-center rounded-sm border border-line bg-surface/90 px-2 text-caption font-medium text-ink-2 shadow-raise outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus focus-visible:outline-solid max-md:h-11 max-md:px-3 md:absolute md:top-1 md:right-1"
              data-try={state.status === "static" ? "start" : "done"}
            >
              {state.status === "static" ? "Try it" : "Done"}
            </button>
          </div>
        )}
      </div>
      {state.status === "static" && state.failure && (
        <p role="status" className="text-caption text-danger" data-try-failure="">
          {state.failure}
        </p>
      )}
      {caption && (
      <p className="flex min-w-0 items-baseline gap-1.5 text-caption text-muted">
        <span className="shrink-0 font-medium text-ink-2">{tile.project}</span>
        {tile.count > 1 && <span className="shrink-0 tabular">×{tile.count}</span>}
        <span className="truncate font-mono" title={tile.place}>
          {tile.place}
        </span>
      </p>
      )}
    </Tag>
  );
}

/**
 * The tile that stands for a set: the first of `tiles` (leadTiles) whose specimen draws something
 * at the desk width; one that loads with nothing visible (say `display: none` above a phone
 * breakpoint) gives way to the next, and the last is the set's shape.
 */
export function LeadTile({ tiles, ...props }: Omit<SpecimenTileProps, "tile" | "onBlank"> & { tiles: readonly Tile[] }) {
  const [blank, setBlank] = useState<ReadonlySet<string>>(() => new Set());
  const id = (t: Tile): string => `${t.css}\n${t.specimen?.html}`;
  const index = tiles.findIndex((t, i) => i === tiles.length - 1 || !blank.has(id(t)));
  const tile = tiles[index];
  if (!tile) return null;
  const last = index === tiles.length - 1;
  return <SpecimenTile key={index} {...props} tile={tile} onBlank={last ? undefined : () => setBlank((b) => new Set(b).add(id(tile)))} />;
}

/** A state strip's height: five cells of one look, scaled to fit. */
export const STRIP_HEIGHT = 112;

/**
 * One look in its five states side by side (stateStripDocument): one frame, mounted like a tile
 * (near the scroll area, six loading at once, within the frame budget), with the states named
 * under their columns. A look with no specimen or no stylesheet has no states to show.
 */
export function StateStrip({ tile, scheme, label }: { tile: Tile; scheme: Scheme; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const visible = useInView(ref);
  const drawn = tile.specimen !== null && tile.css !== null;
  const mounted = useFrameBudget(drawn && near, visible);
  const [columns, setColumns] = useState<{ x: number; width: number } | null>(null);
  const srcDoc = drawn && mounted ? stateStripDocument(tile.specimen!.html, tile.css!, scheme) : null;
  useLayoutEffect(() => setColumns(null), [srcDoc]);
  return (
    <div ref={ref} role="group" aria-label={`${label}, in each state`} className="min-w-0 space-y-1" data-strip={tile.key} data-frame={drawn && near ? (mounted ? "mounted" : "waiting") : undefined}>
      <div className="relative overflow-hidden rounded-md border border-line bg-sunken" style={{ height: STRIP_HEIGHT }}>
        {!drawn ? <ShapeBox shape={tile.shape} caption="no specimen: no states to show" tileHeight={STRIP_HEIGHT} /> : srcDoc ? <SpecimenFrame srcDoc={srcDoc} scheme={scheme} near={near} height={STRIP_HEIGHT} strip={setColumns} /> : near ? <ShapeBox shape={tile.shape} caption="waiting" tileHeight={STRIP_HEIGHT} /> : null}
      </div>
      {drawn && (
        // Each label under its column once the strip is placed; evenly spaced until then.
        <ol aria-label="States" className={clsx("relative h-4 text-caption text-muted", !columns && "grid grid-cols-5 text-center")}>
          {STATES.map((state, i) => (
            <li key={state.id} data-state={state.id} className={clsx(columns && "absolute top-0 -translate-x-1/2 whitespace-nowrap")} style={columns ? { left: columns.x + ((i + 0.5) * columns.width) / STATES.length } : undefined}>
              {state.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A family's tiles: a wrapping grid, virtualised by rows past VIRTUALISE_AT. */
export function TileGrid({ tiles, scheme, tryIt = false }: { tiles: readonly Tile[]; scheme: Scheme; tryIt?: boolean }) {
  if (tiles.length > VIRTUALISE_AT) return <VirtualTileGrid tiles={tiles} scheme={scheme} tryIt={tryIt} />;
  return (
    <ul className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_WIDTH}px, 1fr))` }} aria-label="Specimens">
      {tiles.map((tile) => (
        <SpecimenTile key={tile.key} tile={tile} scheme={scheme} tryIt={tryIt} />
      ))}
    </ul>
  );
}

function VirtualTileGrid({ tiles, scheme, tryIt }: { tiles: readonly Tile[]; scheme: Scheme; tryIt: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.floor((width || 4 * TILE_MIN_WIDTH) / TILE_MIN_WIDTH));
  const rows = Math.ceil(tiles.length / columns);
  const wide = useWide();
  const rowHeight = ROW_HEIGHT + (tryIt && !wide ? TRY_BAR_HEIGHT : 0);
  const virtualizer = useVirtualizer({ count: rows, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 2, initialRect: { width: columns * TILE_MIN_WIDTH, height: rowHeight * VIRTUAL_ROWS_VISIBLE } });
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);
  return (
    <ScrollRoot.Provider value={scrollRef.current}>
      <div ref={scrollRef} className="overflow-y-auto rounded-md border border-line p-2" style={{ height: rowHeight * VIRTUAL_ROWS_VISIBLE }} data-testid="virtual-tiles">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => (
            <ul key={row.key} className="absolute inset-x-0 grid gap-2" style={{ top: row.start, height: rowHeight, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} aria-label={`Specimens, row ${row.index + 1} of ${rows}`}>
              {tiles.slice(row.index * columns, (row.index + 1) * columns).map((tile) => (
                <SpecimenTile key={tile.key} tile={tile} scheme={scheme} tryIt={tryIt} />
              ))}
            </ul>
          ))}
        </div>
      </div>
    </ScrollRoot.Provider>
  );
}
