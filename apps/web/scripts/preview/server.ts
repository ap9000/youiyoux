/**
 * The preview deploy's web server: serves a built hub (dist/) with no dependencies. Unknown paths
 * without an extension get index.html, so client routes (/elements/…, /tokens/…) load directly.
 * Preview URLs are public but not meant to be found, so every response asks not to be indexed.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

export const HEALTH_PATH = "/healthz";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
/** Vite's hashed bundles, and the snapshot's content-hashed catalog and usage files. */
const HASHED = /^\/assets\/|^\/data\/.+\.[0-9a-f]{10}\.json$/;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // The hub frames its own preview.html; nothing else may frame either document.
  "X-Frame-Options": "SAMEORIGIN",
};

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": REVALIDATE });
  res.end(body);
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string): void {
  res.writeHead(200, { ...BASE_HEADERS, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": statSync(file).size, "Cache-Control": cache });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** The file under `root` that `pathname` names, or null when it escapes `root` or is not a file. */
function fileFor(root: string, pathname: string): string | null {
  const file = resolve(join(root, pathname));
  if (file !== root && !file.startsWith(`${root}${sep}`)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

export function handle(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return send(res, 405, "method not allowed");
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://preview").pathname);
  } catch {
    return send(res, 400, "bad request");
  }
  if (pathname.includes("\0")) return send(res, 400, "bad request");
  if (pathname === HEALTH_PATH) return send(res, 200, "ok");

  const file = fileFor(root, pathname === "/" ? "/index.html" : pathname);
  if (file) return sendFile(req, res, file, HASHED.test(pathname) ? IMMUTABLE : REVALIDATE);
  if (extname(pathname) === "") return sendFile(req, res, join(root, "index.html"), REVALIDATE);
  return send(res, 404, "not found");
}

/** A server for the built hub in `dist`; it refuses to start on a directory with no index.html. */
export function createPreviewServer(dist: string): Server {
  const root = resolve(dist);
  if (!existsSync(join(root, "index.html"))) throw new Error(`${root} has no index.html: run the preview build first`);
  return createServer((req, res) => handle(root, req, res));
}
