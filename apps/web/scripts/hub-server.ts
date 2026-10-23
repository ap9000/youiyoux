/**
 * The hub's own server for a built hub: what `youiyoux ui` runs from the npm package, where there
 * is no Vite. It serves, on this machine only (127.0.0.1, and a Host of this machine, else 403):
 *
 * - the built hub (`--dist`: index.html, assets/), client routes falling back to index.html;
 * - the snapshot's public files (`--snapshot`: data/, previews/), which win over the build's;
 * - the preview frame: /preview.html and /kit/ from the frame kit (`--kit`), /frame/ from the
 *   snapshot's frame, built from its demos at start (`--build-frame`, scripts/frame.ts);
 * - the endpoints the dev server has: Try it, the local index's queries, Discover previews and
 *   thumbnails (the same middleware as vite.config.ts);
 * - /api/, proxied to the workflow service (`--api`), as the dev server does;
 * - with `--live`, /__youi/events: an event each time the snapshot's manifest is rewritten
 *   (`youiyoux ui --watch`), named in index.html so the open hub loads each new generation.
 *
 *   node scripts/hub-server.ts --dist <built hub> --kit <frame kit> --snapshot <dir> [--port n] [--api url] [--live] [--build-frame]
 */
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverPreviewMiddleware } from "./discover-preview-server.ts";
import { discoverThumbsMiddleware } from "./discover-thumbs.ts";
import { buildFrame, FRAME_PATH, frameIsCurrent, KIT_PATH, type FrameBuild } from "./frame.ts";
import { BASE_HEADERS, fileFor, IMMUTABLE, REVALIDATE, send, sendFile } from "./preview/server.ts";
import { isLocalHost, queryMiddleware } from "./query-server.ts";
import { tryMiddleware } from "./try-server.ts";

export const EVENTS_PATH = "/__youi/events";
/** index.html names the event stream with this meta tag when the snapshot is live (src/data/store.ts reads it). */
export const LIVE_META = "youi-live";
const HASHED = /^\/assets\/|^\/data\/.+\.[0-9a-f]{10}\.(json|webp|png|css)$|^\/kit\/chunks\//;
/** A path that names a file, never a client route: a miss here is a 404, not the hub. */
const FILE_PATHS = /^\/(?:assets|data|previews|kit|frame)\/|^\/preview\.html$|^\/favicon\.svg$/;

