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

export const ELEMENT_TABS = ["preview", "contract", "tokens", "rules", "where"] as const;
export type ElementTab = (typeof ELEMENT_TABS)[number];

export function elementHref(id: ElementId, tab?: ElementTab): string {
  const parsed = parseId(id);
  if (!parsed) return "/elements";
  const base = `/elements/${parsed.system}/${parsed.kind}/${parsed.name}`;
  return tab && tab !== "preview" ? `${base}/${tab}` : base;
}

export function tokenHref(path: string): string {
  return `/tokens/${path}`;
}

/** `youi:demo/token/color.accent` → `color.accent`; the readable tail of any id. */
export function shortName(id: ElementId): string {
  return parseId(id)?.name ?? id;
}
