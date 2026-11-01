/**
 * Every screen of every project on one board: each project its pictures in rows of four, each with its
 * open requests as numbered pins. Pictures are the thumbnails while zoomed out and the full captures
 * when zoomed in.
 *
 * It is worked as a design tool's canvas is, with its keys (TOOL_KEYS, and SHORTCUTS' Canvas group):
 *   Move (V)     click a screen to select it, double-click or Enter to open its page; drag the board
 *                to pan; a live screen takes the pointer, to use the app
 *   Hand (H)     drag anywhere to pan, live screens included; nothing is clicked. Space held is the
 *                hand from any tool, until it is let go
 *   Comment (C)  the component under the pointer is outlined and named on any screen whose capture
 *                placed its components, and a click opens a comment or change request on it beside
 *                the click; C again goes back to Move
 * Scroll pans (Shift: sideways), ⌘/Ctrl-scroll or a pinch zooms at the pointer, + − or ⌘= ⌘− zoom,
 * ⇧1 fits every screen, ⇧0 is 100% and ⇧2 zooms to the selected screen. A pin opens its request's
 * thread on the board, to reply, close or reopen. Esc closes what is open, then goes back to Move,
 * then lets go of the selection.
 *
 * A screen of the product the local service serves can run live (LiveScreen): its card frames the
 * running app at the screen's address, to use as it is and to comment on the same way. At most
 * LIVE_AT_ONCE run at once, each being a whole page of the app; turning on another stops the first.
 */
import { clsx } from "clsx";
import { ArrowUpRight, Hand, Image, Maximize, MessageSquarePlus, Minus, MousePointer2, Plus, Radio, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Link, useLocation } from "wouter";
import type { ElementId, RequestDoc, RequestTarget } from "@youiyoux/core";
import type { Scheme } from "../../app/theme.tsx";
import { dataUrl } from "../../data/load.ts";
import { elementOf, matchPlaces, pickKey, requestTarget, usePlaces, type Placed } from "../../data/places.ts";
import { routeLabel, screenHref, type Screen, type ScreenIndex } from "../../data/screens.ts";
import { EVERY_SCREEN, type ProjectLookalike, type Site } from "../../data/usage.ts";
import { Button } from "../../ui/Button.tsx";
import { shotFile } from "../../ui/ScreenImage.tsx";
import { IssueBadge } from "./IssueCounts.tsx";
import { PlacesLayer } from "./PlacesOverlay.tsx";
import { RequestComposer, RequestThread } from "./Requests.tsx";
import { LiveScreen, SELECTED } from "./LiveScreen.tsx";
import type { LiveInfo } from "../../data/workflow.ts";
import { pct } from "../../lib/format.ts";

/** A screen's width on the board, in board pixels. */
const CARD_WIDTH = 360;
const GAP = 48;
/** Screens per row before a project's wrap, so a project with many fits at a readable zoom. */
const PER_ROW = 4;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;
/** Past this zoom the thumbnails are too soft: the full pictures are drawn. */
const FULL_AT = 0.75;
const STEP = 1.25;
/** A pointer that moves less than this between down and up is a click, not a pan. */
const CLICK_SLOP = 4;
/** A comment's bubble: its width, and how far it keeps from the board's edges. */
const BUBBLE = 360;
const EDGE = 12;
/** Live screens running at once: each is a whole page of the app. */
export const LIVE_AT_ONCE = 4;

/** The canvas's tools, by the key that picks each, as in a design tool. */
export type Tool = "move" | "hand" | "comment";
export const TOOL_KEYS: Readonly<Record<string, Tool>> = { v: "move", h: "hand", c: "comment" };
const TOOLS: ReadonlyArray<{ tool: Tool; key: string; label: string; icon: typeof Hand }> = [
  { tool: "move", key: "V", label: "Move", icon: MousePointer2 },
  { tool: "hand", key: "H", label: "Hand", icon: Hand },
  { tool: "comment", key: "C", label: "Comment", icon: MessageSquarePlus },
];
/** A key the canvas leaves alone because it is being typed into a field. */
const typing = (target: EventTarget | null): boolean => target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

export interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** A point on the board, in board pixels: where a bubble is anchored, so it moves with a pan or zoom. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** A comment being written: on which screen, about what, and where it was clicked. */
interface Draft {
  readonly screen: Screen;
  readonly target: RequestTarget;
  readonly select: string | null;
  readonly name: string;
  readonly elementName: string | null;
  readonly at: Point;
}

