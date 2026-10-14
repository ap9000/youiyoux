import { join, relative, isAbsolute } from "node:path";
import { COMMAND } from "./command.ts";

/** Executables in transient package-runner caches must never be registered in a repo. */
export function ephemeralTool(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (/(?:^|[/\\])(?:_npx|dlx|bunx)(?:[/\\]|$)/.test(root)) return true;
  const caches = [env.npm_config_cache, env.NPM_CONFIG_CACHE, env.PNPM_HOME && join(env.PNPM_HOME, "store"), env.XDG_CACHE_HOME && join(env.XDG_CACHE_HOME, "pnpm")];
  return caches.some((cache) => {
    if (!cache) return false;
    const path = relative(cache, root);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  });
}

export function toolCommand(root: string): { command: string; args: string[] } {
  return ephemeralTool(root) ? { command: "npx", args: ["-y", COMMAND] } : { command: "node", args: [join(root, "packages/cli/bin/youi.js")] };
}
