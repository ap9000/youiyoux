/**
 * Server-renders component looks the way the app makes them: one esbuild bundle per project (an
 * in-memory entry that loads each module a recipe names lazily, tsconfig paths honoured) resolved
 * against the project's own node_modules, so its React, CVA tables and Radix parts produce the
 * classes and `data-state` the app's do. Per look, `renderToStaticMarkup` runs inside the
 * recipe's wrappers; a look that throws, renders nothing or hangs is reported, and its caller
 * falls back to the static tag and classes.
 *
 * What it may run is fenced, not sandboxed. Every import esbuild resolves must be inside the
 * project root or a package in the root's own node_modules (contain.ts); anything else, a recipe
 * file, a tsconfig `paths` target or a symlink that leaves the root, fails that module's bundle.
 * The bundle is written to our cache directory, never the project, and evaluated in a worker
 * thread. A worker thread shares this process: the project's module code can reach this
 * machine's files, environment and network as this process can, so only code the project's own
 * root and node_modules hold is ever loaded. The worker is there for hangs and crashes: each
 * look has a time limit, and a look that overruns it is stopped with its worker and the rest go
 * on in a fresh one. esbuild has a time limit too, and a module that does not bundle, or throws
 * when it loads, fails only the looks that need it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { BuildOptions, Plugin } from "esbuild";
import type { InventoryRecipe } from "@youiyoux/core";
import type { SpecimenStats } from "./cache.ts";
import { limitOf, parseTsconfigJson } from "./css.ts";
import { displayPath, inPackage, packageName, packageUnderRoot, relativeInside, within } from "./contain.ts";

export type ComponentRecipe = Extract<InventoryRecipe, { kind: "component" }>;

export interface RenderJob {
  readonly key: string;
  readonly recipe: ComponentRecipe;
  /** Children when the site has no text of its own (a card's placeholder). */
  readonly label: string | null;
  /** An icon (ICON_HTML) as its children instead: an icon-size button, which a word would spill out of. */
  readonly icon?: boolean;
  /** Retry this look with its original props if representative names throw. */
  readonly fallback?: RenderJob;
  readonly suppliedNames?: readonly string[];
}

/** Representative accessible names, stable on both sides of a visual comparison. */
export function withNamePlaceholders(job: RenderJob): RenderJob {
  const names = new Set(["id", "title", "aria-label", "alt", "children"]);
  const fill = (props: ComponentRecipe["props"], dynamic: readonly string[], suffix: string) => {
    const result = { ...props };
    for (const name of dynamic) if (names.has(name) && name !== "children" && !(name in result)) result[name] = name === "id" ? `youi-${job.key}-${suffix}` : `Example ${name === "aria-label" ? "label" : name}`;
    return result;
  };
  const dynamic = job.recipe.dynamic ?? [];
  if (!dynamic.some((p) => names.has(p)) && !job.recipe.wrappers.some((w) => w.dynamic?.some((p) => names.has(p)))) return job;
  return { ...job, fallback: dynamic.includes("children") && !job.recipe.label ? { ...job, label: null, icon: false } : job, suppliedNames: dynamic.filter((p) => names.has(p)),
    recipe: { ...job.recipe, props: fill(job.recipe.props, dynamic, "0"), wrappers: job.recipe.wrappers.map((w, n) => ({ ...w, props: fill(w.props, w.dynamic ?? [], String(n + 1)) })) },
    ...(dynamic.includes("children") && !job.recipe.label ? { label: "Example", icon: false } : {}),
  };
}

/** What an icon-size button shows: a plus drawn like a 16px Lucide icon. */
export const ICON_PATH = "M5 12h14M12 5v14";
export const ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATH}"></path></svg>`;

export interface RenderResult {
  readonly html: Map<string, string>;
  readonly suppliedNames: Map<string, readonly string[]>;
  readonly failures: Map<string, string>;
  readonly warnings: string[];
  /** Project-relative files the bundle read (its esbuild metafile inputs inside the root, packages left out). */
  readonly inputs: string[];
}

