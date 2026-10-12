/**
 * The style editor's model, pure: which tokens the editor groups where, what a token's value
 * is with the unsaved edits applied (per scheme, aliases followed), the CSS-variable overrides
 * that show those edits in the live preview, and the colour pairs they put below WCAG AA.
 * Edits are kept as a style draft's content, so saving sends exactly what the editor shows.
 */
import { contrastText, gradePairs, ringOffset, systemPairs, type ContrastContract, type ContrastFinding, type ContrastRing, type ContrastText, type ContrastToken } from "@youiyoux/tokens/contrast";
import { aliasTarget, cssValue, resolveAliases, tokenVariables, variableSuffixes } from "@youiyoux/tokens/values";
import type { StateEdit, StyleDraftContent, TokenEdit } from "@youiyoux/workflow/api";
import type { PreviewVars } from "../../preview/protocol.ts";
import type { ComponentContract, TokenEntry } from "../../data/types.ts";

export type Scheme = "light" | "dark";
export type ComponentState = StateEdit["state"];

export type Group = "color" | "type" | "space" | "radius" | "border" | "shadow" | "motion" | "focus" | "other";

export const GROUPS: ReadonlyArray<{ readonly value: Group; readonly label: string }> = [
  { value: "color", label: "Colour" },
  { value: "type", label: "Type" },
  { value: "space", label: "Spacing" },
  { value: "radius", label: "Radius" },
  { value: "border", label: "Border" },
  { value: "shadow", label: "Shadow" },
  { value: "motion", label: "Motion" },
  { value: "focus", label: "Focus" },
  { value: "other", label: "Other" },
];

export const STATES: readonly ComponentState[] = ["hover", "active", "focus", "disabled"];

/** Where the editor shows a token: by type, and by path for the dimensions. */
export function groupOf(token: Pick<TokenEntry, "type" | "path">): Group {
  switch (token.type) {
    case "color":
      return "color";
    case "typography":
    case "fontFamily":
    case "fontWeight":
      return "type";
    case "dimension":
      if (/(?:^|\.)(?:radius|radii|rounded|corner)/.test(token.path)) return "radius";
      if (/(?:^|\.)(?:border|stroke|line-width|outline)/.test(token.path)) return "border";
      return "space";
    case "border":
    case "strokeStyle":
      return "border";
    case "shadow":
      return "shadow";
    case "duration":
    case "cubicBezier":
    case "transition":
    case "spring":
      return "motion";
    case "focusRing":
      return "focus";
    default:
      return "other";
  }
}

/** What the editor reads: the snapshot's tokens (with their values as written) and contracts. */
export interface EditorModel {
  readonly system: string;
  readonly prefix: string;
  readonly tokens: readonly TokenEntry[];
  readonly byPath: ReadonlyMap<string, TokenEntry>;
  readonly contracts: readonly ComponentContract[];
}

export function editorModel(system: string, prefix: string, tokens: readonly TokenEntry[], contracts: readonly ComponentContract[]): EditorModel {
  return { system, prefix, tokens, byPath: new Map(tokens.map((t) => [t.path, t])), contracts };
}

/** Tokens the editor can change: the snapshot carries their values as written (older snapshots do not). */
export const editable = (token: TokenEntry): boolean => token.source !== undefined;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function editOf(content: StyleDraftContent, path: string): TokenEdit | undefined {
  return content.tokens.find((t) => t.path === path);
}

/** The published value as written, per scheme: dark follows light unless the dark set gives its own. */
export function publishedSource(token: TokenEntry, scheme: Scheme): unknown {
  const source = token.source ?? { light: token.light, dark: token.dark };
  return scheme === "light" || !token.darkOwn ? source.light : source.dark;
}

/** The value as written, with the edits applied. */
export function sourceOf(model: EditorModel, content: StyleDraftContent, path: string, scheme: Scheme): unknown {
  const token = model.byPath.get(path);
  if (!token) return undefined;
  const edit = editOf(content, path);
  const light = edit?.light !== undefined ? edit.light : publishedSource(token, "light");
  if (scheme === "light") return light;
  if (edit?.dark === null) return light;
  if (edit?.dark !== undefined) return edit.dark;
  return token.darkOwn ? publishedSource(token, "dark") : light;
}

/** True when the token has a dark value of its own (published or edited). */
export function hasOwnDark(token: TokenEntry, edit: TokenEdit | undefined): boolean {
  if (edit?.dark === null) return false;
  return edit?.dark !== undefined || token.darkOwn === true;
}

