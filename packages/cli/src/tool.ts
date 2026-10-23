/**
 * Where this tool lives: its checkout (the published JSON Schemas, the hub, the demo) and the CLI
 * entry hooks and MCP configs run. The youiyoux package's bundle replaces this module with its
 * dist layout (packages/youiyoux/src/tool.js).
 */
import { resolve } from "node:path";

export const TOOL_ROOT = resolve(import.meta.dirname, "../../..");
