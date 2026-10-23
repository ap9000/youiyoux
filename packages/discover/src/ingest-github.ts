/**
 * A GitHub repository as Library items, read through GitHub's API at one commit (the default
 * branch's tip, or the ref the link names), in this order:
 *
 *   registry.json   a shadcn registry: its components and blocks, with their files' digests and
 *                   dependencies, installable from the built item when the repo serves one
 *   youi.config.json  a youiyoux design repo: one item per component contract
 *   components      otherwise, the component files under a components folder (by name only)
 *
 * The licence is the one GitHub detects in the repository's licence file, with that file as the
 * evidence; none, or one GitHub cannot name (NOASSERTION), is unknown. Without GITHUB_TOKEN the
 * API allows 60 requests an hour: a small repository needs three or four.
 */
import type { LibraryLicense } from "@youiyoux/core";
import { cleanText } from "./text.ts";
import type { PoliteClient } from "./http.ts";
import { digestOf, displayName, fetchJson, fetchText, IngestError, itemsOf, type IngestLink, type IngestSource, type ItemInput, type ReaderResult } from "./ingest.ts";
import { isCandidate, packageName, parseRegistryItems } from "./sources.ts";

const API = "https://api.github.com";
const COMPONENT_FILE = /\.(tsx|jsx|vue|svelte|astro)$/;
const NOT_A_COMPONENT = /(\.(test|spec|stories|story|d)\.[^.]+$)|(^|\/)(index|types?|utils?|helpers?|constants?)\.[^.]+$|(^|\/)(__tests__|__mocks__|stories|examples?|demo|docs?)\//;
const CONTRACTS_READ = 100;

type GithubTarget = Extract<IngestLink, { kind: "github" }>;
type TreeEntry = { path: string; type: string; sha?: string };

async function licenseOf(client: PoliteClient, repo: string, fetchedAt: string): Promise<LibraryLicense> {
  const got = await client.json(`${API}/repos/${repo}/license`, false);
  if (!got.ok) return "unknown";
  const value = got.value as { license?: { spdx_id?: unknown }; html_url?: unknown };
  const spdx = value.license?.spdx_id;
  if (typeof spdx !== "string" || spdx === "NOASSERTION" || typeof value.html_url !== "string") return "unknown";
  return { spdx, evidenceUrl: value.html_url, verifiedAt: fetchedAt };
}

