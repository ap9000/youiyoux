/**
 * Components on a captured screen (youiyoux.places/v1, from `youiyoux screens capture`), matched
 * to the usage map: a component whose rendering line is a site of a System element is that
 * element; one rendered where the map found a lookalike (a local component named like an
 * element) is that lookalike; any other is the project's own component at its file and line.
 * The picture is drawn at the page's width, so a box is placed as a share of the page's size.
 */
import { useEffect, useState } from "react";
import type { ElementId } from "@youiyoux/core";
import { append } from "../lib/append.ts";
import { loadPlaces } from "./load.ts";
import type { PlacedComponent, PlacesFile } from "./types.ts";
import type { ProjectLookalike, Site } from "./usage.ts";

export interface Placed {
  readonly place: PlacedComponent;
  /** The System element this is, when its line is one of the element's sites. */
  readonly element: ElementId | null;
  readonly site: Site | null;
  /** The element a hand-built lookalike stands in for, when this is one. */
  readonly lookalike: ElementId | null;
  /** `file:line`, or null when the capture could not find its line. */
  readonly at: string | null;
}

const atOf = (place: Pick<PlacedComponent, "file" | "line">): string | null => (place.file && place.line ? `${place.file}:${place.line}` : null);

/**
 * Each place with the site it renders, if any. A site matches on its file and line and the name it
 * is rendered by (`<Button>` is `Button`, a renamed import is its local name, a part its export).
 */
export function matchPlaces(places: readonly PlacedComponent[], sites: readonly Site[], lookalikes: readonly ProjectLookalike[] = []): Placed[] {
  const byLine = new Map<string, Site[]>();
  for (const site of sites) {
    if (site.kind !== "render") continue;
    append(byLine, `${site.file}:${site.line}`, site);
  }
  const lookalikeAt = new Map(lookalikes.map((l) => [`${l.file}:${l.line}:${l.local}`, l.resembles]));
  return places.map((place) => {
    const at = atOf(place);
    const candidates = at ? (byLine.get(at) ?? []) : [];
    const site = candidates.find((s) => s.local === place.name || s.export === place.name || s.local.endsWith(`.${place.name}`)) ?? null;
    const lookalike = !site && at ? (lookalikeAt.get(`${at}:${place.name}`) ?? null) : null;
    return { place, element: site?.element ?? null, site, lookalike, at };
  });
}

/** Whether a placed component is what `select` names: an element id (its uses and its lookalikes), or `file:line`. */
export const isSelected = (placed: Placed, select: string | null): boolean => select !== null && (placed.element === select || placed.lookalike === select || placed.at === select);

/** The System element a placed component is, or stands in for. */
export const elementOf = (placed: Placed): ElementId | null => placed.element ?? placed.lookalike;

/** Among picks that share a line (`<DropdownMenuTrigger asChild><Button>`): the System element first, then the innermost. */
export const pickOrder = (a: Placed, b: Placed): number => Number(elementOf(b) !== null) - Number(elementOf(a) !== null) || b.place.depth - a.place.depth;

/**
 * The component under a point (page pixels): the smallest box holding it, so a button inside a
 * card is the button. `among` narrows what counts (the System elements only, say).
 */
export function hitAt(placed: readonly Placed[], x: number, y: number, among: (p: Placed) => boolean = () => true): Placed | null {
  let best: Placed | null = null;
  let bestArea = Infinity;
  for (const p of placed) {
    const { box } = p.place;
    if (x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height || !among(p)) continue;
    const area = box.width * box.height;
    if (area < bestArea || (area === bestArea && best !== null && p.place.depth > best.place.depth)) {
      best = p;
      bestArea = area;
    }
  }
  return best;
}

type PlacesState = { status: "loading" } | { status: "ready"; value: PlacesFile } | { status: "error"; message: string };

/** A screen's places, loaded when it has some. */
export function usePlaces(file: string | undefined): PlacesState | null {
  const [state, setState] = useState<{ file: string; state: PlacesState } | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setState({ file, state: { status: "loading" } });
    loadPlaces(file).then(
      (value) => !cancelled && setState({ file, state: { status: "ready", value } }),
      (error: unknown) => !cancelled && setState({ file, state: { status: "error", message: error instanceof Error ? error.message : String(error) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [file]);
  return file && state?.file === file ? state.state : null;
}
