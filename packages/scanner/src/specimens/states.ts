/**
 * Forced-state twins, the way Storybook's pseudo-states addon makes them: every selector that
 * uses `:hover`, `:focus-visible`, `:focus`, `:focus-within`, `:active`, `:disabled`,
 * `[disabled]` or `[aria-disabled=true]` also matches a class, so one specimen's static HTML can
 * be drawn default, hover, focus, pressed and disabled side by side with no script. `:hover`
 * becomes `:is(:hover, .youi-state-hover, .youi-state-hover *)`: the same specificity as the
 * pseudo-class, matched by the class on the element or any ancestor (so a cell that carries the
 * class forces the state on everything in it, Storybook's `-all` behaviour).
 *
 * The rewrite walks the sheet's blocks (strings, comments, escapes and parentheses respected,
 * nested rules included) and only touches style-rule selectors; at-rule preludes stay as they
 * are. `:not(…)` arguments are left alone, so `:not(:disabled)` still reads the element itself.
 * A `@media (hover: hover)` block, which a touch screen never matches, is followed by a twin-only
 * copy for `(hover: none)`, so a forced hover shows on a phone too. The sheet is marked once
 * rewritten, and a marked sheet is returned unchanged, so twins are never added twice.
 */

export type ForcedState = "hover" | "focus" | "active" | "disabled";

/** The class that forces each state; the hub's state strip puts it on a cell. */
export const STATE_CLASSES: Readonly<Record<ForcedState, string>> = { hover: "youi-state-hover", focus: "youi-state-focus", active: "youi-state-active", disabled: "youi-state-disabled" };

/** Ends a rewritten sheet; a sheet that holds it is not rewritten again. */
export const STATES_MARKER = "/* youi-states: forced-state twins */";

const PSEUDO: Readonly<Record<string, ForcedState>> = { hover: "hover", "focus-visible": "focus", focus: "focus", "focus-within": "focus", active: "active", disabled: "disabled" };
const HOVER_MEDIA = /\(\s*hover\s*:\s*hover\s*\)/i;

type Node = { readonly text: string } | { readonly prelude: string; readonly children: Node[] };

