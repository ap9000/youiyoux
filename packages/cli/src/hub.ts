/**
 * `youiyoux ui`: start the hub (apps/web) on a design system. With no options it shows the
 * committed demo snapshot. Otherwise it snapshots the given system into apps/web/.hub
 * (gitignored, so the tool's checkout stays clean) and points the dev server at it.
 * From the npm package, which has no Vite, the hub is the one built into the package
 * (`<tool>/hub`), served by its own server (apps/web/scripts/hub-server.ts); a named system's
 * snapshot goes to a temporary directory, removed when the hub stops.
 * `--watch` keeps that snapshot live: a watcher re-scans on every save and the open
 * hub loads each new generation (the demo project is watched when nothing is named).
 * `api` is the rule editor's service, which the dev server proxies at /api. `detect` adds a
 * `youiyoux detect` report to the snapshot (Library > Stack), beside the demo system when nothing else is named.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface HubOptions {
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
  /** The rule editor's service (`youiyoux ui --project`), proxied at /api. */
  readonly api?: string;
  /** A `youiyoux inventory` file for the Inventory page. */
  readonly inventory?: string;
  /** A `youiyoux detect` report (detect.json, screenshots beside it) for Library > Stack. */
  readonly detect?: string;
}

interface HubPlan {
  readonly web: string;
  /** Arguments for scripts/snapshot.ts, or null to show the committed demo snapshot as it is. */
  readonly snapshot: readonly string[] | null;
  readonly env: Readonly<Record<string, string>>;
  readonly vite: readonly string[];
  /** Arguments for the live snapshot watcher (scripts/snapshot.ts --watch), run beside the dev server. */
  readonly watch: readonly string[] | null;
}

const HUB_SNAPSHOT_DIR = ".hub";
/** Vite's default; `youiyoux ui` pins it when it prints a link into the hub. */
export const DEFAULT_HUB_PORT = "5173";

/** The system, product and reports named, as the snapshot script's arguments. */
const named = (options: HubOptions): string[] => (["design", "project", "config", "root", "inventory", "detect"] as const).flatMap((key) => (options[key] ? [`--${key}`, resolve(options[key])] : []));

/** Whether a system or product is named (an inventory file or a detect report alone names neither). */
const namesSystem = (options: HubOptions): boolean => (["design", "project", "config", "root"] as const).some((key) => options[key]);

export function hubPlan(toolRoot: string, options: HubOptions): HubPlan {
  const web = join(toolRoot, "apps/web");
  const vite = [join(web, "node_modules/vite/bin/vite.js"), ...(options.port ? ["--port", options.port, "--strictPort"] : [])];
  // --watch with nothing named keeps the demo project live (an inventory file or a detect report alone names no project).
  const watchesDemo = options.watch && !namesSystem(options);
  const flags = watchesDemo ? [...named(options), "--project", join(toolRoot, "examples/demo-app")] : named(options);
  const api: Record<string, string> = options.api ? { YOUI_API: options.api } : {};
  if (flags.length === 0) return { web, snapshot: null, env: api, vite, watch: null };
  const out = join(web, HUB_SNAPSHOT_DIR);
  const snapshot = [join(web, "scripts/snapshot.ts"), "--out", out, ...flags];
  return { web, snapshot, env: { YOUI_HUB_SNAPSHOT: out, ...api }, vite, watch: options.watch ? [...snapshot, "--watch"] : null };
}

/** The hub the npm package carries, built, under the tool's root: index.html, assets/, kit/. */
const BUILT_HUB = "hub";
/** The demo system's snapshot the npm package carries, its preview frame built. */
const BUILT_DEMO = "hub-demo";

interface BuiltHubPlan {
  /** Arguments for the bundled snapshot script, or null to show the demo as it is. */
  readonly snapshot: readonly string[] | null;
  /** Arguments for the hub's own server. */
  readonly server: readonly string[];
  readonly watch: readonly string[] | null;
}