export interface RenderOptions {
  /** One esbuild run. */
  readonly bundleTimeoutMs?: number;
  /** One look's render, its modules' first load included. */
  readonly renderTimeoutMs?: number;
  /**
   * Contents to bundle instead of what is on disk, by absolute path: a file as it was at a base
   * commit (`youiyoux render`'s before side). null: the file did not exist then, so a module that
   * imports it fails to bundle. Only files the fence already lets in are read this way.
   */
  readonly overlay?: ReadonlyMap<string, string | null>;
}

export const BUNDLE_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 60_000;

const NAMESPACE = "youi-specimen-stub";
const GUARDED = "youiSpecimenGuarded";

/**
 * Modules that do not render on a server the way they do in the page: Next.js runtime modules
 * (links and images become plain tags, everything else does nothing), Radix's portal (its
 * content renders in place, so an open dialog shows), and the server/client markers.
 */
function stubFor(path: string): string | null {
  if (path === "next/link" || path === "next/dist/client/link") return `const React = require("react"); module.exports = { __esModule: true, default: React.forwardRef(function Link({ href, prefetch, replace, scroll, shallow, legacyBehavior, passHref, ...props }, ref) { return React.createElement("a", { ref, href: typeof href === "string" ? href : "#", ...props }); }) };`;
  if (path === "next/image") return `const React = require("react"); module.exports = { __esModule: true, default: function Image({ src, fill, priority, placeholder, blurDataURL, loader, quality, unoptimized, ...props }) { return React.createElement("img", { src: typeof src === "string" ? src : src && src.src, ...props }); } };`;
  if (/^next(?:\/|$)/.test(path)) return `const React = require("react"); const noop = () => undefined; const Passthrough = ({ children }) => children ?? null; module.exports = new Proxy({ __esModule: true, default: Passthrough }, { get: (target, name) => (name in target ? target[name] : typeof name === "string" && /^[A-Z]/.test(name) ? Passthrough : typeof name === "string" && name.startsWith("use") ? () => ({ push: noop, replace: noop, back: noop, prefetch: noop, refresh: noop, get: () => null, has: () => false }) : noop) });`;
  if (path === "@radix-ui/react-portal") return `const React = require("react"); const Portal = React.forwardRef(function Portal({ container, asChild, ...props }, ref) { return React.createElement("div", { ref, ...props }); }); module.exports = { __esModule: true, Portal, Root: Portal };`;
  if (path === "server-only" || path === "client-only") return "module.exports = {};";
  return null;
}

