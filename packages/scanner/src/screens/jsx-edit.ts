/**
 * A live edit written into the code: on the JSX element a component was placed by (its file and
 * line, from the capture's source maps), a prop's literal value changed, added or taken out, or its
 * plain text replaced. Only what is written as a literal is changed; a value computed in code, props
 * spread in that could set the same prop, or text that comes from code is refused with why, for a
 * person (or an agent, through a change request) to change by hand.
 *
 * Pure: source in, source out. The service checks the file and writes it (packages/workflow).
 */
import ts from "typescript";
import { EDIT_REFUSED, isScriptValue } from "./bridge.ts";

export type JsxValue = string | number | boolean;

export interface JsxChange {
  readonly prop: string;
  readonly value: JsxValue;
  /** The contract's default: setting it takes the attribute out, so the code says only what differs. */
  readonly default?: JsxValue;
}

export interface JsxEdit {
  /** The line (1-based) the element starts on, and its column when known. */
  readonly line: number;
  readonly column?: number | null;
  /** The component's name as the page knows it (`Button`), or an HTML tag. */
  readonly component: string;
  readonly set: readonly JsxChange[];
  /** New plain text for the element's children, or null to leave it. */
  readonly text?: string | null;
}

export type JsxEditResult =
  | { readonly ok: true; readonly source: string; readonly tag: string; readonly line: number; readonly before: string; readonly after: string }
  | { readonly ok: false; readonly why: string };

const PROP = /^[A-Za-z_$][\w$-]{0,63}$/;
const refuse = (why: string): JsxEditResult => ({ ok: false, why });

/** A prop's value as JSX writes it. */
function attribute(prop: string, value: JsxValue, quote: '"' | "'"): string {
  if (value === true) return prop;
  if (typeof value !== "string") return `${prop}={${String(value)}}`;
  // A JSX attribute string has no escapes: anything a quote can't hold goes in braces.
  return value.includes(quote) || /[\n\r\\{}]/.test(value) ? `${prop}={${JSON.stringify(value)}}` : `${prop}=${quote}${value}${quote}`;
}

/** Text as JSX children: plain where it can be, otherwise a string in braces. */
const childText = (text: string): string => (/^[^{}<>\n\r]*$/.test(text) && text.trim() === text && text !== "" ? text : `{${JSON.stringify(text)}}`);

/** A literal attribute's value, or undefined when the code computes it. */
function literal(init: ts.JsxAttributeValue | undefined): { value: JsxValue } | undefined {
  if (init === undefined) return { value: true };
  if (ts.isStringLiteral(init)) return { value: init.text };
  if (!ts.isJsxExpression(init) || !init.expression) return undefined;
  const e = init.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { value: e.text };
  if (ts.isNumericLiteral(e)) return { value: Number(e.text) };
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return { value: -Number(e.operand.text) };
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  return undefined;
}

