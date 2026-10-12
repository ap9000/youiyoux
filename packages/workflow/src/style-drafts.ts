/**
 * Style drafts as data: validation against the published tokens and contracts, the content
 * digest a draft is bound to, and the in-place edits a review branch carries (token files and
 * contracts, changed keys only). Pure; no I/O.
 */
import { aliasesIn, COMPONENT_STATES, parseId, sha256, stableStringify, TOKEN_ALIAS, tokenValueProblems, type ComponentContract } from "@youiyoux/core";
import type { ResolverLayout } from "@youiyoux/tokens";
import type { StateEdit, StyleDraftContent, TokenEdit } from "./api.ts";
import { deleteJsonPath, readJsonPath, setJsonPath } from "./json-edit.ts";

/** A published token as a style draft sees it: its type and its values as written. */
export interface StyleToken {
  readonly path: string;
  readonly type: string;
  readonly source: { readonly light: unknown; readonly dark: unknown };
}

export interface StyleContext {
  readonly system: string;
  readonly tokens: readonly StyleToken[];
  readonly contracts: readonly ComponentContract[];
  /** The system has a theme modifier with a dark context to write dark values to. */
  readonly hasDark: boolean;
}

export const MAX_TITLE = 120;

export function emptyStyleContent(): StyleDraftContent {
  return { title: "", tokens: [], states: [] };
}

const stateKey = (edit: Pick<StateEdit, "component" | "state" | "role">): string => `${edit.component}|${edit.state}|${edit.role}`;

/** One order for the same edits, so equal drafts digest equally. */
export function normalizeStyleContent(content: StyleDraftContent): StyleDraftContent {
  return {
    title: content.title,
    tokens: [...content.tokens].sort((a, b) => a.path.localeCompare(b.path)),
    states: [...content.states].sort((a, b) => stateKey(a).localeCompare(stateKey(b))),
  };
}

export function styleDigest(content: StyleDraftContent): string {
  return sha256(stableStringify(normalizeStyleContent(content)));
}

export function tokenPathOf(id: string, system: string): string | null {
  const parsed = parseId(id);
  return parsed && parsed.kind === "token" && parsed.system === system ? parsed.name : null;
}

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

/** Edits that would change nothing (the value is already the published one) are not changes. */
export function effectiveTokenEdits(content: StyleDraftContent, tokens: readonly StyleToken[]): TokenEdit[] {
  const byPath = new Map(tokens.map((t) => [t.path, t]));
  return content.tokens.flatMap((edit) => {
    const token = byPath.get(edit.path);
    if (!token) return [edit];
    const light = edit.light !== undefined && !same(edit.light, token.source.light) ? { light: edit.light } : {};
    const dark = edit.dark !== undefined && !(edit.dark !== null && same(edit.dark, token.source.dark)) ? { dark: edit.dark } : {};
    return "light" in light || "dark" in dark ? [{ path: edit.path, ...light, ...dark }] : [];
  });
}

