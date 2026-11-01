/**
 * A screen's running app on the canvas, in place of its picture: the product's app framed at the
 * screen's address, at the captured viewport scaled to the card, and used as it is (click, type,
 * scroll, navigate). It talks to the hub through the live bridge the app loads in development
 * (data/live.ts): the hub says hello until the bridge answers with where the page is, and gives up
 * saying how to load it. Only messages from this frame, from the app's own origin, are read.
 *
 * Commenting puts a clear layer over the app: the component under the pointer is asked of the
 * bridge, its frames mapped to a file and line by the local service (kept per frame until the page
 * loads again), outlined and named as on a picture, and a click picks it for a comment. Comments
 * go on captured screens only, so a page that is none of them says so. The card's requests are
 * pinned where their boxes are, while the page shows that screen.
 */
import { clsx } from "clsx";
import { PlugZap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RequestDoc } from "@youiyoux/core";
import { bridgeMessage, bridgeSnippet, routeAt, type BridgeMessage, type LiveRawPlace, type LiveView } from "../../data/live.ts";
import { matchPlaces, type Placed } from "../../data/places.ts";
import type { PlacedComponent } from "../../data/types.ts";
import type { ProjectLookalike, Site } from "../../data/usage.ts";
import { workflowApi } from "../../data/workflow.ts";
import { pct } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Modal } from "../../ui/Modal.tsx";

/** How often hello is said until the bridge answers, and how long until the card says how to load it. */
export const HELLO_EVERY_MS = 500;
export const GIVE_UP_MS = 5000;

/** A selected screen's outline: as wide on screen at any zoom (the board sets --unscale), as a design tool draws it. */
export const SELECTED = "border-accent outline-solid outline-accent [outline-width:calc(2px*var(--unscale,1))] [outline-offset:calc(2px*var(--unscale,1))]";

export type LiveStatus = "connecting" | "live" | "no-bridge";

type Pickable = { readonly placed: Placed; readonly view: LiveView };

interface Props {
  /** The screen's address on the running app. */
  url: string;
  /** The captured viewport: the frame is this size, scaled to `width`. */
  viewport: { width: number; height: number };
  width: number;
  /** Every captured screen's route and address, to tell which one the page is on. */
  screens: ReadonlyArray<{ route: string; path: string }>;
  route: string;
  commenting: boolean;
  sites: { readonly sites: readonly Site[]; readonly lookalikes: readonly ProjectLookalike[] };
  nameOf: (placed: Placed) => string;
  /** A comment on this card is being written: its component stays outlined. */
  picking: boolean;
  onPick: (placed: Placed, page: { width: number; height: number }, at: { clientX: number; clientY: number }, route: string) => void;
  requests: readonly RequestDoc[];
  onPin: (request: RequestDoc, at: { clientX: number; clientY: number }) => void;
  selected?: boolean;
}

const frameKey = (place: LiveRawPlace): string => `${place.name}|${place.frames.map((f) => `${f.url}:${f.line}:${f.column}`).join("|")}`;

