/**
 * Try it: one tile made live. Loaded (as its own chunk) on the first click, never before. It asks
 * the hub's server to bundle the look (scripts/try-server.ts: the project's own code, fenced to
 * its root), then swaps the tile's static frame for a live one: the same document and stylesheet
 * plus that bundle, in a frame sandboxed with `allow-scripts` only. Without `allow-same-origin`
 * the project's code runs in an opaque origin: it cannot read the hub's DOM, storage or cookies,
 * and talks to the hub only by message. The hub reads three kinds, and only from that frame's own
 * window: the box the look covers (finite numbers, to fit it in the tile), an Escape the look did
 * not use, and an error. Until the bundle runs, and when it fails, the static specimen stays.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { DESK_WIDTH, documentHead, FRAME_HEIGHT, fitTransform, MARGIN } from "./Specimens.tsx";

export const TRY_ENDPOINT = "__youi/try";

/** How long a live frame may take to say it has rendered (its script loaded and ran) before the tile gives up. */
export const START_TIMEOUT_MS = 15_000;

/** The sandbox a live frame gets: scripts, and nothing else (never allow-same-origin). */
export const LIVE_SANDBOX = "allow-scripts";

const escapeAttribute = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const absolute = (url: string): string => {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
};

/** The live frame's document: the static one, plus the look's bundle as a classic script at the end. */
export function liveDocument(html: string, css: string, scheme: Scheme, script: string): string {
  return `${documentHead(absolute(css), scheme)}</head><body><div id="youi-specimen" style="display:inline-block;margin:${MARGIN}px">${html}</div><script src="${escapeAttribute(absolute(script))}"></script></body></html>`;
}

/** Requests still waiting, by look: a second ask for the same look (StrictMode runs effects twice) shares the first. */
const asking = new Map<string, Promise<{ script: string } | { error: string }>>();

/** The script URL for a look, or the sentence the tile shows instead. */
export function requestBundle(project: string, specimen: string, base: string = import.meta.env.BASE_URL): Promise<{ script: string } | { error: string }> {
  const key = `${base}\0${project}\0${specimen}`;
  let request = asking.get(key);
  if (!request) {
    request = ask(project, specimen, base).finally(() => asking.delete(key));
    asking.set(key, request);
  }
  return request;
}

async function ask(project: string, specimen: string, base: string): Promise<{ script: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetch(`${base}${TRY_ENDPOINT}?project=${encodeURIComponent(project)}&specimen=${encodeURIComponent(specimen)}`, { cache: "no-store" });
  } catch {
    return { error: "Try it needs the hub's own server (pnpm dev, youiyoux ui or vite preview), which did not answer; the static specimen stays." };
  }
  // A host that only serves files answers with a page or nothing, not the endpoint's JSON.
  const body = (await response.json().catch(() => null)) as { script?: unknown; error?: unknown } | null;
  if (response.ok && typeof body?.script === "string") return { script: body.script };
  if (typeof body?.error !== "string") return { error: "Try it needs the hub's own server (pnpm dev, youiyoux ui or vite preview); this host only serves files, so the static specimen stays." };
  return { error: response.status === 404 || response.status === 503 ? body.error : `Try it could not bundle this look (${body.error.replace(/\.$/, "")}); the static specimen stays.` };
}

interface LiveFrameProps {
  project: string;
  specimen: string;
  /** A bundle built already (a Discover preview's): used as it is, nothing is asked for. */
  script?: string | null;
  html: string;
  css: string;
  scheme: Scheme;
  height: number;
  /** The look's page background, read from its static frame: fills the whole tile, not just the moved frame. */
  background?: string;
  /** What the tile shows until the live frame has drawn: its static frame. */
  fallback: ReactNode;
  onReady: () => void;
  onEnd: () => void;
  onFail: (sentence: string) => void;
}

type TryData = { youi?: unknown; type?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; message?: unknown };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function LiveFrame({ project, specimen, script: built = null, html, css, scheme, height, background, fallback, onReady, onEnd, onFail }: LiveFrameProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [script, setScript] = useState<string | null>(built);
  const [transform, setTransform] = useState<string | null>(null);
  // The latest callbacks, so the listeners below are set up once.
  const handlers = useRef({ onReady, onEnd, onFail });
  handlers.current = { onReady, onEnd, onFail };

  useEffect(() => {
    if (built !== null) return;
    let cancelled = false;
    void requestBundle(project, specimen).then((result) => {
      if (cancelled) return;
      if ("script" in result) setScript(result.script);
      else handlers.current.onFail(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [project, specimen, built]);

  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (script === null || started) return;
    // A script that never loads (the server restarted, the bundle is gone) or never renders.
    const timer = setTimeout(() => handlers.current.onFail(`This look did not start within ${START_TIMEOUT_MS / 1000}s; the static specimen stays.`), START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [script, started]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Only the live frame's own window; its origin is opaque ("null"), so the source is what identifies it.
      const frame = frameRef.current;
      if (!frame || event.source === null || event.source !== frame.contentWindow) return;
      const data = event.data as TryData | null;
      if (!data || data.youi !== "try") return;
      if (data.type === "box") {
        const tile = boxRef.current;
        const { x, y, width, height: tall } = data;
        if (!tile || !finite(x) || !finite(y) || !finite(width) || !finite(tall) || width <= 0 || tall <= 0) return;
        setTransform(fitTransform({ x, y, width, height: tall }, tile.clientWidth, height));
      } else if (data.type === "ready") {
        setStarted(true);
        handlers.current.onReady();
        frame.focus();
        frame.contentWindow?.postMessage({ youi: "try-focus" }, "*");
      } else if (data.type === "escape") handlers.current.onEnd();
      else if (data.type === "error") handlers.current.onFail(`This look failed when it ran (${typeof data.message === "string" ? data.message.slice(0, 200) : "an error"}); the static specimen stays.`);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [height]);

  return (
    <div ref={boxRef} className="absolute inset-0" style={{ background: transform !== null ? background : undefined }} data-live={transform !== null ? "drawn" : "loading"}>
      {transform === null && fallback}
      {script !== null && (
        <iframe
          ref={frameRef}
          title="Live specimen: Escape or Done returns to the static one"
          tabIndex={0}
          sandbox={LIVE_SANDBOX}
          srcDoc={liveDocument(html, css, scheme, script)}
          data-live-frame=""
          className={transform === null ? "pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-transparent opacity-0" : "absolute left-0 top-0 origin-top-left border-0 bg-transparent"}
          style={{ width: DESK_WIDTH, height: FRAME_HEIGHT, transform: transform ?? undefined, colorScheme: scheme }}
        />
      )}
    </div>
  );
}