/**
 * The worker: loads the bundle (React only; each project module loads the first time a look
 * needs it, once), then renders each job, posting `{ start }` before and its result after, so the
 * parent knows which look a hang belongs to. Plain CommonJS, run with `eval: true`.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
console.error = console.warn = console.log = () => undefined;
const { React, renderToStaticMarkup, modules } = require(workerData.bundle);
const loaded = new Map();
const load = (file) => {
  if (!loaded.has(file)) {
    try {
      const thunk = modules[file];
      if (!thunk) throw new Error(file + " was not bundled");
      loaded.set(file, { module: thunk() });
    } catch (error) {
      loaded.set(file, { error: file + " threw when it loaded: " + String((error && error.message) || error).split("\\n")[0] });
    }
  }
  const entry = loaded.get(file);
  if (entry.error) throw new Error(entry.error);
  return entry.module;
};
const exported = (file, name) => {
  const module = load(file);
  const value = module && (name === "default" ? module.default : module[name]);
  if (value === undefined || value === null) throw new Error(file + " has no export " + name);
  return value;
};
for (const job of workerData.jobs) {
  parentPort.postMessage({ start: job.key });
  let result;
  const draw = (job) => {
    const icon = () => React.createElement("svg", { xmlns: "http://www.w3.org/2000/svg", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, React.createElement("path", { d: ${JSON.stringify(ICON_PATH)} }));
    let element = React.createElement(exported(job.file, job.export), job.props, ...(job.icon ? [icon()] : job.label === null ? [] : [job.label]));
    for (const wrapper of [...job.wrappers].reverse()) element = React.createElement(exported(wrapper.file, wrapper.export), wrapper.props, element);
    const html = renderToStaticMarkup(element).trim();
    if (!html) throw new Error("rendered nothing");
    return { html, suppliedNames: job.suppliedNames ?? [] };
  };
  try {
    try { result = draw(job); } catch (error) { if (!job.fallback) throw error; result = draw(job.fallback); }
  } catch (error) {
    result = { error: String((error && error.message) || error).split("\\n")[0] };
  }
  parentPort.postMessage({ key: job.key, ...result });
}
parentPort.postMessage({ done: true });
`;

/** The stubs (stubFor) as an esbuild plugin; `portal: false` keeps Radix's real portal (a browser bundle, where it works). */
export function stubs(root: string, { portal }: { portal: boolean }): Plugin {
  return {
    name: "youi-specimen-stubs",
    setup(build) {
      build.onResolve({ filter: portal ? /^(?:next(?:\/.*)?|@radix-ui\/react-portal|server-only|client-only)$/ : /^(?:next(?:\/.*)?|server-only|client-only)$/ }, (args) => ({ path: args.path, namespace: NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({ contents: stubFor(args.path) ?? "module.exports = {};", loader: "js", resolveDir: root }));
    },
  };
}

const SOURCE_LOADERS: Readonly<Record<string, "tsx" | "ts" | "jsx" | "js">> = { ".tsx": "tsx", ".ts": "ts", ".mts": "ts", ".cts": "ts", ".jsx": "jsx", ".js": "js", ".mjs": "js", ".cjs": "js" };

/** Serves `overlay` contents for the source files it names; anything else loads from disk. */
function overlaid(root: string, overlay: ReadonlyMap<string, string | null>): Plugin {
  return {
    name: "youi-specimen-overlay",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        if (!overlay.has(args.path)) return undefined;
        const loader = SOURCE_LOADERS[posix.extname(args.path.replace(/\\/g, "/"))];
        if (!loader) return undefined;
        const contents = overlay.get(args.path);
        if (contents === null || contents === undefined) return { errors: [{ text: `${displayPath(root, args.path)} did not exist at the base commit` }] };
        return { contents, loader, resolveDir: posix.dirname(args.path.replace(/\\/g, "/")) };
      });
    },
  };
}

/** Assets a component imports: stylesheets come from the project's sheet, images inline, fonts dropped. */
export const ASSET_LOADERS: BuildOptions["loader"] = { ".css": "empty", ".scss": "empty", ".sass": "empty", ".less": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".webp": "dataurl", ".woff": "empty", ".woff2": "empty", ".ttf": "empty" };

/** Why a module esbuild resolved may not be bundled, or null when it may. */
function moduleRefusal(root: string, importer: string, specifier: string, resolved: string): string | null {
  // An installed package loading its own files or its dependencies, wherever the store is.
  if (isAbsolute(importer) && !within(root, importer) && inPackage(importer)) return inPackage(resolved) || within(root, resolved) ? null : `"${specifier}" from a package leads outside node_modules`;
  if (packageName(specifier)) {
    const dir = packageUnderRoot(root, specifier);
    if (dir && within(dir, resolved)) return null;
  }
  if (within(root, resolved) && !(isAbsolute(importer) && !within(root, importer))) return null;
  return `"${specifier}" resolves outside the project root`;
}

/** Every import checked against the root before esbuild loads it (see moduleRefusal). */
export function containment(root: string, refusals: Set<string>): Plugin {
  return {
    name: "youi-specimen-root",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if ((args.pluginData as Record<string, unknown> | undefined)?.[GUARDED] || args.kind === "entry-point") return undefined;
        const result = await build.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, namespace: args.namespace === NAMESPACE ? "file" : args.namespace, pluginData: { [GUARDED]: true }, with: args.with });
        if (result.errors.length > 0) return { errors: result.errors, warnings: result.warnings };
        if (result.external || result.namespace !== "file" || !result.path) return { path: result.path, external: result.external, namespace: result.namespace, pluginData: result.pluginData, sideEffects: result.sideEffects, suffix: result.suffix };
        const reason = moduleRefusal(root, args.importer, args.path, result.path);
        if (reason) {
          const from = isAbsolute(args.importer) ? displayPath(root, args.importer) : "the specimen entry";
          refusals.add(`refused import ${reason} (from ${from})`);
          return { errors: [{ text: `refused: ${reason}` }] };
        }
        return { path: result.path, namespace: "file", pluginData: result.pluginData, sideEffects: result.sideEffects, suffix: result.suffix };
      });
    },
  };
}

