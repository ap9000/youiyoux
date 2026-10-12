/**
 * Near-duplicates side by side. A compare card lays one side's specimen over the other's and a
 * slider wipes between them (the top layer, side B, clipped by `clip-path: inset(0 0 0 X%)`, so
 * side A shows left of the handle and B right of it, as the table reads), or shows
 * them next to each other, over a table of their attributes with the differing rows marked. A
 * fix card shows every side's specimen, the files to change, and a Merge button that stays off:
 * the hub reads projects, it never edits them.
 */
import { clsx } from "clsx";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Scheme } from "../../app/theme.tsx";
import type { InventorySource } from "../../data/inventory-source.ts";
import { attributeRows, clipInset, compareSides, sideShape, sliderPercent, type FamilyView, type Libraries } from "../../data/inventory-view.ts";
import type { InventoryChunk, InventoryFamily } from "../../data/types.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { familyTiles, leadTile } from "./family-tiles.ts";
import { LARGE_TILE_HEIGHT, SpecimenTile } from "./Specimens.tsx";

type Side = InventoryFamily["sides"][number];

interface CardProps {
  view: FamilyView;
  chunks: readonly InventoryChunk[];
  source: InventorySource;
  scheme: Scheme;
  libraries: Libraries;
}

const sideLabel = (side: Side, libraries: Libraries): string => `${side.project} · ${libraries.primary(side.kit).label}`;
const sideKey = (family: InventoryFamily, side: Side): string => `${family.id}:${side.project}:${side.kit ?? "plain"}`;

function sideTile({ view, chunks, source, scheme }: CardProps, side: Side, prefix: string) {
  const tiles = familyTiles(view.family, chunks, source, scheme, (project, kit) => project === side.project && kit === side.kit);
  return leadTile(tiles, view.family, `${prefix}:${sideKey(view.family, side)}`);
}

export const compareAnchor = (family: string): string => `compare-${family}`;
export const fixAnchor = (family: string): string => `fix-${family}`;

/** Step for the arrow keys; Page Up/Down move ten times as far. */
const STEP = 5;

export function CompareCard(props: CardProps) {
  const { view, libraries } = props;
  const pair = compareSides(view.family);
  const [mode, setMode] = useState<"overlay" | "side">("overlay");
  const [percent, setPercent] = useState(50);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  if (!pair) return null;
  const [a, b] = pair;
  const tileA = sideTile(props, a, "compare-a");
  const tileB = sideTile(props, b, "compare-b");
  const rows = attributeRows({ shape: sideShape(a, view.looks, view.family.shape), uses: a.looks, projects: [a.project] }, { shape: sideShape(b, view.looks, view.family.shape), uses: b.looks, projects: [b.project] });

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
    <article id={compareAnchor(view.family.id)} aria-labelledby={`${compareAnchor(view.family.id)}-title`} className="min-w-0 scroll-mt-4 space-y-3 rounded-lg border border-line bg-surface p-4" data-compare={view.family.id}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={`${compareAnchor(view.family.id)}-title`} className="text-heading text-ink">
          {view.name}
        </h3>
        <Badge tone="warning">Built {view.family.sides.length} ways</Badge>
        <Segmented
          className="ml-auto"
          label="Compare as"
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
            <span className="truncate">← {sideLabel(a, libraries)}</span>
            <span className="truncate">{sideLabel(b, libraries)} →</span>
          </div>
          {/* Narrow, so the specimens (drawn at their real size) fill enough of it to wipe across. */}
          <div ref={boxRef} className="relative mx-auto max-w-80 touch-none select-none overflow-hidden rounded-md" style={{ height: LARGE_TILE_HEIGHT }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} data-testid="compare-stage">
            <div className="absolute inset-0" data-layer="bottom">
              <SpecimenTile tile={tileA} scheme={props.scheme} size="large" as="div" caption={false} />
            </div>
            <div className="absolute inset-0" data-layer="top" style={{ clipPath: clipInset(percent) }}>
              <SpecimenTile tile={tileB} scheme={props.scheme} size="large" as="div" caption={false} />
            </div>
            <div
              role="slider"
              tabIndex={0}
              aria-label={`Wipe between ${sideLabel(a, libraries)} and ${sideLabel(b, libraries)}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${Math.round(percent)}% from the left`}
              onKeyDown={onKeyDown}
              className="absolute inset-y-0 w-6 -translate-x-1/2 cursor-ew-resize outline-none focus-visible:[&>span]:bg-focus"
              style={{ left: `${percent}%` }}
            >
              <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent" />
              <span aria-hidden className="absolute top-1/2 left-1/2 size-4 -translate-1/2 rounded-full border-2 border-surface bg-accent shadow-raise" />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3" data-testid="compare-side-by-side">
          {[
            { side: a, tile: tileA },
            { side: b, tile: tileB },
          ].map(({ side, tile }) => (
            <div key={sideKey(view.family, side)} className="min-w-0 space-y-1.5">
              <p className="truncate text-caption text-muted">{sideLabel(side, libraries)}</p>
              <SpecimenTile tile={tile} scheme={props.scheme} size="large" as="div" caption={false} />
            </div>
          ))}
        </div>
      )}
      <table className="w-full border-collapse text-left text-small" aria-label="Attributes">
        <thead>
          <tr className="border-b border-line text-muted">
            <th scope="col" className="h-8 pr-3 font-medium">
              Attribute
            </th>
            <th scope="col" className="h-8 pr-3 font-medium">
              {sideLabel(a, libraries)}
            </th>
            <th scope="col" className="h-8 font-medium">
              {sideLabel(b, libraries)}
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
      {view.family.sides.length > 2 && <p className="text-caption text-muted">{view.family.sides.length - 2} more ways to build it are in its fix below.</p>}
    </article>
  );
}

