/** This tool's version, read once where it is needed (records, behaviour results' freshness). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCANNER_VERSION } from "@youiyoux/scanner";
import { TOOL_ROOT } from "./tool.ts";

/** This tool's version: the youiyoux package's, from a checkout or from the package itself. */
export function toolVersion(root = TOOL_ROOT): string | null {
  for (const file of [join(root, "packages/youiyoux/package.json"), join(root, "../package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "youiyoux" && pkg.version) return pkg.version;
    } catch {
      /* not this layout */
    }
  }
  return null;
}

/** What a behaviour result records as the youiyoux that made it: a new release makes stored results stale. */
export const behaviourTool = (): string => `youiyoux ${toolVersion() ?? "unknown"} (${SCANNER_VERSION})`;
