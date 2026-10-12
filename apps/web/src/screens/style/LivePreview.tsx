/**
 * The live preview: the system's own components and specimen screens, rendered in its tokens in
 * isolated frames (preview.html), light beside dark. Unsaved edits arrive as CSS-variable
 * overrides and a pinned state over postMessage, so the frames never reload while editing.
 */
import { clsx } from "clsx";
import { ChevronDown, ChevronUp, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { PinnedState } from "../../preview/pin.ts";
import { PREVIEW_SCREENS, type FromFrame, type PreviewScreen, type PreviewToken, type PreviewVars, type ToFrame } from "../../preview/protocol.ts";
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
  className?: string;
}

function LiveFrame({ screen, scheme, vars, pinned, tokens, replay, className }: FrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_FRAME);
  const latest = useRef({ vars, pinned, tokens });
  latest.current = { vars, pinned, tokens };
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
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => post({ type: "yx-preview-vars", vars }), [vars]);
  useEffect(() => post({ type: "yx-preview-state", state: pinned }), [pinned]);
  useEffect(() => post({ type: "yx-preview-tokens", tokens }), [tokens]);
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

/**
 * The phone preview: light beside dark at a reduced height, pinned under the header while the
 * token cards scroll beneath it, so an edit shows without scrolling away from the field. One
 * row of controls (screen, pinned state, replay) and a toggle that folds it to that row. The
 * frames are a glance view, inert, so Tab goes from these controls straight to the editor.
 */
export function MiniPreview({ vars, tokens, pinned, onPinned, screen, onScreen }: LivePreviewProps) {
  const [open, setOpen] = useState(true);
  const [replay, setReplay] = useState(0);
  const framesId = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <select aria-label="Preview screen" value={screen} onChange={(event) => onScreen(event.target.value as PreviewScreen)} className={clsx(INPUT, "h-8 min-w-0 flex-1 pr-7")}>
          {PREVIEW_SCREENS.map((option) => (
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
        <Button size="icon" variant="ghost" className="shrink-0" aria-expanded={open} aria-controls={framesId} aria-label={open ? "Fold the preview" : "Show the preview"} title={open ? "Fold the preview" : "Show the preview"} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>
      <div id={framesId} hidden={!open} inert className="grid grid-cols-2 gap-2">
        {(["light", "dark"] as const).map((scheme) => (
          <div key={`${screen}:${scheme}`} className="max-h-[24vh] min-w-0 overflow-hidden rounded-lg">
            <LiveFrame screen={screen} scheme={scheme} vars={vars} pinned={pinned} tokens={tokens} replay={replay} />
          </div>
        ))}
      </div>
    </div>
  );
}
