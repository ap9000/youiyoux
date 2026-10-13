/**
 * The live preview: the system's own components and specimen screens, rendered in its tokens in
 * isolated frames (preview.html), light beside dark. Unsaved edits arrive as CSS-variable
 * overrides and a pinned state over postMessage, so the frames never reload while editing.
 */
import { clsx } from "clsx";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Play } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PinnedState } from "../../preview/pin.ts";
import { PREVIEW_SCREENS, type FromFrame, type PreviewFocus, type PreviewScreen, type PreviewToken, type PreviewVars, type ToFrame } from "../../preview/protocol.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { INPUT } from "./fields.tsx";
import type { Scheme } from "./model.ts";

const BASE = import.meta.env.BASE_URL;
const MIN_FRAME = 200;
const MAX_FRAME = 4000;

type StateChoice = PinnedState | "rest";
const STATE_OPTIONS: ReadonlyArray<{ value: StateChoice; label: string }> = [
  { value: "rest", label: "Rest" },
  { value: "hover", label: "Hover" },
  { value: "active", label: "Active" },
  { value: "focus", label: "Focus" },
  { value: "disabled", label: "Disabled" },
];

interface FrameProps {
  screen: PreviewScreen;
  scheme: Scheme;
  vars: PreviewVars;
  pinned: PinnedState | null;
  tokens: readonly PreviewToken[];
  replay: number;
  /** The edited token, for the `token` screen. */
  focus?: PreviewFocus | null;
  className?: string;
}

function LiveFrame({ screen, scheme, vars, pinned, tokens, replay, focus = null, className }: FrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_FRAME);
  const latest = useRef({ vars, pinned, tokens, focus });
  latest.current = { vars, pinned, tokens, focus };
  const post = (message: ToFrame): void => ref.current?.contentWindow?.postMessage(message, location.origin);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== ref.current?.contentWindow) return;
      const data = event.data as Partial<FromFrame> & { height?: unknown };
      if (data.type === "yx-preview-size" && typeof data.height === "number") setHeight(Math.min(MAX_FRAME, Math.max(MIN_FRAME, Math.ceil(data.height))));
      if (data.type === "yx-preview-ready") {
        // A frame that (re)loads gets everything it needs at once.
        post({ type: "yx-preview-tokens", tokens: latest.current.tokens });
        post({ type: "yx-preview-vars", vars: latest.current.vars });
        post({ type: "yx-preview-state", state: latest.current.pinned });
        post({ type: "yx-preview-focus", focus: latest.current.focus });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => post({ type: "yx-preview-vars", vars }), [vars]);
  useEffect(() => post({ type: "yx-preview-state", state: pinned }), [pinned]);
  useEffect(() => post({ type: "yx-preview-tokens", tokens }), [tokens]);
  useEffect(() => post({ type: "yx-preview-focus", focus }), [focus]);
  useEffect(() => {
    if (replay > 0) post({ type: "yx-preview-replay" });
  }, [replay]);

  return (
    <figure className={clsx("min-w-0 overflow-hidden rounded-lg border border-line", className)}>
      <figcaption className="flex h-7 items-center border-b border-line bg-sunken px-3 text-caption text-muted capitalize">{scheme}</figcaption>
      <iframe ref={ref} src={`${BASE}preview.html?screen=${screen}&scheme=${scheme}`} title={`Live preview, ${scheme}`} className="block w-full border-0" style={{ height }} />
    </figure>
  );
}

interface LivePreviewProps {
  vars: PreviewVars;
  tokens: readonly PreviewToken[];
  pinned: PinnedState | null;
  onPinned: (state: PinnedState | null) => void;
  screen: PreviewScreen;
  onScreen: (screen: PreviewScreen) => void;
}

export function LivePreview({ vars, tokens, pinned, onPinned, screen, onScreen }: LivePreviewProps) {
  const [phoneScheme, setPhoneScheme] = useState<Scheme>("light");
  const [replay, setReplay] = useState(0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<PreviewScreen> label="Preview screen" value={screen} onChange={onScreen} options={PREVIEW_SCREENS} wrap />
        <Segmented<StateChoice> label="Pin a state" value={pinned ?? "rest"} onChange={(value) => onPinned(value === "rest" ? null : value)} options={STATE_OPTIONS} wrap />
        {screen === "motion" && (
          <Button size="sm" onClick={() => setReplay((n) => n + 1)}>
            <Play /> Play
          </Button>
        )}
        <Segmented<Scheme> label="Scheme" value={phoneScheme} onChange={setPhoneScheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} className="md:hidden" />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {(["light", "dark"] as const).map((scheme) => (
          <LiveFrame key={`${screen}:${scheme}`} screen={screen} scheme={scheme} vars={vars} pinned={pinned} tokens={tokens} replay={replay} className={clsx(scheme !== phoneScheme && "max-md:hidden")} />
        ))}
      </div>
    </div>
  );
}

