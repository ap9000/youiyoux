/** Element identity, `youi:<system>/<kind>/<name>` (mirrors @youiyoux/core ids.ts), and hub URLs. */
import type { ElementId, ElementKind } from "./types.ts";

const ID_PATTERN = /^youi:([a-z][a-z0-9-]*)\/(token|component|rule|migration)\/([a-z0-9][a-z0-9.-]*)$/;

export interface ParsedId {
  readonly system: string;
  readonly kind: ElementKind;
  readonly name: string;
}

export function parseId(id: string): ParsedId | null {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  return { system: match[1]!, kind: match[2] as ElementKind, name: match[3]! };
}

export function formatId(system: string, kind: ElementKind, name: string): ElementId {
  return `youi:${system}/${kind}/${name}`;
}

export const ELEMENT_TABS = ["overview", "usage", "contract", "rules"] as const;
export type ElementTab = (typeof ELEMENT_TABS)[number];

/** Tab names from before the tabs were merged, so old links still land on the right content. */
const LEGACY_TABS: Readonly<Record<string, ElementTab>> = { preview: "overview", where: "usage", tokens: "contract" };

/** A URL segment → the tab it names (overview when it names none). */
export function tabOf(segment: string | undefined): ElementTab {
  if (!segment) return "overview";
  return ELEMENT_TABS.find((t) => t === segment) ?? LEGACY_TABS[segment] ?? "overview";
}

export function elementHref(id: ElementId, tab?: ElementTab): string {
  const parsed = parseId(id);
  if (!parsed) return "/elements";
  const base = `/elements/${parsed.system}/${parsed.kind}/${parsed.name}`;
  return tab && tab !== "overview" ? `${base}/${tab}` : base;
}

export function tokenHref(path: string): string {
  return `/tokens/${path}`;
}

/** `youi:demo/token/color.accent` → `color.accent`; the readable tail of any id. */
export function shortName(id: ElementId): string {
  return parseId(id)?.name ?? id;
}
