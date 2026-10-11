/**
 * Where a rule's definitions live in the design repository, read at an exact commit, and
 * the files a review branch carries for a draft.
 */
import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseId, sha256, toPosix, type RuleSpec } from "@youiyoux/core";
import type { Project } from "@youiyoux/scanner";
import type { DraftContent } from "./api.ts";
import { componentChanges, renderContract, renderRuleYaml } from "./drafts.ts";
import { listAt, readAt, type RepoLocation } from "./git.ts";

const DEFAULT_SCHEMA_REF = "../schema/youi.rule.schema.json";

export class DesignFiles {
  private readonly repo: RepoLocation;
  private readonly project: Project;

  constructor(repo: RepoLocation, project: Project) {
    this.repo = repo;
    this.project = project;
  }

  /** Design-root-relative path → repository-top-relative path. */
  top(path: string): string {
    return `${this.repo.prefix}${path}`;
  }

  get rulesDir(): string {
    return this.project.system.config.rules;
  }

  async read(commit: string, path: string): Promise<string | null> {
    return readAt(this.repo.top, commit, this.top(path));
  }

  async digest(commit: string, path: string): Promise<string | null> {
    const text = await this.read(commit, path);
    return text === null ? null : sha256(text);
  }

  /** Every rule file at `commit`, by rule id. */
  async ruleFiles(commit: string): Promise<Map<string, { path: string; text: string }>> {
    const files = new Map<string, { path: string; text: string }>();
    for (const name of await listAt(this.repo.top, commit, this.top(this.rulesDir))) {
      if (!name.endsWith(".rule.yaml")) continue;
      const path = `${this.rulesDir}/${name}`;
      const text = (await this.read(commit, path)) ?? "";
      try {
        const id = (parseYaml(text) as { id?: unknown } | null)?.id;
        if (typeof id === "string") files.set(id, { path, text });
      } catch {
        // An unparsable rule file is the loader's problem to report; it cannot match an id.
      }
    }
    return files;
  }

  /** The path a rule lives at, or would be created at. */
  async rulePath(commit: string, ruleId: string): Promise<string> {
    const existing = (await this.ruleFiles(commit)).get(ruleId);
    if (existing) return existing.path;
    return `${this.rulesDir}/${parseId(ruleId)?.name ?? "new-rule"}.rule.yaml`;
  }

  async contractPath(commit: string, componentId: string): Promise<string | null> {
    const component = this.project.system.components.find((c) => c.contract.id === componentId);
    if (!component) return null;
    const dir = toPosix(relative(this.project.repo.root, component.dir));
    const name = (await listAt(this.repo.top, commit, this.top(dir))).find((n) => n.endsWith(".contract.json"));
    return name ? `${dir}/${name}` : null;
  }

  /** Components whose contract lists `ruleId` at `commit`. */
  async declaredBy(commit: string, ruleId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const { contract } of this.project.system.components) {
      const path = await this.contractPath(commit, contract.id);
      const text = path ? await this.read(commit, path) : null;
      if (text && ((JSON.parse(text) as { rules?: string[] }).rules ?? []).includes(ruleId)) ids.push(contract.id);
    }
    return ids;
  }

  /** The files (design-root-relative path → content) a review branch for this draft writes on `commit`. */
  async filesFor(commit: string, rule: RuleSpec, content: DraftContent): Promise<Record<string, string>> {
    const rules = await this.ruleFiles(commit);
    const existing = rules.get(rule.id);
    const sibling = [...rules.values()][0]?.text;
    const schemaRef = (sibling ? (parseYaml(sibling) as { $schema?: string } | null)?.$schema : undefined) ?? DEFAULT_SCHEMA_REF;
    const path = existing?.path ?? (await this.rulePath(commit, rule.id));
    const files: Record<string, string> = {};
    const ruleText = renderRuleYaml(rule, existing?.text ?? null, schemaRef);
    if (ruleText !== existing?.text) files[path] = ruleText;
    const { add, remove } = componentChanges(await this.declaredBy(commit, rule.id), content.components);
    for (const [ids, listed] of [[add, true], [remove, false]] as const) {
      for (const id of ids) {
        const contractPath = await this.contractPath(commit, id);
        const text = contractPath ? await this.read(commit, contractPath) : null;
        const next = text ? renderContract(text, rule.id, listed) : null;
        if (contractPath && next) files[contractPath] = next;
      }
    }
    return files;
  }
}
