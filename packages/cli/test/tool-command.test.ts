import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ephemeralTool, toolCommand } from "../src/tool-command.ts";
import { mcpCommand } from "../src/agents-install.ts";
import { hookCommand } from "../src/hooks-install.ts";
import { TOOL_ROOT } from "../src/tool.ts";

for (const root of ["/cache/_npx/hash/node_modules/youiyoux/dist", "/cache/pnpm/dlx/hash/node_modules/youiyoux/dist", "C:\\cache\\_npx\\hash\\node_modules\\youiyoux\\dist"]) test(`ephemeral tool registration is portable: ${root}`, () => {
  expect(toolCommand(root)).toEqual({ command: "npx", args: ["-y", "youiyoux"] });
  expect(mcpCommand(root, { project: "." })).toEqual({ command: "npx", args: ["-y", "youiyoux", "mcp", "--project", "."] });
  expect(hookCommand(root, "claude", {})).toBe("npx -y youiyoux hooks run claude");
  expect(hookCommand(root, "pre-commit", {}, ["--strict"])).toBe("npx -y youiyoux hooks run pre-commit --strict");
});

test("an installed checkout registers an existing executable; custom cache detection respects path boundaries", () => {
  const command = toolCommand(TOOL_ROOT);
  expect(command.command).toBe("node");
  expect(command.args).toEqual([join(TOOL_ROOT, "packages/cli/bin/youi.js")]);
  expect(existsSync(command.args[0]!)).toBe(true);
  expect(ephemeralTool("/custom/npm/run/package", { npm_config_cache: "/custom/npm" })).toBe(true);
  expect(ephemeralTool("/custom/npm-project/tool", { npm_config_cache: "/custom/npm" })).toBe(false);
});
