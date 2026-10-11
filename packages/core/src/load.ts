/** Load and validate the design-language definitions repo into one in-memory graph. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DefinitionError, readDefinition } from "./files.ts";
import { parseId } from "./ids.ts";
import { ComponentContract, DesignConfig, MigrationSpec, RuleSpec, type SystemConfig } from "./schemas.ts";

export interface LoadedComponent {
  readonly contract: ComponentContract;
  /** Absolute directory of the component folder (holds the contract and its source file). */
  readonly dir: string;
  readonly migrations: readonly MigrationSpec[];
}

export interface LoadedSystem {
  readonly config: SystemConfig;
  readonly components: readonly LoadedComponent[];
  readonly rules: readonly RuleSpec[];
}

export interface DesignRepo {
  readonly root: string;
  readonly config: DesignConfig;
  readonly systems: readonly LoadedSystem[];
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadComponent(root: string, dir: string): Promise<LoadedComponent | null> {
  const entries = await listDir(dir);
  const contractFile = entries.find((name) => name.endsWith(".contract.json"));
  if (!contractFile) return null;
  const contract = await readDefinition(join(dir, contractFile), ComponentContract, root);
  const migrationDir = join(dir, "migrations");
  const migrations = await Promise.all(
    (await listDir(migrationDir)).filter((name) => /\.ya?ml$/.test(name)).map((name) => readDefinition(join(migrationDir, name), MigrationSpec, root)),
  );
  return { contract, dir, migrations };
}

async function loadSystem(root: string, config: SystemConfig): Promise<LoadedSystem> {
  const componentsDir = join(root, config.components);
  const loaded = await Promise.all((await listDir(componentsDir)).map((name) => loadComponent(root, join(componentsDir, name))));
  const components = loaded.filter((c): c is LoadedComponent => c !== null);
  const rulesDir = join(root, config.rules);
  const rules = await Promise.all(
    (await listDir(rulesDir)).filter((name) => name.endsWith(".rule.yaml")).map((name) => readDefinition(join(rulesDir, name), RuleSpec, root)),
  );
  return { config, components, rules };
}

/** Cross-file checks the per-file schemas cannot express. */
function validateGraph(system: LoadedSystem): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const ruleIds = new Set(system.rules.map((r) => r.id));
  const claim = (id: string, where: string): void => {
    if (ids.has(id)) problems.push(`${where}: duplicate id ${id}`);
    ids.add(id);
    const parsed = parseId(id);
    if (parsed && parsed.system !== system.config.id) problems.push(`${where}: id ${id} is outside system "${system.config.id}"`);
  };
  for (const rule of system.rules) claim(rule.id, `rule ${rule.id}`);
  for (const { contract, migrations } of system.components) {
    claim(contract.id, `component ${contract.name}`);
    for (const ruleId of contract.rules) {
      if (!ruleIds.has(ruleId)) problems.push(`component ${contract.name}: unknown rule ${ruleId}`);
    }
    for (const migration of migrations) {
      claim(migration.id, `migration ${migration.id}`);
      if (migration.element !== contract.id) problems.push(`migration ${migration.id}: element ${migration.element} is not ${contract.id}`);
    }
  }
  return problems;
}

export async function loadDesignRepo(root: string): Promise<DesignRepo> {
  const config = await readDefinition(join(root, "dl.config.json"), DesignConfig, root);
  const systems = await Promise.all(config.systems.map((system) => loadSystem(root, system)));
  const problems = systems.flatMap(validateGraph);
  if (problems.length > 0) throw new DefinitionError("design repo", problems);
  return { root, config, systems };
}

export function getSystem(repo: DesignRepo, id?: string): LoadedSystem {
  const system = id ? repo.systems.find((s) => s.config.id === id) : repo.systems[0];
  if (!system) throw new DefinitionError("dl.config.json", [`no system "${id}"; known: ${repo.systems.map((s) => s.config.id).join(", ")}`]);
  return system;
}