/** Each place a fix touches: the files of its looks, else of its examples. */
function fixFiles(view: FamilyView): string[] {
  const files = view.looks.length > 0 ? view.looks.map((l) => `${l.project}:${l.file}`) : view.family.sides.flatMap((s) => s.examples.map((e) => `${e.project}:${e.file}`));
  return [...new Set(files)].sort();
}

export function FixCard(props: CardProps) {
  const { view, libraries } = props;
  const files = fixFiles(view);
  const reason = `${fixAnchor(view.family.id)}-reason`;
  return (
    <li id={fixAnchor(view.family.id)} className="min-w-0 scroll-mt-4 space-y-3 rounded-lg border border-line bg-surface p-4" data-fix={view.family.id}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-heading text-ink">{view.name}</h3>
        <span className="tabular text-small text-muted">
          {view.uses} {view.uses === 1 ? "use" : "uses"} · built {view.family.sides.length} ways in {view.projects} {view.projects === 1 ? "project" : "projects"}
        </span>
      </header>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 max-md:grid-cols-2" aria-label="Ways it is built">
        {view.family.sides.map((side) => (
          <li key={sideKey(view.family, side)} className="min-w-0 space-y-1">
            <SpecimenTile tile={sideTile(props, side, "fix")} scheme={props.scheme} as="div" caption={false} />
            <p className="truncate text-caption text-muted" title={sideLabel(side, libraries)}>
              <span className="font-medium text-ink-2">{side.project}</span> · {libraries.primary(side.kit).label} · {side.looks} {side.looks === 1 ? "use" : "uses"}
            </p>
          </li>
        ))}
      </ul>
      <div className="space-y-1">
        <p className="text-small text-muted">
          {files.length} {files.length === 1 ? "file" : "files"} to change
        </p>
        <ul className="space-y-0.5">
          {files.map((file) => (
            <li key={file}>
              <code className="font-mono text-mono-sm break-all text-ink-2">{file}</code>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled aria-describedby={reason}>
          Merge into one
        </Button>
        <span id={reason} className="text-small text-muted">
          Not available yet: the hub reads your projects and never changes them.
        </span>
      </div>
    </li>
  );
}
