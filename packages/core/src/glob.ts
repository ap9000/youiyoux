/**
 * Glob matching with no Node imports, so the hub can use it (`@youiyoux/core/glob`). The scanner's
 * `matchesAny` (files.ts) uses the same expressions, and Node's own matcher for anything else.
 */

const compiled = new Map<string, RegExp>();

/** A glob as a regular expression: `**` spans directories (zero or more), `*` and `?` stay in one, `{a,b}` and `[…]` as in a shell; `*` skips dot names. */
export function globRegExp(pattern: string): RegExp {
  let cached = compiled.get(pattern);
  if (cached) return cached;
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const whole = (i === 0 || pattern[i - 1] === "/") && (i + 2 === pattern.length || pattern[i + 2] === "/");
      if (whole && pattern[i + 2] === "/") {
        out += "(?:(?!\\.)[^/]*/)*";
        i += 2;
      } else {
        out += whole ? "(?:(?!\\.)[^/]*(?:/(?!\\.)[^/]*)*)?" : "[^/]*";
        i += 1;
      }
    } else if (c === "*") out += (i === 0 || pattern[i - 1] === "/" ? "(?!\\.)" : "") + "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        out += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else out += /[.+^$()|\\\]]/.test(c) ? `\\${c}` : c;
  }
  cached = new RegExp(`^${out}$`);
  compiled.set(pattern, cached);
  return cached;
}

/**
 * What makes a pattern a glob: `*`, `?`, `[…]`, `{…}`, an escape, an extglob (`@(…)`, `!(…)`,
 * `+(…)`) or a leading `!`. A Next.js route group's `(ee)` is plain text. Without these, a
 * pattern names one path.
 */
export const GLOB_SYNTAX = /[*?[{\\]|[@!+]\(|^!/;

/** A glob of `**`, `*`, `{a,b}` and plain characters: the shape globRegExp is proven to match as Node does (files.test.ts), compiled once. */
export const SIMPLE_GLOB = /^(?:[\w.\-/{},]|\*)+$/;

/**
 * Whether `path` matches any of `patterns`, or null when this cannot tell without Node's matcher (a
 * pattern beyond `**`, `*`, `{a,b}` and plain characters). A caller that cannot tell must not read it as no.
 */
export function matchesSimply(path: string, patterns: readonly string[]): boolean | null {
  let unknown = false;
  for (const pattern of patterns) {
    if (path === pattern) return true;
    if (!GLOB_SYNTAX.test(pattern)) continue;
    if (!SIMPLE_GLOB.test(pattern)) unknown = true;
    else if (globRegExp(pattern).test(path)) return true;
  }
  return unknown ? null : false;
}