/**
 * The tsconfig esbuild may use: inside the root, and every `extends` inside it or a package in
 * the root's node_modules. Returns its path, null for none, or why it was refused.
 */
export function checkedTsconfig(root: string, tsconfig: string): { path: string | null } | { refused: string } {
  const seen = new Set<string>();
  let current: string | null = tsconfig;
  let first: string | null = null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const inside = relativeInside(root, current);
    if ("refused" in inside) return { refused: `tsconfig ${current}: ${inside.refused}` };
    const file = join(root, inside.ok);
    if (!existsSync(file)) return first === null ? { path: null } : { refused: `tsconfig ${current} does not exist` };
    first ??= file;
    let extend: unknown;
    try {
      extend = (parseTsconfigJson(readFileSync(file, "utf8")) as { extends?: unknown }).extends;
    } catch {
      return { path: first };
    }
    current = null;
    for (const parent of (Array.isArray(extend) ? extend : [extend]).filter((e): e is string => typeof e === "string")) {
      if (parent.startsWith(".")) current = posix.join(posix.dirname(inside.ok), parent.endsWith(".json") ? parent : `${parent}.json`);
      else if (!packageUnderRoot(root, parent)) return { refused: `tsconfig ${inside.ok} extends "${parent}", outside the project root` };
    }
  }
  return { path: first };
}

/** esbuild's own words when its service process has gone: every later call in this process fails the same way until it is stopped. */
const SERVICE_GONE = /^The service (is no longer running|was stopped)/;

/**
 * An esbuild run that is cancelled after `timeoutMs`: its output, and (with `metafile`) the files
 * it read. When esbuild's service process has died (killed, or crashed), it is restarted and the
 * run tried once more, so a long-running hub or MCP server keeps bundling.
 */
export async function bundleWithin(options: BuildOptions & { metafile: true }, timeoutMs: number, signal?: AbortSignal): Promise<{ text: string; inputs: string[] }>;
export async function bundleWithin(options: BuildOptions, timeoutMs: number, signal?: AbortSignal): Promise<string>;
export async function bundleWithin(options: BuildOptions, timeoutMs: number, signal?: AbortSignal): Promise<string | { text: string; inputs: string[] }> {
  try {
    return await bundleOnce(options, timeoutMs, signal);
  } catch (error) {
    if (!(error instanceof Error && SERVICE_GONE.test(error.message))) throw error;
    await (await import("esbuild")).stop();
    return await bundleOnce(options, timeoutMs, signal);
  }
}

async function bundleOnce(options: BuildOptions, timeoutMs: number, signal?: AbortSignal): Promise<string | { text: string; inputs: string[] }> {
  signal?.throwIfAborted();
  const esbuild = await import("esbuild");
  const context = await esbuild.context({ ...options, write: false });
  let timer: NodeJS.Timeout | undefined;
  let stop: (() => void) | undefined;
  try {
    const result = await Promise.race([
      context.rebuild(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void context.cancel();
          reject(new Error(`esbuild timed out after ${limitOf(timeoutMs)}`));
        }, timeoutMs);
        // Stopped from outside (a Discover preview past its limit): cancelled the same way.
        stop = () => {
          void context.cancel();
          reject(new Error("esbuild was stopped"));
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      }),
    ]);
    const text = result.outputFiles![0]!.text;
    return options.metafile ? { text, inputs: Object.keys(result.metafile!.inputs) } : text;
  } finally {
    clearTimeout(timer);
    if (stop) signal?.removeEventListener("abort", stop);
    await context.dispose();
  }
}

export const bundleError = (error: unknown): string =>
  (error as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> }).errors?.slice(0, 3).map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text)).join("; ") || (error instanceof Error ? error.message : String(error));

type Outcome = { html?: string; error?: string; suppliedNames?: readonly string[] };

/**
 * Renders jobs in a worker, one result message per job. A job that overruns its time limit is
 * failed, the worker is stopped, and the jobs after it go on in a fresh one; past the total time
 * limit, every job not yet done fails.
 */