interface MiniPreviewProps extends LivePreviewProps {
  /** The token last edited, with its direct uses: the `token` screen draws them. */
  focus: PreviewFocus | null;
}

/** True while the element's content is taller than its box, so it scrolls. */
function useOverflow<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [overflows, setOverflows] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null): void => {
    observer.current?.disconnect();
    if (!node) return;
    const check = (): void => setOverflows(node.scrollHeight > node.clientHeight + 1);
    observer.current = new ResizeObserver(check);
    observer.current.observe(node);
    if (node.firstElementChild) observer.current.observe(node.firstElementChild);
  }, []);
  return [ref, overflows];
}

/**
 * The phone preview: light beside dark, pinned under the header while the token cards scroll
 * beneath it, so an edit shows without scrolling away from the field. An edit turns it to the
 * edited token: each direct use drawn as a sample (text, surfaces, borders, corners, gaps),
 * then the components that bind it. One row of controls (screen, pinned state, replay, a taller
 * view, a fold). The frames are inert; when they are taller than the strip, the strip itself
 * scrolls, by touch or, once focused, by the arrow keys, light and dark together.
 */
export function MiniPreview({ vars, tokens, pinned, onPinned, screen, onScreen, focus }: MiniPreviewProps) {
  const [open, setOpen] = useState(true);
  const [tall, setTall] = useState(false);
  const [replay, setReplay] = useState(0);
  const framesId = useId();
  const [scrollRef, overflows] = useOverflow<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement | null>(null);
  const setScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scroller.current = node;
      scrollRef(node);
    },
    [scrollRef],
  );
  const screens = focus ? [...PREVIEW_SCREENS, { value: "token" as const, label: "Edited" }] : PREVIEW_SCREENS;
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [screen, focus?.path]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <select aria-label="Preview screen" value={screen} onChange={(event) => onScreen(event.target.value as PreviewScreen)} className={clsx(INPUT, "h-8 min-w-0 flex-1 pr-7")}>
          {screens.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select aria-label="Pin a state" value={pinned ?? "rest"} onChange={(event) => onPinned(event.target.value === "rest" ? null : (event.target.value as PinnedState))} className={clsx(INPUT, "h-8 w-[6.5rem] shrink-0 pr-7")}>
          {STATE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {screen === "motion" && (
          <Button size="icon" aria-label="Play the motion" title="Play the motion" onClick={() => setReplay((n) => n + 1)}>
            <Play />
          </Button>
        )}
        {open && (overflows || tall) && (
          <Button size="icon" variant="ghost" className="shrink-0" aria-pressed={tall} aria-controls={framesId} aria-label="Taller preview" title={tall ? "Shorter preview" : "Taller preview"} onClick={() => setTall((v) => !v)}>
            {tall ? <Minimize2 /> : <Maximize2 />}
          </Button>
        )}
        <Button size="icon" variant="ghost" className="shrink-0" aria-expanded={open} aria-controls={framesId} aria-label={open ? "Fold the preview" : "Show the preview"} title={open ? "Fold the preview" : "Show the preview"} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>
      <div
        id={framesId}
        hidden={!open}
        ref={setScroller}
        // Focusable only when there is something to scroll to, so Tab otherwise goes straight to the editor.
        tabIndex={overflows ? 0 : undefined}
        role={overflows ? "region" : undefined}
        aria-label={overflows ? "Preview, scrolls with the arrow keys" : undefined}
        className={clsx("overflow-y-auto overscroll-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus", tall ? "max-h-[60dvh]" : "max-h-[24vh]")}
      >
        <div inert className="grid grid-cols-2 gap-2">
          {(["light", "dark"] as const).map((scheme) => (
            <LiveFrame key={`${screen}:${scheme}`} screen={screen} scheme={scheme} vars={vars} pinned={pinned} tokens={tokens} replay={replay} focus={focus} />
          ))}
        </div>
      </div>
    </div>
  );
}