/** The value with every alias followed (through the edits), as DTCG data. */
export function resolvedOf(model: EditorModel, content: StyleDraftContent, path: string, scheme: Scheme): unknown {
  return resolveAliases(sourceOf(model, content, path, scheme), (p) => sourceOf(model, content, p, scheme));
}

/** The value as CSS, as the token build writes it; "" when it cannot be formatted (an unresolved alias). */
export function cssOf(model: EditorModel, content: StyleDraftContent, path: string, scheme: Scheme): string {
  const token = model.byPath.get(path);
  if (!token) return "";
  try {
    return cssValue(token.type, resolvedOf(model, content, path, scheme));
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------- live preview */

/** `--<prefix>-<component>-<state>-<role>`, as the token build names a contract's state variable. */
export function stateVariable(prefix: string, component: string, state: string, role: string): string {
  return `--${prefix}-${component.split("/").at(-1)}-${state}-${role.replace(/\./g, "-")}`;
}

/**
 * The CSS variables that show the edits, per scheme. Only edited tokens are overridden: the
 * preview sheet writes aliases as `var()`, so whatever reads an edited token follows it.
 */
export function previewVars(model: EditorModel, content: StyleDraftContent): PreviewVars {
  const ref = (path: string, suffix = ""): string => `var(${model.byPath.get(path)?.cssVar ?? `--${model.prefix}-${path.replace(/\./g, "-")}`}${suffix})`;
  const vars: { light: Record<string, string>; dark: Record<string, string> } = { light: {}, dark: {} };
  for (const edit of content.tokens) {
    const token = model.byPath.get(edit.path);
    if (!token) continue;
    for (const scheme of ["light", "dark"] as const) {
      const value = sourceOf(model, content, edit.path, scheme);
      if (same(value, publishedSource(token, scheme))) continue;
      try {
        for (const [suffix, css] of tokenVariables(token.type, value, ref)) vars[scheme][`${token.cssVar}${suffix}`] = css;
      } catch {
        // A value the person is still typing that cannot be formatted yet: keep the published one.
      }
    }
  }
  for (const edit of content.states) {
    const path = edit.token.split("/token/")[1] ?? "";
    const token = model.byPath.get(path);
    if (!token) continue;
    for (const suffix of variableSuffixes(token.type)) {
      const name = `${stateVariable(model.prefix, edit.component, edit.state, edit.role)}${suffix}`;
      vars.light[name] = vars.dark[name] = ref(path, suffix);
    }
  }
  return vars;
}

/* ------------------------------------------------------------------ contrast */

function contrastInput(model: EditorModel, content: StyleDraftContent | null): { tokens: ContrastToken[]; rings: Map<string, ContrastRing>; typography: ContrastText[]; contracts: ContrastContract[] } {
  const css = (path: string, scheme: Scheme): string => {
    const token = model.byPath.get(path)!;
    return content ? cssOf(model, content, path, scheme) : token[scheme];
  };
  const tokens: ContrastToken[] = model.tokens.filter((t) => t.type === "color").map((t) => ({ path: t.path, type: "color", light: css(t.path, "light"), dark: css(t.path, "dark") }));
  const resolved = (path: string, scheme: Scheme): unknown =>
    content ? resolvedOf(model, content, path, scheme) : resolveAliases(publishedSource(model.byPath.get(path)!, scheme), (p) => (model.byPath.get(p) ? publishedSource(model.byPath.get(p)!, scheme) : undefined));
  const rings = new Map<string, ContrastRing>();
  for (const ring of model.tokens.filter((t) => t.type === "focusRing")) {
    const color = (scheme: Scheme): string => {
      try {
        return cssValue("color", (resolved(ring.path, scheme) as { color: unknown }).color);
      } catch {
        return "";
      }
    };
    tokens.push({ path: `${ring.path}.color`, type: "color", light: color("light"), dark: color("dark") });
    rings.set(ring.path, { color: `${ring.path}.color`, offset: ringOffset(resolved(ring.path, "light")) });
  }
  const typography = model.tokens.filter((t) => t.type === "typography").map((t) => contrastText(t.path, resolved(t.path, "light")));
  const pathOf = (id: string): string => id.split("/token/")[1] ?? id;
  const contracts = model.contracts.map((c) => {
    const states: Record<string, Record<string, string>> = {};
    for (const [state, roles] of Object.entries(c.states ?? {})) states[state] = Object.fromEntries(Object.entries(roles ?? {}).map(([role, id]) => [role, pathOf(id)]));
    for (const edit of content?.states ?? []) if (edit.component === c.id) states[edit.state] = { ...states[edit.state], [edit.role]: pathOf(edit.token) };
    return { id: c.id, name: c.name, tokens: Object.fromEntries(Object.entries(c.tokens).map(([role, id]) => [role, pathOf(id)])), states };
  });
  return { tokens, rings, typography, contracts };
}

export interface ContrastWarning extends ContrastFinding {
  /** It passed before these edits. */
  readonly isNew: boolean;
}

/** Colour pairs below WCAG AA with the edits applied (new ones first), and how many passed before. */
export function contrastWarnings(model: EditorModel, content: StyleDraftContent): ContrastWarning[] {
  const grade = (input: ReturnType<typeof contrastInput>): ContrastFinding[] => gradePairs(systemPairs(input.tokens, input.contracts, { focusRings: input.rings, typography: input.typography }), input.tokens);
  const before = new Map(grade(contrastInput(model, null)).map((f) => [`${f.pair.key}|${f.scheme}`, f]));
  return grade(contrastInput(model, content))
    .filter((f) => !f.passes)
    .map((f) => ({ ...f, isNew: before.get(`${f.pair.key}|${f.scheme}`)?.passes !== false }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || (a.ratio ?? 0) - (b.ratio ?? 0));
}

/* --------------------------------------------------------------------- edits */

export type EditAction =
  | { readonly type: "token"; readonly path: string; readonly scheme: Scheme; readonly value: unknown }
  | { readonly type: "reset-token"; readonly path: string }
  /** Give the token its own dark value, starting from what dark shows now. */
  | { readonly type: "dark-own"; readonly path: string }
  /** Drop the dark value: dark follows light. */
  | { readonly type: "dark-follows"; readonly path: string }
  | { readonly type: "state"; readonly component: string; readonly state: ComponentState; readonly role: string; readonly token: string }
  | { readonly type: "reset-state"; readonly component: string; readonly state: ComponentState; readonly role: string }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "replace"; readonly content: StyleDraftContent };

export const EMPTY: StyleDraftContent = { title: "", tokens: [], states: [] };

function putToken(content: StyleDraftContent, path: string, edit: Omit<TokenEdit, "path">): StyleDraftContent {
  const rest = content.tokens.filter((t) => t.path !== path);
  const kept = Object.fromEntries(Object.entries(edit).filter(([key, v]) => key !== "path" && v !== undefined));
  const tokens = Object.keys(kept).length === 0 ? rest : [...rest, { path, ...kept }].sort((a, b) => a.path.localeCompare(b.path));
  return { ...content, tokens };
}

/** The next edits after an action. An edit back to the published value is no edit at all. */
export function applyEdit(model: EditorModel, content: StyleDraftContent, action: EditAction): StyleDraftContent {
  switch (action.type) {
    case "token": {
      const token = model.byPath.get(action.path);
      if (!token) return content;
      const edit = editOf(content, action.path) ?? { path: action.path };
      if (action.scheme === "light") return putToken(content, action.path, { ...edit, light: same(action.value, publishedSource(token, "light")) ? undefined : action.value });
      // A dark value equal to what dark would show anyway is not an edit.
      const followsLight = !token.darkOwn && same(action.value, sourceOf(model, content, action.path, "light"));
      const unchanged = token.darkOwn && same(action.value, publishedSource(token, "dark"));
      return putToken(content, action.path, { ...edit, dark: followsLight || unchanged ? undefined : action.value });
    }
    case "reset-token":
      return { ...content, tokens: content.tokens.filter((t) => t.path !== action.path) };
    case "dark-own": {
      const edit = editOf(content, action.path) ?? { path: action.path };
      return putToken(content, action.path, { ...edit, dark: sourceOf(model, content, action.path, "dark") });
    }
    case "dark-follows": {
      const token = model.byPath.get(action.path);
      const edit = editOf(content, action.path) ?? { path: action.path };
      return putToken(content, action.path, { ...edit, dark: token?.darkOwn ? null : undefined });
    }
    case "state": {
      const rest = content.states.filter((s) => !(s.component === action.component && s.state === action.state && s.role === action.role));
      const published = model.contracts.find((c) => c.id === action.component)?.states?.[action.state]?.[action.role];
      const states = published === action.token ? rest : [...rest, { component: action.component as StateEdit["component"], state: action.state, role: action.role, token: action.token as StateEdit["token"] }];
      return { ...content, states };
    }
    case "reset-state":
      return { ...content, states: content.states.filter((s) => !(s.component === action.component && s.state === action.state && s.role === action.role)) };
    case "title":
      return { ...content, title: action.title };
    case "replace":
      return action.content;
  }
}

/** How many changes the edits hold. */
export const editCount = (content: StyleDraftContent): number => content.tokens.length + content.states.length;

/** An alias's target path, or null for an own value. */
export const aliasOf = (value: unknown): string | null => aliasTarget(value);
