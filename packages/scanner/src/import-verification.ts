/**
 * Independent checks over TypeScript's AST and binding table. These checks never ask the
 * import planner which syntax it recognized: missed imports/uses must still fail a gate.
 */
import ts from "typescript";
import type { MigrationSpec } from "@youiyoux/core";
import type { GateResult, Residual } from "./codemod.ts";
import { exportChanges } from "./import-rewrite.ts";
import { ExportOrigins } from "./export-origin.ts";
import type { ScanResult } from "./scan.ts";

type Ref = { file: string; name: string } | { external: true };

function sourceOf(node: ts.Node): string | null {
  for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
    if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier && ts.isStringLiteral(parent.moduleSpecifier)) return parent.moduleSpecifier.text;
  }
  return null;
}

function importedName(node: ts.Declaration): string | null {
  if (ts.isImportSpecifier(node)) return (node.propertyName ?? node.name).text;
  if (ts.isImportClause(node)) return "default";
  if (ts.isNamespaceImport(node)) return "*";
  return null;
}

function nodesIn(root: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const walk = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return nodes;
}

function semanticSources(scan: ScanResult): { sources: Map<string, ts.SourceFile>; checker: ts.TypeChecker } {
  const sources = new Map([...scan.modules.values()].filter((m) => m.lang !== "css").map((m) => [m.file, ts.createSourceFile(m.file, m.source, ts.ScriptTarget.Latest, true)]));
  const host: ts.CompilerHost = {
    getSourceFile: (file) => sources.get(file),
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: (file) => sources.has(file), readFile: (file) => sources.get(file)?.text,
    getCanonicalFileName: (file) => file, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([...sources.keys()], {
    noLib: true, noResolve: true, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolvePackageJsonImports: false, resolvePackageJsonExports: false,
  }, host);
  return { sources, checker: program.getTypeChecker() };
}

export async function verifyImports(migration: MigrationSpec, before: ScanResult, after: ScanResult, target: string, outputs: ReadonlyMap<string, string>, residuals: readonly Residual[]): Promise<{ resolution: GateResult; leftover: string[] }> {
  const changes = exportChanges(migration);
  const oldNames = new Set(changes.map((c) => c.from));
  const origins = new ExportOrigins(after.graph, target, new Map(changes.map((c) => [c.from, c])), after.elements);
  const { sources, checker } = semanticSources(after);
  const leftover = new Set<string>();
  const unresolved = new Set<string>();
  const held = new Set(residuals.filter((r) => before.modules.get(r.file)?.source === after.modules.get(r.file)?.source).map((r) => r.file));
  const refFrom = (file: string, specifier: string, name: string): Ref | null => {
    const resolved = after.graph.resolveSpecifier(specifier, file);
    return resolved.kind === "file" ? { file: resolved.file, name } : resolved.kind === "external" ? { external: true } : null;
  };
  const resolve = async (ref: Ref | null): Promise<boolean> => {
    if (!ref) return false;
    if ("external" in ref || ref.name === "*") return true;
    return (await after.graph.resolveExport(ref.file, ref.name)).kind !== "unknown";
  };
  const old = async (ref: Ref | null): Promise<boolean> => !!ref && !("external" in ref) && (await origins.origin(ref.file, ref.name)) !== null;
  const holdsOld = async (ref: Ref | null): Promise<boolean> => {
    if (!ref || "external" in ref) return false;
    return (await origins.affected(ref.file)).length > 0;
  };

  for (const [file, source] of sources) {
    if (after.elements.isOwned(file) || after.elements.implementationFiles.has(file)) continue;
    const at = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const nodes = nodesIn(source);
    const original = ts.createSourceFile(file, before.modules.get(file)?.source ?? "", ts.ScriptTarget.Latest, true);
    const originalNodes = new Set(nodesIn(original).map((n) => `${n.kind}:${n.getText(original)}`));
    const changedNode = (node: ts.Node): boolean => !originalNodes.has(`${node.kind}:${node.getText(source)}`);
    const rewritten = outputs.has(file);
    // Text coverage includes quoted names. AST nodes classify each executable/name-bearing hit;
    // comments, prose strings, and JSX text have no binding and are intentionally ignored.
    const textHits = new Set<number>();
    for (const name of oldNames) {
      const regex = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "g");
      for (const hit of source.text.matchAll(regex)) textHits.add(hit.index);
    }
    const refForSymbol = (symbol: ts.Symbol | undefined): Ref | null => {
      const declaration = symbol?.declarations?.find((d) => importedName(d) !== null);
      const name = declaration ? importedName(declaration) : null;
      const specifier = declaration ? sourceOf(declaration) : null;
      return name && specifier ? refFrom(file, specifier, name) : null;
    };
    const importLocals = new Set(after.modules.get(file)!.imports.map((i) => i.local));
    const refForLocal = (node: ts.Identifier): Ref | null => importLocals.has(node.text) ? refForSymbol(checker.getSymbolAtLocation(node)) : null;
    const namespace = async (node: ts.Node): Promise<Ref | null> => {
      if (ts.isIdentifier(node)) {
        const ref = refForLocal(node);
        if (!ref || "external" in ref || ref.name === "*") return ref;
        const resolved = await after.graph.resolveExport(ref.file, ref.name);
        return resolved.kind === "namespace" ? { file: resolved.file, name: "*" } : null;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const base = await namespace(node.expression);
        if (!base || "external" in base) return base;
        const resolved = await after.graph.resolveExport(base.file, node.name.text);
        return resolved.kind === "namespace" ? { file: resolved.file, name: "*" } : null;
      }
      return null;
    };
    const memberRef = async (object: ts.Node, name: string): Promise<Ref | null> => {
      const base = await namespace(object);
      return base && !("external" in base) ? { file: base.file, name } : base;
    };
    const checkResolution = async (node: ts.Node, ref: Ref | null): Promise<void> => {
      if (rewritten && changedNode(node) && !(await resolve(ref))) unresolved.add(at(node));
    };

    for (const node of nodes) {
      // Independently enumerate every import and sourced export, types included.
      if (ts.isImportSpecifier(node) || ts.isImportClause(node) && node.name || ts.isNamespaceImport(node)) {
        const name = importedName(node as ts.Declaration)!;
        const specifier = sourceOf(node);
        const ref = specifier ? refFrom(file, specifier, name) : null;
        // Compare the containing statement too: changing its source may break an unchanged specifier.
        const statement = ts.findAncestor(node, ts.isImportDeclaration)!;
        await checkResolution(statement, ref);
        if (!held.has(file) && await old(ref)) leftover.add(at(node));
      }
      if (ts.isExportSpecifier(node) && sourceOf(node)) {
        const ref = refFrom(file, sourceOf(node)!, (node.propertyName ?? node.name).text);
        const statement = ts.findAncestor(node, ts.isExportDeclaration)!;
        await checkResolution(statement, ref);
        if (!held.has(file) && await old(ref)) leftover.add(at(node));
      }
      if (ts.isExportSpecifier(node) && !sourceOf(node)) {
        const symbol = checker.getExportSpecifierLocalTargetSymbol(node);
        const ref = refForSymbol(symbol);
        if (!held.has(file) && (await old(ref) || !symbol && oldNames.has((node.propertyName ?? node.name).text))) leftover.add(at(node));
        if (ref) await checkResolution(node, ref);
      }
      if (ts.isPropertyAccessExpression(node)) {
        const ref = await memberRef(node.expression, node.name.text);
        if (ref) {
          await checkResolution(node, ref);
          if (!held.has(file) && await old(ref)) leftover.add(at(node));
        }
      }
      if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
        const ref = await memberRef(node.left, node.right.text);
        if (ref) {
          await checkResolution(node, ref);
          if (!held.has(file) && await old(ref)) leftover.add(at(node));
        }
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        const qualifier = node.qualifier;
        const name = qualifier && ts.isIdentifier(qualifier) ? qualifier.text : "*";
        const ref = refFrom(file, node.argument.literal.text, name);
        await checkResolution(node, ref);
        if (!held.has(file) && (name === "*" ? await holdsOld(ref) : await old(ref))) leftover.add(at(node));
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const ref = refFrom(file, node.arguments[0].text, "*");
        if (!held.has(file) && await holdsOld(ref)) leftover.add(at(node));
      }
      if (!held.has(file) && ts.isIdentifier(node)) {
        const parent = node.parent;
        const isBinding = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
        const staticMember = ts.isPropertyAccessExpression(parent) && parent.expression === node || ts.isQualifiedName(parent) && parent.left === node;
        if (!isBinding && !staticMember && await holdsOld(await namespace(node))) leftover.add(at(node));
      }
      if (held.has(file) || !ts.isIdentifier(node) || !oldNames.has(node.text) || !textHits.has(node.getStart(source))) continue;
      const parent = node.parent;
      // Imported/exported names and members were checked above. Public aliases are intentional.
      if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) ||
          ts.isPropertyAccessExpression(parent) && parent.name === node || ts.isQualifiedName(parent) && parent.right === node ||
          ts.isImportTypeNode(parent) || ts.isJsxAttribute(parent) ||
          (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) continue;
      const symbol = checker.getSymbolAtLocation(node);
      const ref = refForLocal(node);
      if (ref) {
        if (await old(ref)) leftover.add(at(node));
      } else if (!symbol?.declarations?.length) {
        // Includes a JSX/local use left behind after its import was renamed.
        leftover.add(at(node));
      }
    }
  }
  return {
    resolution: { name: "imports-resolve", ok: unresolved.size === 0, detail: unresolved.size ? `rewritten imports do not resolve: ${[...unresolved].join(", ")}` : "every rewritten import, re-export and namespace member resolves" },
    leftover: [...leftover],
  };
}