export function editJsx(source: string, fileName: string, edit: JsxEdit): JsxEditResult {
  for (const change of edit.set) {
    if (!PROP.test(change.prop) || EDIT_REFUSED.test(change.prop)) return refuse(`${change.prop} isn't a prop a live edit sets: it can carry a URL, HTML, a style or a handler`);
    if (typeof change.value === "string" && isScriptValue(change.value)) return refuse(`${change.prop}'s value is a script address, which a live edit never writes`);
  }
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/.test(fileName) ? ts.ScriptKind.JSX : /\.ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (pos: number): number => file.getLineAndCharacterOfPosition(pos).line + 1;

  // Every element that starts on the line; the one named like the component, nearest the column.
  const starts: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && lineOf(node.getStart(file)) === edit.line) starts.push(node);
    node.forEachChild(visit);
  };
  visit(file);
  const tagOf = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string => node.tagName.getText(file);
  // Its own name, or the name this file imports it as (`Button as Action`).
  const aliases = new Set([edit.component]);
  for (const statement of file.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) if (spec.propertyName?.text === edit.component) aliases.add(spec.name.text);
  }
  const candidates = starts.filter((node) => aliases.has(tagOf(node)) || tagOf(node).endsWith(`.${edit.component}`));
  if (candidates.length === 0) return refuse(starts.length === 0 ? `no JSX element starts on line ${edit.line} any more: the code moved since the screen was captured, so capture it again` : `no ${edit.component} starts on line ${edit.line}: the code moved since the screen was captured, so capture it again`);
  const column = edit.column ?? null;
  const element = column === null ? candidates[0]! : candidates.reduce((best, node) => (Math.abs(file.getLineAndCharacterOfPosition(node.getStart(file)).character - column) < Math.abs(file.getLineAndCharacterOfPosition(best.getStart(file)).character - column) ? node : best));
  if (column === null && candidates.length > 1) return refuse(`${candidates.length} ${edit.component} elements start on line ${edit.line}, and the capture didn't say which: change it by hand`);

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const props = element.attributes.properties;
  const spreadAt = props.findIndex((p) => ts.isJsxSpreadAttribute(p));
  for (const change of edit.set) {
    const index = props.findIndex((p) => ts.isJsxAttribute(p) && p.name.getText(file) === change.prop);
    const attr = index >= 0 ? (props[index] as ts.JsxAttribute) : null;
    // A spread after the attribute (or with no attribute at all) may set the prop itself.
    if (spreadAt >= 0 && (attr === null || spreadAt > index)) return refuse(`${tagOf(element)} spreads props in (${props[spreadAt]!.getText(file)}), which can set ${change.prop} too: change it by hand`);
    const removing = change.default !== undefined && change.default === change.value;
    if (attr) {
      const now = literal(attr.initializer);
      if (!now) return refuse(`${change.prop} is computed in code (${attr.getText(file)}): change it by hand, or file it as a change request`);
      if (now.value === change.value && !removing) continue;
      if (removing) {
        // The attribute and the space (or line break) before it.
        replacements.push({ start: attr.getFullStart(), end: attr.getEnd(), text: "" });
      } else {
        const quote = attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.getText(file).startsWith("'") ? "'" : '"';
        replacements.push({ start: attr.getStart(file), end: attr.getEnd(), text: attribute(change.prop, change.value, quote) });
      }
    } else if (!removing) {
      const last = props.at(-1);
      const after = last ? last.getEnd() : element.tagName.getEnd();
      const own = last && lineOf(last.getStart(file)) !== lineOf(element.getStart(file));
      const indent = own ? /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", last!.getStart(file)) + 1))![0] : "";
      replacements.push({ start: after, end: after, text: `${own ? `\n${indent}` : " "}${attribute(change.prop, change.value, '"')}` });
    }
  }

  if (edit.text !== undefined && edit.text !== null) {
    if (!ts.isJsxOpeningElement(element)) return refuse(`${tagOf(element)} has no children in the code, so its text comes from elsewhere: change it by hand`);
    const children = element.parent.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
    const only = children.length === 1 ? children[0]! : null;
    if (only && ts.isJsxText(only)) {
      const raw = only.getText(file);
      const lead = /^\s*/.exec(raw)![0].length;
      const trail = /\s*$/.exec(raw)![0].length;
      replacements.push({ start: only.getStart(file) + lead, end: only.getEnd() - trail, text: childText(edit.text) });
    } else if (only && ts.isJsxExpression(only) && only.expression && (ts.isStringLiteral(only.expression) || ts.isNoSubstitutionTemplateLiteral(only.expression))) {
      replacements.push({ start: only.getStart(file), end: only.getEnd(), text: childText(edit.text) });
    } else return refuse(`${tagOf(element)}'s text isn't written as plain text in the code (it comes from a value or holds other elements): change it by hand`);
  }

  if (replacements.length === 0) return refuse("the code already says this");
  let next = source;
  for (const r of replacements.sort((a, b) => b.start - a.start)) next = next.slice(0, r.start) + r.text + next.slice(r.end);
  // The element's lines before and after, for a person to read before it is written.
  const node = ts.isJsxOpeningElement(element) ? element.parent : element;
  const first = lineOf(node.getStart(file));
  const lines = (text: string, count: number): string => text.split("\n").slice(first - 1, first - 1 + count).join("\n");
  const span = lineOf(node.getEnd()) - first + 1;
  const grown = next.split("\n").length - source.split("\n").length;
  return { ok: true, source: next, tag: tagOf(element), line: first, before: lines(source, span), after: lines(next, span + grown) };
}
