/**
 * A Figma file as Library items, through Figma's REST API with FIGMA_TOKEN (sent to
 * api.figma.com only): one component item per component set (a Button with its variants) and per
 * component outside a set, and one token item per kind of style (colours, text, effects, grids).
 * Figma lists only what is published to a team library; a file with none says so. A Figma file
 * says nothing of a licence: unknown.
 */
import type { PoliteClient } from "./http.ts";
import { digestOf, fetchJson, IngestError, itemsOf, type IngestLink, type IngestSource, type ItemInput, type ReaderResult } from "./ingest.ts";

type FigmaTarget = Extract<IngestLink, { kind: "figma" }>;
type Published = { key?: unknown; node_id?: unknown; name?: unknown; description?: unknown; style_type?: unknown; containing_frame?: { name?: unknown; pageName?: unknown; containingComponentSet?: unknown } };

const API = "https://api.figma.com/v1";
const STYLE_GROUP: Readonly<Record<string, string>> = { FILL: "Color styles", TEXT: "Text styles", EFFECT: "Effect styles", GRID: "Grid styles" };
const SAMPLES = 5;

const listOf = (value: unknown, field: string): Published[] => {
  const list = (value as { meta?: Record<string, unknown> }).meta?.[field];
  return Array.isArray(list) ? (list as Published[]) : [];
};
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function readFigma(target: FigmaTarget, client: PoliteClient, fetchedAt: string): Promise<ReaderResult> {
  const file = (await fetchJson(client, `${API}/files/${target.key}?depth=1`, "the Figma file").catch((error: unknown) => {
    throw new IngestError(`${error instanceof Error ? error.message : String(error)}: is FIGMA_TOKEN allowed to read this file?`);
  })) as { name?: unknown };
  const fileName = text(file.name) || target.key;
  const [sets, components, styles] = await Promise.all([
    fetchJson(client, `${API}/files/${target.key}/component_sets`, "its component sets"),
    fetchJson(client, `${API}/files/${target.key}/components`, "its components"),
    fetchJson(client, `${API}/files/${target.key}/styles`, "its styles"),
  ]);
  const at = (node: unknown): string => `https://www.figma.com/design/${target.key}?node-id=${encodeURIComponent(String(node).replace(/:/g, "-"))}`;
  const source: IngestSource = { kind: "figma", name: `${fileName} (Figma)`, url: `https://www.figma.com/design/${target.key}` };
  const inputs: ItemInput[] = [];
  const page = (p: Published): string[] => [text(p.containing_frame?.pageName), text(p.containing_frame?.name)].filter(Boolean);
  for (const set of listOf(sets, "component_sets")) {
    if (!text(set.name)) continue;
    inputs.push({ kind: "component", name: text(set.name), summary: text(set.description) || `${text(set.name)}, a component set in ${fileName}`, ref: text(set.key) || String(set.node_id), url: at(set.node_id), digest: digestOf(set), categories: page(set) });
  }
  // A variant belongs to its set, which is already an item.
  const loose = listOf(components, "components").filter((c) => !c.containing_frame?.containingComponentSet && text(c.name));
  for (const component of loose) inputs.push({ kind: "component", name: text(component.name), summary: text(component.description) || `${text(component.name)}, a component in ${fileName}`, ref: text(component.key) || String(component.node_id), url: at(component.node_id), digest: digestOf(component), categories: page(component) });
  const byType = new Map<string, Published[]>();
  for (const style of listOf(styles, "styles")) {
    const type = text(style.style_type);
    if (type) byType.set(type, [...(byType.get(type) ?? []), style]);
  }
  for (const [type, list] of byType) {
    const names = list.map((s) => text(s.name)).filter(Boolean);
    inputs.push({ kind: "token", name: STYLE_GROUP[type] ?? `${type.toLowerCase()} styles`, summary: `${names.length} ${(STYLE_GROUP[type] ?? type).toLowerCase()} in ${fileName}: ${names.slice(0, SAMPLES).join(", ")}${names.length > SAMPLES ? ", …" : ""}`, ref: `${target.key}#${type.toLowerCase()}`, url: source.url!, digest: digestOf(list), categories: [type.toLowerCase()] });
  }
  if (inputs.length === 0) throw new IngestError(`${fileName} has no components or styles published to a team library: Figma lists only published ones, so publish the library (Assets > Libraries) and ingest it again`);
  return {
    source,
    license: "unknown",
    entries: itemsOf(source, "unknown", fetchedAt, inputs),
    skipped: [],
    notes: [`a Figma file: ${fileName}, ${listOf(sets, "component_sets").length} component sets, ${loose.length} other components, ${byType.size} kinds of style`, "only what is published to a team library is listed", "licence unknown: a Figma file does not say one"],
  };
}