/** What one project's screens render, to tell which placed component is which System element. */
interface ProjectSites {
  readonly sites: readonly Site[];
  readonly lookalikes: readonly ProjectLookalike[];
}

const clamp = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Zoom by `factor` keeping the board point under (px, py) where it is on screen. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clamp(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** The view that shows a board of `board` size whole inside a frame of `frame` size, centred, never larger than 1. */
export function fitView(board: { width: number; height: number }, frame: { width: number; height: number }, pad = 32): View {
  const scale = clamp(Math.min(1, (frame.width - 2 * pad) / Math.max(1, board.width), (frame.height - 2 * pad) / Math.max(1, board.height)));
  return { scale, x: (frame.width - board.width * scale) / 2, y: Math.max(pad, (frame.height - board.height * scale) / 2) };
}

interface CardProps {
  screen: Screen;
  scheme: Scheme;
  full: boolean;
  requests: readonly RequestDoc[];
  onPin: (request: RequestDoc, at: { clientX: number; clientY: number }) => void;
  onLoad: () => void;
  /** Commenting: the components are loaded and pickable. */
  commenting: boolean;
  /** The hand: the card is a surface to pan from, its live app and pins out of reach. */
  hand: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  project: ProjectSites;
  nameOf: (placed: Placed) => string;
  /** What the comment being written is about, when it is on this screen. */
  picking: string | null;
  onPick: (placed: Placed, page: { width: number; height: number }, at: { clientX: number; clientY: number }, route?: string) => void;
  /** Where this screen runs, when it can run live: its address on the app, and every captured screen's. */
  live: { url: string; viewport: { width: number; height: number }; screens: LiveInfo["screens"] } | null;
  running: boolean;
  onLive: () => void;
}

function Card({ screen, scheme, full, requests, onPin, onLoad, commenting, hand, selected, onSelect, onOpen, project, nameOf, picking, onPick, live, running, onLive }: CardProps) {
  const picked = shotFile(screen.shot, scheme, full ? "full" : "thumb");
  const open = requests.filter((r) => r.status !== "closed");
  const placesState = usePlaces(commenting && picked && !running ? screen.shot?.places : undefined);
  const places = placesState?.status === "ready" ? placesState.value : null;
  const placed = useMemo(() => (places ? matchPlaces(places.places, project.sites, project.lookalikes) : []), [places, project]);
  const unplaced = commenting && picked && !running && (!screen.shot?.places || placesState?.status === "error");
  const picture = (
    <>
      {picked ? (
        <img src={dataUrl(picked.file)} alt="" draggable={false} onLoad={onLoad} className="block w-full select-none" />
      ) : (
        <span className="grid h-[200px] place-items-center p-4 text-center text-small text-faint">No screenshot yet</span>
      )}
      {places && <PlacesLayer places={places} placed={placed} outline="all" select={picking} pointed={null} nameOf={nameOf} onSelect={(p, at) => p && onPick(p, places.size, at)} />}
    </>
  );
  return (
    <article className="relative shrink-0 space-y-2" style={{ width: CARD_WIDTH }} data-canvas-screen={`${screen.project}:${screen.route}`} {...(selected ? { "data-selected": "" } : {})}>
      {hand && <div className="absolute -inset-2 z-40 cursor-[inherit]" data-canvas-shield aria-hidden />}
      <header className="flex min-w-0 items-center gap-2" onClick={(event) => !commenting && event.target === event.currentTarget && onSelect()}>
        <Link href={screenHref(screen.project, screen.route)} className="min-w-0 truncate font-mono text-mono text-ink hover:text-accent" draggable={false}>
          {screen.route === EVERY_SCREEN ? "every screen" : routeLabel(screen.route)}
        </Link>
        {open.length > 0 && <span className="rounded-full bg-accent px-1.5 text-caption font-medium text-on-accent tabular" title={`${open.length} open or addressed requests`}>{open.length}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <IssueBadge issues={screen.issues} />
          {live && (
            <button
              type="button"
              onClick={onLive}
              aria-pressed={running}
              title={running ? "Show the screenshot" : `Run ${routeLabel(screen.route)} live from ${live.url}`}
              className={clsx("inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-caption font-medium", running ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-raised hover:text-ink")}
              data-live-toggle
            >
              {running ? <Image aria-hidden className="size-3.5" /> : <Radio aria-hidden className="size-3.5" />}
              {running ? "Picture" : "Live"}
            </button>
          )}
        </span>
      </header>
      {running && live ? (
        <LiveScreen
          url={live.url}
          viewport={live.viewport}
          width={CARD_WIDTH}
          screens={live.screens}
          route={screen.route}
          commenting={commenting}
          sites={project}
          nameOf={nameOf}
          picking={picking !== null}
          onPick={(placed, page, at, route) => onPick(placed, page, at, route)}
          requests={requests}
          onPin={onPin}
          selected={selected}
        />
      ) : (
        <PictureFrame selected={selected} label={`${screen.project} ${routeLabel(screen.route)}`} onSelect={commenting ? null : onSelect} onOpen={commenting ? null : onOpen}>
          {picture}
          {picked &&
            requests.map((request, i) =>
              request.target.box && request.target.page ? (
                <button
                  key={request.id}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onPin(request, event);
                  }}
                  aria-label={`Request ${i + 1} on ${routeLabel(screen.route)} (${request.status}): ${request.body}`}
                  title={request.body}
                  data-canvas-pin={request.id}
                  className={clsx(
                    "absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-surface text-caption font-semibold tabular shadow-raise",
                    request.status === "closed" ? "bg-neutral-soft text-muted" : request.status === "addressed" ? "bg-success text-on-accent" : "bg-accent text-on-accent",
                  )}
                  style={{ left: pct(request.target.box.x, request.target.page.width), top: pct(request.target.box.y, request.target.page.height) }}
                >
                  {i + 1}
                </button>
              ) : null,
            )}
        </PictureFrame>
      )}
      {unplaced && (
        <p className="text-caption text-muted" data-canvas-unplaced>
          No component positions for this screen: <code className="font-mono">youiyoux screens capture</code> places them.
        </p>
      )}
    </article>
  );
}

/** A screen's picture: with Move, a click selects it and a double-click opens its page; while commenting, a surface to pick on. */
function PictureFrame({ selected, label, onSelect, onOpen, children }: { selected: boolean; label: string; onSelect: (() => void) | null; onOpen: (() => void) | null; children: ReactNode }) {
  return (
    <div
      className={clsx("relative block overflow-hidden rounded-md border bg-surface shadow-raise", selected ? SELECTED : "border-line")}
      onClick={onSelect ?? undefined}
      onDoubleClick={onOpen ?? undefined}
      aria-label={label}
      data-canvas-picture
    >
      {children}
    </div>
  );
}

/** A comment's box on the board, beside where it was clicked and moving with the board, kept inside it. */
function Bubble({ at, view, frame, label, onClose, children }: { at: Point; view: View; frame: HTMLDivElement | null; label: ReactNode; onClose: () => void; children: ReactNode }) {
  const width = frame?.clientWidth ?? 0;
  const height = frame?.clientHeight ?? 0;
  const left = Math.max(EDGE, Math.min(view.x + at.x * view.scale + EDGE, width - BUBBLE - EDGE));
  const y = view.y + at.y * view.scale;
  // In the board's lower half it opens upward from the click, so it never runs off the bottom.
  const place = height > 0 && y > height / 2 ? { bottom: Math.max(EDGE, height - y - EDGE), maxHeight: Math.max(160, y) } : { top: Math.max(EDGE, y - EDGE), maxHeight: Math.max(160, height - Math.max(EDGE, y - EDGE) - EDGE) };
  return (
    <div
      role="dialog"
      aria-label="Comment"
      className="absolute z-30 flex max-h-[min(560px,calc(100%-24px))] w-[min(360px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-popover animate-pop"
      style={{ left, ...place }}
      data-canvas-bubble
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1 text-small">{label}</div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink max-sm:size-10">
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

interface CanvasProps {
  screens: ScreenIndex;
  scheme: Scheme;
  requests: readonly RequestDoc[];
  /** A request filed, answered, closed or reopened here, as the service returned it. */
  onRequest?: (request: RequestDoc) => void;
  /** A System element's name, for "Every Button". */
  nameOf?: (element: ElementId) => string;
  /** Where the served product's app runs, for live screens; null when the service is not running. */
  live?: LiveInfo | null;
}

export function ScreensCanvas({ screens, scheme, requests, onRequest = () => undefined, nameOf: elementName = (id) => id, live = null }: CanvasProps) {
  const [, navigate] = useLocation();
  const frame = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const projects = [...new Set(screens.screens.map((s) => s.project))];
  const [tool, setTool] = useState<Tool>("move");
  /** Space held: the hand from any tool, until it is let go. */
  const [space, setSpace] = useState(false);
  const active: Tool = space ? "hand" : tool;
  const commenting = tool === "comment";
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const openScreen = (screen: Screen): void => navigate(screenHref(screen.project, screen.route));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [thread, setThread] = useState<{ id: string; at: Point } | null>(null);
  /** The live screens, oldest first, by project and route. */
  const [running, setRunning] = useState<readonly string[]>([]);
  const liveOf = (screen: Screen): CardProps["live"] => {
    if (!live?.base || !live.viewport || live.project !== screen.project) return null;
    const path = live.screens.find((s) => s.route === screen.route)?.path;
    return path ? { url: `${live.base}${path}`, viewport: live.viewport, screens: live.screens } : null;
  };
  const toggleLive = (key: string): void => setRunning((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key].slice(-LIVE_AT_ONCE)));

  // A place names its own file and line, so it is matched against every site of its project, as on a screen's page.
  const sitesOf = useMemo(() => {
    const map = new Map<string, ProjectSites>();
    for (const project of new Set(screens.screens.map((s) => s.project))) {
      const own = screens.screens.filter((s) => s.project === project);
      map.set(project, { sites: own.flatMap((s) => s.elements.flatMap((e) => e.sites)), lookalikes: own.flatMap((s) => s.lookalikes) });
    }
    return map;
  }, [screens]);
  const nameOf = (p: Placed): string => (p.element ? elementName(p.element) : p.place.name);

  /** Where a click was, on the board. */
  const boardPoint = (at: { clientX: number; clientY: number }): Point => {
    const rect = frame.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const v = viewRef.current;
    return { x: (at.clientX - rect.left - v.x) / v.scale, y: (at.clientY - rect.top - v.y) / v.scale };
  };
  const pick = (card: Screen, placed: Placed, page: { width: number; height: number }, at: { clientX: number; clientY: number }, route?: string): void => {
    // A live screen may have been navigated to another captured screen: the comment goes on that one.
    const screen = (route && screens.screens.find((s) => s.project === card.project && s.route === route)) || card;
    const element = elementOf(placed);
    setThread(null);
    setDraft({ screen, target: requestTarget(screen.route, placed, page), select: pickKey(placed) ?? element, name: nameOf(placed), elementName: element ? elementName(element) : null, at: boardPoint(at) });
  };
  const openThread = (request: RequestDoc, at: { clientX: number; clientY: number }): void => {
    setDraft(null);
    setThread({ id: request.id, at: boardPoint(at) });
  };

  // Once someone pans or zooms, pictures that finish loading no longer refit the board.
  const touched = useRef(false);
  const fit = useCallback(() => {
    const f = frame.current;
    const b = board.current;
    if (f && b) setView(fitView({ width: b.offsetWidth, height: b.offsetHeight }, { width: f.clientWidth, height: f.clientHeight }));
  }, []);
  useLayoutEffect(fit, [fit, screens]);
  const refit = useCallback(() => !touched.current && fit(), [fit]);

  const zoom = useCallback((factor: number, at?: { x: number; y: number }) => {
    const f = frame.current;
    if (!f) return;
    touched.current = true;
    setView((v) => zoomAt(v, factor, at?.x ?? f.clientWidth / 2, at?.y ?? f.clientHeight / 2));
  }, []);
  /** The selected screen filling the frame, as far as the zoom goes. */
  const zoomToSelected = useCallback(() => {
    const f = frame.current;
    const card = selectedRef.current ? f?.querySelector(`[data-canvas-screen="${CSS.escape(selectedRef.current)}"]`) : null;
    if (!f || !card) return;
    const box = card.getBoundingClientRect();
    const at = f.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    touched.current = true;
    setView((v) => {
      const width = box.width / v.scale;
      const height = box.height / v.scale;
      const x = (box.left - at.left - v.x) / v.scale;
      const y = (box.top - at.top - v.y) / v.scale;
      const scale = clamp(Math.min((f.clientWidth - 64) / width, (f.clientHeight - 64) / height));
      return { scale, x: (f.clientWidth - width * scale) / 2 - x * scale, y: (f.clientHeight - height * scale) / 2 - y * scale };
    });
  }, []);

  // Esc closes what is open, then goes back to Move, then lets go of the selection; it works from inside a comment's text too.
  const escape = useCallback((): boolean => {
    if (draft || thread) {
      setDraft(null);
      setThread(null);
      return true;
    }
    if (tool !== "move") {
      setTool("move");
      return true;
    }
    if (!selected) return false;
    setSelected(null);
    return true;
  }, [draft, thread, tool, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (escape()) event.preventDefault();
        return;
      }
      if (typing(event.target)) return;
      if (event.metaKey || event.ctrlKey) {
        // ⌘= and ⌘− zoom the board, not the page.
        if (event.altKey) return;
        if (event.key === "=" || event.key === "+") zoom(STEP);
        else if (event.key === "-") zoom(1 / STEP);
        else return;
        event.preventDefault();
        return;
      }
      if (event.altKey) return;
      if (event.key === " ") {
        if (!event.repeat) setSpace(true);
      } else if (event.shiftKey && event.code === "Digit1") fit();
      else if (event.shiftKey && event.code === "Digit0") zoom(1 / viewRef.current.scale);
      else if (event.shiftKey && event.code === "Digit2") zoomToSelected();
      else if (event.key === "+" || event.key === "=") zoom(STEP);
      else if (event.key === "-") zoom(1 / STEP);
      else if (event.key === "0") fit();
      else if (event.key === "Enter" && selectedRef.current) {
        const screen = screens.screens.find((s) => `${s.project}:${s.route}` === selectedRef.current);
        if (!screen) return;
        openScreen(screen);
      } else if (TOOL_KEYS[event.key.toLowerCase()] && !event.shiftKey) {
        const next = TOOL_KEYS[event.key.toLowerCase()]!;
        // C again puts the comment tool down, as the button does.
        setTool((now) => (now === next && next === "comment" ? "move" : next));
      } else return;
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== " ") return;
      setSpace(false);
      if (!typing(event.target)) event.preventDefault();
    };
    const letGo = (): void => setSpace(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", letGo);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", letGo);
    };
  }, [zoom, fit, zoomToSelected, escape, screens]);

  // Wheel: pan, or zoom with ⌘/Ctrl (a trackpad pinch arrives as a ctrl-wheel). Not passive, so the page does not scroll too.
  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = f.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      else {
        touched.current = true;
        // Shift turns a mouse wheel's scroll sideways, where the system does not already.
        const [dx, dy] = event.shiftKey && event.deltaX === 0 ? [event.deltaY, 0] : [event.deltaX, event.deltaY];
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    f.addEventListener("wheel", onWheel, { passive: false });
    return () => f.removeEventListener("wheel", onWheel);
  }, [zoom]);

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    if (!d.moved) frame.current?.setPointerCapture?.(event.pointerId);
    d.moved = true;
    touched.current = true;
    setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
  };
  const up = (): void => {
    // A pan that ends over a link or a component is not a click on it.
    if (drag.current?.moved) {
      const swallow = (e: MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    }
    drag.current = null;
  };

  const forScreen = (screen: Screen): RequestDoc[] => requests.filter((r) => r.target.route === screen.route && r.project === screen.project).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-sunken" data-canvas data-tool={active}>
      <div
        ref={frame}
        className={clsx("absolute inset-0 touch-none select-none", active === "hand" ? (drag.current?.moved ? "cursor-grabbing" : "cursor-grab") : "cursor-default")}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClick={(event) => active === "move" && !(event.target as Element).closest("[data-canvas-screen]") && setSelected(null)}
        onWheel={(event: ReactWheelEvent) => event.stopPropagation()}
        aria-label="Every screen on one board: V to select, H or Space to pan, C to comment; scroll to pan, ⌘ or Ctrl and scroll to zoom"
        role="region"
      >
        <div ref={board} className="absolute top-0 left-0 inline-flex origin-top-left flex-col p-8" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, gap: GAP * 1.5, ["--unscale" as string]: 1 / view.scale }} data-board>
          {projects.map((project) => (
            <section key={project} aria-label={project} className="space-y-4">
              <h2 className="text-heading">{project}</h2>
              <div className="flex flex-wrap items-start" style={{ gap: GAP, width: PER_ROW * CARD_WIDTH + (PER_ROW - 1) * GAP }}>
                {screens.screens
                  .filter((s) => s.project === project)
                  .map((screen) => (
                    <Card
                      key={screen.route}
                      screen={screen}
                      scheme={scheme}
                      full={view.scale >= FULL_AT}
                      requests={forScreen(screen)}
                      onPin={openThread}
                      onLoad={refit}
                      commenting={commenting}
                      hand={active === "hand"}
                      selected={selected === `${screen.project}:${screen.route}`}
                      onSelect={() => setSelected(`${screen.project}:${screen.route}`)}
                      onOpen={() => openScreen(screen)}
                      project={sitesOf.get(project)!}
                      nameOf={nameOf}
                      picking={draft?.screen === screen ? draft.select : null}
                      onPick={(placed, page, at, route) => pick(screen, placed, page, at, route)}
                      live={liveOf(screen)}
                      running={running.includes(`${screen.project}:${screen.route}`)}
                      onLive={() => toggleLive(`${screen.project}:${screen.route}`)}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {commenting && !space && (
        <p className="pointer-events-none absolute top-3 left-1/2 z-20 w-max max-w-[calc(100%-24px)] -translate-x-1/2 rounded-md border border-line bg-surface px-3 py-1.5 text-center text-small text-ink-2 shadow-raise" role="status" data-canvas-hint>
          Click a component on any screen to comment on it. Esc or V to stop.
        </p>
      )}
      {draft && (
        <Bubble
          at={draft.at}
          view={view}
          frame={frame.current}
          onClose={() => setDraft(null)}
          label={
            <>
              <span className="font-medium text-ink">{draft.name}</span>
              <span className="text-muted"> on {routeLabel(draft.screen.route)}</span>
              {draft.target.file && draft.target.line && <span className="block truncate font-mono text-mono-sm text-faint">{draft.target.file}:{draft.target.line}</span>}
            </>
          }
        >
          <RequestComposer
            key={`${draft.screen.project}:${draft.screen.route}:${draft.select}`}
            bare
            target={draft.target}
            elementName={draft.elementName}
            onCancel={() => setDraft(null)}
            onFiled={(request) => {
              onRequest(request);
              setDraft(null);
            }}
          />
        </Bubble>
      )}
      {thread && <ThreadBubble id={thread.id} at={thread.at} view={view} frame={frame.current} requests={requests} screens={screens} onRequest={onRequest} onClose={() => setThread(null)} onOpen={(href) => navigate(href)} />}
      <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-raise max-sm:right-2 max-sm:bottom-2" data-canvas-controls>
        <div role="toolbar" aria-label="Tools" className="flex items-center gap-0.5" data-canvas-tools>
          {TOOLS.map(({ tool: t, key, label, icon: Icon }) => (
            <Button key={t} variant={active === t ? "primary" : "ghost"} size="icon" onClick={() => setTool(t)} aria-pressed={active === t} aria-label={`${label} (${key})`} title={`${label} (${key})${t === "hand" ? ", or hold Space" : ""}`}>
              <Icon />
            </Button>
          ))}
        </div>
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
        <Button variant="ghost" size="icon" onClick={() => zoom(1 / STEP)} aria-label="Zoom out" title="Zoom out (−)">
          <Minus />
        </Button>
        <span className="w-12 text-center text-small text-muted tabular" aria-live="polite" data-zoom>
          {Math.round(view.scale * 100)}%
        </span>
        <Button variant="ghost" size="icon" onClick={() => zoom(STEP)} aria-label="Zoom in" title="Zoom in (+)">
          <Plus />
        </Button>
        <Button variant="ghost" size="sm" onClick={fit} title="Fit every screen (⇧1)" aria-label="Fit every screen">
          <Maximize /> <span className="max-sm:hidden">Fit</span>
        </Button>
      </div>
    </div>
  );
}

/** A pin's request on the board: its thread, a reply, close or reopen, and the way to its screen's page. */
function ThreadBubble({ id, at, view, frame, requests, screens, onRequest, onClose, onOpen }: { id: string; at: Point; view: View; frame: HTMLDivElement | null; requests: readonly RequestDoc[]; screens: ScreenIndex; onRequest: (request: RequestDoc) => void; onClose: () => void; onOpen: (href: string) => void }) {
  const request = requests.find((r) => r.id === id);
  if (!request) return null;
  const screen = screens.screens.find((s) => s.project === request.project && s.route === request.target.route);
  const siblings = requests.filter((r) => r.project === request.project && r.target.route === request.target.route).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const href = `${screen ? screenHref(screen.project, screen.route) : "/screens"}?request=${request.id}`;
  return (
    <Bubble
      at={at}
      view={view}
      frame={frame}
      onClose={onClose}
      label={
        <Link href={href} className="inline-flex items-center gap-1 font-medium text-ink hover:text-accent">
          {request.project} {routeLabel(request.target.route)} <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <ol>
        <RequestThread request={request} number={siblings.indexOf(request) + 1} active={false} onChange={onRequest} onPick={() => onOpen(href)} />
      </ol>
    </Bubble>
  );
}
