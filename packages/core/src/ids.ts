/** Element identity: `youi:<system>/<kind>/<name>`, e.g. `youi:demo/component/button`. */
import { z } from "zod";

export const ELEMENT_KINDS = ["token", "component", "rule", "migration"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

const ID_PATTERN = /^youi:([a-z][a-z0-9-]*)\/(token|component|rule|migration)\/([a-z0-9][a-z0-9.\-]*)$/;

export const ElementId = z.string().regex(ID_PATTERN, "expected youi:<system>/<kind>/<name>");
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
  return `youi:${system}/${kind}/${name}`;
}

/** True when `query` names this id: the full id, `kind/name`, or the bare name (case-insensitive). */
export function matchesQuery(id: string, query: string): boolean {
  const parsed = parseId(id);
  if (!parsed) return false;
  const q = query.trim().toLowerCase();
  return q === id || q === `${parsed.kind}/${parsed.name}` || q === parsed.name;
}

/** A plain id safe to use as one path segment, or null for an unsafe value. */
export function safeId(id: unknown): string | null {
  return typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..") ? id : null;
}
