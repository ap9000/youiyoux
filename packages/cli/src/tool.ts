/**
 * Where this tool lives: its checkout (the published JSON Schemas, the hub, the demo) and the CLI
 * entry hooks and MCP configs run. The youiyoux package's bundle replaces this module with its
 * dist layout (packages/youiyoux/src/tool.js).
 */
import { join, resolve } from "node:path";

export const TOOL_ROOT = resolve(import.meta.dirname, "../../..");
export const CLI_BIN = join(TOOL_ROOT, "packages/cli/bin/youi.js");
