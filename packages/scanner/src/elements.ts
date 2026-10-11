/** Which canonical symbols are design-system elements. */
import { basename } from "node:path";
import type { ComponentContract, ElementId } from "@youiyoux/core";
import type { Project } from "./project.ts";

export interface ElementBinding {
  readonly element: ElementId;
  readonly contract: ComponentContract;
  /** The exported name this symbol is (Button, CardHeader, buttonVariants). */
  readonly exportName: string;
  /** component: the element itself; part: a sub-part (TabsTrigger); variants: its style function. */
  readonly role: "component" | "part" | "variants";
}

export interface ElementIndex {
  /** `<project-relative file>#<export>` → binding. */
  readonly byCanonical: ReadonlyMap<string, ElementBinding>;
  /** Exported name → element, for spotting lookalikes and unknown candidates by name. */
  readonly byName: ReadonlyMap<string, ElementBinding>;
  /** Project-relative paths of every vendored implementation file. */
  readonly implementationFiles: ReadonlySet<string>;
  readonly contracts: ReadonlyMap<ElementId, ComponentContract>;
  /** True for files in the owned components directory (contracted or not yet). */
  readonly isOwned: (file: string) => boolean;
}

/** Where a contract's source file lives inside a project. */
export function vendoredPath(project: Project, sourceFile: string): string {
  return `${project.config.componentsDir}/${basename(sourceFile)}`;
}

export function canonicalKey(file: string, exportName: string): string {
  return `${file}#${exportName}`;
}

export function buildElementIndex(project: Project): ElementIndex {
  const byCanonical = new Map<string, ElementBinding>();
  const byName = new Map<string, ElementBinding>();
  const implementationFiles = new Set<string>();
  const contracts = new Map<ElementId, ComponentContract>();
  for (const { contract } of project.system.components) {
    contracts.set(contract.id, contract);
    const file = vendoredPath(project, contract.source.file);
    implementationFiles.add(file);
    const add = (exportName: string, role: ElementBinding["role"]): void => {
      const binding = { element: contract.id, contract, exportName, role };
      byCanonical.set(canonicalKey(file, exportName), binding);
      byName.set(exportName, binding);
    };
    add(contract.source.export, "component");
    for (const part of contract.source.also) add(part, "part");
    for (const alias of contract.aliases) add(alias, "variants");
  }
  for (const support of project.system.config.support) implementationFiles.add(vendoredPath(project, support));
  const ownedPrefix = `${project.config.componentsDir}/`;
  return { byCanonical, byName, implementationFiles, contracts, isOwned: (file) => file.startsWith(ownedPrefix) };
}
