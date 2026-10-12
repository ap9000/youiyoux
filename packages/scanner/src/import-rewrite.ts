/**
 * The import pass of a migration: an element's implementation file renames or removes an export.
 *
 * A name counts only if it resolves (through barrels, `export *` and re-exports) to the element's
 * vendored file under the old name, before `youi sync` or after it, when the old name no longer
 * resolves and the chain is followed to that file instead. Lookalikes that resolve elsewhere are
 * never touched, nor are vendored implementation files. Rewritten:
 *   import specifiers  named, aliased, default (`{ default as Card }`), type-only, keeping `type`
 *   re-exports         `export { Card } from`, `export { Card as default } from` in product barrels
 *   uses of a local    that had the old name: JSX tags, references, types, `export { Card }`
 *   namespace members  `ui.Card`, `<ui.Card>`, `ui.CardProps` in types
 * A file is left unchanged, with one residual per site, when a rewrite is ambiguous: the old local
 * is re-declared, the new name is already used, a namespace import is used dynamically, or an
 * export is removed with no replacement.
 */
import type { Edit, SgNode } from "@ast-grep/napi";
import type { MigrationSpec } from "@youiyoux/core";
import type { Residual } from "./codemod.ts";
import { vendoredPath } from "./elements.ts";
import { ExportOrigins, type ExportOrigin } from "./export-origin.ts";
import { unquote, type ModuleInfo } from "./parse.ts";
import type { Project } from "./project.ts";
import type { ScanResult } from "./scan.ts";

/** An export of the element's file that goes away: renamed to `to`, or removed (`to` null: no replacement). */
export interface ExportChange {
  readonly from: string;
  readonly to: string | null;
  readonly renameBarrels?: boolean;
}

export function exportChanges(migration: MigrationSpec): ExportChange[] {
  return migration.changes.flatMap((change): ExportChange[] => {
    if ("renameExport" in change) return [change.renameExport];
    if ("removeExport" in change) return [{ from: change.removeExport.name, to: change.removeExport.replacement ?? null }];
    return [];
  });
}

/** Names a module exports, including types and interfaces. */
export function exportedNames(module: ModuleInfo): Set<string> {
  const names = new Set(module.exports.map((e) => e.name));
  for (const statement of module.root.root().children()) {
    const name = statement.kind() === "export_statement" ? statement.field("declaration")?.field("name") : null;
    if (name) names.add(name.text());
  }
  return names;
}

export interface ImportSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface ImportPlan {
  /** The element's vendored implementation file, which declares the exports. */
  readonly target: string;
  readonly outputs: Map<string, string>;
  /** Import, re-export and namespace-member sites rewritten. */
  readonly edited: number;
  readonly residuals: Residual[];
  /** Files left unchanged because a rewrite there is ambiguous, and why. */
  readonly held: Map<string, string>;
  /** Every planned site, including unchanged bindings whose barrel may be held. */
  readonly sites: ImportSite[];
  readonly keptBarrels: Array<ImportSite & { name: string }>;
}

const emptyPlan = (target: string): ImportPlan => ({ target, outputs: new Map(), edited: 0, residuals: [], held: new Map(), sites: [], keptBarrels: [] });

const lineOf = (node: SgNode): number => node.range().start.line + 1;
const where = (file: string, node: SgNode): ImportSite => ({ file, line: lineOf(node), column: node.range().start.column + 1 });

/** Parent kind → the field that declares a name there ("" for every child). */
const DECLARES: Readonly<Record<string, string>> = {
  variable_declarator: "name",
  function_declaration: "name",
  function_expression: "name",
  generator_function_declaration: "name",
  generator_function: "name",
  class_declaration: "name",
  abstract_class_declaration: "name",
  class: "name",
  required_parameter: "pattern",
  optional_parameter: "pattern",
  arrow_function: "parameter",
  catch_clause: "parameter",
  type_alias_declaration: "name",
  interface_declaration: "name",
  enum_declaration: "name",
  type_parameter: "name",
  pair_pattern: "value",
  assignment_pattern: "left",
  for_in_statement: "left",
  array_pattern: "",
  rest_pattern: "",
};

function declares(node: SgNode): boolean {
  if (node.kind() === "shorthand_property_identifier_pattern") return true;
  const parent = node.parent();
  const field = parent ? DECLARES[String(parent.kind())] : undefined;
  if (!parent || field === undefined) return false;
  return field === "" || parent.field(field)?.id() === node.id();
}

