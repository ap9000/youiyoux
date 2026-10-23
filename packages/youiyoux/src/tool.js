// The bundle's stand-in for packages/cli/src/tool.ts: this package's dist is the tool's root,
// with the published schemas in dist/schema and dist/packages/cli/bin/youi.js for hooks and MCP configs.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const TOOL_ROOT = join(dirname(createRequire(import.meta.url).resolve("youiyoux/package.json")), "dist");
