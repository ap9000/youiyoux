/** Emit the published JSON Schemas from the Zod definitions (one source for both). */
import { z } from "zod";
import { PUBLISHED_SCHEMAS } from "./schemas.ts";

export type SchemaFile = keyof typeof PUBLISHED_SCHEMAS;

export function jsonSchemaFor(file: SchemaFile): Record<string, unknown> {
  const schema = z.toJSONSchema(PUBLISHED_SCHEMAS[file], { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  return { $id: `https://design-language.local/schema/${file}`, ...schema };
}

/** Every schema file name with its serialized content (stable, newline-terminated). */
export function renderJsonSchemas(): Array<{ file: SchemaFile; content: string }> {
  return (Object.keys(PUBLISHED_SCHEMAS) as SchemaFile[]).map((file) => ({ file, content: `${JSON.stringify(jsonSchemaFor(file), null, 2)}\n` }));
}