async function renderInWorkers(bundle: string, jobs: readonly RenderJob[], renderMs: number, totalMs: number): Promise<Map<string, Outcome>> {
  const results = new Map<string, Outcome>();
  const deadline = Date.now() + totalMs;
  let pending = [...jobs];
  while (pending.length > 0) {
    if (Date.now() >= deadline) {
      for (const job of pending) results.set(job.key, { error: `timed out: the project's looks took over ${limitOf(totalMs)}` });
      break;
    }
    const payloadOf = (j: RenderJob): object => ({ fallback: j.fallback ? payloadOf(j.fallback) : undefined, suppliedNames: j.suppliedNames, key: j.key, file: j.recipe.file, export: j.recipe.export, props: j.recipe.props, label: j.label, icon: j.icon === true, wrappers: j.recipe.wrappers });
    const payload = pending.map(payloadOf);
    const stopped = await new Promise<{ current: string | null; reason: string } | null>((done) => {
      const worker = new Worker(WORKER, { eval: true, workerData: { bundle, jobs: payload }, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
      let current: string | null = null;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: { current: string | null; reason: string } | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(total);
        void worker.terminate();
        done(value);
      };
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ current, reason: `timed out after ${limitOf(renderMs)}` }), renderMs);
      };
      const total = setTimeout(() => finish({ current, reason: `timed out: the project's looks took over ${limitOf(totalMs)}` }), Math.max(0, deadline - Date.now()));
      arm();
      worker.on("message", (message: { start?: string; key?: string; done?: true } & Outcome) => {
        if (message.start !== undefined) {
          current = message.start;
          arm();
        } else if (message.key !== undefined) {
          results.set(message.key, { html: message.html, error: message.error, suppliedNames: message.suppliedNames });
          current = null;
        } else if (message.done) finish(null);
      });
      worker.once("error", (error) => finish({ current, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) }));
      worker.once("exit", (code) => finish({ current, reason: `the render worker exited with code ${code}` }));
    });
    if (stopped === null) break;
    const left = pending.filter((j) => !results.has(j.key));
    if (stopped.current === null || stopped.reason.startsWith("timed out: ")) {
      // Not one look's fault (the bundle would not load, or the total ran out): every look left fails.
      for (const job of left) results.set(job.key, { error: stopped.reason });
      break;
    }
    results.set(stopped.current, { error: stopped.reason });
    pending = left.filter((j) => j.key !== stopped.current);
  }
  return results;
}

