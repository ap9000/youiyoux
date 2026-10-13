/**
 * A pinned inventory family beside each opened candidate (Discover opened from an Inventory
 * family's Find alternatives). As the Inventory's compare card: the candidate laid over the
 * family's lead specimen with a slider wiping between them (pointer and keyboard; the top layer,
 * the candidate, clipped by `clip-path: inset(0 0 0 X%)`), or the two side by side, over a table
 * of their attributes with the differing rows marked.
 */
import { clsx } from "clsx";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { ROLE_LABEL } from "../../data/inventory.ts";
import { clipInset, sliderPercent } from "../../data/inventory-view.ts";
import { useDrawn, type PreviewAnswer } from "../../data/discover-preview.ts";
import type { InventoryFamily } from "../../data/types.ts";
import { Segmented } from "../../ui/Segmented.tsx";
import { LARGE_TILE_HEIGHT, LeadTile, SpecimenTile, type Tile } from "../inventory/Specimens.tsx";
import { candidateTile } from "./candidate.tsx";

/** Step for the arrow keys; Page Up/Down move ten times as far (as Compare.tsx). */
const STEP = 5;

const px = (n: number | null | undefined): string => (n === null || n === undefined ? "?" : n === 9999 ? "pill" : `${n}px`);

/** The pinned family and the candidate, attribute by attribute: role, radius, type size, padding, colours, licence, source. */
export function pinnedRows(family: Pick<InventoryFamily, "role" | "shape" | "projects">, answer: Pick<PreviewAnswer, "fit" | "license" | "entry" | "name">, role: string | null): Array<{ label: string; a: string; b: string; differs: boolean }> {
  const shape = family.shape;
  const colourGaps = answer.fit.unthemed.filter((line) => /--color-|fixed colours/.test(line)).length;
  const rows: Array<[string, string, string]> = [
    ["Role", ROLE_LABEL[family.role], role ?? "not given"],
    ["Radius", px(shape.radius), px(answer.fit.radius)],
    ["Type size", px(shape.fontSize), px(answer.fit.type.item)],
    ["Padding", shape.paddingY === null && shape.paddingX === null ? "?" : `${px(shape.paddingY)} ${px(shape.paddingX)}`, "not measured"],
    ["Colours", "your tokens", colourGaps === 0 ? "your tokens" : "some not in your theme"],
    ["Licence", "yours", answer.license === "unknown" ? "licence unknown" : answer.license],
    ["Source", family.projects.join(", "), answer.entry.source.ref ?? answer.name],
  ];
  return rows.map(([label, a, b]) => ({ label, a, b, differs: a !== b }));
}

export function PinnedCompare({ family, familyName, familyTiles, answer, scheme, role }: { family: InventoryFamily; familyName: string; familyTiles: readonly Tile[]; answer: PreviewAnswer; scheme: Scheme; role: string | null }) {
  const html = useDrawn(answer.id);
  const [mode, setMode] = useState<"overlay" | "side">("overlay");
  const [percent, setPercent] = useState(50);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const tile = candidateTile(answer, html, scheme, `${answer.id}:compare`);
  const rows = pinnedRows(family, answer, role);
  const a = familyName;
  const b = answer.entry.source.ref ?? answer.name;

  const moveTo = (x: number): void => {
    const box = boxRef.current?.getBoundingClientRect();
    if (box) setPercent(sliderPercent(x, box.left, box.width));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = event.pointerId;
    moveTo(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current === event.pointerId) moveTo(event.clientX);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current === event.pointerId) dragging.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = { ArrowLeft: percent - STEP, ArrowDown: percent - STEP, ArrowRight: percent + STEP, ArrowUp: percent + STEP, PageDown: percent - 10 * STEP, PageUp: percent + 10 * STEP, Home: 0, End: 100 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPercent(Math.min(100, Math.max(0, next)));
  };

  return (
    <article aria-labelledby={`pinned-${answer.id}`} className="min-w-0 space-y-3 rounded-lg border border-line bg-surface p-4" data-pinned-compare={answer.id}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={`pinned-${answer.id}`} className="min-w-0 truncate text-heading text-ink">
          {a} <span className="text-muted">vs</span> {b}
        </h3>
        <Segmented
          className="ml-auto"
          label="Compare as"
          touch
          value={mode}
          onChange={setMode}
          options={[
            { value: "overlay", label: "Overlay" },
            { value: "side", label: "Side by side" },
          ]}
        />
      </header>
      {mode === "overlay" ? (
        <div className="space-y-1.5">
          <div className="mx-auto flex max-w-80 justify-between gap-3 text-caption text-muted">
            <span className="truncate">← yours</span>
            <span className="truncate">{b} →</span>
          </div>
          <div ref={boxRef} className="relative mx-auto max-w-80 touch-none select-none overflow-hidden rounded-md" style={{ height: LARGE_TILE_HEIGHT }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} data-testid="pinned-stage">
            <div className="absolute inset-0" data-layer="bottom">
              <LeadTile tiles={familyTiles} scheme={scheme} size="large" as="div" caption={false} />
            </div>
            <div className="absolute inset-0" data-layer="top" style={{ clipPath: clipInset(percent) }}>
              <SpecimenTile tile={tile} scheme={scheme} size="large" as="div" caption={false} />
            </div>
            <div
              role="slider"
              tabIndex={0}
              aria-label={`Wipe between ${a} and ${b}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${Math.round(percent)}% from the left`}
              onKeyDown={onKeyDown}
              className="absolute inset-y-0 w-6 -translate-x-1/2 cursor-ew-resize rounded-md outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid focus-visible:[&>span]:bg-focus max-md:w-11"
              style={{ left: `${percent}%` }}
            >
              <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent" />
              <span aria-hidden className="absolute top-1/2 left-1/2 size-4 -translate-1/2 rounded-full border-2 border-surface bg-accent shadow-raise" />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3" data-testid="pinned-side-by-side">
          <div className="min-w-0 space-y-1.5">
            <p className="truncate text-caption text-muted">Yours</p>
            <LeadTile tiles={familyTiles} scheme={scheme} size="large" as="div" caption={false} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="truncate text-caption text-muted">{b}</p>
            <SpecimenTile tile={tile} scheme={scheme} size="large" as="div" caption={false} />
          </div>
        </div>
      )}
      <table className="w-full border-collapse text-left text-small" aria-label="Attributes">
        <thead>
          <tr className="border-b border-line text-muted">
            <th scope="col" className="h-8 pr-3 font-medium">
              Attribute
            </th>
            <th scope="col" className="h-8 pr-3 font-medium">
              Yours
            </th>
            <th scope="col" className="h-8 font-medium">
              {b}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} data-differs={row.differs || undefined} className={clsx("border-b border-line last:border-0", row.differs && "bg-warning-soft")}>
              <th scope="row" className={clsx("py-1.5 pr-3 font-normal", row.differs ? "text-warning" : "text-muted")}>
                {row.label}
                {row.differs && <span className="sr-only"> (differs)</span>}
              </th>
              <td className="tabular py-1.5 pr-3 text-ink">{row.a}</td>
              <td className="tabular py-1.5 text-ink">{row.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
