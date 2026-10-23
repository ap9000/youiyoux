/**
 * A small `.astro` reader. The frontmatter (between the `---` fences) is TypeScript and goes
 * through parse.ts like any module; the template is read by a tag tokenizer that keeps line
 * and column, and `<style>` blocks are kept as CSS scoped to the file. It is not an Astro
 * compiler: tags inside `{…}` expressions are found, but what an expression renders is not.
 */
import { parseModule, type ModuleInfo } from "../parse.ts";

interface TemplateAttribute {
  readonly name: string;
  /** A quoted value, `true` for a bare attribute, or the source of a `{…}` expression. */
  readonly value: { readonly literal: string | true } | { readonly expression: string };
}

export interface TemplateTag {
  readonly tag: string;
  readonly line: number;
  readonly column: number;
  readonly attributes: readonly TemplateAttribute[];
  /** The first tag opened inside this one, for `asChild`-style checks. */
  readonly firstChild: string | null;
  /** The plain text right inside it (`<Badge>New</Badge>` → `New`); null when none or an expression. */
  readonly text: string | null;
}

export interface AstroFile {
  readonly module: ModuleInfo;
  readonly tags: readonly TemplateTag[];
  /** `<style>` contents, with the line each starts on. */
  readonly styles: ReadonlyArray<{ readonly css: string; readonly line: number }>;
  /** Template regions the tokenizer could not close (an unterminated tag or expression). */
  readonly problems: readonly string[];
}

const RAW_TEXT = new Set(["script", "style"]);

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionAt(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low]! + 1 };
}

/** The end of a `{…}` expression starting at `start` (on the `{`), skipping strings and nested braces; -1 if unclosed. */
function expressionEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      const close = stringEnd(text, i);
      if (close < 0) return -1;
      i = close;
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

interface Opened {
  readonly tag: string;
  readonly index: number;
  firstChild: string | null;
}

/** Text from `start` to the next tag, collapsed; null when empty or it holds an expression. */
function textAt(source: string, start: number): string | null {
  const end = source.indexOf("<", start);
  const text = source.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ").trim();
  return text && !text.includes("{") ? text : null;
}

/** Tags in an Astro template; `offset` is where the template starts in the file. */
export function readTemplate(source: string, offset: number): { tags: TemplateTag[]; styles: Array<{ css: string; line: number }>; problems: string[] } {
  const starts = lineStarts(source);
  const found: Array<{ tag: string; index: number; attributes: TemplateAttribute[]; opened: Opened | null; text: string | null }> = [];
  const styles: Array<{ css: string; line: number }> = [];
  const problems: string[] = [];
  const stack: Opened[] = [];
  let i = offset;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[i] === "<" && source[i + 1] === "/") {
      const end = source.indexOf(">", i);
      const name = source.slice(i + 2, end < 0 ? undefined : end).trim();
      const at = stack.map((s) => s.tag).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[i] !== "<" || !/[A-Za-z]/.test(source[i + 1] ?? "")) {
      i++;
      continue;
    }
    const nameMatch = /^[A-Za-z][\w.:-]*/.exec(source.slice(i + 1, i + 200));
    const tag = nameMatch![0];
    let j = i + 1 + tag.length;
    const attributes: TemplateAttribute[] = [];
    let selfClosing = false;
    let closed = false;
    while (j < source.length) {
      const ch = source[j]!;
      if (/\s/.test(ch)) {
        j++;
        continue;
      }
      if (ch === ">") {
        closed = true;
        j++;
        break;
      }
      if (ch === "/" && source[j + 1] === ">") {
        closed = true;
        selfClosing = true;
        j += 2;
        break;
      }
      if (ch === "{") {
        // `{...spread}` or `{shorthand}`
        const end = expressionEnd(source, j);
        if (end < 0) break;
        const inner = source.slice(j + 1, end).trim();
        attributes.push(inner.startsWith("...") ? { name: "{...}", value: { expression: inner } } : { name: inner, value: { expression: inner } });
        j = end + 1;
        continue;
      }
      const attr = /^[^\s=>/{]+/.exec(source.slice(j, j + 200));
      if (!attr) {
        j++;
        continue;
      }
      const name = attr[0];
      j += name.length;
      while (/\s/.test(source[j] ?? "")) j++;
      if (source[j] !== "=") {
        attributes.push({ name, value: { literal: true } });
        continue;
      }
      j++;
      while (/\s/.test(source[j] ?? "")) j++;
      const start = source[j];
      if (start === "\"" || start === "'" || start === "`") {
        const end = stringEnd(source, j);
        if (end < 0) break;
        const text = source.slice(j + 1, end);
        attributes.push({ name, value: start === "`" && text.includes("${") ? { expression: source.slice(j, end + 1) } : { literal: text } });
        j = end + 1;
      } else if (start === "{") {
        const end = expressionEnd(source, j);
        if (end < 0) break;
        attributes.push({ name, value: { expression: source.slice(j + 1, end).trim() } });
        j = end + 1;
      } else {
        const bare = /^[^\s>]+/.exec(source.slice(j, j + 200))?.[0] ?? "";
        attributes.push({ name, value: { literal: bare } });
        j += bare.length;
      }
    }
    if (!closed) {
      problems.push(`unterminated <${tag}> at line ${positionAt(starts, i).line}`);
      i = j;
      continue;
    }
    const parent = stack.at(-1);
    if (parent && parent.firstChild === null) parent.firstChild = tag;
    const lower = tag.toLowerCase();
    if (RAW_TEXT.has(lower) && !selfClosing) {
      const close = source.indexOf(`</${lower}`, j);
      const end = close < 0 ? source.length : close;
      if (lower === "style") styles.push({ css: source.slice(j, end), line: positionAt(starts, j).line });
      found.push({ tag, index: i, attributes, opened: null, text: null });
      i = close < 0 ? source.length : source.indexOf(">", close) + 1 || source.length;
      continue;
    }
    const opened: Opened | null = selfClosing ? null : { tag, index: i, firstChild: null };
    if (opened) stack.push(opened);
    found.push({ tag, index: i, attributes, opened, text: opened ? textAt(source, j) : null });
    i = j;
  }
  const tags = found.map(({ tag, index, attributes, opened, text }) => ({ tag, ...positionAt(starts, index), attributes, firstChild: opened?.firstChild ?? null, text }));
  return { tags, styles, problems };
}

/** The frontmatter as a module of its own: same line numbers, everything else blanked. */
function frontmatterOf(source: string): { code: string; end: number } {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return { code: "", end: 0 };
  const start = match.index + match[0].indexOf("\n") + 1;
  const before = source.slice(0, start).replace(/[^\n]/g, " ");
  return { code: before + match[1]!, end: match.index + match[0].length };
}

export async function parseAstro(file: string, source: string): Promise<AstroFile> {
  const { code, end } = frontmatterOf(source);
  // Parsed as a .ts file, then named as the .astro file it came from.
  const parsed = (await parseModule(`${file}.ts`, code))!;
  // An Astro file is a component: its default export is the file itself.
  const module: ModuleInfo = {
    ...parsed,
    file,
    exports: [...parsed.exports, { kind: "local", name: "default", local: "default" }],
    declarations: new Set([...parsed.declarations, "default"]),
  };
  const template = readTemplate(source, end);
  return { module, tags: template.tags, styles: template.styles, problems: template.problems };
}
