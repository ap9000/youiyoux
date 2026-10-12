import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The design tokens, read once and inlined into every page: no stylesheet links or imports them. */
const TOKENS = readFileSync(new URL("../design/tokens.css", import.meta.url), "utf8");

/** The page the server sends: the tokens, the CLI's Tailwind build, then the plain kit. */
export async function chrome(body: string): Promise<string> {
  const kit = await readFile(join(import.meta.dirname, "../browser/ui.css"), "utf8");
  return `<!doctype html>
<html lang="en">
  <head>
    <style>${TOKENS}</style>
    <link rel="stylesheet" href="/assets/tailwind.css" />
    <style>${kit}</style>
  </head>
  <body>${body}</body>
</html>`;
}
