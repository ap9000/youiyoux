/**
 * Every screen of every project on one board: each project its pictures in rows of four, each with its
 * open requests as numbered pins. Drag to pan, scroll to pan, ⌘/Ctrl-scroll or pinch to zoom,
 * + / − / 0 on the keyboard, and Fit. A screen opens its page; a pin opens its request there.
 * Pictures are the thumbnails while zoomed out and the full captures when zoomed in.
 */
import { clsx } from "clsx";
import { Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Link, useLocation } from "wouter";
import type { RequestDoc } from "@youiyoux/core";
import type { Scheme } from "../../app/theme.tsx";
import { routeLabel, screenHref, type Screen, type ScreenIndex } from "../../data/screens.ts";
import { EVERY_SCREEN } from "../../data/usage.ts";
import { Button } from "../../ui/Button.tsx";
import { shotFile, shotUrl } from "../../ui/ScreenImage.tsx";
import { IssueBadge } from "./IssueCounts.tsx";

/** A screen's width on the board, in board pixels. */
export const CARD_WIDTH = 360;
const GAP = 48;
/** Screens per row before a project's wrap, so a project with many fits at a readable zoom. */
export const PER_ROW = 4;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;
/** Past this zoom the thumbnails are too soft: the full pictures are drawn. */
const FULL_AT = 0.75;
const STEP = 1.25;
/** A pointer that moves less than this between down and up is a click, not a pan. */
const CLICK_SLOP = 4;

export interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
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

const pct = (value: number, of: number): string => `${(value / of) * 100}%`;

function Card({ screen, scheme, full, requests, onPin, onLoad }: { screen: Screen; scheme: Scheme; full: boolean; requests: readonly RequestDoc[]; onPin: (request: RequestDoc) => void; onLoad: () => void }) {
  const picked = shotFile(screen.shot, scheme, full ? "full" : "thumb");
  const open = requests.filter((r) => r.status !== "closed");
  return (
    <article className="shrink-0 space-y-2" style={{ width: CARD_WIDTH }} data-canvas-screen={`${screen.project}:${screen.route}`}>
      <header className="flex min-w-0 items-center gap-2">
        <Link href={screenHref(screen.project, screen.route)} className="min-w-0 truncate font-mono text-mono text-ink hover:text-accent" draggable={false}>
          {screen.route === EVERY_SCREEN ? "every screen" : routeLabel(screen.route)}
        </Link>
        {open.length > 0 && <span className="rounded-full bg-accent px-1.5 text-caption font-medium text-on-accent tabular" title={`${open.length} open or addressed requests`}>{open.length}</span>}
        <span className="ml-auto">
          <IssueBadge issues={screen.issues} />
        </span>
      </header>
      <Link href={screenHref(screen.project, screen.route)} className="relative block overflow-hidden rounded-md border border-line bg-surface shadow-raise" draggable={false} aria-label={`Open ${screen.project} ${routeLabel(screen.route)}`}>
        {picked ? (
          <img src={shotUrl(picked.file)} alt="" draggable={false} onLoad={onLoad} className="block w-full select-none" />
        ) : (
          <span className="grid h-[200px] place-items-center p-4 text-center text-small text-faint">No screenshot yet</span>
        )}
        {picked &&
          requests.map((request, i) =>
            request.target.box && request.target.page ? (
              <button
                key={request.id}
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onPin(request);
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
      </Link>
    </article>
  );
}

export function ScreensCanvas({ screens, scheme, requests }: { screens: ScreenIndex; scheme: Scheme; requests: readonly RequestDoc[] }) {
  const [, navigate] = useLocation();
  const frame = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const projects = [...new Set(screens.screens.map((s) => s.project))];

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      if (event.key === "+" || event.key === "=") zoom(STEP);
      else if (event.key === "-") zoom(1 / STEP);
      else if (event.key === "0") fit();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, fit]);

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
        setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
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
    if (!d.moved) frame.current?.setPointerCapture(event.pointerId);
    d.moved = true;
    touched.current = true;
    setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
  };
  const up = (): void => {
    // A pan that ends over a link is not a click on it.
    if (drag.current?.moved) window.addEventListener("click", (e) => e.preventDefault(), { capture: true, once: true });
    drag.current = null;
  };

  const forScreen = (screen: Screen): RequestDoc[] => requests.filter((r) => r.target.route === screen.route && r.project === screen.project).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-sunken" data-canvas>
      <div
        ref={frame}
        className={clsx("absolute inset-0 touch-none select-none", drag.current?.moved ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={(event: ReactWheelEvent) => event.stopPropagation()}
        aria-label="Every screen on one board: drag or scroll to pan, ⌘ or Ctrl and scroll to zoom"
        role="region"
      >
        <div ref={board} className="absolute top-0 left-0 inline-flex origin-top-left flex-col p-8" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, gap: GAP * 1.5 }} data-board>
          {projects.map((project) => (
            <section key={project} aria-label={project} className="space-y-4">
              <h2 className="text-heading">{project}</h2>
              <div className="flex flex-wrap items-start" style={{ gap: GAP, width: PER_ROW * CARD_WIDTH + (PER_ROW - 1) * GAP }}>
                {screens.screens
                  .filter((s) => s.project === project)
                  .map((screen) => (
                    <Card key={screen.route} screen={screen} scheme={scheme} full={view.scale >= FULL_AT} requests={forScreen(screen)} onPin={(request) => navigate(`${screenHref(screen.project, screen.route)}?request=${request.id}`)} onLoad={refit} />
                  ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-raise" data-canvas-controls>
        <Button variant="ghost" size="icon" onClick={() => zoom(1 / STEP)} aria-label="Zoom out" title="Zoom out (−)">
          <Minus />
        </Button>
        <span className="w-12 text-center text-small text-muted tabular" aria-live="polite" data-zoom>
          {Math.round(view.scale * 100)}%
        </span>
        <Button variant="ghost" size="icon" onClick={() => zoom(STEP)} aria-label="Zoom in" title="Zoom in (+)">
          <Plus />
        </Button>
        <Button variant="ghost" size="sm" onClick={fit} title="Fit every screen (0)">
          <Maximize /> Fit
        </Button>
      </div>
    </div>
  );
}