/** Skips a string or comment starting at `i`; returns the index after it, or `i` when there is none. */
function skip(css: string, i: number): number {
  const c = css[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== c && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
    return Math.min(css.length, j + 1);
  }
  if (c === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  return i;
}

/** A block's contents: statements and declarations as text, nested blocks as nodes; stops at its `}`. */
function parse(css: string, start: number): { nodes: Node[]; end: number } {
  const nodes: Node[] = [];
  let from = start;
  let depth = 0;
  let i = start;
  while (i < css.length) {
    const after = skip(css, i);
    if (after !== i) {
      i = after;
      continue;
    }
    const c = css[i]!;
    if (c === "\\") i += 2;
    else if (c === "(" || c === "[") {
      depth++;
      i++;
    } else if ((c === ")" || c === "]") && depth > 0) {
      depth--;
      i++;
    } else if (depth > 0) i++;
    else if (c === ";") {
      nodes.push({ text: css.slice(from, i + 1) });
      from = ++i;
    } else if (c === "{") {
      const inner = parse(css, i + 1);
      nodes.push({ prelude: css.slice(from, i), children: inner.nodes });
      from = i = inner.end + 1;
    } else if (c === "}") {
      if (from < i) nodes.push({ text: css.slice(from, i) });
      return { nodes, end: i };
    } else i++;
  }
  if (from < css.length) nodes.push({ text: css.slice(from) });
  return { nodes, end: css.length };
}

const twinOf = (state: ForcedState, original: string | null): string => `:is(${original === null ? "" : `${original}, `}.${STATE_CLASSES[state]}, .${STATE_CLASSES[state]} *)`;

/** The state an attribute selector's contents (`disabled`, `aria-disabled="true"`) stand for, if any. */
function attributeState(inside: string): ForcedState | null {
  const normal = inside.replace(/\s+/g, "").replace(/["']/g, "").toLowerCase();
  return normal === "disabled" || normal === "aria-disabled=true" ? "disabled" : null;
}

/**
 * One selector (or selector list) with each state pseudo-class and attribute twinned. `only`:
 * the twin without the real state (for the `(hover: none)` copy). Returns the rewritten text and
 * whether that state was found.
 */
function rewrite(selector: string, only: ForcedState | null = null): { text: string; found: boolean } {
  let out = "";
  let found = false;
  let i = 0;
  while (i < selector.length) {
    const after = skip(selector, i);
    if (after !== i) {
      out += selector.slice(i, after);
      i = after;
      continue;
    }
    const c = selector[i]!;
    if (c === "\\") {
      out += selector.slice(i, i + 2);
      i += 2;
    } else if (c === "[") {
      let j = i + 1;
      while (j < selector.length && selector[j] !== "]") {
        const past = skip(selector, j);
        j = past !== j ? past : j + (selector[j] === "\\" ? 2 : 1);
      }
      const whole = selector.slice(i, j + 1);
      const state = attributeState(selector.slice(i + 1, j));
      if (state && (only === null || only === state)) {
        out += twinOf(state, only === null ? whole : null);
        found = true;
      } else out += whole;
      i = j + 1;
    } else if (c === ":" && selector[i + 1] === ":") {
      // A pseudo-element (`::before`, `::-moz-focus-inner`): its name is not a state.
      const name = /^::[-\w]+/.exec(selector.slice(i))![0];
      out += name;
      i += name.length;
    } else if (c === ":") {
      const name = /^:([-\w]*)/.exec(selector.slice(i))![1]!;
      const end = i + 1 + name.length;
      const lower = name.toLowerCase();
      if (selector[end] === "(") {
        const close = closing(selector, end);
        const inside = selector.slice(end + 1, close);
        // `:not(…)` is left alone; twins already made are not twinned again.
        if (lower === "not" || inside.includes(".youi-state-")) out += selector.slice(i, close + 1);
        else {
          const inner = rewrite(inside, only);
          found ||= inner.found;
          out += `:${name}(${inner.text})`;
        }
        i = close + 1;
      } else {
        const state = PSEUDO[lower];
        if (state && (only === null || only === state)) {
          out += twinOf(state, only === null ? `:${name}` : null);
          found = true;
        } else out += `:${name}`;
        i = end;
      }
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, found };
}

/** The index of the `)` that closes the `(` at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const after = skip(text, i);
    if (after !== i) {
      i = after;
      continue;
    }
    const c = text[i]!;
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
    i++;
  }
  return text.length;
}

/** A selector list split at its top-level commas. */
function selectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  let i = 0;
  while (i < list.length) {
    const after = skip(list, i);
    if (after !== i) {
      i = after;
      continue;
    }
    const c = list[i]!;
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
    i++;
  }
  parts.push(list.slice(from));
  return parts;
}

const isAtRule = (prelude: string): boolean => prelude.replace(/\/\*[\s\S]*?\*\//g, "").trimStart().startsWith("@");
const isKeyframes = (prelude: string): boolean => /@(?:-[a-z]+-)?keyframes\b/i.test(prelude);

/** Every block twinned; `inRule`: inside a style rule (nested CSS). */
function serialize(nodes: readonly Node[], inRule: boolean): string {
  let out = "";
  for (const node of nodes) {
    if ("text" in node) {
      out += node.text;
      continue;
    }
    if (isAtRule(node.prelude)) {
      const body = isKeyframes(node.prelude) ? plain(node.children) : serialize(node.children, inRule);
      out += `${node.prelude}{${body}}`;
      if (/^\s*@media\b/i.test(node.prelude.replace(/\/\*[\s\S]*?\*\//g, "")) && HOVER_MEDIA.test(node.prelude)) {
        // Inside a rule its selector already carries the twin; at the top, only the forced hover.
        const copy = inRule ? body : hoverOnly(node.children);
        if (copy.trim()) out += `\n${node.prelude.replace(new RegExp(HOVER_MEDIA.source, "gi"), "(hover: none)")}{${copy}}`;
      }
      continue;
    }
    out += `${rewrite(node.prelude).text}{${serialize(node.children, true)}}`;
  }
  return out;
}

const plain = (nodes: readonly Node[]): string => nodes.map((n) => ("text" in n ? n.text : `${n.prelude}{${plain(n.children)}}`)).join("");

/** The rules of a `@media (hover: hover)` block that use `:hover`, with only the forced twin. */
function hoverOnly(nodes: readonly Node[]): string {
  let out = "";
  for (const node of nodes) {
    if ("text" in node) continue;
    if (isAtRule(node.prelude)) {
      const inner = hoverOnly(node.children);
      if (inner.trim()) out += `${node.prelude}{${inner}}`;
      continue;
    }
    const kept = selectors(node.prelude).map((s) => rewrite(s, "hover")).filter((s) => s.found);
    if (kept.length > 0) out += `${kept.map((s) => s.text).join(",")}{${plain(node.children)}}`;
  }
  return out;
}

/** The sheet with forced-state twins added (see the top of this file); a sheet already rewritten is returned as is. */
export function forcedStates(css: string): string {
  if (css.includes(STATES_MARKER)) return css;
  let { nodes, end } = parse(css, 0);
  // A stray `}` at the top level: keep the rest as it was.
  let out = serialize(nodes, false);
  while (end < css.length) {
    out += "}";
    ({ nodes, end } = parse(css, end + 1));
    out += serialize(nodes, false);
  }
  return `${out}\n${STATES_MARKER}\n`;
}
