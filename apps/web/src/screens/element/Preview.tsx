/**
 * The preview stage: a captured image until someone interacts, then the real component,
 * rendered in the system's own tokens inside an isolated frame (preview.html).
 */
import { clsx } from "clsx";
import { MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import type { ComponentContract } from "../../data/types.ts";
import { Segmented } from "../../ui/Segmented.tsx";

type Width = "desk" | "phone";

const BASE = import.meta.env.BASE_URL;
const MIN_FRAME = 120;
const MAX_FRAME = 1600;
const INITIAL_FRAME = 240;

export const previewImage = (name: string, scheme: Scheme): string => `${BASE}previews/${name}.${scheme}.webp`;
const frameUrl = (name: string, scheme: Scheme): string => `${BASE}preview.html?c=${encodeURIComponent(name)}&scheme=${scheme}`;

function prefetchFrame(): void {
  if (document.querySelector("link[data-preview-prefetch]")) return;
  const link = Object.assign(document.createElement("link"), { rel: "prefetch", href: `${BASE}preview.html` });
  link.dataset.previewPrefetch = "";
  document.head.append(link);
}

function PreviewFrame({ name, scheme, width }: { name: string; scheme: Scheme; width: Width }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_FRAME);
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  // The src keeps the first scheme; later changes are posted in, so the frame never reloads.
  const [src] = useState(() => frameUrl(name, scheme));

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== ref.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown };
      if (data.type === "yx-preview-size" && typeof data.height === "number") setHeight(Math.min(MAX_FRAME, Math.max(MIN_FRAME, Math.ceil(data.height))));
      if (data.type === "yx-preview-ready") ref.current?.contentWindow?.postMessage({ type: "yx-preview-scheme", scheme: schemeRef.current }, location.origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ type: "yx-preview-scheme", scheme }, location.origin);
  }, [scheme]);

  return (
    <div className={clsx("mx-auto transition-[width] duration-200 ease-out", width === "phone" ? "w-[390px] max-w-full border-x border-line" : "w-full")}>
      <iframe ref={ref} src={src} title={`${name} live preview`} className="block w-full border-0" style={{ height }} />
    </div>
  );
}

interface PreviewProps {
  name: string;
  contract: ComponentContract;
  /** The system's paper per scheme: the snapshot and the live frame sit on it, so swapping them never shifts. */
  paper: Readonly<Record<Scheme, string>>;
}

export function Preview({ name, contract, paper }: PreviewProps) {
  const { scheme: hubScheme } = useTheme();
  const [scheme, setScheme] = useState<Scheme>(hubScheme);
  const [width, setWidth] = useState<Width>("desk");
  const [live, setLive] = useState(false);
  const [imageMissing, setImageMissing] = useState(false);
  const showImage = !live && !imageMissing && width === "desk";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Scheme> label="Colour scheme" value={scheme} onChange={setScheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <Segmented<Width> label="Width" value={width} onChange={setWidth} options={[{ value: "desk", label: "Desk" }, { value: "phone", label: "Phone" }]} />
        <span className="ml-auto text-small text-muted">{showImage ? "Snapshot. Click to interact." : "Live: the owned component in its system's tokens."}</span>
      </div>
      <div className="grid min-h-64 place-items-center overflow-hidden rounded-lg border border-line" style={{ background: paper[scheme] }}>
        {showImage ? (
          <button
            type="button"
            onClick={() => setLive(true)}
            onPointerEnter={prefetchFrame}
            onFocus={prefetchFrame}
            aria-label={`Interact with the live ${contract.name} preview`}
            className="group relative block w-full cursor-pointer"
          >
            <img
              src={previewImage(name, scheme)}
              srcSet={`${previewImage(name, scheme)} 2x`}
              alt={`${contract.name} in ${scheme} scheme`}
              decoding="async"
              onError={() => setImageMissing(true)}
              className="block h-auto max-w-full"
            />
            <span className="absolute inset-0 grid place-items-center transition-colors duration-150 group-hover:bg-scrim/5">
              <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-small font-medium text-ink opacity-0 shadow-popover transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                <MousePointerClick className="size-3.5" /> Click to interact
              </span>
            </span>
          </button>
        ) : (
          <PreviewFrame name={name} scheme={scheme} width={width} />
        )}
      </div>
    </div>
  );
}
