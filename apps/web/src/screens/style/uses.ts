/**
 * What a token touches, for the phone preview: its direct uses, so an edit shows on the text,
 * surfaces, borders or shapes that read it. A use is a component contract's role that binds the
 * token, or another token whose value aliases it (a plain alias stands for the token, so its own
 * uses count; a composite, such as a border that takes its colour, is a use itself). A token that
 * nothing reads directly is sampled by its name: `color.muted` as text on each surface.
 */
import type { StyleDraftContent } from "@youiyoux/workflow/api";
import type { PreviewFocus, PreviewTokenUse } from "../../preview/protocol.ts";
import { aliasOf, groupOf, sourceOf, type EditorModel } from "./model.ts";

type Kind = PreviewTokenUse["kind"];

/** Types the edited-token view can draw; anything else keeps its group's screen. */
export const SAMPLED_TYPES: ReadonlySet<string> = new Set(["color", "dimension", "border", "shadow", "typography", "focusRing"]);

/** Colour paths that read as surfaces and as text, by the names systems give them (as the Type & colour screen reads them). */
const SURFACE = /(?:^|\.)(?:paper|ground|raised|surface|canvas|background|card|sunken)$/;
const TEXT = /(?:^|[.-])(?:ink|text|foreground|fg|muted|subtle|faint)(?:-\d)?$/;
const MAIN_TEXT = /(?:^|\.)(?:ink|text|foreground|fg)$/;
const LINE = /(?:^|[.-])(?:line|border|divider|stroke|outline|separator)s?$/;

const MAX_USES = 12;

/** How a sample by name is labelled, by what it draws. */
const NAME_LABEL: Readonly<Record<Kind, string>> = { text: "text", surface: "surface", border: "border", ring: "focus ring", shadow: "shadow", radius: "corners", space: "gap and padding", type: "text" };

/** What a contract role does with a token of this type: `bg.default` is a surface, `fg.danger` text. */
function roleKind(type: string, role: string): Kind | null {
  const head = role.split(".")[0]!.toLowerCase();
  switch (type) {
    case "color":
      if (/^(?:bg|background|surface|fill|paper|canvas)$/.test(head)) return "surface";
      if (/^(?:fg|text|foreground|color|ink|label|icon)$/.test(head)) return "text";
      if (/^(?:border|outline|stroke|divider|line)$/.test(head)) return "border";
      if (head === "ring") return "ring";
      return "surface";
    case "dimension":
      if (/radius|rounded|corner/.test(head)) return "radius";
      if (/border|stroke|outline/.test(head)) return "border";
      return "space";
    case "border":
      return "border";
    case "shadow":
      return "shadow";
    case "typography":
      return "type";
    case "focusRing":
      return "ring";
    default:
      return null;
  }
}

/** A composite token that reads the token in one of its parts is drawn as itself. */
const COMPOSITE_KIND: Readonly<Record<string, Kind>> = { border: "border", focusRing: "ring", shadow: "shadow", typography: "type" };

/** The token's own kind when nothing reads it: by its name and type. */
function nameKind(type: string, path: string): Kind | null {
  if (type === "color") return TEXT.test(path) ? "text" : SURFACE.test(path) ? "surface" : LINE.test(path) ? "border" : null;
  if (type === "dimension") return groupOf({ type, path }) === "radius" ? "radius" : groupOf({ type, path }) === "border" ? "border" : "space";
  return roleKind(type, "");
}

