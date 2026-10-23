/**
 * `youiyoux library ingest <link>`: what a GitHub repository, a Storybook, a Figma file or a
 * DESIGN.md holds, read into Library items (Discover's readers), shown, and with --draft filed as
 * one ingest draft in the product's changes queue, where a person keeps or drops each item and
 * approves the rest (`youiyoux ui`, Changes). Nothing is written to the Library here.
 *
 * GITHUB_TOKEN (api.github.com only) raises GitHub's limit of 60 requests an hour; FIGMA_TOKEN
 * (api.figma.com only) is needed to read a Figma file. Both are read from the environment only.
 */
import { userInfo } from "node:os";
import type { IngestReading } from "@youiyoux/workflow";
import type { Project } from "@youiyoux/scanner";
import { workflowStateDir } from "./editor.ts";
import { padEnd, plural, style } from "./ui.ts";

export async function readLink(link: string, options: { readonly allowLocal: boolean; readonly env?: NodeJS.ProcessEnv }): Promise<IngestReading> {
  const { githubBuckets, ingestLink, PoliteClient } = await import("@youiyoux/discover");
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN || undefined;
  const figmaToken = env.FIGMA_TOKEN || undefined;
  const client = new PoliteClient({ buckets: githubBuckets(token), ...(token ? { token } : {}), ...(figmaToken ? { figmaToken } : {}) });
  const result = await ingestLink(link, { client, allowLocal: options.allowLocal, figma: Boolean(figmaToken) });
  return { link: result.link, source: result.source, license: result.license, fetchedAt: result.fetchedAt, entries: result.entries, skipped: result.skipped, notes: result.notes };
}

/** File the reading as one ingest draft in the product's queue; the hub's Changes page reviews it. */
export async function fileIngestDraft(project: Project, reading: IngestReading, state?: string): Promise<{ id: string; problems: readonly string[] }> {
  const { FileStore, RuleWorkflow } = await import("@youiyoux/workflow");
  const workflow = new RuleWorkflow({ projectRoot: project.root, store: new FileStore(workflowStateDir(project, state)), ...(project.configFile ? { configPath: project.configFile } : {}), ...(project.designOverride ? { designRoot: project.repo.root } : {}), ...(project.rootOverride ? { productRoot: project.root } : {}), ingest: async () => reading });
  const draft = await workflow.create({ kind: "person", name: userInfo().username }, { kind: "ingest", link: reading.link });
  return { id: draft.id, problems: draft.problems };
}

export function renderIngest(reading: IngestReading, filed: { id: string } | null): string {
  const licence = reading.license === "unknown" ? style.warn("licence unknown") : `licence ${reading.license.spdx}`;
  const lines = [`${style.bold(reading.source.name)} ${style.dim(`· ${reading.source.kind}${reading.source.url ? ` · ${reading.source.url}` : ""}`)} · ${plural(reading.entries.length, "item")} · ${licence}`, ""];
  const width = Math.min(28, Math.max(0, ...reading.entries.map((e) => e.name.length)));
  for (const kind of ["component", "pattern", "token"] as const) {
    const items = reading.entries.filter((e) => e.kind === kind);
    if (items.length === 0) continue;
    lines.push(style.bold(`${kind}s`));
    for (const e of items) lines.push(`  ${padEnd(e.name.length > width ? `${e.name.slice(0, width - 1)}…` : e.name, width)}  ${style.dim(e.categories.length ? e.categories.join(", ") : "no role")}  ${e.summary}`);
    lines.push("");
  }
  const SKIPPED_SHOWN = 10;
  if (reading.skipped.length > 0) lines.push(style.bold(`not read (${reading.skipped.length})`), ...reading.skipped.slice(0, SKIPPED_SHOWN).map((s) => `  ${s.name}  ${style.dim(s.reason)}`), ...(reading.skipped.length > SKIPPED_SHOWN ? [style.dim(`  … ${reading.skipped.length - SKIPPED_SHOWN} more (--json lists them all)`)] : []), "");
  lines.push(...reading.notes.map((n) => style.dim(`· ${n}`)), "");
  lines.push(filed ? `${style.ok("filed")} as draft ${filed.id}: keep or drop each item, then approve, in youiyoux ui > Changes` : `Next: youiyoux library ingest ${reading.link} --draft files it for review (nothing is written to the Library until a person approves)`);
  return lines.join("\n");
}
