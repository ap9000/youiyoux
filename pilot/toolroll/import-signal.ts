/**
 * Reproducible import of Toolroll's "Signal" design system into this repo.
 *
 *   node pilot/toolroll/import-signal.ts /path/to/toolroll
 *
 * Reads Toolroll's DESIGN.md (Google format) and src/server/console.css
 * (the shipped custom properties) and writes the DTCG token files, the
 * resolver, Signal's narrative, and an import report. Toolroll is only read.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import { importTokens } from "@youiyoux/tokens";

const repo = resolve(import.meta.dirname, "../..");
const toolroll = process.argv[2];
if (!toolroll) {
  process.stderr.write("usage: node pilot/toolroll/import-signal.ts <toolroll-dir>\n");
  process.exit(2);
}

/** CSS names whose value type alone cannot place them in the token tree. */
const PATHS = {
  "sheet-shadow": "shadow.sheet",
  "pill-shadow": "shadow.pill",
  "shadow-overlay": "shadow.overlay",
  overlay: "color.scrim",
  "ease-out": "easing.out",
  "phone-gutter": "space.phone.gutter",
  "phone-gap": "space.phone.gap",
  "phone-block": "space.phone.block",
  "phone-row": "space.phone.row",
  "phone-card": "space.phone.card",
};

const designMd = await readFile(join(toolroll, "DESIGN.md"), "utf8");
const css = await readFile(join(toolroll, "src/server/console.css"), "utf8");
const result = importTokens({
  designMd,
  css: { css, prefix: "so", light: { selector: ":root" }, dark: { selector: ":root[data-theme=\"dark\"]" } },
  paths: PATHS,
});

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const resolver = {
  $schema: "https://www.designtokens.org/schemas/2025.10/resolver.json",
  name: "Signal",
  version: "2025.10",
  description: "Signal tokens: one base set plus a theme modifier whose dark context overrides the values that change.",
  sets: { base: { sources: [{ $ref: "signal.tokens.json" }] } },
  modifiers: { theme: { contexts: { light: [], dark: [{ $ref: "signal.dark.tokens.json" }] }, default: "light" } },
  resolutionOrder: [{ $ref: "#/sets/base" }, { $ref: "#/modifiers/theme" }],
};

await writeFileAtomic(join(repo, "tokens/signal/signal.tokens.json"), json(result.base));
await writeFileAtomic(join(repo, "tokens/signal/signal.dark.tokens.json"), json(result.dark));
await writeFileAtomic(join(repo, "tokens/signal/signal.resolver.json"), json(resolver));
const body = designMd.replace(/^---\n[\s\S]*?\n---\n+/, "");
await writeFileAtomic(
  join(repo, "systems/signal/design.md"),
  `<!-- Imported from Toolroll DESIGN.md by pilot/toolroll/import-signal.ts. Token values live in tokens/signal; this is the narrative. -->\n\n${body}`,
);
const { fromCss, ...report } = result.report;
await writeFileAtomic(join(repo, "pilot/toolroll/import-report.json"), json({ source: "toolroll DESIGN.md + src/server/console.css", tokensFromCss: fromCss.length, ...report }));
process.stdout.write(`imported ${result.report.tokenCount} tokens (${fromCss.length} from shipped CSS); ${report.mismatches.length} mismatches, ${report.documentedOnly.length} documented-only, ${report.undocumented.length} undocumented\n`);
