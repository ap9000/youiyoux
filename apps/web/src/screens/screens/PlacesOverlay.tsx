/**
 * A captured screen with its components on it: each System element outlined (lookalikes in the
 * warning colour), or every component under the pointer, or none; the one under the pointer is
 * named, and a click picks it out. What is picked lives in the
 * address (`?select=<element id>` or `?select=<file:line>`), so an element's page links straight
 * to it here, and every box it has on this screen is lit. Boxes are placed as shares of the page's
 * size, so they stay on their component at any width.
 */
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { elementOf, hitAt, isSelected, type Placed } from "../../data/places.ts";
import type { PlacesFile, ScreenShot } from "../../data/types.ts";
import { ScreenImage } from "../../ui/ScreenImage.tsx";

export type Outline = "elements" | "all" | "off";

interface Props {
  shot: ScreenShot | null;
  scheme: Scheme;
  label: string;
  places: PlacesFile;
  placed: readonly Placed[];
  outline: Outline;
  select: string | null;
  /** An element the side list points at (hovered or focused there). */
  pointed: string | null;
  nameOf: (placed: Placed) => string;
  onSelect: (placed: Placed | null) => void;
}

const pct = (value: number, of: number): string => `${(value / of) * 100}%`;

export function PlacesOverlay({ shot, scheme, label, places, placed, outline, select, pointed, nameOf, onSelect }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Placed | null>(null);
  const { size } = places;
  const counts = outline === "elements" ? (p: Placed) => elementOf(p) !== null : () => true;
  // Every component outlined at once is noise: "all" names each one under the pointer only.
  const shown = outline === "elements" ? placed.filter(counts) : [];
  const lit = placed.filter((p) => isSelected(p, select) || (pointed !== null && elementOf(p) === pointed));

  // Opened with something picked (from an element's page): bring its first box into view.
  const first = useRef<string | null>(null);
  useEffect(() => {
    if (!select || first.current === select) return;
    const target = layer.current?.querySelector<HTMLElement>("[data-place-lit]");
    if (!target) return;
    first.current = select;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [select, lit.length]);

  const pointAt = (event: { clientX: number; clientY: number }): Placed | null => {
    const rect = layer.current!.getBoundingClientRect();
    return hitAt(placed, ((event.clientX - rect.left) / rect.width) * size.width, ((event.clientY - rect.top) / rect.height) * size.height, outline === "elements" ? counts : undefined);
  };

  const box = (p: Placed, kind: "shown" | "hover" | "lit", key: string) => (
    <div
      key={key}
      data-place={elementOf(p) ?? p.at ?? p.place.name}
      {...(p.lookalike ? { "data-lookalike": "" } : {})}
      {...(kind === "lit" ? { "data-place-lit": "" } : {})}
      className={clsx(
        "pointer-events-none absolute rounded-[3px]",
        kind === "shown" && (p.element ? "outline-1 -outline-offset-1 outline-accent/50 outline-dashed" : "outline-1 -outline-offset-1 outline-warning/70 outline-dashed"),
        kind === "hover" && "bg-accent/8 outline-2 -outline-offset-1 outline-accent outline-solid",
        kind === "lit" && "bg-accent/12 outline-2 -outline-offset-1 outline-accent outline-solid",
      )}
      style={{ left: pct(p.place.box.x, size.width), top: pct(p.place.box.y, size.height), width: pct(p.place.box.width, size.width), height: pct(p.place.box.height, size.height) }}
    />
  );

  return (
    <div className="relative">
      <ScreenImage shot={shot} scheme={scheme} size="full" label={label} ratio={size.width / size.height} />
      <div
        ref={layer}
        className={clsx("absolute inset-0", outline !== "off" && "cursor-crosshair")}
        data-places-layer
        onPointerMove={(event) => outline !== "off" && setHover(pointAt(event))}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => outline !== "off" && onSelect(pointAt(event))}
      >
        {shown.map((p, i) => box(p, "shown", `s${i}`))}
        {lit.map((p, i) => box(p, "lit", `l${i}`))}
        {hover && !lit.includes(hover) && box(hover, "hover", "hover")}
        {hover && (
          <span
            className="pointer-events-none absolute z-10 max-w-[60%] -translate-y-full truncate rounded-xs bg-ink px-1.5 py-0.5 font-mono text-mono-sm text-canvas shadow-raise"
            style={{ left: pct(hover.place.box.x, size.width), top: pct(hover.place.box.y, size.height) }}
            data-place-label
          >
            {nameOf(hover)}
          </span>
        )}
      </div>
    </div>
  );
}
