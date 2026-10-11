/**
 * `youi ui`: start the hub (apps/web) on a design system. With no options it shows the
 * committed demo snapshot. Otherwise it snapshots the given system into apps/web/.hub
 * (gitignored, so the tool's checkout stays clean) and points the dev server at it.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface HubOptions {
  /** Design repo checkout; default: the project config's source.path, else the demo system. */
  readonly design?: string;
  /** Product repo to scan (read-only) for the Where and Screens views. */
  readonly project?: string;
  /** Project config, when it lives outside the product repo. */
  readonly config?: string;
  readonly port?: string;
}

export interface HubPlan {
  readonly web: string;
  /** Arguments for scripts/snapshot.ts, or null to show the committed demo snapshot as it is. */
  readonly snapshot: readonly string[] | null;
  readonly env: Readonly<Record<string, string>>;
  readonly vite: readonly string[];
}

export const HUB_SNAPSHOT_DIR = ".hub";

export function hubPlan(toolRoot: string, options: HubOptions): HubPlan {
  const web = join(toolRoot, "apps/web");
  const vite = [join(web, "node_modules/vite/bin/vite.js"), ...(options.port ? ["--port", options.port, "--strictPort"] : [])];
  const flags = (["design", "project", "config"] as const).flatMap((key) => (options[key] ? [`--${key}`, resolve(options[key])] : []));
  if (flags.length === 0) return { web, snapshot: null, env: {}, vite };
  const out = join(web, HUB_SNAPSHOT_DIR);
  return { web, snapshot: [join(web, "scripts/snapshot.ts"), "--out", out, ...flags], env: { YOUI_HUB_SNAPSHOT: out }, vite };
}

function run(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code, signal) => done(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1)));
  });
}

/** Snapshot (when a system is named), then serve until the dev server exits. */
export async function runHub(toolRoot: string, options: HubOptions): Promise<number> {
  const plan = hubPlan(toolRoot, options);
  await access(plan.vite[0]!).catch(() => {
    throw new Error(`the hub's dependencies are not installed: run \`pnpm install\` in ${toolRoot}`);
  });
  if (plan.snapshot) {
    const code = await run(plan.snapshot, process.cwd(), {});
    if (code !== 0) return code;
  }
  return run(plan.vite, plan.web, plan.env);
}
