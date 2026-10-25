/**
 * Discover previews on the hub's own server: one candidate drawn in the user's project theme, on
 * request, never before.
 *
 * The dev and preview servers (vite.config.ts) answer
 * `GET /__youi/discover-preview?id=<lib: id or ref>&project=<project id>` with
 *
 *   { id, project, script, css: { light, dark }, html, compose, fit, notes, parts, implicitDeps,
 *     missing, install, license, fetched }
 *
 * or `{ error }` (a plain sentence). `script` and the two `css` are URLs under
 * `/__youi/discover-preview/<hash>.{js,css}`, served immutable. The request names ids only, never
 * a path: the project is one the snapshot's try.json lists (its root and tsconfig), the candidate
 * one the local Discover index lists. Only a request whose Host is this machine is answered.
 *
 * Opening a candidate is the one step that may use the network: its registry source is fetched
 * (cache-first, `show --source`'s path, each request timed out) into the Discover cache, with the
 * registry parts it imports (preparePreview). The fetched code never runs on this server: it is
 * bundled (bundlePreview: fenced to the project root, its packages and that one preview
 * directory) and runs only in the hub's sandboxed frame. The project's CSS is built with
 * Tailwind's sources widened to the fetched files (so the classes they use exist in the project's
 * sheet), with forced-state twins for the state strip; theme fit says what the project's tokens
 * draw and what they cannot. One build per candidate and project is in flight at a time, at most
 * MAX_BUILDS builds run at once with MAX_QUEUED waiting (more is answered 503), and a build past
 * PREVIEW_TIMEOUT_MS is aborted: its fetches, esbuild and Tailwind workers are stopped.
 *
 * A build is something only the hub's own page asks for: a request with an Origin that is not
 * this machine (a sandboxed frame's `null` included) or marked `Sec-Fetch-Site: cross-site` is
 * refused, so another site the person has open cannot make the hub fetch and build. The bundles
 * and sheets themselves (content-addressed, immutable) are served to the hub's frames, which are
 * cross-origin by design.
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { dirname, join, posix, resolve } from "node:path";
import { loadPackage } from "./packages.ts";
import { isLocalHost, send } from "./query-server.ts";
import { readTryIndex } from "./try-server.ts";

const PREVIEW_PATH = "/__youi/discover-preview";
/** The whole preview: fetch, bundle, CSS and theme fit. */
const PREVIEW_TIMEOUT_MS = 60_000;
/** One registry request. */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CSS = 32;
/** Builds running at once, across candidates and projects. */
const MAX_BUILDS = 2;
/** Builds waiting for a slot; past that a request is answered 503. */
const MAX_QUEUED = 4;
/** How long a stopped build may take to wind down before its 504 is sent anyway. */
const STOP_GRACE_MS = 2_000;
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/** The hub's own packages: what draws a candidate whose packages the project does not have. */
const HUB_ROOT = resolve(import.meta.dirname, "..");

type Discover = typeof import("../../../packages/discover/src/index.ts");

/** What the server uses of the scanner (typed here, so the hub never compiles the scanner). */
interface ComposeNode {
  readonly export: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<ComposeNode | string>;
}
type Built = { hash: string; code: string; notes: readonly string[] } | { error: string; busy?: true };
interface Fit {
  readonly themed: readonly string[];
  readonly unthemed: readonly string[];
  readonly type: { readonly item: number | null; readonly project: number | null };
  readonly radius: number | null;
}
interface Scanner {
  loadInventoryTarget(root: string): Promise<{ files: readonly string[]; templates: readonly string[]; tsconfig: string; specimenCss: readonly string[] | null }>;
  composeOf(name: string, exports: readonly string[], label: string): ComposeNode | null;
  tsconfigAliases(root: string, tsconfig?: string): Array<[string, string]>;
  bundlePreview(job: { root: string; tsconfig: string; dir: string; main: string; compose: ComposeNode; fallback?: string | null; projectParts?: readonly string[] }, options?: { signal?: AbortSignal }): Promise<Built>;
  buildProjectCss(root: string, files: readonly string[], stats: unknown, options: { tsconfig?: string; templates?: readonly string[]; override?: readonly string[] | null; extraSources?: readonly string[]; signal?: AbortSignal }): Promise<{ light: string | null; dark: string | null; warnings: string[] }>;
  newStats(): unknown;
  forcedStates(css: string): string;
  projectTheme(root: string): Promise<{ theme: unknown; sources: string[] }>;
  themeFit(input: { theme: unknown; item: readonly string[]; project: readonly string[]; cssVars?: unknown }): Fit;
  BrowserBundleCache: new () => { get(key: string, build: () => Promise<Built>): Promise<Built>; code(hash: string): string | null };
}

