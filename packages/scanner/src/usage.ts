/**
 * Per-module usage analysis. Every JSX tag, variants call and bare reference is
 * resolved to its canonical symbol and then classified:
 *   usage     – resolves to an owned design-system implementation
 *   lookalike – shares a design-system name but resolves somewhere else
 *   unknown   – cannot be resolved statically (never counted as zero or as a usage)
 */
import type { SgNode } from "@ast-grep/napi";
import { shortHash, type Lookalike, type PropValue, type RouteAttribution, type UnknownSite, type UsageSite } from "@youiyoux/core";
import { canonicalKey, type ElementBinding, type ElementIndex } from "./elements.ts";
import type { ModuleGraph, ResolvedSymbol } from "./graph.ts";
import { unquote, type ModuleInfo } from "./parse.ts";

export type LocalUsage = Omit<UsageSite, keyof RouteAttribution>;

export interface NativeSite {
  readonly tag: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly props: Readonly<Record<string, PropValue>>;
}

export interface ModuleAnalysis {
  readonly usages: readonly LocalUsage[];
  readonly unknowns: readonly UnknownSite[];
  readonly lookalikes: readonly Lookalike[];
  readonly natives: readonly NativeSite[];
}

const MAX_DYNAMIC = 120;
const TYPE_CONTEXTS = new Set(["type_annotation", "type_arguments", "type_query", "generic_type", "type_alias_declaration", "interface_declaration", "type_parameters"]);

function position(node: SgNode): { line: number; column: number } {
  const start = node.range().start;
  return { line: start.line + 1, column: start.column + 1 };
}

function literalOf(node: SgNode): PropValue {
  const kind = node.kind();
  if (kind === "string") return { literal: unquote(node.text()) };
  if (kind === "number") return { literal: Number(node.text()) };
  if (kind === "true" || kind === "false") return { literal: kind === "true" };
  if (kind === "template_string" && !node.text().includes("${")) return { literal: unquote(node.text()) };
  const text = node.text().replace(/\s+/g, " ");
  return { dynamic: text.length > MAX_DYNAMIC ? `${text.slice(0, MAX_DYNAMIC - 1)}…` : text };
}

/** JSX attributes → props; `{...rest}` marks the site as spread (props partly unknown). */
export function propsOf(element: SgNode): { props: Record<string, PropValue>; spread: boolean } {
  const props: Record<string, PropValue> = {};
  let spread = false;
  for (const child of element.children()) {
    if (child.kind() === "jsx_expression" && child.find({ rule: { kind: "spread_element" } })) spread = true;
    if (child.kind() !== "jsx_attribute") continue;
    const [name, value] = child.children().filter((c) => c.kind() !== "=");
    if (!name) continue;
    if (!value) props[name.text()] = { literal: true };
    else if (value.kind() === "jsx_expression") {
      const inner = value.children().find((c) => c.isNamed() && c.kind() !== "comment");
      props[name.text()] = inner ? literalOf(inner) : { dynamic: value.text() };
    } else props[name.text()] = literalOf(value);
  }
  return { props, spread };
}

/** `buttonVariants({ variant: "outline", size: "sm" })` → props of the first object argument. */
function callProps(call: SgNode): Record<string, PropValue> {
  const object = call.field("arguments")?.children().find((c) => c.kind() === "object");
  const props: Record<string, PropValue> = {};
  for (const pair of object?.findAll({ rule: { kind: "pair" } }) ?? []) {
    if (pair.parent()?.id() !== object?.id()) continue;
    const key = pair.field("key");
    const value = pair.field("value");
    if (key && value) props[unquote(key.text())] = literalOf(value);
  }
  return props;
}

function inTypeContext(node: SgNode): boolean {
  for (let current = node.parent(), depth = 0; current && depth < 8; current = current.parent(), depth++) {
    if (TYPE_CONTEXTS.has(String(current.kind()))) return true;
    if (String(current.kind()).endsWith("statement")) return false;
  }
  return false;
}

class Collector {
  readonly usages: LocalUsage[] = [];
  readonly unknowns: UnknownSite[] = [];
  readonly lookalikes: Lookalike[] = [];
  readonly natives: NativeSite[] = [];
  private readonly seenFingerprints = new Map<string, number>();
  private readonly module: ModuleInfo;
  private readonly elements: ElementIndex;

  constructor(module: ModuleInfo, elements: ElementIndex) {
    this.module = module;
    this.elements = elements;
  }

  private fingerprint(node: SgNode): string {
    const base = `${this.module.file}\0${node.text().replace(/\s+/g, " ")}`;
    const occurrence = this.seenFingerprints.get(base) ?? 0;
    this.seenFingerprints.set(base, occurrence + 1);
    return shortHash(`${base}\0${occurrence}`);
  }

  usage(binding: ElementBinding, node: SgNode, kind: LocalUsage["kind"], local: string, props: Record<string, PropValue>, spread: boolean): void {
    this.usages.push({ element: binding.element, kind, export: binding.exportName, local, props, spread, file: this.module.file, ...position(node), fingerprint: this.fingerprint(node) });
  }

