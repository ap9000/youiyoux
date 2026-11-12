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
  // The listener that hears a refusal can't take the fence down either.
  const tell = (refusal: FenceRefusal): void => {
    try {
      refused(refusal);
    } catch {
      // Ignored: the request is refused all the same.
    }
  };
  const refuseSocket = (socket: Duplex, authority: string): void => {
    tell({ kind: "socket", words: `the page tried to open a WebSocket or tunnel to ${authority}; it was blocked` });
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    socket.destroy();
  };
  /** A proxy request's whole address, parsed once; null when it names no http address that parses. */
  const addressOf = (url: string | undefined): URL | null => {
    if (!url || !/^http:\/\//i.test(url)) return null;
    try {
      return new URL(url);
    } catch {
      return null;
    }
  };
  /** The authority a tunnel or upgrade names, for the words only; never throws. */
  const authorityOf = (url: string | undefined): string => {
    const text = (url ?? "").slice(0, 200);
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).host || "an address";
    } catch {
      return "an address";
    }
  };
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // A proxy request names its whole address; anything else (no address, one that doesn't parse) isn't the browser's.
    const parsed = addressOf(req.url);
    if (!parsed) {
      tell({ kind: "origin", words: "a request that named no http address was refused" });
      req.resume();
      return void res.writeHead(400, { connection: "close" }).end();
    }
    if (req.headers.upgrade) return refuseSocket(req.socket, parsed.host);
    const verdict = requestVerdict(parsed.href, req.method ?? "GET", origin);
    if (!verdict.allow) {
      tell({ kind: verdict.kind, words: verdict.words });
      req.resume();
      return void res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("blocked by the youiyoux probe");
    }
    const upstream = httpRequest(
      { host: parsed.hostname.replace(/^\[|\]$/g, ""), port: parsed.port || 80, path: `${parsed.pathname}${parsed.search}`, method: req.method, headers: forwardHeaders(req.headers), agent: false },
      (answer) => {
        answer.on("error", () => res.destroy());
        res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers));
        answer.pipe(res);
      },
    );
    // A side that goes away ends the other; no stream error goes unheard.
    req.on("error", () => upstream.destroy());
    res.on("error", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    req.pipe(upstream);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // No throw may escape a listener: it would end the process the fence runs in.
    try {
      handle(req, res);
    } catch {
      try {
        if (!res.headersSent) res.writeHead(500, { connection: "close" });
        res.end();
      } catch {
        req.socket.destroy();
      }
    }
  });
  // A WebSocket (ws:// and wss://) and https reach a proxy as a tunnel: never opened.
  const refuseTunnel = (req: IncomingMessage, socket: Duplex): void => {
    try {
      refuseSocket(socket, authorityOf(req.url));
    } catch {
      socket.destroy();
    }
  };
  server.on("connect", refuseTunnel);
  server.on("upgrade", refuseTunnel);
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