/** Why the draft cannot be previewed or published as it stands; empty when it can. */
export function validateStyleContent(content: StyleDraftContent, context: StyleContext): string[] {
  const problems: string[] = [];
  const byPath = new Map(context.tokens.map((t) => [t.path, t]));
  if (content.title.length > MAX_TITLE) problems.push(`title: keep it under ${MAX_TITLE} characters`);
  const seen = new Set<string>();
  for (const edit of content.tokens) {
    const where = `tokens.${edit.path}`;
    if (seen.has(edit.path)) problems.push(`${where}: edited twice; keep one edit per token`);
    seen.add(edit.path);
    const token = byPath.get(edit.path);
    if (!token) {
      problems.push(`${where}: no token ${edit.path} in ${context.system}; the style editor changes existing tokens`);
      continue;
    }
    if (edit.light === undefined && edit.dark === undefined) problems.push(`${where}: set a light or a dark value`);
    // Only a dark value can be removed (dark then follows light); a token always has a light value.
    if (edit.light === null) problems.push(`${where}: the light value cannot be removed; set a value or drop the edit`);
    if (edit.dark !== undefined && !context.hasDark) problems.push(`${where}: ${context.system} has no dark theme to write a dark value to`);
    for (const [scheme, value] of [["light", edit.light], ["dark", edit.dark]] as const) {
      if (value === undefined || value === null) continue;
      for (const problem of tokenValueProblems(token.type, value)) problems.push(`${where} (${scheme}): ${problem}`);
      for (const target of aliasesIn(value)) {
        const aliased = byPath.get(target);
        if (!aliased) problems.push(`${where} (${scheme}): alias {${target}} names no token`);
        else if (typeof value === "string" && TOKEN_ALIAS.test(value) && aliased.type !== token.type) problems.push(`${where} (${scheme}): {${target}} is a ${aliased.type}, not a ${token.type}`);
        if (target === edit.path) problems.push(`${where} (${scheme}): a token cannot alias itself`);
      }
    }
  }
  problems.push(...aliasCycles(content.tokens, context.tokens).map((cycle) => `tokens: alias cycle ${cycle.join(" → ")}`));
  const keys = new Set<string>();
  for (const edit of content.states) {
    const where = `states.${edit.component.split("/").at(-1)}.${edit.state}.${edit.role}`;
    if (keys.has(stateKey(edit))) problems.push(`${where}: edited twice; keep one edit per state role`);
    keys.add(stateKey(edit));
    const contract = context.contracts.find((c) => c.id === edit.component);
    if (!contract) {
      problems.push(`${where}: no component ${edit.component}`);
      continue;
    }
    if (!(COMPONENT_STATES as readonly string[]).includes(edit.state)) problems.push(`${where}: ${edit.state} is not a state (${COMPONENT_STATES.join(", ")})`);
    const current = contract.states?.[edit.state]?.[edit.role];
    if (!current) {
      problems.push(`${where}: ${contract.name}'s contract defines no ${edit.state} ${edit.role}; states are added in the contract`);
      continue;
    }
    const path = tokenPathOf(edit.token, context.system);
    const token = path ? byPath.get(path) : undefined;
    if (!token) {
      problems.push(`${where}: no token ${edit.token} in ${context.system}`);
      continue;
    }
    const was = byPath.get(tokenPathOf(current, context.system) ?? "");
    if (was && was.type !== token.type) problems.push(`${where}: ${path} is a ${token.type}; this role takes a ${was.type}`);
  }
  if (problems.length === 0 && effectiveTokenEdits(content, context.tokens).length === 0 && effectiveStateEdits(content, context.contracts).length === 0) problems.push("nothing changes yet: edit a token or a state");
  return problems;
}

export function effectiveStateEdits(content: StyleDraftContent, contracts: readonly ComponentContract[]): StateEdit[] {
  return content.states.filter((edit) => contracts.find((c) => c.id === edit.component)?.states?.[edit.state]?.[edit.role] !== edit.token);
}

/** Alias cycles the edits would create, each once. */
function aliasCycles(edits: readonly TokenEdit[], tokens: readonly StyleToken[]): string[][] {
  const reads = new Map<string, Set<string>>();
  const edited = new Map(edits.map((e) => [e.path, e]));
  for (const token of tokens) {
    const edit = edited.get(token.path);
    const light = edit?.light !== undefined ? edit.light : token.source.light;
    const dark = edit?.dark === undefined ? token.source.dark : edit.dark === null ? light : edit.dark;
    reads.set(token.path, new Set([...aliasesIn(light), ...aliasesIn(dark)]));
  }
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, "open");
    stack.push(node);
    for (const next of reads.get(node) ?? []) {
      if (state.get(next) === "open") cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const path of [...edited.keys()].sort()) if (!state.has(path)) visit(path);
  return cycles;
}

/* --------------------------------------------------------------- rendering */

