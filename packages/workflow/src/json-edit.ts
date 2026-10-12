/**
 * Edit one value in a JSON document without re-serializing the rest, so a review diff shows
 * only the keys a draft changed, whatever the file's layout (expanded arrays, inline objects,
 * key order). A small recursive-descent reader records where each value starts and ends; an
 * edit splices new text into that span, indented to match its surroundings.
 */

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Member {
  readonly key: string;
  /** From the key's opening quote to the end of its value. */
  readonly span: Span;
  readonly value: Node;
}

type Node = (Span & { readonly kind: "object"; readonly members: readonly Member[] }) | (Span & { readonly kind: "array"; readonly items: readonly Node[] }) | (Span & { readonly kind: "scalar" });

export class JsonEditError extends Error {
  override name = "JsonEditError";
}

function parse(text: string): Node {
  let i = 0;
  const fail = (what: string): never => {
    throw new JsonEditError(`${what} at offset ${i}`);
  };
  const space = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (text[i] !== '"') fail("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): Node => {
    space();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      const members: Member[] = [];
      space();
      if (text[i] === "}") return { kind: "object", start, end: ++i, members };
      for (;;) {
        space();
        if (text[i] !== '"') fail("expected a key");
        const keyStart = i;
        const key = string();
        space();
        if (text[i] !== ":") fail("expected :");
        i++;
        const child = value();
        members.push({ key, span: { start: keyStart, end: child.end }, value: child });
        space();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") return { kind: "object", start, end: ++i, members };
        fail("expected , or }");
      }
    }
    if (ch === "[") {
      i++;
      const items: Node[] = [];
      space();
      if (text[i] === "]") return { kind: "array", start, end: ++i, items };
      for (;;) {
        items.push(value());
        space();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") return { kind: "array", start, end: ++i, items };
        fail("expected , or ]");
      }
    }
    if (ch === '"') {
      string();
      return { kind: "scalar", start, end: i };
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!literal) fail("unexpected character");
    i += literal![0].length;
    return { kind: "scalar", start, end: i };
  };
  const root = value();
  space();
  if (i !== text.length) fail("trailing text");
  return root;
}

/** The indentation of the line `offset` is on. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** The file's indent unit: the first indented line's indentation, else two spaces. */
function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
}

/** `value` as JSON at a given depth: nested lines carry the surrounding indentation. */
function render(value: unknown, unit: string, indent: string): string {
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);
}

function find(root: Node, path: readonly string[]): { parent: Node | null; member: Member | null; node: Node | null; depth: number } {
  let node: Node = root;
  let parent: Node | null = null;
  let member: Member | null = null;
  for (let depth = 0; depth < path.length; depth++) {
    if (node.kind !== "object") return { parent: node, member: null, node: null, depth };
    const next = node.members.find((m) => m.key === path[depth]);
    if (!next) return { parent: node, member: null, node: null, depth };
    parent = node;
    member = next;
    node = next.value;
  }
  return { parent, member, node, depth: path.length };
}

/** The value at `path`, or undefined. */
export function readJsonPath(text: string, path: readonly string[]): unknown {
  let value: unknown = JSON.parse(text);
  for (const key of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Set the value at `path` (object keys), creating missing objects on the way. Lines outside
 * the edited value are left byte for byte; a value equal to the current one changes nothing.
 */
export function setJsonPath(text: string, path: readonly string[], value: unknown): string {
  if (path.length === 0) throw new JsonEditError("cannot replace the whole document");
  if (JSON.stringify(readJsonPath(text, path)) === JSON.stringify(value)) return text;
  const root = parse(text);
  const unit = indentUnit(text);
  const found = find(root, path);
  if (found.node && found.member) {
    const indent = lineIndent(text, found.member.span.start);
    return `${text.slice(0, found.node.start)}${render(value, unit, indent)}${text.slice(found.node.end)}`;
  }
  // Insert the missing part under the deepest object that exists.
  const container = found.parent;
  if (!container || container.kind !== "object") throw new JsonEditError(`${path.slice(0, found.depth).join(".") || "the document"} is not an object`);
  const rest = path.slice(found.depth);
  const nested = rest.slice(1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  const last = container.members.at(-1);
  const closing = container.end - 1;
  if (last) {
    const indent = lineIndent(text, last.span.start);
    const entry = `${JSON.stringify(rest[0])}: ${render(nested, unit, indent)}`;
    const inline = !text.slice(container.start, container.end).includes("\n");
    return inline ? `${text.slice(0, last.span.end)}, ${entry}${text.slice(last.span.end)}` : `${text.slice(0, last.span.end)},\n${indent}${entry}${text.slice(last.span.end)}`;
  }
  const outer = lineIndent(text, container.start);
  const indent = `${outer}${unit}`;
  return `${text.slice(0, container.start + 1)}\n${indent}${JSON.stringify(rest[0])}: ${render(nested, unit, indent)}\n${outer}${text.slice(closing)}`;
}

/** Remove the member at `path`, with its comma; then any object it leaves empty on the way up. Absent paths change nothing. */
export function deleteJsonPath(text: string, path: readonly string[]): string {
  if (readJsonPath(text, path) === undefined) return text;
  const root = parse(text);
  const { parent, member } = find(root, path);
  if (!parent || parent.kind !== "object" || !member) return text;
  const index = parent.members.indexOf(member);
  const previous = parent.members[index - 1];
  const next = parent.members[index + 1];
  let result: string;
  if (previous) result = `${text.slice(0, previous.span.end)}${text.slice(member.span.end)}`;
  else if (next) result = `${text.slice(0, member.span.start)}${text.slice(next.span.start)}`;
  else result = `${text.slice(0, parent.start + 1)}${text.slice(parent.end - 1)}`;
  // A group left with no members goes too: DTCG groups exist for their tokens.
  if (!previous && !next && path.length > 1) return deleteJsonPath(result, path.slice(0, -1));
  return result;
}