/** Every token a value as written aliases, in any part of it. */
function aliasesIn(value: unknown): string[] {
  const alias = aliasOf(value);
  if (alias) return [alias];
  if (Array.isArray(value)) return value.flatMap(aliasesIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(aliasesIn);
  return [];
}

const tail = (id: string): string => id.split("/").at(-1) ?? id;
const tokenPath = (id: string): string => id.split("/token/")[1] ?? id;

/** The token's direct uses, followed through plain aliases, with the edits applied. */
export function tokenFocus(model: EditorModel, content: StyleDraftContent, path: string): PreviewFocus | null {
  const token = model.byPath.get(path);
  if (!token || !SAMPLED_TYPES.has(token.type)) return null;
  const cssVar = (p: string): string | undefined => model.byPath.get(p)?.cssVar;
  const uses: PreviewTokenUse[] = [];
  const seen = new Set<string>();
  const add = (use: PreviewTokenUse): void => {
    const key = `${use.kind}|${use.cssVar}|${use.on ?? ""}|${use.label}`;
    if (seen.has(key) || uses.length >= MAX_USES) return;
    seen.add(key);
    uses.push(use);
  };

  const visit = (target: string, via: string | null, visited: Set<string>): void => {
    const variable = cssVar(target)!;
    const suffix = via ? ` (via ${via})` : "";
    for (const contract of model.contracts) {
      const roleSets: Array<[string, Record<string, string>]> = [["", contract.tokens], ...Object.entries(contract.states ?? {}).map(([state, roles]): [string, Record<string, string>] => [`${state} `, roles ?? {}])];
      for (const [state, roles] of roleSets) {
        for (const [role, id] of Object.entries(roles)) {
          if (tokenPath(id) !== target) continue;
          const kind = roleKind(token.type, role);
          if (!kind) continue;
          // Text sits on the surface the same variant uses, and a surface carries its text.
          const variant = role.includes(".") ? role.slice(role.indexOf(".")) : "";
          const partner = (heads: string[]): string | undefined => {
            for (const name of heads.flatMap((h) => [`${h}${variant}`, h])) {
              const bound = roles[name] ?? contract.tokens[name];
              const partnerToken = bound ? model.byPath.get(tokenPath(bound)) : undefined;
              if (partnerToken?.type === "color") return partnerToken.cssVar;
            }
            return undefined;
          };
          const on = kind === "text" ? partner(["bg", "background", "surface"]) : undefined;
          const fg = kind === "surface" ? partner(["fg", "text", "foreground", "color"]) : undefined;
          add({ kind, type: token.type, label: `${contract.name} ${state}${role}${suffix}`, cssVar: variable, ...(on ? { on } : {}), ...(fg ? { fg } : {}), demo: tail(contract.id) });
        }
      }
    }
    for (const other of model.tokens) {
      if (visited.has(other.path)) continue;
      const reads = (["light", "dark"] as const).some((scheme) => aliasesIn(sourceOf(model, content, other.path, scheme)).includes(target));
      if (!reads) continue;
      if (other.type === token.type) {
        visited.add(other.path);
        const before = uses.length;
        visit(other.path, other.path, visited);
        if (uses.length === before) byName(other.path, other.path);
      } else if (COMPOSITE_KIND[other.type]) {
        add({ kind: COMPOSITE_KIND[other.type]!, type: other.type, label: `${other.path}${suffix}`, cssVar: other.cssVar });
      }
    }
  };

  /** Samples by name: text on every surface, a surface under the main text, or one sample of its kind. */
  const byName = (target: string, via: string | null): void => {
    const variable = cssVar(target)!;
    const suffix = via ? ` (via ${via})` : "";
    const kind = nameKind(token.type, target);
    if (token.type !== "color") {
      if (kind) add({ kind, type: token.type, label: `${NAME_LABEL[kind]}${suffix}`, cssVar: variable });
      return;
    }
    if (kind === "border") return add({ kind, type: "color", label: `border${suffix}`, cssVar: variable });
    const colours = model.tokens.filter((t) => t.type === "color" && t.path !== target);
    if (kind !== "surface") {
      const surfaces = colours.filter((t) => SURFACE.test(t.path));
      for (const surface of surfaces) add({ kind: "text", type: "color", label: `on ${surface.path}${suffix}`, cssVar: variable, on: surface.cssVar });
      if (surfaces.length === 0) add({ kind: "text", type: "color", label: `text${suffix}`, cssVar: variable });
    }
    if (kind !== "text") {
      const text = colours.find((t) => MAIN_TEXT.test(t.path));
      add({ kind: "surface", type: "color", label: `surface${suffix}`, cssVar: variable, ...(text ? { fg: text.cssVar } : {}) });
    }
  };

  visit(path, null, new Set([path]));
  const direct = uses.length > 0;
  if (!direct) byName(path, null);
  return { path, type: token.type, cssVar: token.cssVar, uses, byName: !direct };
}