  classify(symbol: ResolvedSymbol, node: SgNode, local: string, name: string): ElementBinding | null {
    const where = { file: this.module.file, ...position(node) };
    const exported = symbol.kind === "symbol" || symbol.kind === "external" ? symbol.name.split(".").at(-1)! : name;
    const candidate = this.elements.byName.get(exported) ?? this.elements.byName.get(name) ?? this.elements.byName.get(local);
    if (symbol.kind === "symbol") {
      const binding = this.elements.byCanonical.get(canonicalKey(symbol.file, symbol.name));
      if (binding) return binding;
      const definedHere = symbol.file === this.module.file && this.elements.implementationFiles.has(this.module.file);
      if (candidate && candidate.role !== "variants" && !definedHere && /^[A-Z]/.test(local)) this.lookalikes.push({ resembles: candidate.element, local, resolved: canonicalKey(symbol.file, symbol.name), ...where });
      return null;
    }
    if (symbol.kind === "external") {
      // Owned implementations wrap primitives that share their names (Radix Label inside Label).
      if (this.elements.isOwned(this.module.file)) return null;
      if (candidate && candidate.role !== "variants") this.lookalikes.push({ resembles: candidate.element, local, resolved: `${symbol.module}#${symbol.name}`, ...where });
      return null;
    }
    if (symbol.kind === "namespace") {
      this.unknowns.push({ name: local, reason: "namespace-member", detail: `${local} is a namespace object, rendered directly`, ...where });
      return null;
    }
    this.unknowns.push({ name: local, reason: symbol.reason, detail: symbol.detail, ...(candidate ? { candidate: candidate.element } : {}), ...where });
    return null;
  }
}

async function resolveTag(graph: ModuleGraph, module: ModuleInfo, tag: string): Promise<{ symbol: ResolvedSymbol; name: string }> {
  const parts = tag.split(".");
  if (parts.length === 1) return { symbol: await graph.resolveLocal(module, tag), name: tag };
  const [head, member] = parts as [string, string];
  const base = await graph.resolveLocal(module, head);
  if (parts.length > 2) return { symbol: { kind: "unknown", reason: "namespace-member", detail: `nested member ${tag}` }, name: parts.at(-1)! };
  if (base.kind === "namespace") return { symbol: await graph.resolveExport(base.file, member), name: member };
  if (base.kind === "external") return { symbol: { kind: "external", module: base.module, name: `${base.name}.${member}` }, name: member };
  return { symbol: { kind: "unknown", reason: "namespace-member", detail: `${tag}: ${head} is not a module namespace` }, name: member };
}

async function analyzeJsx(collector: Collector, graph: ModuleGraph, module: ModuleInfo): Promise<void> {
  for (const element of module.jsx) {
    const { props, spread } = propsOf(element.node);
    if (/^[a-z]/.test(element.tag) && !element.tag.includes(".")) {
      collector.natives.push({ tag: element.tag, file: module.file, line: element.line, column: element.column, props });
      continue;
    }
    const { symbol, name } = await resolveTag(graph, module, element.tag);
    const binding = collector.classify(symbol, element.node, element.tag, name);
    if (binding) collector.usage(binding, element.node, "render", element.tag, props, spread);
  }
}

/** Import locals that resolve to design-system elements (for calls and bare references). */
async function elementLocals(graph: ModuleGraph, module: ModuleInfo, elements: ElementIndex): Promise<Map<string, ElementBinding>> {
  const locals = new Map<string, ElementBinding>();
  for (const binding of module.imports) {
    if (binding.typeOnly || !elements.byName.has(binding.imported)) continue;
    const symbol = await graph.resolveLocal(module, binding.local);
    if (symbol.kind !== "symbol") continue;
    const element = elements.byCanonical.get(canonicalKey(symbol.file, symbol.name));
    if (element) locals.set(binding.local, element);
  }
  return locals;
}

const NOT_A_REFERENCE = new Set(["import_specifier", "namespace_import", "import_clause", "jsx_opening_element", "jsx_closing_element", "jsx_self_closing_element", "export_specifier", "member_expression"]);

function analyzeReferences(collector: Collector, module: ModuleInfo, locals: Map<string, ElementBinding>): void {
  if (locals.size === 0) return;
  for (const identifier of module.root.root().findAll({ rule: { kind: "identifier" } })) {
    const binding = locals.get(identifier.text());
    const parent = identifier.parent();
    if (!binding || !parent || NOT_A_REFERENCE.has(String(parent.kind())) || inTypeContext(identifier)) continue;
    if (parent.kind() === "call_expression" && parent.field("function")?.id() === identifier.id()) {
      if (binding.role === "variants") collector.usage(binding, parent, "variants", identifier.text(), callProps(parent), false);
      continue;
    }
    collector.usage(binding, identifier, "reference", identifier.text(), {}, false);
  }
}

export async function analyzeModule(module: ModuleInfo, graph: ModuleGraph, elements: ElementIndex): Promise<ModuleAnalysis> {
  const collector = new Collector(module, elements);
  if (module.lang === "css") return collector;
  await analyzeJsx(collector, graph, module);
  analyzeReferences(collector, module, await elementLocals(graph, module, elements));
  return collector;
}