export interface PreviewAnswer {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly script: string | null;
  readonly css: { readonly light: string; readonly dark: string } | null;
  /** A block's page, drawn at a page's size rather than as one component. */
  readonly page?: boolean;
  /** What the frame shows before its script draws: nothing yet. */
  readonly html: string;
  readonly compose: ComposeNode | null;
  readonly fit: Fit;
  /** What was substituted or fetched, in plain words. */
  readonly notes: readonly string[];
  readonly parts: ReadonlyArray<{ readonly name: string; readonly from: string; readonly detail: string }>;
  /** Packages its code imports without declaring them. */
  readonly implicitDeps: readonly string[];
  /** Why it could not be drawn, when it could not (the listing and theme fit still stand). */
  readonly error: string | null;
  readonly install: { readonly command: string; readonly npm: readonly string[] } | null;
  readonly license: string;
  /** Whether this open fetched anything (false: it came from the cache). */
  readonly fetched: boolean;
  readonly ms: number;
  /** The listing as youi.library/v1: what Save to Library and Add to my project draft. */
  readonly entry: import("@youiyoux/core").LibraryEntry;
}

export interface PreviewOptions {
  /** The Discover cache directory (default: as the CLI). */
  readonly cache?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The network seam (tests replay recorded responses). */
  readonly fetcher?: import("../../../packages/discover/src/index.ts").Fetcher;
  readonly timeoutMs?: number;
  /** Builds at once and builds waiting (default MAX_BUILDS, MAX_QUEUED). */
  readonly maxBuilds?: number;
  readonly maxQueued?: number;
  /** Where packages the project lacks come from (default: the hub's own). */
  readonly fallback?: string | null;
}