const NAME_KINDS = ["identifier", "type_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"];

function namesIn(root: SgNode, text: string): SgNode[] {
  const regex = `^${text.replace(/\$/g, "\\$")}$`;
  return root.findAll({ rule: { any: NAME_KINDS.map((kind) => ({ kind, regex })) } });
}

/** `export { a as b } from "x"`: both names belong to another module, not to this file's scope. */
function inSourcedExport(node: SgNode): boolean {
  const spec = node.parent();
  return spec?.kind() === "export_specifier" && spec.parent()?.parent()?.field("source") !== null && spec.parent()?.parent()?.kind() === "export_statement";
}

/** Whether this node binds or refers to a local of that name (rather than naming another module's export). */
function isLocalName(node: SgNode): boolean {
  const parent = node.parent();
  if (!parent) return false;
  // Qualified member names are not local bindings.
  if (["nested_type_identifier", "nested_identifier"].includes(String(parent.kind())) && (parent.field("name") ?? parent.field("property"))?.id() === node.id()) return false;
  if (parent.kind() === "import_specifier") return (parent.field("alias") ?? parent.field("name"))?.id() === node.id();
  if (parent.kind() === "export_specifier") return !inSourcedExport(node) && parent.field("name")?.id() === node.id();
  return true;
}

interface Pending {
  /** specifier: an import, re-export, default import or namespace member, the sites a person looks at; use: a use of a renamed local. */
  readonly kind: "specifier" | "use";
  readonly site: ImportSite;
  readonly edits: Edit[];
  readonly chain: readonly string[];
  /** Set when this site cannot be rewritten at all: the export it names is removed with no replacement. */
  readonly blocked?: { readonly name: string; readonly reason: string };
}

interface LocalRename {
  readonly from: string;
  readonly to: string;
  /** The import binding's own node, excluded from the scope checks. */
  readonly binding: SgNode;
  readonly origin: ExportOrigin;
}

/** Is an import() call in a type position, rather than a runtime promise? */
function isImportType(call: SgNode): boolean {
  for (let node = call.parent(); node; node = node.parent()) {
    if (["type_query", "type_annotation", "type_alias_declaration", "type_arguments"].includes(String(node.kind()))) return true;
    if (["expression_statement", "variable_declarator", "arrow_function", "statement_block"].includes(String(node.kind()))) return false;
  }
  return false;
}

const spell = (node: SgNode, name: string): string => node.kind() === "string" ? `${node.text()[0]}${name}${node.text().at(-1)}` : name;

