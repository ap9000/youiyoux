/** Element identity: `dl:<system>/<kind>/<name>`, e.g. `dl:signal/component/button`. */
import { z } from "zod";

export const ELEMENT_KINDS = ["token", "component", "rule", "migration"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

const ID_PATTERN = /^dl:([a-z][a-z0-9-]*)\/(token|component|rule|migration)\/([a-z0-9][a-z0-9.\-]*)$/;

export const ElementId = z.string().regex(ID_PATTERN, "expected dl:<system>/<kind>/<name>");
export type ElementId = z.infer<typeof ElementId>;

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
  return `dl:${system}/${kind}/${name}`;
}

/** True when `query` names this id: the full id, `kind/name`, or the bare name (case-insensitive). */
export function matchesQuery(id: string, query: string): boolean {
  const parsed = parseId(id);
  if (!parsed) return false;
  const q = query.trim().toLowerCase();
  return q === id || q === `${parsed.kind}/${parsed.name}` || q === parsed.name;
}