/** A lib: id or a registry ref; never a path. */
const ID = /^(?:lib:[a-z0-9-]+\/(?:component|pattern|token)\/[a-z0-9][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/i;

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

/** Whether a project file sits inside a package of its own (a package.json between it and the root): another package's code, not the project's. */
function inNestedPackage(root: string, file: string): boolean {
  for (let dir = dirname(file); dir !== "." && dir !== "/" && dir !== ""; dir = dirname(dir)) if (existsSync(join(root, dir, "package.json"))) return true;
  return false;
}

/**
 * Where the project keeps its ui components, as its components.json says (`aliases.ui`, through
 * the tsconfig's paths): `src/components/ui`, or null when it says nothing usable.
 */
export function uiDirOf(root: string, aliases: ReadonlyArray<readonly [string, string]>): string | null {
  let ui: unknown;
  try {
    ui = (JSON.parse(readFileSync(join(root, "components.json"), "utf8")) as { aliases?: { ui?: unknown } }).aliases?.ui;
  } catch {
    return null;
  }
  if (typeof ui !== "string") return null;
  const alias = aliases.find(([key]) => ui.startsWith(key));
  return alias ? posix.join(alias[1], ui.slice(alias[0].length)) : null;
}

/**
 * The project's own component for a registry part (`button`): one in the folder its components.json
 * names first, else any `components/[ui/]<name>`, never one inside a nested package (a design
 * package of its own, say), which is not what the project's code imports.
 */
export function projectParts(root: string, files: readonly string[], exportNames: (source: string) => string[], uiDir: string | null = null) {
  return (name: string) => {
    const pattern = new RegExp(`(?:^|/)components/(?:ui/)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:tsx|jsx|ts|js)$`);
    const found = files.filter((f) => pattern.test(f) && !inNestedPackage(root, f));
    const file = (uiDir ? found.find((f) => posix.dirname(f) === uiDir) : undefined) ?? found[0];
    if (!file) return null;
    const absolute = join(root, file);
    try {
      return { file: absolute, display: file, exports: exportNames(readFileSync(absolute, "utf8")) };
    } catch {
      return null;
    }
  };
}

/**
 * The preview endpoint for a snapshot directory, as connect middleware under the hub's `base`.
 * `load` loads the discover and scanner modules (a test passes its own).
 */
export function discoverPreviewMiddleware(snapshot: string, base = "/", options: PreviewOptions = {}, load: () => Promise<{ discover: Discover; scanner: Scanner }> = async () => ({ discover: await loadPackage<Discover>("discover"), scanner: await loadPackage<Scanner>("scanner") })) {
  const env = options.env ?? process.env;
  const fallback = options.fallback === undefined ? HUB_ROOT : options.fallback;
  let modules: Promise<{ discover: Discover; scanner: Scanner; bundles: InstanceType<Scanner["BrowserBundleCache"]> }> | null = null;
  const loaded = () => (modules ??= load().then((m) => ({ ...m, bundles: new m.scanner.BrowserBundleCache() })));
  const css = new Map<string, string>();
  const inFlight = new Map<string, Promise<PreviewAnswer>>();

  const keepCss = (text: string): string => {
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    css.delete(hash);
    css.set(hash, text);
    while (css.size > MAX_CSS) css.delete(css.keys().next().value!);
    return `${base}${PREVIEW_PATH.slice(1)}/${hash}.css`;
  };

  async function preview(id: string, projectId: string, root: string, tsconfig: string, signal: AbortSignal): Promise<PreviewAnswer> {
    const started = performance.now();
    const { discover, scanner, bundles } = await loaded();
    const cache = resolve(options.cache ?? discover.discoverCacheDir(undefined, env));
    if (!existsSync(join(cache, discover.INDEX_FILE))) throw new Refusal(404, "There is no Discover index on this machine yet: run youiyoux discover sync.");
    const { entry } = await discover.findListing(cache, id).catch((error: unknown) => {
      throw new Refusal(404, sentence(error));
    });
    const license = discover.licenceOf(entry);
    const install = entry.install ? { command: entry.install.command, npm: entry.install.npm } : null;
    const target = await scanner.loadInventoryTarget(root);
    const { theme, sources } = await scanner.projectTheme(root);
    let requests = 0;
    const network = options.fetcher ?? discover.nodeFetcher;
    // Each request carries the build's signal too: a build past its limit stops fetching at once.
    const fetchOptions = {
      timeoutMs: FETCH_TIMEOUT_MS,
      fetcher: ((url, init) => {
        signal.throwIfAborted();
        requests++;
        return network(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
      }) satisfies NonNullable<PreviewOptions["fetcher"]>,
    };
    let prepared: Awaited<ReturnType<Discover["preparePreview"]>>;
    try {
      prepared = await discover.preparePreview(cache, entry.id, { ...fetchOptions, projectPart: projectParts(root, target.files, discover.exportNames, uiDirOf(root, scanner.tsconfigAliases(root, target.tsconfig))) });
    } catch (error: unknown) {
      // An npm package, or an item that could not be fetched: the listing stands, without a drawing.
      return { id: entry.id, name: entry.name, entry, project: projectId, script: null, css: null, html: "", compose: null, fit: { themed: [], unthemed: [], type: { item: null, project: null }, radius: null }, notes: [], parts: [], implicitDeps: entry.install?.implicitDeps ?? [], error: sentence(error), install, license, fetched: requests > 0, ms: Math.round(performance.now() - started) };
    }
    signal.throwIfAborted();
    const fit = scanner.themeFit({ theme, item: prepared.sources, project: sources, cssVars: prepared.cssVars });
    const compose = scanner.composeOf(entry.name, prepared.exports, entry.title ?? entry.name);
    const common = { id: entry.id, name: entry.name, entry, project: projectId, page: prepared.page, html: "", compose, fit, parts: prepared.parts.map(({ name, from, detail }) => ({ name, from, detail })), implicitDeps: prepared.implicit, install, license, fetched: requests > 0 };
    if (!compose) return { ...common, script: null, css: null, notes: [], error: `${entry.name} exports no component to draw`, ms: Math.round(performance.now() - started) };
    const [built, sheet] = await Promise.all([
      bundles.get(`${projectId}\0${prepared.key}\0${root}`, () => scanner.bundlePreview({ root, tsconfig, dir: prepared.dir, main: prepared.main, compose, fallback, projectParts: prepared.parts.flatMap((part) => (part.file ? [part.file] : [])) }, { signal })),
      scanner.buildProjectCss(root, target.files, scanner.newStats(), { tsconfig: target.tsconfig, templates: target.templates, override: target.specimenCss, extraSources: [prepared.dir], signal }),
    ]);
    signal.throwIfAborted();
    const styles = sheet.light !== null && sheet.dark !== null ? { light: keepCss(scanner.forcedStates(sheet.light)), dark: keepCss(scanner.forcedStates(sheet.dark)) } : null;
    const ms = Math.round(performance.now() - started);
    if ("error" in built) return { ...common, script: null, css: styles, notes: [], error: built.error, ms };
    const notes = [...(built.notes ?? []), ...(styles ? [] : ["your project loads no stylesheet, so it draws unstyled"])];
    return { ...common, script: `${base}${PREVIEW_PATH.slice(1)}/${built.hash}.js`, css: styles, notes, error: null, ms };
  }

  /* Builds at once, and the ones waiting for a slot (each resolves when it may start). */
  const maxBuilds = options.maxBuilds ?? MAX_BUILDS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED;
  let running = 0;
  const waiting: Array<{ start: () => void; signal: AbortSignal }> = [];
  const release = (): void => {
    running--;
    while (waiting.length > 0 && running < maxBuilds) {
      const next = waiting.shift()!;
      if (next.signal.aborted) continue;
      running++;
      next.start();
    }
  };
  /** A slot for one build, or a 503 when every slot and the queue are taken. */
  function slot(signal: AbortSignal): Promise<void> {
    if (running < maxBuilds) {
      running++;
      return Promise.resolve();
    }
    if (waiting.length >= maxQueued) return Promise.reject(new Refusal(503, `The hub is already drawing ${running} previews with ${waiting.length} waiting; open it again in a moment.`));
    return new Promise((start, reject) => {
      const entry = { start, signal };
      waiting.push(entry);
      signal.addEventListener("abort", () => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        reject(signal.reason);
      }, { once: true });
    });
  }

  /** One build: a slot, then the work, aborted (fetches, esbuild, Tailwind) once it runs past `ms`. */
  function build(id: string, projectId: string, root: string, tsconfig: string, ms: number): Promise<PreviewAnswer> {
    const controller = new AbortController();
    const stopped = new Refusal(504, `The preview took over ${Math.round(ms / 1000)}s and was stopped; the listing stands.`);
    const timer = setTimeout(() => controller.abort(stopped), ms);
    const work = slot(controller.signal).then(() => preview(id, projectId, root, tsconfig, controller.signal).finally(release));
    // Aborted, the work stops (its fetches fail, esbuild and Tailwind are cancelled) and frees its
    // slot; the answer waits for that, up to STOP_GRACE_MS, so a 504 means it has stopped.
    const settled = work.then(
      (answer) => {
        if (controller.signal.aborted) throw stopped;
        return answer;
      },
      (error: unknown) => {
        throw controller.signal.aborted ? stopped : error;
      },
    );
    const late = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => setTimeout(() => reject(stopped), STOP_GRACE_MS).unref(), { once: true }));
    return Promise.race([settled, late]).finally(() => clearTimeout(timer));
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL((req.url ?? "/").replace(base, "/"), "http://hub.local");
    if (!url.pathname.startsWith(PREVIEW_PATH) || req.method !== "GET") return next();
    if (!isLocalHost(req.headers.host)) return send(res, 403, { error: "Previews answer this machine only (Host must be localhost)." });
    const origin = req.headers.origin;
    const crossSite = req.headers["sec-fetch-site"] === "cross-site" || (origin !== undefined && !LOOPBACK_ORIGIN.test(origin));
    try {
      const asset = /^\/__youi\/discover-preview\/([0-9a-f]{16})\.(js|css)$/.exec(url.pathname);
      if (asset) {
        const body = asset[2] === "js" ? (modules ? (await modules).bundles.code(asset[1]!) : null) : (css.get(asset[1]!) ?? null);
        if (body === null) return send(res, 404, { error: "no such file" });
        res.setHeader("Content-Type", asset[2] === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(body);
        return;
      }
      if (url.pathname !== PREVIEW_PATH) return send(res, 404, { error: "not found" });
      if (crossSite) return send(res, 403, { error: "Previews are built for the hub's own page only; a request from another site is refused." });
      const id = url.searchParams.get("id") ?? "";
      if (!ID.test(id) || id.length > 200) return send(res, 400, { error: "Name a candidate by its lib: id or registry ref." });
      const projects = readTryIndex(snapshot)?.projects ?? {};
      const wanted = url.searchParams.get("project");
      const projectId = wanted && Object.hasOwn(projects, wanted) ? wanted : wanted ? null : (Object.keys(projects)[0] ?? null);
      if (projectId === null) return send(res, 404, { error: wanted ? `The hub has no project "${wanted.slice(0, 60)}".` : "Previews draw in your project's theme, and the hub has no project: open it with youiyoux ui --project." });
      const project = projects[projectId]!;
      const root = resolve(snapshot, project.root);
      const key = `${projectId}\0${id}`;
      let work = inFlight.get(key);
      if (!work) {
        work = build(id, projectId, root, project.tsconfig, options.timeoutMs ?? PREVIEW_TIMEOUT_MS).finally(() => inFlight.delete(key));
        inFlight.set(key, work);
      }
      send(res, 200, await work);
    } catch (error: unknown) {
      if (error instanceof Refusal) return send(res, error.status, { error: error.message });
      send(res, 500, { error: `The preview failed: ${sentence(error)}` });
    }
  };
}
