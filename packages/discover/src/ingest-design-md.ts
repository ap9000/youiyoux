/**
 * A DESIGN.md as Library items: one token item per group of its frontmatter (colors, typography,
 * rounded, spacing, …) with what the group holds, and one component item per component it names,
 * in its frontmatter (`components:`, a variant such as `button-hover` folded into `button`) or
 * in its body (a table under a Components heading, or a heading per component beneath one).
 * A DESIGN.md says nothing of a licence: unknown. A local file is read by the CLI only, and its
 * path is never written into an item.
 */
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PoliteClient } from "./http.ts";
import { digestOf, fetchText, IngestError, itemsOf, type IngestLink, type IngestSource, type ItemInput, type ReaderResult } from "./ingest.ts";

type DesignTarget = Extract<IngestLink, { kind: "design-md" }>;

const GROUP_TITLE: Readonly<Record<string, string>> = { colors: "Colors", typography: "Typography", rounded: "Corner radius", spacing: "Spacing", elevation: "Elevation", shadows: "Shadows", motion: "Motion" };
const NOT_TOKENS = new Set(["name", "version", "description", "components", "$schema"]);
const SAMPLES = 4;

const title = (key: string): string => key.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** `primary #5e6ad2`, `label 14px/1.4 600`: a token as a reader scans it. */
function sample(name: string, value: unknown): string {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return `${name} ${[v.fontSize, v.lineHeight, v.fontWeight].filter((x) => x !== undefined).join("/")}`.trim();
  }
  return `${name} ${String(value)}`;
}

/** Component names in the body: a table's first column, or headings, under a heading that says Components. */
function bodyComponents(body: string): Array<{ name: string; summary: string }> {
  const lines = body.split(/\r?\n/);
  const found: Array<{ name: string; summary: string }> = [];
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i]!);
    if (heading) {
      const depth = heading[1]!.length;
      if (/\bcomponents?\b/i.test(heading[2]!)) {
        level = depth;
        continue;
      }
      if (level > 0 && depth <= level) level = 0;
      else if (level > 0 && depth > level) {
        const text = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("|"));
        found.push({ name: heading[2]!.replace(/[`*_]/g, ""), summary: text?.trim() ?? "" });
      }
      continue;
    }
    if (level === 0) continue;
    const row = /^\|(.+)\|\s*$/.exec(lines[i]!);
    if (!row || /^\|[\s:-]+\|/.test(lines[i]!)) continue;
    const cells = row[1]!.split("|").map((c) => c.trim());
    const name = cells[0]!.replace(/[`*_]/g, "");
    // The header row names its columns: skip it.
    if (!name || /^(component|name|element)s?$/i.test(name)) continue;
    found.push({ name, summary: cells.slice(1).filter((c) => c && c !== "—" && !c.startsWith("`")).at(-1) ?? "" });
  }
  return found;
}

export async function readDesignMd(target: DesignTarget, client: PoliteClient, fetchedAt: string, readLocal: (path: string) => Promise<string>): Promise<ReaderResult> {
  const text = target.local
    ? await readLocal(target.location).then((body) => ({ body, sha256: digestOf(body) }), () => {
        throw new IngestError(`could not read ${basename(target.location)}`);
      })
    : await fetchText(client, target.location, "the DESIGN.md");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.body);
  let front: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1]!) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
    } catch (error: unknown) {
      throw new IngestError(`the DESIGN.md's frontmatter is not YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  const body = match ? match[2]! : text.body;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.replace(/^Design System:\s*/i, "").trim();
  const name = (typeof front.name === "string" && front.name.trim()) || heading || (target.local ? basename(target.location, ".md") : new URL(target.location).host);
  const url = target.local ? null : target.location;
  const source: IngestSource = { kind: "design-md", name, url };
  const file = target.local ? basename(target.location) : (new URL(target.location).pathname.split("/").at(-1) ?? "DESIGN.md");

  const inputs: ItemInput[] = [];
  for (const [group, value] of Object.entries(front)) {
    if (NOT_TOKENS.has(group) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const tokens = Object.entries(value as Record<string, unknown>);
    if (tokens.length === 0) continue;
    const samples = tokens.slice(0, SAMPLES).map(([k, v]) => sample(k, v)).join(", ");
    inputs.push({ kind: "token", name: GROUP_TITLE[group] ?? title(group), summary: `${tokens.length} ${group} token${tokens.length === 1 ? "" : "s"}: ${samples}${tokens.length > SAMPLES ? ", …" : ""}`, ref: `${file}#${group}`, url, digest: digestOf(value), categories: [group] });
  }
  // Components: the frontmatter's, a variant folded into its base, then the body's, each once.
  const components = new Map<string, { name: string; summary: string; digest: string }>();
  const keys = Object.keys((front.components as Record<string, unknown> | undefined) ?? {});
  for (const key of keys) {
    const base = keys.filter((other) => other !== key && key.startsWith(`${other}-`)).sort((a, b) => a.length - b.length)[0] ?? key;
    const entry = components.get(base.toLowerCase()) ?? { name: title(base), summary: "", digest: digestOf((front.components as Record<string, unknown>)[base]) };
    if (base !== key) entry.summary = `${entry.summary ? `${entry.summary}, ` : "Variants: "}${key.slice(base.length + 1)}`;
    components.set(base.toLowerCase(), entry);
  }
  for (const found of bodyComponents(body)) {
    const key = found.name.toLowerCase().replace(/\s+/g, "-");
    const known = components.get(key);
    components.set(key, { name: known?.name ?? found.name, summary: found.summary || known?.summary || "", digest: known?.digest ?? digestOf(found) });
  }
  for (const [key, c] of components) inputs.push({ kind: "component", name: c.name, summary: c.summary || `${c.name}, as ${name}'s DESIGN.md describes it`, ref: `${file}#${key}`, url, digest: c.digest });
  if (inputs.length === 0) throw new IngestError(`the DESIGN.md names no token groups in its frontmatter and no components: nothing to read`);
  return {
    source,
    license: "unknown",
    entries: itemsOf(source, "unknown", fetchedAt, inputs),
    skipped: [],
    notes: ["licence unknown: a DESIGN.md does not say one", ...(target.local ? ["read from a local file: its path is not written into the items"] : [])],
  };
}