/** The token files of a system at one commit: its resolver's layout and each file's text (design-root-relative paths). */
export interface TokenFiles {
  /** Directory of the resolver, design-root-relative (`tokens/demo`). */
  readonly dir: string;
  readonly layout: ResolverLayout;
  readonly texts: ReadonlyMap<string, string>;
  readonly light: string;
  readonly dark: string | null;
}

const join = (dir: string, ref: string): string => (dir ? `${dir}/${ref}` : ref).replace(/\/\.\//g, "/").replace(/^\.\//, "");

function has(text: string, segments: readonly string[]): boolean {
  const node = readJsonPath(text, segments);
  return typeof node === "object" && node !== null && "$value" in node;
}

/**
 * The token files with the edits applied, by path; only files that change. Light edits go to
 * the last file that gives the token its light value (base sets, then the light context); dark
 * edits to the dark context file that holds the token, else the last dark context file (as a
 * new override). `dark: null` removes the token's dark overrides.
 */
export function renderTokenEdits(files: TokenFiles, edits: readonly TokenEdit[], types: ReadonlyMap<string, string>): { files: Record<string, string>; problems: string[] } {
  const texts = new Map(files.texts);
  const problems: string[] = [];
  const lightFiles = [...files.layout.base, ...(files.layout.contexts[files.light] ?? [])].map((ref) => join(files.dir, ref));
  const darkFiles = files.dark ? (files.layout.contexts[files.dark] ?? []).map((ref) => join(files.dir, ref)) : [];
  const holding = (candidates: readonly string[], segments: readonly string[]): string | undefined => [...candidates].reverse().find((file) => has(texts.get(file) ?? "{}", segments));
  for (const edit of edits) {
    const segments = edit.path.split(".");
    if (edit.light !== undefined) {
      const file = holding(lightFiles, segments);
      if (!file) problems.push(`tokens.${edit.path}: no token file holds its light value`);
      else texts.set(file, setJsonPath(texts.get(file)!, [...segments, "$value"], edit.light));
    }
    if (edit.dark === null) {
      for (const file of darkFiles) if (has(texts.get(file) ?? "{}", segments)) texts.set(file, deleteJsonPath(texts.get(file)!, segments));
    } else if (edit.dark !== undefined) {
      const file = holding(darkFiles, segments) ?? darkFiles.at(-1);
      if (!file || !texts.has(file)) problems.push(`tokens.${edit.path}: there is no dark token file to write to`);
      else if (has(texts.get(file)!, segments)) texts.set(file, setJsonPath(texts.get(file)!, [...segments, "$value"], edit.dark));
      else texts.set(file, setJsonPath(texts.get(file)!, segments, { $type: types.get(edit.path), $value: edit.dark }));
    }
  }
  const changed = Object.fromEntries([...texts].filter(([path, text]) => files.texts.get(path) !== text));
  return { files: changed, problems };
}

/** A contract with the state bindings re-pointed, edited in place; null when nothing changes. */
export function renderContractStates(text: string, edits: readonly StateEdit[]): string | null {
  let next = text;
  for (const edit of edits) next = setJsonPath(next, ["states", edit.state, edit.role], edit.token);
  return next === text ? null : next;
}

/** A short, branch-safe name for a style draft: its title, else what it changes. */
export function styleSlug(content: StyleDraftContent): string {
  const from = content.title.trim() || content.tokens[0]?.path || (content.states[0] ? `${content.states[0].component.split("/").at(-1)}-${content.states[0].state}` : "") || "tokens";
  return (
    from
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "tokens"
  );
}

/** What a style draft changes, in words: "color.accent, focus.ring and 2 states". */
export function describeStyle(content: StyleDraftContent): string {
  const tokens = content.tokens.map((t) => t.path);
  const parts = [...tokens.slice(0, 3), ...(tokens.length > 3 ? [`${tokens.length - 3} more token(s)`] : []), ...(content.states.length ? [`${content.states.length} state binding(s)`] : [])];
  if (parts.length === 0) return "nothing yet";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

