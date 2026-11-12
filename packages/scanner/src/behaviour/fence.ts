/**
 * The probe's network fence: a proxy on this machine that the probe's browser context must send
 * every request through (loopback included), which passes only reads (GET, HEAD, OPTIONS) to the one
 * consented origin and refuses everything else, every WebSocket and tunnel included.
 *
 * Page-level routing alone is not enough: Playwright's route never sees a redirect's next hop, nor a
 * WebSocket a Web Worker opens, so an app could reach another port through either. Below the page,
 * the browser's own network stack sends all of those here. A refusal never reaches the app: the
 * browser sees a 403 or a failed connection, and the probe hears what was refused.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { requestVerdict } from "./guards.ts";

export interface FenceRefusal {
  readonly kind: "write" | "origin" | "socket";
  /** Plain words: what was tried, its path only, and that nothing was sent. */
  readonly words: string;
}

export interface Fence {
  /** The proxy's address, for the browser context's `proxy.server`. */
  readonly server: string;
  close(): Promise<void>;
}

/** Hop-by-hop headers (and the proxy's own), never passed on. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"]);

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name.toLowerCase())));
}

/** Start a fence that lets reads reach `origin` (an http origin on this machine) and nothing else. */
export async function startFence(origin: string, refused: (refusal: FenceRefusal) => void): Promise<Fence> {
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.origin !== origin) throw new Error(`the fence takes an http origin, not ${origin}`);
  const sockets = new Set<Socket | Duplex>();
  const refuseSocket = (socket: Duplex, authority: string): void => {
    refused({ kind: "socket", words: `the page tried to open a WebSocket or tunnel to ${authority}; it was blocked` });
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    socket.destroy();
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    // A proxy request names its whole address; anything else isn't the browser's.
    if (!/^http:\/\//i.test(url)) {
      refused({ kind: "origin", words: "a request that named no http address was refused" });
      return void res.writeHead(400, { connection: "close" }).end();
    }
    if (req.headers.upgrade) return refuseSocket(req.socket, new URL(url).host);
    const verdict = requestVerdict(url, req.method ?? "GET", origin);
    if (!verdict.allow) {
      refused({ kind: verdict.kind, words: verdict.words });
      req.resume();
      return void res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("blocked by the youiyoux probe");
    }
    const parsed = new URL(url);
    const upstream = httpRequest(
      { host: parsed.hostname.replace(/^\[|\]$/g, ""), port: parsed.port || 80, path: `${parsed.pathname}${parsed.search}`, method: req.method, headers: forwardHeaders(req.headers), agent: false },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers));
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    req.pipe(upstream);
  });
  // A WebSocket (ws:// and wss://) and https reach a proxy as a tunnel: never opened.
  server.on("connect", (req: IncomingMessage, socket: Duplex) => refuseSocket(socket, req.url ?? "an address"));
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => refuseSocket(socket, (() => {
    try {
      return new URL(req.url ?? "").host;
    } catch {
      return "an address";
    }
  })()));
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket: Duplex) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the probe's fence has no port");
  return {
    server: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