export function LiveScreen({ url, viewport, width, screens, route, commenting, sites, nameOf, picking, onPick, requests, onPin, selected = false }: Props) {
  const origin = new URL(url).origin;
  const frame = useRef<HTMLIFrameElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [view, setView] = useState<LiveView | null>(null);
  const [hover, setHover] = useState<Pickable | null>(null);
  const [picked, setPicked] = useState<Pickable | null>(null);
  const [help, setHelp] = useState(false);
  const asked = useRef(0);
  /** The click waiting for its answer, by the id it asked with. */
  const clicked = useRef<{ id: number; clientX: number; clientY: number } | null>(null);
  /** Lines found per component's frames, until the page loads again. */
  const lines = useRef(new Map<string, Promise<Pick<PlacedComponent, "file" | "line" | "column">>>());
  const height = viewport.height * (width / viewport.width);
  const onRoute = view ? routeAt(screens, view.path) : null;

  // Hello until the bridge answers; past GIVE_UP_MS the card says how to load it, and keeps listening.
  const hello = (): void => frame.current?.contentWindow?.postMessage({ youiyoux: 1, type: "hello" }, origin);
  const since = useRef(Date.now());
  useEffect(() => {
    if (status === "live") return;
    const timer = setInterval(() => {
      hello();
      if (Date.now() - since.current > GIVE_UP_MS) setStatus((now) => (now === "connecting" ? "no-bridge" : now));
    }, HELLO_EVERY_MS);
    return () => clearInterval(timer);
  }, [status, origin]);

  // Each answer is read through a ref, so the listener always sees this render's props.
  const answer = useRef<(message: BridgeMessage) => void>(() => undefined);
  answer.current = (message) => {
    const now: LiveView = { path: message.path, scroll: message.scroll, viewport: message.viewport, page: message.page };
    setView(now);
    setStatus("live");
    if (message.type !== "at" || message.id !== asked.current) return;
    void placedOf(message.places).then((placed) => {
      if (message.id !== asked.current) return;
      const first = placed[0] ?? null;
      setHover(first ? { placed: first, view: now } : null);
      const click = clicked.current;
      if (!click || click.id !== message.id) return;
      clicked.current = null;
      const at = routeAt(screens, now.path);
      if (!first || !at) return;
      setPicked({ placed: first, view: now });
      onPick(first, now.page, click, at);
    });
  };
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const message = bridgeMessage(event.data);
      if (message) answer.current(message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);
  useEffect(() => {
    if (!picking) setPicked(null);
  }, [picking]);

  /** The bridge's components with their lines: asked of the service once per frames, then kept. */
  const placedOf = async (raw: readonly LiveRawPlace[]): Promise<Placed[]> => {
    const missing = raw.filter((p) => !lines.current.has(frameKey(p)));
    if (missing.length > 0) {
      const asking = workflowApi.resolveLive(missing).then(
        (answer) => answer.places,
        () => missing.map(() => null),
      );
      missing.forEach((place, i) => lines.current.set(frameKey(place), asking.then((found) => found[i] ?? { file: null, line: null, column: null })));
    }
    const resolved = await Promise.all(raw.map(async (place): Promise<PlacedComponent> => ({ ...place, ...(await lines.current.get(frameKey(place))!) })));
    return matchPlaces(resolved, sites.sites, sites.lookalikes);
  };

  const ask = (event: { clientX: number; clientY: number }): number => {
    const rect = layer.current!.getBoundingClientRect();
    const id = ++asked.current;
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * viewport.width;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * viewport.height;
    frame.current?.contentWindow?.postMessage({ youiyoux: 1, type: "at", id, x, y }, origin);
    return id;
  };

  const box = (target: Pickable, kind: "hover" | "lit") => {
    const { box: b } = target.placed.place;
    const s = target.view.scroll;
    return (
      <div
        className={clsx("pointer-events-none absolute rounded-[3px] outline-2 -outline-offset-1 outline-accent outline-solid", kind === "hover" ? "bg-accent/8" : "bg-accent/12")}
        style={{ left: pct(b.x - s.x, viewport.width), top: pct(b.y - s.y, viewport.height), width: pct(b.width, viewport.width), height: pct(b.height, viewport.height) }}
        data-live-box={kind}
      />
    );
  };

  // The card's requests, where their boxes are on the page as it is scrolled now, while it shows the card's screen.
  const pins = view && onRoute === route ? requests.flatMap((request, i) => {
    const b = request.target.box;
    if (!b || request.target.route !== route) return [];
    const x = b.x - view.scroll.x;
    const y = b.y - view.scroll.y;
    return x < 0 || y < 0 || x > viewport.width || y > viewport.height ? [] : [{ request, number: i + 1, x, y }];
  }) : [];

  return (
    <div className="space-y-1.5" data-live={status}>
      <div className={clsx("relative overflow-hidden rounded-md border bg-surface shadow-raise", selected ? SELECTED : "border-line")} style={{ width, height }}>
        <iframe
          ref={frame}
          src={url}
          title={`${route} running at ${url}`}
          onLoad={() => {
            // A load is a new page: its lines are found again, and the bridge is greeted again.
            lines.current.clear();
            since.current = Date.now();
            setStatus((now) => (now === "no-bridge" ? now : "connecting"));
            hello();
          }}
          className="absolute top-0 left-0 origin-top-left border-0 bg-surface"
          style={{ width: viewport.width, height: viewport.height, transform: `scale(${width / viewport.width})` }}
        />
        {commenting && status === "live" && (
          <div
            ref={layer}
            className={clsx("absolute inset-0", onRoute ? "cursor-crosshair" : "cursor-not-allowed")}
            data-live-layer
            onPointerMove={(event) => onRoute && ask(event)}
            onPointerLeave={() => {
              asked.current++;
              setHover(null);
            }}
            onClick={(event) => {
              if (!onRoute) return;
              clicked.current = { id: ask(event), clientX: event.clientX, clientY: event.clientY };
            }}
          >
            {picked && box(picked, "lit")}
            {hover && hover !== picked && box(hover, "hover")}
            {hover && (
              <span
                className="pointer-events-none absolute z-10 max-w-[60%] -translate-y-full truncate rounded-xs bg-ink px-1.5 py-0.5 font-mono text-mono-sm text-canvas shadow-raise"
                style={{ left: pct(hover.placed.place.box.x - hover.view.scroll.x, viewport.width), top: pct(hover.placed.place.box.y - hover.view.scroll.y, viewport.height) }}
                data-place-label
              >
                {nameOf(hover.placed)}
              </span>
            )}
          </div>
        )}
        {pins.map(({ request, number, x, y }) => (
          <button
            key={request.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPin(request, event);
            }}
            aria-label={`Request ${number} on ${route} (${request.status}): ${request.body}`}
            title={request.body}
            data-canvas-pin={request.id}
            className={clsx(
              "absolute z-20 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-surface text-caption font-semibold tabular shadow-raise",
              request.status === "closed" ? "bg-neutral-soft text-muted" : request.status === "addressed" ? "bg-success text-on-accent" : "bg-accent text-on-accent",
            )}
            style={{ left: pct(x, viewport.width), top: pct(y, viewport.height) }}
          >
            {number}
          </button>
        ))}
      </div>
      {status === "no-bridge" && (
        <p className="flex flex-wrap items-center gap-x-2 text-caption text-muted" data-live-note>
          The app is not talking to the hub yet.
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => setHelp(true)}>
            How to connect it
          </button>
        </p>
      )}
      {commenting && status === "live" && view && !onRoute && (
        <p className="text-caption text-muted" data-live-note>
          This page (<code className="font-mono">{view.path}</code>) is not a captured screen: comments go on captured screens, so capture it first.
        </p>
      )}
      {help && (
        <Modal
          title="Connect the running app"
          icon={PlugZap}
          description="Add this to code that runs in the app's browser bundle, such as its entry file. It loads the live bridge only on this machine, inside this hub, so a production build that keeps it does nothing."
          onClose={() => setHelp(false)}
          footer={
            <Button variant="primary" onClick={() => setHelp(false)}>
              Done
            </Button>
          }
        >
          <CodeBlock code={bridgeSnippet(location.origin)} title="live bridge" maxHeight="sm" />
          <p className="text-small text-muted" data-live-policy>
            An app that sends a Content-Security-Policy or X-Frame-Options refuses to be framed, and to load scripts from elsewhere. In development, allow this hub: <code className="font-mono break-all">frame-ancestors {location.origin}</code>, and <code className="font-mono break-all">{location.origin}</code> in <code className="font-mono">script-src</code>.
          </p>
          <p className="text-small text-muted">Then reload the app. Components get their file and line in a development build with source maps, as for <code className="font-mono">youiyoux screens capture</code>.</p>
        </Modal>
      )}
    </div>
  );
}
