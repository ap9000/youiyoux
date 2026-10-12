/**
 * `youi ui`: start the hub (apps/web) on a design system. With no options it shows the
 * committed demo snapshot. Otherwise it snapshots the given system into apps/web/.hub
 * (gitignored, so the tool's checkout stays clean) and points the dev server at it.
 * `--watch` keeps that snapshot live: a watcher re-scans on every save and the open
 * hub loads each new generation (the demo project is watched when nothing is named).
 * `api` is the rule editor's service, which the dev server proxies at /api. `detect` adds a
 * `youi detect` report to the snapshot (Library > Stack), beside the demo system when nothing else is named.
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
  /** Product root, when the config does not name it. */
  readonly root?: string;
  readonly port?: string;
  /** Keep the snapshot live while the hub runs. */
  readonly watch?: boolean;
  /** The rule editor's service (`youi ui --project`), proxied at /api. */
  readonly api?: string;
  /** A `youi inventory` file for the Inventory page. */
  readonly inventory?: string;
  /** A `youi detect` report (detect.json, screenshots beside it) for Library > Stack. */
  readonly detect?: string;
}

export interface HubPlan {
  readonly web: string;
  /** Arguments for scripts/snapshot.ts, or null to show the committed demo snapshot as it is. */
  readonly snapshot: readonly string[] | null;
  readonly env: Readonly<Record<string, string>>;
  readonly vite: readonly string[];
  /** Arguments for the live snapshot watcher (scripts/snapshot.ts --watch), run beside the dev server. */
  readonly watch: readonly string[] | null;
}

export const HUB_SNAPSHOT_DIR = ".hub";
/** Vite's default; `youi ui` pins it when it prints a link into the hub. */
export const DEFAULT_HUB_PORT = "5173";

export function hubPlan(toolRoot: string, options: HubOptions): HubPlan {
  const web = join(toolRoot, "apps/web");
  const vite = [join(web, "node_modules/vite/bin/vite.js"), ...(options.port ? ["--port", options.port, "--strictPort"] : [])];
  const named = (["design", "project", "config", "root", "inventory", "detect"] as const).flatMap((key) => (options[key] ? [`--${key}`, resolve(options[key])] : []));
  // --watch with nothing named keeps the demo project live (an inventory file or a detect report alone names no project).
  const watchesDemo = options.watch && !(["design", "project", "config", "root"] as const).some((key) => options[key]);
  const flags = watchesDemo ? [...named, "--project", join(toolRoot, "examples/demo-app")] : named;
  const api: Record<string, string> = options.api ? { YOUI_API: options.api } : {};
  if (flags.length === 0) return { web, snapshot: null, env: api, vite, watch: null };
  const out = join(web, HUB_SNAPSHOT_DIR);
  const snapshot = [join(web, "scripts/snapshot.ts"), "--out", out, ...flags];
  return { web, snapshot, env: { YOUI_HUB_SNAPSHOT: out, ...api }, vite, watch: options.watch ? [...snapshot, "--watch"] : null };
}

function run(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code, signal) => done(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1)));
  });
}

/** Snapshot (when a system is named), then serve until the dev server exits; with --watch, a watcher runs alongside. */
export async function runHub(toolRoot: string, options: HubOptions): Promise<number> {
  const plan = hubPlan(toolRoot, options);
  await access(plan.vite[0]!).catch(() => {
    throw new Error(`the hub's dependencies are not installed: run \`pnpm install\` in ${toolRoot}`);
  });
  if (plan.snapshot) {
    const code = await run(plan.snapshot, process.cwd(), {});
    if (code !== 0) return code;
  }
  const watcher = plan.watch ? spawn(process.execPath, plan.watch, { cwd: process.cwd(), stdio: "inherit" }) : null;
  try {
    return await run(plan.vite, plan.web, plan.env);
  } finally {
    watcher?.kill("SIGTERM");
  }
}