/** The packaged hub: `out` is where a named system's snapshot goes. */
export function builtHubPlan(toolRoot: string, options: HubOptions, out: string): BuiltHubPlan {
  const flags = named(options);
  if (options.watch && !namesSystem(options)) throw new Error("--watch keeps a system's snapshot live: name it with --design or --project (the demo system is not watched)");
  const hub = join(toolRoot, BUILT_HUB);
  const snapshot = flags.length > 0 ? [join(toolRoot, "hub-snapshot.js"), "--out", out, ...flags] : null;
  const server = [join(toolRoot, "hub-server.js"), "--dist", hub, "--kit", join(hub, "kit"), "--snapshot", snapshot ? out : join(toolRoot, BUILT_DEMO), ...(snapshot ? ["--build-frame"] : []), ...(options.port ? ["--port", options.port] : []), ...(options.api ? ["--api", options.api] : []), ...(options.watch ? ["--live"] : [])];
  return { snapshot, server, watch: options.watch && snapshot ? [...snapshot, "--watch"] : null };
}

function run(args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, started?: (child: ChildProcess) => void): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    started?.(child);
    child.on("error", fail);
    child.on("exit", (code, signal) => done(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1)));
  });
}

/** The packaged hub: snapshot into a temporary directory, serve until stopped, then remove it. */
async function runBuiltHub(toolRoot: string, options: HubOptions): Promise<number> {
  const out = await mkdtemp(join(tmpdir(), "youiyoux-hub-"));
  // Ctrl-C or a SIGTERM stops the children, and this process waits for them, so the snapshot is removed.
  const children = new Set<ChildProcess>();
  const stop = (): void => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const plan = builtHubPlan(toolRoot, options, out);
    if (plan.snapshot) {
      const code = await run(plan.snapshot, process.cwd(), {}, (child) => children.add(child));
      if (code !== 0) return code;
    }
    if (plan.watch) children.add(spawn(process.execPath, plan.watch, { cwd: process.cwd(), stdio: "inherit" }));
    return await run(plan.server, process.cwd(), {}, (child) => children.add(child));
  } finally {
    stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await rm(out, { recursive: true, force: true });
  }
}

/** Snapshot (when a system is named), then serve until the dev server exits; with --watch, a watcher runs alongside. */
export async function runHub(toolRoot: string, options: HubOptions): Promise<number> {
  if (existsSync(join(toolRoot, BUILT_HUB, "index.html"))) return runBuiltHub(toolRoot, options);
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

interface PreviewsOptions {
  /** The running hub's port (default DEFAULT_HUB_PORT). */
  readonly port?: string;
  /** One registry's items (`@shadcn`, the default), or `all`. */
  readonly registry?: string;
  readonly role?: string;
  readonly limit?: string;
  /** Photograph again even what is current, and retry what could not be drawn. */
  readonly force?: boolean;
  readonly cache?: string;
}

/** `youiyoux discover previews`: the hub's capture script, pointed at a hub running on this machine. */
export function previewsPlan(toolRoot: string, options: PreviewsOptions): { web: string; args: string[] } {
  const web = join(toolRoot, "apps/web");
  const registry = options.registry ?? "@shadcn";
  const args = [join(web, "scripts/capture-discover-thumbs.ts"), "--hub", `http://localhost:${options.port ?? DEFAULT_HUB_PORT}`];
  if (registry !== "all") args.push("--registry", registry);
  for (const key of ["role", "limit"] as const) if (options[key]) args.push(`--${key}`, options[key]!);
  if (options.cache) args.push("--cache", resolve(options.cache));
  if (options.force) args.push("--force");
  return { web, args };
}

export async function runPreviews(toolRoot: string, options: PreviewsOptions): Promise<number> {
  const plan = previewsPlan(toolRoot, options);
  // The npm package carries the capture bundled; it runs where it is.
  if (existsSync(join(toolRoot, BUILT_HUB, "index.html"))) return run([join(toolRoot, "hub-previews.js"), ...plan.args.slice(1)], process.cwd(), {});
  await access(join(plan.web, "node_modules/playwright-core")).catch(() => {
    throw new Error(`the hub's dependencies are not installed: run \`pnpm install\` in ${toolRoot}`);
  });
  return run(plan.args, plan.web, {});
}
