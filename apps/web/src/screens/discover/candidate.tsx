/**
 * One opened candidate, drawn in the user's project theme. Opening is what asks for it
 * (requestPreview): its source is fetched into the cache and bundled by the hub's server, never
 * before. The bundle runs only in a frame sandboxed with `allow-scripts` (DrawProbe), which
 * posts back the markup it drew; the hub then draws that markup in script-free frames with the
 * project's own CSS, light and dark, in each state, and Try it makes one live.
 */
import { useEffect, useRef, useState } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { requestPreview, setDrawn, settleDrawn, useDrawn, useSettled, type PreviewAnswer, type PreviewState } from "../../data/discover-preview.ts";
import type { InventoryShape } from "../../data/types.ts";
import { LIVE_SANDBOX, liveDocument } from "../inventory/try-live.tsx";
import { DESK_WIDTH, FRAME_HEIGHT, PAGE_HEIGHT, PAGE_WIDTH, type Tile } from "../inventory/Specimens.tsx";

/** How long the hidden frame may take to draw before the preview says so. */
const DRAW_TIMEOUT_MS = 15_000;

/** A candidate's shape before anything is drawn: unknown, so tiles show "drawing". */
const UNKNOWN_SHAPE: InventoryShape = { height: null, paddingX: null, paddingY: null, radius: null, fontSize: null, fontWeight: null };

/** The preview of one candidate, asked for while `id` is set (and only then). */
export function usePreview(id: string | null, project: string | null): PreviewState | null {
  const [state, setState] = useState<{ id: string; state: PreviewState } | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void requestPreview(id, project).then((next) => !cancelled && setState({ id, state: next }));
    return () => {
      cancelled = true;
    };
  }, [id, project]);
  return id && state?.id === id ? state.state : null;
}

type ProbeData = { youi?: unknown; type?: unknown; html?: unknown; settled?: unknown; message?: unknown };

/**
 * The candidate's bundle, run once in a hidden sandboxed frame (`allow-scripts`, no same origin)
 * to learn the markup it draws. Only that frame's own messages are read: its markup (cleaned
 * before use, setDrawn) or an error sentence.
 */
export function DrawProbe({ answer, onFail }: { answer: PreviewAnswer; onFail: (sentence: string) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const failed = useRef(onFail);
  failed.current = onFail;
  const drawn = useDrawn(answer.id);
  const hasDrawn = useRef(false);
  hasDrawn.current = drawn !== null;
  // The frame stays until the drawing settles (a chart has finished animating in).
  const done = useSettled(answer.id);
  useEffect(() => {
    if (done) return;
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current;
      if (!frame || event.source === null || event.source !== frame.contentWindow) return;
      const data = event.data as ProbeData | null;
      if (!data || data.youi !== "try") return;
      if (data.type === "html" && typeof data.html === "string") setDrawn(answer.id, data.html, data.settled !== false);
      else if (data.type === "error") failed.current(`It failed when it ran (${typeof data.message === "string" ? data.message.slice(0, 200) : "an error"}); the listing stands.`);
    };
    window.addEventListener("message", onMessage);
    // Past the limit, a drawing that never settled is kept as it is; none at all is a failure.
    const timer = setTimeout(() => (hasDrawn.current ? settleDrawn(answer.id) : failed.current(`It did not draw within ${DRAW_TIMEOUT_MS / 1000}s; the listing stands.`)), DRAW_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [answer.id, done]);
  if (done || !answer.script || !answer.css) return null;
  return (
    <iframe
      ref={frameRef}
      title={`Drawing ${answer.name}`}
      aria-hidden
      tabIndex={-1}
      sandbox={LIVE_SANDBOX}
      srcDoc={liveDocument("", answer.css.light, "light", answer.script, answer.page)}
      data-draw-probe={answer.id}
      // In the viewport, though unseen: a frame out of sight gets no animation frames, so a chart would never finish.
      className="pointer-events-none fixed top-0 left-0 -z-10 border-0 opacity-0"
      style={answer.page ? { width: PAGE_WIDTH, height: PAGE_HEIGHT } : { width: DESK_WIDTH, height: FRAME_HEIGHT }}
    />
  );
}

/** A candidate's tile in one scheme: its drawn markup with the project's sheet for that scheme, and its bundle for Try it. */
export function candidateTile(answer: PreviewAnswer, html: string | null, scheme: Scheme, key = `${answer.id}:${scheme}`): Tile {
  return {
    key,
    project: answer.project,
    specimen: html ? { kind: "component", html } : null,
    css: html && answer.css ? answer.css[scheme] : null,
    shape: UNKNOWN_SHAPE,
    count: 1,
    place: answer.entry.source.ref ?? answer.name,
    script: answer.script,
  };
}
