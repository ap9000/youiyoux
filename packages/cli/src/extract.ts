/**
 * `youiyoux system extract <dir>`: move a System kept inside its product (youiyoux adopt) into a
 * design repo of its own, for a second app to follow.
 *
 * The new repo is a plain design repo: each contract's implementation is copied beside it, the
 * support files into components/_shared, the tokens, rules and narrative as they were. It is built
 * in a folder beside `<dir>` and renamed into place once it loads, so it is never half there. The
 * product then follows it by path (`source.path`), its System files are removed, and sync records
 * its own components as vendored copies, identical to the new repo's: from then on a change to the
 * System is made there and merged 3-way into each product, and a change in a product is drift.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { DESIGN_CONFIG_FILE, implementationsDir, loadDesignRepo, normalizeRelPath, readTextOrNull, writeFileAtomic, type SystemConfig } from "@youiyoux/core";
import { escapingLinks, PROJECT_FILE, within, type Project } from "@youiyoux/scanner";

export interface ExtractOptions {
  /** Also write a package.json naming the new repo as this npm package. */
  readonly package?: string;
  readonly dryRun?: boolean;
}

export interface ExtractResult {
  readonly target: string;
  readonly system: SystemConfig;
  /** Files of the new repo, relative to it. */
  readonly written: readonly string[];
  /** The product's System files, relative to the product, removed once the new repo loads. */
  readonly removed: readonly string[];
  /** The product's new source. */
  readonly source: { readonly path: string };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const toPosix = (path: string): string => path.split(sep).join("/");

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** A System this product holds itself: its design repo is the product root and its implementations are the product's files. */
export async function heldInPlace(project: Project): Promise<boolean> {
  const [repo, root] = await Promise.all([realpath(project.repo.root), realpath(project.root)]);
  return repo === root && project.system.config.implementations !== undefined;
}

/**
 * Extract copies the System's folders into the new repo and then removes them from the product, so
 * each must hold the System alone: never the product's root (`"."`, which would copy the whole
 * product, secrets included, and remove it), never outside it, and never holding what must stay:
 * the components, the product's config, its generated outputs or the new repo itself.
 */
function ownedPaths(project: Project, paths: readonly string[], kept: readonly string[]): void {
  const root = project.repo.root;
  for (const path of paths) {
    const own = normalizeRelPath(path);
    if (own === "." || own.startsWith("../") || !within(root, join(root, own)) || resolve(root, own) === resolve(root)) throw new Error(`the System's ${path} is not a folder of its own inside ${root}: move its files into one (design/…) before extracting; nothing was changed`);
    for (const keep of kept.map((k) => normalizeRelPath(toPosix(k)))) {
      if (keep === own || keep.startsWith(`${own}/`)) throw new Error(`the System's ${own} holds ${keep}, which stays in the product: move the System's files into a folder of their own before extracting; nothing was changed`);
    }
  }
}

export async function extractSystem(project: Project, dir: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  if (!(await heldInPlace(project))) throw new Error(`${project.root}'s System is already a design repo of its own (${project.repo.root}): extract moves a System youiyoux adopt keeps inside the product`);
  const target = resolve(dir);
  if (await isDirectory(target)) {
    if ((await readdir(target)).length > 0) throw new Error(`${target} already exists and is not empty: extract into a new folder`);
  } else if ((await stat(target).catch(() => null)) !== null) throw new Error(`${target} already exists: extract into a new folder`);
  const { repo, system } = project;
  const config = system.config;
  const from = (path: string): string => join(repo.root, path);
  const components = from(config.components);
  const implementations = from(implementationsDir(config));
  const tokensDir = posix.dirname(config.tokens);
  const removed = [DESIGN_CONFIG_FILE, config.components, tokensDir, config.rules, ...(config.design ? [config.design] : [])];
  ownedPaths(project, removed, [implementationsDir(config), relative(project.root, project.configFile ?? join(project.root, PROJECT_FILE)), project.config.outputs.dir, relative(project.root, target)]);

  // The new system: every path inside the new repo, no implementations folder (they sit beside their contracts).
  const { implementations: _inPlace, ...rest } = config;
  const shared = config.support.map((file) => `_shared/${posix.basename(file)}`);
  const next: SystemConfig = { ...rest, tokens: `tokens/${posix.relative(tokensDir, config.tokens)}`, components: "components", support: shared, rules: "rules", ...(config.design ? { design: "design.md" } : {}) };

  const written: string[] = [];
  const temp = await mkdtemp(join(dirname(target), `.${basename(target)}.`));
  try {
    const copy = async (source: string, to: string): Promise<void> => {
      await mkdir(dirname(join(temp, to)), { recursive: true });
      await cp(source, join(temp, to), { recursive: true });
    };
    await copy(components, "components");
    const placed = new Map<string, string>();
    for (const { contract, dir: folder } of system.components) {
      const contractFile = (await readdir(folder)).find((name) => name.endsWith(".contract.json"))!;
      const at = toPosix(relative(components, folder));
      const file = placed.get(contract.source.file) ?? `${at}/${posix.basename(contract.source.file)}`;
      if (!placed.has(contract.source.file)) {
        await copy(join(implementations, contract.source.file), `components/${file}`);
        placed.set(contract.source.file, file);
      }
      const raw = JSON.parse(await readFile(join(folder, contractFile), "utf8")) as { source: Record<string, unknown> };
      await writeFileAtomic(join(temp, "components", at, contractFile), json({ ...raw, source: { ...raw.source, file } }));
    }
    for (const [i, file] of config.support.entries()) await copy(join(implementations, file), `components/${shared[i]}`);
    await copy(from(tokensDir), "tokens");
    if (await isDirectory(from(config.rules))) await copy(from(config.rules), "rules");
    if (config.design) await copy(from(config.design), "design.md");
    await writeFileAtomic(join(temp, DESIGN_CONFIG_FILE), json({ schema: "youi.config/v1", name: repo.config.name, systems: [next] }));
    if (options.package) await writeFileAtomic(join(temp, "package.json"), json({ name: options.package, version: config.version, description: config.description, files: [DESIGN_CONFIG_FILE, "components", "tokens", "rules", ...(config.design ? ["design.md"] : [])] }));
    // It must hold no link leading outside it, and load as a design repo, before anything of the product changes.
    const leaving = escapingLinks(temp);
    if (leaving.length > 0) throw new Error(`the System has links that lead outside it (${leaving.slice(0, 3).join(", ")}); nothing was changed`);
    await loadDesignRepo(temp);
    for (const entry of await readdir(temp, { recursive: true })) if (!(await isDirectory(join(temp, entry)))) written.push(toPosix(entry));
    written.sort();

    const source = { path: toPosix(relative(project.root, target)) || "." };
    if (!options.dryRun) {
      if (await isDirectory(target)) await rmdir(target);
      await rename(temp, target);
      const configFile = project.configFile ?? join(project.root, PROJECT_FILE);
      const raw = JSON.parse((await readTextOrNull(configFile)) ?? "{}") as Record<string, unknown>;
      await writeFileAtomic(configFile, json({ ...raw, source }));
      for (const path of removed) await rm(join(repo.root, path), { recursive: true, force: true });
    }
    return { target, system: next, written, removed, source };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