export async function readGithub(target: GithubTarget, client: PoliteClient, fetchedAt: string): Promise<ReaderResult> {
  const repo = `${target.owner}/${target.repo}`;
  const meta = (await fetchJson(client, `${API}/repos/${repo}`, `the repository ${repo}`)) as { default_branch?: string; html_url?: string; private?: boolean };
  const ref = target.ref ?? meta.default_branch ?? "main";
  const commit = ((await fetchJson(client, `${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, `${repo} at ${ref}`)) as { sha?: unknown }).sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new IngestError(`${repo} has no commit at ${ref}`);
  const tree = (await fetchJson(client, `${API}/repos/${repo}/git/trees/${commit}?recursive=1`, `${repo}'s files`)) as { tree?: TreeEntry[]; truncated?: boolean };
  const scope = target.path ? `${target.path.replace(/\/+$/, "")}/` : "";
  const blobs = new Map((tree.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(scope)).map((e) => [e.path, e.sha ?? null]));
  const files = [...blobs.keys()];
  const license = await licenseOf(client, repo, fetchedAt);
  const source: IngestSource = { kind: "github", name: repo, url: `https://github.com/${repo}${target.ref || target.path ? `/tree/${ref}${target.path ? `/${target.path}` : ""}` : ""}` };
  const blob = (path: string): string => `https://github.com/${repo}/blob/${commit}/${path}`;
  const raw = (path: string): string => `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
  const notes = [
    `read at ${commit.slice(0, 7)} (${ref})`,
    license === "unknown" ? "licence unknown: GitHub names none for this repository, so its items cannot be adopted until one is found" : `licence ${license.spdx}, from ${license.evidenceUrl}`,
    ...(tree.truncated ? ["GitHub listed only part of this repository's files: name a folder (https://github.com/<owner>/<repo>/tree/<ref>/<folder>) to read the rest"] : []),
  ];
  const byDepth = (a: string, b: string): number => a.split("/").length - b.split("/").length || a.localeCompare(b);

  // 1. A shadcn registry.
  const registry = files.filter((f) => /(^|\/)registry\.json$/.test(f) && !f.includes("node_modules/")).sort(byDepth)[0];
  if (registry) {
    const text = await fetchText(client, raw(registry), `${repo}'s ${registry}`);
    let value: unknown;
    try {
      value = JSON.parse(text.body);
    } catch {
      throw new IngestError(`${repo}'s ${registry} is not JSON`);
    }
    const { items, invalid } = parseRegistryItems(value);
    // A built item is offered as an install command a person copies: only paths of plain characters, so nothing in one can reach a shell.
    const built = new Set(files.filter((f) => /(^|\/)public\/r\/[^/]+\.json$/.test(f) && /^[A-Za-z0-9._/-]+$/.test(f)));
    const inputs: ItemInput[] = items.filter(isCandidate).map((item) => {
      const servedAt = [...built].find((f) => f.endsWith(`/r/${item.name}.json`));
      return {
        kind: item.type === "registry:block" ? "pattern" : "component",
        name: item.name,
        ...(item.title ? { title: item.title } : {}),
        summary: item.description ?? "",
        ref: `${registry}#${item.name}`,
        url: blob(registry),
        digest: item.itemSha256 ?? digestOf(item),
        files: (item.files ?? []).map((f) => ({ path: f.path, sha256: f.sha256 ?? null })),
        categories: item.categories ?? [],
        ...(servedAt ? { install: { command: `npx shadcn add ${raw(servedAt)}`, npm: [...new Set((item.dependencies ?? []).map(packageName))], registryDeps: [...new Set(item.registryDependencies ?? [])], implicitDeps: [] } } : {}),
      };
    });
    const others = items.filter((i) => !isCandidate(i));
    return {
      source,
      license,
      entries: itemsOf(source, license, fetchedAt, inputs),
      skipped: [...others.map((i) => ({ name: i.name, reason: `${i.type}: not a component or block` })), ...(invalid > 0 ? [{ name: `${invalid} item${invalid === 1 ? "" : "s"}`, reason: "not valid registry items" }] : [])],
      notes: [`a shadcn registry: ${registry}`, ...notes],
    };
  }

  // 2. A youiyoux design repo: its contracts.
  const config = files.filter((f) => /(^|\/)youi\.config\.json$/.test(f)).sort(byDepth)[0];
  if (config) {
    const contracts = files.filter((f) => f.endsWith(".contract.json")).sort();
    const inputs: ItemInput[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const path of contracts.slice(0, CONTRACTS_READ)) {
      const text = await fetchText(client, raw(path), path).catch((error: unknown) => {
        skipped.push({ name: path, reason: error instanceof Error ? error.message : String(error) });
        return null;
      });
      if (!text) continue;
      try {
        const contract = JSON.parse(text.body) as { name?: unknown; summary?: unknown; status?: unknown; version?: unknown };
        if (typeof contract.name !== "string") throw new Error("no name");
        inputs.push({ kind: "component", name: contract.name, summary: typeof contract.summary === "string" ? contract.summary : "", ref: path, url: blob(path), digest: text.sha256, files: [{ path, sha256: text.sha256 }], categories: ["contract", ...(typeof contract.status === "string" ? [contract.status] : [])] });
      } catch (error: unknown) {
        skipped.push({ name: path, reason: `not a component contract: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { source, license, entries: itemsOf(source, license, fetchedAt, inputs), skipped, notes: [`a youiyoux design repo: ${config}`, ...notes, ...(contracts.length > CONTRACTS_READ ? [`${contracts.length - CONTRACTS_READ} more contracts not read: at most ${CONTRACTS_READ}`] : [])] };
  }

  // 3. Component files under a components folder, by name.
  const components = files.filter((f) => /(^|\/)components?\//.test(f) && COMPONENT_FILE.test(f) && !NOT_A_COMPONENT.test(f) && !f.includes("node_modules/")).sort();
  if (components.length === 0) throw new IngestError(`${repo}${scope ? `/${scope}` : ""} has no registry.json, no youi.config.json and no components folder: nothing to read as Library items`);
  // Each listed as GitHub served it (its path and git blob id): the file itself is not fetched.
  const inputs: ItemInput[] = components.map((path) => ({ kind: "component", name: displayName(path), summary: cleanText(`${displayName(path)}, in ${path}`), ref: path, url: blob(path), digest: digestOf({ path, blob: blobs.get(path) }), categories: [] }));
  return { source, license, entries: itemsOf(source, license, fetchedAt, inputs), skipped: [], notes: [`component files under a components folder, by name: their code was not read`, ...notes] };
}
