/**
 * Which files a DTCG 2025.10 resolver reads, and for what: the base sets every scheme starts
 * from, and each theme context's overrides. The token build validates every one of them; the
 * style editor writes a light edit to the base (or light context) file that holds the token and
 * a dark edit to the dark context file. Pure: it reads only the resolver document.
 */
import type { SystemConfig } from "@youiyoux/core";

export interface ResolverLayout {
  /** Base set files, in resolution order (relative to the resolver). */
  readonly base: readonly string[];
  /** Context name → its override files, for the theme modifier (empty without one). */
  readonly contexts: Readonly<Record<string, readonly string[]>>;
  /** Every file the resolver reads, once, in order. */
  readonly files: readonly string[];
  /** Sources written inline in the resolver: valid DTCG, but there is no file to edit. */
  readonly inline: number;
}

interface ResolverDocument {
  sets?: Record<string, { sources?: unknown[] }>;
  modifiers?: Record<string, { contexts?: Record<string, unknown[]> }>;
  resolutionOrder?: unknown[];
}

function refs(sources: readonly unknown[] | undefined, inline: { count: number }): string[] {
  return (sources ?? []).flatMap((source) => {
    const ref = (source as { $ref?: unknown } | null)?.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) return [ref];
    inline.count++;
    return [];
  });
}

export function resolverLayout(document: unknown, themeModifier?: SystemConfig["themeModifier"]): ResolverLayout {
  const doc = (document ?? {}) as ResolverDocument;
  const inline = { count: 0 };
  // Sets in resolution order when the resolver gives one; else as declared.
  const order = (doc.resolutionOrder ?? [])
    .map((entry) => /^#\/sets\/(.+)$/.exec(String((entry as { $ref?: unknown } | null)?.$ref ?? ""))?.[1])
    .filter((name): name is string => name !== undefined);
  const setNames = order.length > 0 ? order : Object.keys(doc.sets ?? {});
  const base = setNames.flatMap((name) => refs(doc.sets?.[name]?.sources, inline));
  const modifier = themeModifier ? doc.modifiers?.[themeModifier.name] : undefined;
  const contexts = Object.fromEntries(Object.entries(modifier?.contexts ?? {}).map(([name, sources]) => [name, refs(sources, inline)]));
  const files = [...new Set([...base, ...Object.values(contexts).flat()])];
  return { base, contexts, files, inline: inline.count };
}