/** Bundle every module the jobs name, with the project's React, then render each job. */
export async function renderComponents(root: string, tsconfig: string, jobs: readonly RenderJob[], scratch: string, stats: SpecimenStats, options: RenderOptions = {}): Promise<RenderResult> {
  const html = new Map<string, string>();
  const suppliedNames = new Map<string, readonly string[]>();
  const failures = new Map<string, string>();
  const warnings: string[] = [];
  const inputs = new Set<string>();
  if (jobs.length === 0) return { html, suppliedNames, failures, warnings, inputs: [] };
  if (!packageUnderRoot(root, "react") || !packageUnderRoot(root, "react-dom")) {
    for (const job of jobs) failures.set(job.key, "react is not installed in the project");
    return { html, suppliedNames, failures, warnings: ["react and react-dom are not installed in the project's node_modules: component looks are drawn from their classes"], inputs: [] };
  }
  // A recipe file outside the root is never bundled (build.ts refuses it first, with a note).
  const runnable: RenderJob[] = [];
  for (const job of jobs) {
    const outside = [job.recipe.file, ...job.recipe.wrappers.map((w) => w.file)].map((f) => relativeInside(root, f)).find((r) => "refused" in r);
    if (outside && "refused" in outside) failures.set(job.key, `refused: ${outside.refused}`);
    else runnable.push(job);
  }
  const config = checkedTsconfig(root, tsconfig);
  if ("refused" in config) warnings.push(`refused ${config.refused}: bundled without it`);
  const refusals = new Set<string>();
  const bundleMs = options.bundleTimeoutMs ?? BUNDLE_TIMEOUT_MS;
  const bundleOf = async (files: readonly string[]): Promise<string> => {
    stats.bundles++;
    const entry = [
      `const React = require("react");`,
      `const { renderToStaticMarkup } = require("react-dom/server");`,
      // Thunks: a module's code runs only when a look needs it, so one that throws fails alone.
      `const modules = { ${files.map((file) => `${JSON.stringify(file)}: () => require(${JSON.stringify(`./${file}`)})`).join(", ")} };`,
      `module.exports = { React, renderToStaticMarkup, modules };`,
    ].join("\n");
    const { text, inputs: read } = await bundleWithin(
      {
        stdin: { contents: entry, resolveDir: root, loader: "tsx", sourcefile: "youi-specimens.tsx" },
        absWorkingDir: scratch,
        bundle: true,
        outfile: join(scratch, "bundle.cjs"),
        platform: "node",
        format: "cjs",
        jsx: "automatic",
        ...("path" in config && config.path ? { tsconfig: config.path } : { tsconfigRaw: {} }),
        define: { "process.env.NODE_ENV": '"production"' },
        loader: ASSET_LOADERS,
        logLevel: "silent",
        plugins: [stubs(root, { portal: true }), containment(root, refusals), ...(options.overlay ? [overlaid(root, options.overlay)] : [])],
        metafile: true,
      },
      bundleMs,
    );
    // Metafile paths are relative to the working directory; a package's own files are keyed by its version instead.
    for (const input of read) {
      if (/^[a-z-]+:/.test(input)) continue;
      const inside = relativeInside(root, resolve(scratch, input));
      if ("ok" in inside && !inside.ok.split("/").includes("node_modules")) inputs.add(inside.ok);
    }
    return text;
  };
  let files = [...new Set(runnable.flatMap((j) => [j.recipe.file, ...j.recipe.wrappers.map((w) => w.file)]))].sort();
  const unbundled = new Map<string, string>();
  let code: string | null = null;
  try {
    code = await bundleOf(files);
  } catch (error: unknown) {
    // Find the modules that do not bundle, one at a time, and bundle the rest without them.
    const whole = bundleError(error);
    const timedOut = whole.startsWith("esbuild timed out");
    for (const file of timedOut ? [] : files) {
      try {
        await bundleOf([file]);
      } catch (alone: unknown) {
        unbundled.set(file, bundleError(alone));
      }
    }
    files = files.filter((f) => !unbundled.has(f));
    if (unbundled.size === 0) {
      for (const job of runnable) failures.set(job.key, `bundle failed: ${whole}`);
      warnings.push(`the component bundle failed (${whole}): component looks are drawn from their classes`);
      return { html, suppliedNames, failures, warnings: [...warnings, ...refusals], inputs: [...inputs].sort() };
    }
    try {
      code = files.length > 0 ? await bundleOf(files) : null;
    } catch (error: unknown) {
      const message = bundleError(error);
      for (const job of runnable) failures.set(job.key, `bundle failed: ${message}`);
      return { html, suppliedNames, failures, warnings: [...warnings, ...refusals, `the component bundle failed (${message}): component looks are drawn from their classes`], inputs: [...inputs].sort() };
    }
  }
  const renderable: RenderJob[] = [];
  for (const job of runnable) {
    const broken = [job.recipe.file, ...job.recipe.wrappers.map((w) => w.file)].find((f) => unbundled.has(f));
    if (broken) failures.set(job.key, `${broken} did not bundle: ${unbundled.get(broken)}`);
    else renderable.push(job);
  }
  if (code !== null && renderable.length > 0) {
    const bundle = join(scratch, "bundle.cjs");
    writeFileSync(bundle, code);
    const results = await renderInWorkers(bundle, renderable, options.renderTimeoutMs ?? RENDER_TIMEOUT_MS, TOTAL_TIMEOUT_MS);
    for (const job of renderable) {
      const result = results.get(job.key);
      if (result?.html) { html.set(job.key, result.html); suppliedNames.set(job.key, result.suppliedNames ?? []); }
      else failures.set(job.key, result?.error ?? "not rendered");
    }
  }
  return { html, suppliedNames, failures, warnings: [...warnings, ...refusals], inputs: [...inputs].sort() };
}
