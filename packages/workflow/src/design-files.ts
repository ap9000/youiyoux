/**
 * Where a rule's definitions live in the design repository, read at an exact commit, and
 * the files a review branch carries for a draft.
 */
import { posix, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseId, sha256, toPosix, type RuleSpec } from "@youiyoux/core";
import type { Project } from "@youiyoux/scanner";
import { resolverLayout } from "@youiyoux/tokens";
import type { DraftContent, StyleDraftContent } from "./api.ts";
import { componentChanges, renderContract, renderRuleYaml } from "./drafts.ts";
import { listAt, listTreeAt, readAt, type RepoLocation } from "./git.ts";
import { effectiveStateEdits, renderContractStates, renderTokenEdits, type TokenFiles } from "./style-drafts.ts";

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

  /* ------------------------------------------------------------ style drafts */

  /** The directory holding the system's resolver, design-root-relative. */
  get tokensDir(): string {
    return posix.dirname(this.project.system.config.tokens);
  }

  /** Every file in the tokens directory at `commit` (design-root-relative path → text): what a token build reads. */
  async tokenTree(commit: string): Promise<Map<string, string>> {
    const dir = this.tokensDir;
    const names = await listTreeAt(this.repo.top, commit, this.top(dir));
    const entries = await Promise.all(names.map(async (name) => [`${dir}/${name}`, (await this.read(commit, `${dir}/${name}`)) ?? ""] as const));
    return new Map(entries);
  }

  /** The system's token files at `commit`: the resolver's layout and the text of every file it reads. */
  async tokenFiles(commit: string): Promise<TokenFiles> {
    const { config } = this.project.system;
    const resolverText = await this.read(commit, config.tokens);
    if (resolverText === null) throw new Error(`${config.tokens} is not in the design repository at ${commit.slice(0, 7)}`);
    const layout = resolverLayout(JSON.parse(resolverText), config.themeModifier);
    const texts = new Map<string, string>();
    for (const ref of layout.files) {
      const path = posix.normalize(`${this.tokensDir}/${ref}`);
      const text = await this.read(commit, path);
      if (text !== null) texts.set(path, text);
    }
    return { dir: this.tokensDir, layout, texts, light: config.themeModifier?.light ?? "", dark: config.themeModifier?.dark ?? null };
  }

  /** The files a style draft could touch: every token file the resolver reads and every contract that declares states. */
  async stylePaths(commit: string): Promise<string[]> {
    const tokenPaths = [...(await this.tokenFiles(commit)).texts.keys()];
    const contracts = await Promise.all(this.project.system.components.filter((c) => c.contract.states).map((c) => this.contractPath(commit, c.contract.id)));
    return [...tokenPaths, ...contracts.filter((p): p is string => p !== null)];
  }

  /** The files (design-root-relative path → content) a review branch for a style draft writes on `commit`: only the edited keys change. */
  async styleFilesFor(commit: string, content: StyleDraftContent, types: ReadonlyMap<string, string>): Promise<{ files: Record<string, string>; problems: string[] }> {
    const rendered = renderTokenEdits(await this.tokenFiles(commit), content.tokens, types);
    const files: Record<string, string> = { ...rendered.files };
    const states = effectiveStateEdits(content, this.project.system.components.map((c) => c.contract));
    for (const component of new Set(states.map((s) => s.component))) {
      const path = await this.contractPath(commit, component);
      const text = path ? await this.read(commit, path) : null;
      const next = text ? renderContractStates(text, states.filter((s) => s.component === component)) : null;
      if (path && next) files[path] = next;
      else if (!path || !text) rendered.problems.push(`states: the contract of ${component} is not in the design repository at ${commit.slice(0, 7)}`);
    }
    return { files, problems: rendered.problems };
  }
}
