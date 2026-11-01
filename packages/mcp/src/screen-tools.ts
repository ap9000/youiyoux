/**
 * What an agent reads before it puts options on the Screens canvas: the captured screens, and one
 * screen's components (its name as the page knows it, its file and line, its box on the picture,
 * and for a System element the choices its contract gives). The places come from the capture
 * (`<slug>.places.json`); which element a place is comes from the scan's render sites at that
 * file and line, never from what an agent says.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentContract, ElementId, UsageSite } from "@youiyoux/core";
import { readScreensSpec, screenSlug, type PlacesFile, type Place } from "@youiyoux/scanner";
import { contractChoices } from "@youiyoux/workflow";

/** Components listed per screen: the page's own, each file:line once. */
export const COMPONENTS_AT_MOST = 80;

export interface ScreenComponent {
  readonly name: string;
  readonly element: ElementId | null;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly box: Place["box"];
  /** How many times this line renders on the screen (a list's rows): the box is the first. */
  readonly count: number;
  /** For a System element: each prop its contract lets an option set, with its values and default. */
  readonly choices?: Record<string, { type: string; values?: readonly string[]; default?: unknown }>;
}

/** The contract's props an option may set: values, not functions or slots, and not deprecated. */
export function choicesOf(contract: ComponentContract): NonNullable<ScreenComponent["choices"]> {
  return contractChoices(contract);
}

export function screensDir(root: string): string {
  return join(root, ".youi/screens");
}

/** A screen's places as captured, or why there are none. */
export function placesOf(root: string, route: string): PlacesFile | { error: string } {
  const dir = screensDir(root);
  if (!existsSync(join(dir, "screens.json"))) return { error: `no screens are captured in ${dir}: a person captures them first (youiyoux screens capture --base <url>)` };
  const spec = readScreensSpec(dir);
  if (!spec.screens.some((s) => s.route === route)) return { error: `screens.json has no route ${route}: screens_list names the captured ones` };
  const file = join(dir, `${screenSlug(route)}.places.json`);
  if (!existsSync(file)) return { error: `${route} has no placed components yet: screens_capture captures it again` };
  return JSON.parse(readFileSync(file, "utf8")) as PlacesFile;
}

/**
 * The element a place is: the scan's render site at its file and line that names it (as the hub
 * matches them). A component a line also places (a wrapper, a provider) is not that element.
 */
export function elementAt(usages: readonly UsageSite[], place: Pick<Place, "name" | "file" | "line">): ElementId | null {
  if (!place.file || !place.line) return null;
  const named = (u: UsageSite): boolean => u.local === place.name || u.export === place.name || u.local.endsWith(`.${place.name}`);
  return usages.find((u) => u.kind === "render" && u.file === place.file && u.line === place.line && named(u))?.element ?? null;
}

/** One screen's components, each file:line once, React's own (HTML a server writes can't be edited in place). */
export function screenComponents(places: PlacesFile, usages: readonly UsageSite[], contractOf: (element: ElementId) => ComponentContract | null): { components: ScreenComponent[]; html: number; more: number } {
  const seen = new Map<string, { component: ScreenComponent; count: number }>();
  let html = 0;
  for (const place of places.places) {
    if (place.html) {
      html++;
      continue;
    }
    const key = place.file && place.line ? `${place.name}|${place.file}:${place.line}` : `${place.name}|${place.box.x},${place.box.y}`;
    const known = seen.get(key);
    if (known) {
      known.count++;
      continue;
    }
    const element = elementAt(usages, place);
    const contract = element ? contractOf(element) : null;
    seen.set(key, { component: { name: place.name, element, file: place.file ?? null, line: place.line ?? null, column: place.column ?? null, box: place.box, count: 1, ...(contract ? { choices: choicesOf(contract) } : {}) }, count: 1 });
  }
  const all = [...seen.values()].map(({ component, count }) => ({ ...component, count }));
  // System elements first: they are what options can change.
  all.sort((a, b) => Number(b.element !== null) - Number(a.element !== null));
  return { components: all.slice(0, COMPONENTS_AT_MOST), html, more: Math.max(0, all.length - COMPONENTS_AT_MOST) };
}

/** The captured place an agent names: by name, file and line (or box), nearest the box it gave. */
export function findPlace(places: PlacesFile, want: { name: string; file?: string | undefined; line?: number | undefined; box?: Place["box"] | undefined }): Place | null {
  const matches = places.places.filter((p) => !p.html && p.name === want.name && (want.file === undefined || p.file === want.file) && (want.line === undefined || p.line === want.line));
  if (matches.length === 0) return null;
  if (!want.box) return matches[0]!;
  const off = (p: Place): number => Math.abs(p.box.x - want.box!.x) + Math.abs(p.box.y - want.box!.y);
  return matches.reduce((best, p) => (off(p) < off(best) ? p : best));
}