export async function planImports(project: Project, migration: MigrationSpec, scan: ScanResult): Promise<ImportPlan> {
  const changes = exportChanges(migration);
  const contract = scan.elements.contracts.get(migration.element);
  const target = contract ? vendoredPath(project, contract.source.file) : "";
  if (changes.length === 0 || !contract) return emptyPlan(target);
  const byOld = new Map(changes.map((c) => [c.from, c]));
  const { graph } = scan;
  const origins = new ExportOrigins(graph, target, byOld, scan.elements);
  const originFrom = async (module: ModuleInfo, specifier: string, name: string): Promise<ExportOrigin | null> => {
    const resolved = graph.resolveSpecifier(specifier, module.file);
    return resolved.kind === "file" ? origins.origin(resolved.file, name) : null;
  };
  const plan = emptyPlan(target);
  const files = new Map<string, { pending: Pending[]; ambiguities: Residual[]; source: string }>();
  const removed = (old: string): string => `imports ${old}, which ${contract.name}'s ${target} no longer exports; the migration declares no replacement`;

  for (const module of scan.modules.values()) {
    if (module.lang === "css" || scan.elements.isOwned(module.file) || scan.elements.implementationFiles.has(module.file)) continue;
    const top = module.root.root();
    const pending: Pending[] = [];
    const renames: LocalRename[] = [];
    const ambiguities: Residual[] = [];
    const namespaces: Array<{ local: string; binding: SgNode; file: string; chain: string[] }> = [];
    const publicNames: Array<{ from: string; to: string; node: SgNode }> = [];
    const ambiguous = (node: SgNode, reason: string): void => { ambiguities.push({ ...where(module.file, node), reason }); };
    const add = (node: SgNode, origin: ExportOrigin, edits: Edit[]): void => {
      pending.push({ kind: "specifier", site: where(module.file, node), edits, chain: origin.chain,
        ...(origin.next === null ? { blocked: { name: origin.old, reason: removed(origin.old) } } : {}) });
    };
    const keepPublic = (node: SgNode, name: string): void => { plan.keptBarrels.push({ ...where(module.file, node), name }); };

    for (const statement of top.children()) {
      const source = statement.field("source");
      if (!source) continue;
      const specifier = unquote(source.text());
      if (statement.kind() === "import_statement") {
        // Resolve both namespace imports and imports of namespace re-exports.
        for (const binding of module.imports.filter((i) => i.specifier === specifier)) {
          const resolved = graph.resolveSpecifier(specifier, module.file);
          const ns = resolved.kind === "file" ? await origins.namespace(resolved.file, binding.imported) : null;
          if (!ns) continue;
          const node = namesIn(statement, binding.local).find(isLocalName);
          if (node) namespaces.push({ local: binding.local, binding: node, ...ns });
        }
        const clause = statement.find({ rule: { kind: "import_clause" } });
        for (const child of clause?.children() ?? []) {
          if (child.kind() === "identifier") {
            const origin = await originFrom(module, specifier, "default");
            if (!origin) continue;
            const change = byOld.get(origin.old)!;
            const to = origin.next;
            const local = child.text();
            const nextLocal = change.renameBarrels && local === origin.old && change.to !== null ? change.to : local;
            const replacement = to !== null && to !== "default" ? `{ ${to} as ${nextLocal} }` : nextLocal;
            let edits = replacement !== local ? [child.replace(replacement)] : [];
            if (to !== null && to !== "default" && (clause?.children().filter((n) => n.isNamed()).length ?? 0) > 1) {
              // Keep the existing named/namespace clause; move the former default to its own import.
              const comma = clause!.children().find((n) => n.kind() === ",")!;
              const type = /^import\s+type\b/.test(statement.text()) ? "type " : "";
              const suffix = module.source.slice(source.range().end.index, statement.range().end.index);
              const start = statement.range().start.index;
              edits = [child.replace(""), comma.replace(""), { startPos: start, endPos: start, insertedText: `import ${type}${replacement} from ${source.text()}${suffix}\n` }];
            }
            add(child, origin, edits);
            if (nextLocal !== local) renames.push({ from: local, to: nextLocal, binding: child, origin });
          } else if (child.kind() === "named_imports") {
            for (const spec of child.findAll({ rule: { kind: "import_specifier" } })) {
              const nameNode = spec.field("name");
              if (!nameNode) continue;
              const imported = unquote(nameNode.text());
              const local = spec.field("alias")?.text() ?? imported;
              const origin = await originFrom(module, specifier, imported);
              if (!origin) continue;
              const change = byOld.get(origin.old)!;
              const nextImported = origin.next ?? imported;
              const nextLocal = local === origin.old && change.to !== "default" && (nextImported !== imported || change.renameBarrels) ? change.to ?? local : local;
              const typePrefix = /^type\s+/.exec(spec.text())?.[0] ?? "";
              const written = spell(nameNode, nextImported);
              const replacement = `${typePrefix}${nextImported === nextLocal && nameNode.kind() !== "string" ? written : `${written} as ${nextLocal}`}`;
              add(spec, origin, replacement !== spec.text() ? [spec.replace(replacement)] : []);
              if (nextLocal !== local) renames.push({ from: local, to: nextLocal, binding: spec.field("alias") ?? nameNode, origin });
            }
          }
        }
      } else if (statement.kind() === "export_statement") {
        for (const spec of statement.findAll({ rule: { kind: "export_specifier" } })) {
          const nameNode = spec.field("name");
          if (!nameNode) continue;
          const imported = unquote(nameNode.text());
          const aliasNode = spec.field("alias");
          const exported = unquote(aliasNode?.text() ?? imported);
          const origin = await originFrom(module, specifier, imported);
          if (!origin) continue;
          const change = byOld.get(origin.old)!;
          const nextImported = origin.next ?? imported;
          const nextExported = change.renameBarrels && exported === origin.old ? change.to ?? exported : exported;
          const written = spell(nameNode, nextImported);
          const publicName = aliasNode ? spell(aliasNode, nextExported) : nextExported;
          const typePrefix = /^type\s+/.exec(spec.text())?.[0] ?? "";
          const replacement = `${typePrefix}${nextImported === nextExported ? written : `${written} as ${publicName}`}`;
          add(spec, origin, replacement !== spec.text() ? [spec.replace(replacement)] : []);
          if (nextExported !== exported) publicNames.push({ from: exported, to: nextExported, node: spec });
          else if (nextImported !== imported) keepPublic(spec, exported);
        }
        // A product export-star also has outside consumers: retain old names as explicit aliases.
        if (/^export\s+(?:type\s+)?\*\s+from/.test(statement.text())) {
          const aliases: string[] = [];
          for (const change of changes) {
            const origin = await originFrom(module, specifier, change.from);
            if (!origin) continue;
            add(statement, origin, []);
            if (!change.renameBarrels && origin.next !== null && origin.next !== change.from && !module.exports.some((e) => e.name === change.from)) {
              aliases.push(`${origin.next} as ${change.from}`);
              keepPublic(statement, change.from);
            }
          }
          if (aliases.length) {
            const type = /^export\s+type\b/.test(statement.text()) ? "type " : "";
            pending.push({ kind: "use", site: where(module.file, statement), chain: [], edits: [statement.replace(`${statement.text()}\nexport ${type}{ ${aliases.join(", ")} } from ${source.text()};`)] });
          }
        }
      }
    }

    // Local-import barrels can publish a different name, even when their import local is aliased.
    for (const statement of top.children()) {
      if (statement.kind() !== "export_statement" || statement.field("source")) continue;
      for (const node of statement.findAll({ rule: { kind: "export_specifier" } })) {
        const name = node.field("name");
        if (!name) continue;
        const binding = module.imports.find((i) => i.local === name.text());
        if (!binding) continue;
        const origin = await originFrom(module, binding.specifier, binding.imported);
        if (!origin) continue;
        const alias = node.field("alias");
        const exported = unquote(alias?.text() ?? name.text());
        const local = renames.find((r) => r.from === name.text())?.to ?? name.text();
        const change = byOld.get(origin.old)!;
        const nextExported = change.renameBarrels && exported === origin.old ? change.to ?? exported : exported;
        const typePrefix = /^type\s+/.exec(node.text())?.[0] ?? "";
        const publicName = alias ? spell(alias, nextExported) : nextExported;
        const replacement = `${typePrefix}${local === nextExported ? local : `${local} as ${publicName}`}`;
        add(node, origin, replacement !== node.text() ? [node.replace(replacement)] : []);
        if (nextExported !== exported) publicNames.push({ from: exported, to: nextExported, node });
        else if (local !== name.text() || origin.next !== binding.imported) keepPublic(node, exported);
      }
    }

    for (const node of top.findAll({ rule: { kind: "nested_type_identifier" } })) {
      const member = node.field("name");
      const qualifier = node.field("module");
      if (!member || !qualifier || !byOld.has(member.text())) continue;
      let base = qualifier;
      while (base.kind() === "nested_identifier" && base.field("object")) base = base.field("object")!;
      const local = base.text();
      const binding = module.imports.find((i) => i.local === local);
      if (!binding) continue;
      const resolved = graph.resolveSpecifier(binding.specifier, module.file);
      if (resolved.kind !== "file") continue;
      const ns = await origins.namespace(resolved.file, binding.imported);
      if (qualifier.id() === base.id() && ns && await origins.origin(ns.file, member.text())) continue;
      ambiguous(node, `qualified reference ${node.text()} cannot be traced to ${target}`);
    }

    for (const local of renames) {
      for (const node of namesIn(top, local.from)) {
        if (node.id() === local.binding.id() || !isLocalName(node)) continue;
        if (declares(node)) {
          ambiguous(node, `local ${local.from} is re-declared at line ${lineOf(node)}`);
          continue;
        }
        const parent = node.parent();
        if (parent?.kind() === "export_specifier") continue;
        const text = node.kind() === "shorthand_property_identifier" ? `${local.from}: ${local.to}` : local.to;
        pending.push({ kind: "use", site: where(module.file, node), chain: local.origin.chain, edits: [node.replace(text)] });
      }
      for (const node of namesIn(top, local.to)) {
        if (isLocalName(node)) ambiguous(node, `${local.to} is already used at line ${lineOf(node)}`);
      }
    }

    for (const ns of namespaces) {
      const holds = await origins.affected(ns.file);
      if (holds.length === 0) continue;
      for (const node of namesIn(top, ns.local)) {
        if (node.id() === ns.binding.id() || !isLocalName(node)) continue;
        const parent = node.parent();
        if (declares(node)) {
          ambiguous(node, `namespace ${ns.local} is re-declared at line ${lineOf(node)}`);
          continue;
        }
        const member = parent?.kind() === "member_expression" && parent.field("object")?.id() === node.id() ? parent.field("property") : parent?.kind() === "nested_type_identifier" && parent.field("module")?.id() === node.id() ? parent.field("name") : null;
        if (!member || !parent || !["property_identifier", "type_identifier"].includes(String(member.kind()))) {
          ambiguous(node, `namespace ${ns.local} is used dynamically at line ${lineOf(node)}, so its uses of ${holds.map((h) => h.old).join(", ")} cannot be traced`);
          continue;
        }
        const origin = await origins.origin(ns.file, member.text());
        if (!origin) continue;
        add(parent, { ...origin, chain: [...ns.chain, ...origin.chain] }, origin.next !== null && origin.next !== member.text() ? [member.replace(origin.next)] : []);
      }
    }

    for (const call of top.findAll({ rule: { kind: "call_expression" } })) {
      if (call.field("function")?.text() !== "import") continue;
      const source = call.field("arguments")?.children().find((n) => n.kind() === "string");
      if (!source) continue;
      const specifier = unquote(source.text());
      const resolved = graph.resolveSpecifier(specifier, module.file);
      const holds = resolved.kind === "file" ? await origins.affected(resolved.file) : [];
      if (holds.length === 0) continue;
      const parent = call.parent();
      const member = parent?.kind() === "member_expression" ? parent.field("property") : null;
      if (isImportType(call) && member) {
        const origin = await originFrom(module, specifier, member.text());
        if (origin) add(member, origin, origin.next !== null && origin.next !== member.text() ? [member.replace(origin.next)] : []);
      } else {
        ambiguous(call, `dynamic import of ${specifier}; its uses of ${holds.map((h) => h.old).join(", ")} cannot be traced`);
      }
    }

    for (const name of publicNames) {
      if (module.exports.some((e) => e.name === name.to)) ambiguous(name.node, `this file already exports ${name.to}, so ${name.from} cannot take that name (line ${lineOf(name.node)})`);
    }
    const primary = pending.filter((p) => p.kind === "specifier");
    const blocked = primary.find((p) => p.blocked !== undefined);
    const why = blocked ? `${blocked.blocked!.name} is imported at line ${blocked.site.line} and removed with no replacement` : ambiguities[0]?.reason;
    if (why !== undefined) plan.held.set(module.file, why);
    plan.sites.push(...primary.map((p) => p.site), ...ambiguities);
    files.set(module.file, { pending, ambiguities, source: top.commitEdits(pending.flatMap((p) => p.edits)) });
  }

  // Holding a barrel holds all its consumers, including unchanged/type-only bindings.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, { pending }] of files) {
      if (plan.held.has(file)) continue;
      const dependency = pending.flatMap((p) => p.chain).find((path) => plan.held.has(path));
      if (!dependency) continue;
      plan.held.set(file, `imports through held file ${dependency}: ${plan.held.get(dependency)}`);
      changed = true;
    }
  }
  let edited = 0;
  for (const [file, { pending, ambiguities, source }] of files) {
    const why = plan.held.get(file);
    const primary = pending.filter((p) => p.kind === "specifier");
    if (why !== undefined) {
      for (const p of primary) plan.residuals.push({ ...p.site, reason: p.blocked?.reason ?? `not rewritten: ${why}` });
      plan.residuals.push(...ambiguities.map((a) => ({ ...a, reason: `not rewritten: ${a.reason}` })));
    } else if (source !== scan.modules.get(file)!.source) {
      plan.outputs.set(file, source);
      edited += primary.filter((p) => p.edits.length > 0).length;
    }
  }
  return { ...plan, edited, keptBarrels: plan.keptBarrels.filter((b) => plan.outputs.has(b.file)) };
}
