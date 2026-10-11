/** A captured screen: the thumbnail or full image in the asked scheme, or an honest placeholder when none exists. */
import { clsx } from "clsx";
import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { Scheme } from "../app/theme.tsx";
import type { ScreenShot } from "../data/types.ts";

const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
/** Desktop capture proportions, used until a project records its own viewport. */
const DEFAULT_RATIO = 16 / 10;

export const shotUrl = (file: string): string => `${DATA_BASE}${file}`;

/** The image file for a scheme, falling back to the other scheme rather than to nothing. */
export function shotFile(shot: ScreenShot | null, scheme: Scheme, size: "thumb" | "full"): { file: string; scheme: Scheme } | null {
  if (!shot) return null;
  const other: Scheme = scheme === "light" ? "dark" : "light";
  const files = shot[scheme] ?? shot[other];
  if (!files) return null;
  return { file: files[size], scheme: shot[scheme] ? scheme : other };
}

interface ScreenImageProps {
  shot: ScreenShot | null;
  scheme: Scheme;
  size: "thumb" | "full";
  /** What the picture shows, for the alt text and the placeholder. */
  label: string;
  ratio?: number;
  className?: string;
}

export function ScreenImage({ shot, scheme, size, label, ratio = DEFAULT_RATIO, className }: ScreenImageProps) {
  const picked = shotFile(shot, scheme, size);
  const [failed, setFailed] = useState<string | null>(null);
  const missing = !picked || failed === picked.file;
  return (
    <div className={clsx("relative overflow-hidden bg-sunken", className)} style={{ aspectRatio: ratio }}>
      {missing ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center">
          <div className="flex flex-col items-center gap-1.5 text-muted">
            <ImageOff aria-hidden className={size === "full" ? "size-5" : "size-4"} />
            <span className={size === "full" ? "text-body" : "text-small"}>{picked ? "Screenshot didn't load" : "No screenshot yet"}</span>
            {size === "full" && !picked && <span className="max-w-xs text-small text-faint">Capture this route with scripts/capture-screens.ts against a demo or seeded instance, then run pnpm data.</span>}
          </div>
        </div>
      ) : (
        <img
          key={picked.file}
          src={shotUrl(picked.file)}
          alt={`${label}${picked.scheme === scheme ? "" : ` (${picked.scheme} only)`}`}
          loading={size === "thumb" ? "lazy" : "eager"}
          decoding="async"
          onError={() => setFailed(picked.file)}
          className="absolute inset-0 size-full object-cover object-top"
        />
      )}
    </div>
  );
}