export interface HubServerOptions {
  /** The built hub: index.html and assets/. */
  readonly dist: string;
  /** The preview frame's kit (scripts/frame.ts buildFrameKit). */
  readonly kit: string;
  /** The snapshot directory: public/, preview/, frame/. */
  readonly snapshot: string;
  /** The workflow service, proxied at /api/. */
  readonly api?: string;
  /** Announce each new snapshot generation at /__youi/events. */
  readonly live?: boolean;
  /** Build the snapshot's frame from its demos (else it is served as it is). */
  readonly buildFrame?: boolean;
  /** Where a new frame build is reported (default: stdout). */
  readonly log?: (line: string) => void;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void | Promise<void>;

/** Each demo the frame could not build, in words, for the terminal. */
function frameNotes(build: FrameBuild): string[] {
  return Object.entries(build.errors).map(([name, why]) => `preview frame: ${name} has no live preview: ${why}`);
}

/** What the workflow service reads of a request (packages/workflow/src/http.ts); nothing else is passed on. */
const FORWARDED = ["accept", "content-type", "content-length", "origin", "sec-fetch-site", "x-youi-session"] as const;

function proxy(api: string | undefined, req: IncomingMessage, res: ServerResponse): void {
  const offline = (): void => {
    if (res.headersSent) return void res.destroy();
    send(res, 502, "the workflow service is not running: start the hub with youiyoux ui --project <your product>");
  };
  if (!api) return offline();
  // The service's own address, then only the path and query asked for: a request target such as
  // `//elsewhere/api/x` never chooses where this goes.
  const raw = req.url ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return send(res, 400, "bad request");
  const parsed = new URL(raw, "http://hub.local");
  const service = new URL(api);
  const target = new URL(`${parsed.pathname}${parsed.search}`, service.origin);
  if (target.origin !== service.origin) return send(res, 400, "bad request");
  const headers: Record<string, string | string[]> = { host: target.host };
  for (const name of FORWARDED) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const upstream = request(target, { method: req.method, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on("error", offline);
  req.pipe(upstream);
}

export async function createHubServer(options: HubServerOptions): Promise<{ server: Server; close(): Promise<void> }> {
  const dist = resolve(options.dist);
  const kit = resolve(options.kit);
  const snapshot = resolve(options.snapshot);
  const pub = join(snapshot, "public");
  const frame = join(snapshot, "frame");
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist} has no index.html: the hub is not built`);
  if (!existsSync(join(kit, "preview.html"))) throw new Error(`${kit} has no preview.html: the preview frame's kit is not built`);

  const rebuildFrame = async (): Promise<void> => {
    if (!options.buildFrame || !existsSync(join(snapshot, "preview"))) return;
    if (frameIsCurrent(snapshot, frame)) return;
    for (const note of frameNotes(await buildFrame(snapshot, kit, frame))) log(note);
  };
  await rebuildFrame();

  const index = readFileSync(join(dist, "index.html"), "utf8");
  const page = options.live ? index.replace("</head>", `    <meta name="${LIVE_META}" content="${EVENTS_PATH}" />\n  </head>`) : index;
  const listeners = new Set<ServerResponse>();
  let watcher: FSWatcher | null = null;
  if (options.live && existsSync(join(pub, "data"))) {
    // The snapshot writes its manifest last and atomically (a rename), so one event is one new generation.
    let pending: Promise<void> = Promise.resolve();
    watcher = watch(join(pub, "data"), (_event, file) => {
      if (file !== "manifest.json") return;
      pending = pending.then(rebuildFrame).catch((error: unknown) => log(`preview frame: not rebuilt: ${error instanceof Error ? error.message : String(error)}`)).then(() => {
        for (const res of listeners) res.write("event: snapshot\ndata: {}\n\n");
      });
    });
  }

  const middleware: Middleware[] = [tryMiddleware(snapshot), queryMiddleware(), discoverPreviewMiddleware(snapshot, "/", { fallback: null }), discoverThumbsMiddleware(snapshot)];
  const run = (req: IncomingMessage, res: ServerResponse, at: number, last: () => void): void => {
    const step = middleware[at];
    if (!step) return last();
    void Promise.resolve(step(req, res, () => run(req, res, at + 1, last))).catch(() => {
      if (!res.headersSent) send(res, 500, "internal error");
    });
  };

  const serveFile = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    const cache = HASHED.test(pathname) ? IMMUTABLE : REVALIDATE;
    if (pathname === "/preview.html") return sendFile(req, res, join(kit, "preview.html"), REVALIDATE);
    if (pathname.startsWith(KIT_PATH)) {
      const file = fileFor(kit, pathname.slice(KIT_PATH.length - 1));
      return file && !file.endsWith(".src") && !file.endsWith("candidates.json") ? sendFile(req, res, file, cache) : send(res, 404, "not found");
    }
    if (pathname.startsWith(FRAME_PATH)) {
      const file = fileFor(frame, pathname.slice(FRAME_PATH.length - 1));
      return file ? sendFile(req, res, file, REVALIDATE) : send(res, 404, "not found");
    }
    const file = (pathname !== "/" && fileFor(pub, pathname)) || (pathname !== "/" && pathname !== "/index.html" && fileFor(dist, pathname));
    if (file) return sendFile(req, res, file, cache);
    if (FILE_PATHS.test(pathname)) return send(res, 404, "not found");
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": REVALIDATE });
    res.end(req.method === "HEAD" ? undefined : page);
  };

  const server = createServer((req, res) => {
    if (!isLocalHost(req.headers.host)) return send(res, 403, "this hub answers only on this machine");
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://hub.local").pathname);
    } catch {
      return send(res, 400, "bad request");
    }
    if (pathname.includes("\0")) return send(res, 400, "bad request");
    if (pathname === "/api" || pathname.startsWith("/api/")) return proxy(options.api, req, res);
    run(req, res, 0, () => {
      if (pathname === EVENTS_PATH && options.live) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(": live\n\n");
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return send(res, 405, "method not allowed");
      }
      serveFile(req, res, pathname);
    });
  });
  return {
    server,
    close: async () => {
      watcher?.close();
      for (const res of listeners) res.end();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Listen on this machine; with no port named, the first free one from 5173, as Vite does. */
export async function listen(server: Server, port: number | null): Promise<number> {
  for (let next = port ?? 5173; ; next++) {
    const result = await new Promise<number | NodeJS.ErrnoException>((done) => {
      const onError = (error: NodeJS.ErrnoException): void => done(error);
      server.once("error", onError);
      server.listen(next, "127.0.0.1", () => {
        server.off("error", onError);
        done((server.address() as AddressInfo).port);
      });
    });
    if (typeof result === "number") return result;
    if (result.code !== "EADDRINUSE" || port !== null || next > 5173 + 50) throw result;
  }
}

export async function main(): Promise<void> {
  const { values } = parseArgs({ options: { dist: { type: "string" }, kit: { type: "string" }, snapshot: { type: "string" }, port: { type: "string" }, api: { type: "string" }, live: { type: "boolean" }, "build-frame": { type: "boolean" } } });
  if (!values.dist || !values.kit || !values.snapshot) throw new Error("hub-server: --dist, --kit and --snapshot are required");
  const hub = await createHubServer({ dist: values.dist, kit: values.kit, snapshot: values.snapshot, ...(values.api ? { api: values.api } : {}), live: values.live ?? false, buildFrame: values["build-frame"] ?? false });
  const port = await listen(hub.server, values.port ? Number(values.port) : null);
  process.stdout.write(`hub http://localhost:${port}/\n`);
  const stop = (): void => void hub.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) await main();
