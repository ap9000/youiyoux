/**
 * The probe's network fence: a proxy on this machine that the probe's browser context must send
 * every request through (loopback included), which passes only reads (GET, HEAD, OPTIONS, without a
 * body) to the one consented origin and refuses everything else, every WebSocket and tunnel included.
 *
 * Page-level routing alone is not enough: Playwright's route never sees a redirect's next hop, nor a
 * WebSocket a Web Worker opens, so an app could reach another port through either. Below the page,
 * the browser's own network stack sends all of those here. A refusal never reaches the app: the
 * browser sees a 403 or a failed connection, and the probe hears what was refused.
 *
 * Only the probe's own context may use it: each fence has a random user and password, given to the
 * browser context and checked (in constant time) on every request and tunnel; anything else gets
 * 407. What is forwarded is rebuilt: Host from the checked target, no hop-by-hop headers, none the
 * client's Connection header names. Upstream requests are bounded (time, how many at once) and end
 * when their client goes away or the fence closes.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { describeUrl, requestVerdict } from "./guards.ts";

export interface FenceRefusal {
  /** busy: more requests at once than the fence carries. */
  readonly kind: "write" | "origin" | "socket" | "busy";
  /** Plain words: what was tried, its path only, and that nothing was sent. */
  readonly words: string;
}

export interface Fence {
  /** The proxy's address, for the browser context's `proxy.server`. */
  readonly server: string;
  /** This fence's own credentials, for the context's `proxy.username` and `proxy.password`. */
  readonly username: string;
  readonly password: string;
  close(): Promise<void>;
}

export interface FenceOptions {
  /** An upstream request is ended after this long, however busy it is (an endless stream too). */
  readonly requestTimeoutMs?: number;
  /** Upstream requests at once; past this a request is refused (503). */
  readonly maxUpstreams?: number;
}

export const FENCE_REQUEST_TIMEOUT_MS = 15_000;
export const FENCE_MAX_UPSTREAMS = 16;

/** Hop-by-hop headers (and the proxy's own and the message framing), never passed on. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "trailers", "upgrade", "transfer-encoding", "content-length", "host"]);

/** Headers to pass on: none that are hop-by-hop, framing, or named by the message's own Connection header. */
function passOn(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(String(headers.connection ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name.toLowerCase()) && !named.has(name.toLowerCase())));
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

/** Start a fence that lets bodiless reads reach `origin` (an http origin on this machine) and nothing else. */
export async function startFence(origin: string, refused: (refusal: FenceRefusal) => void, options: FenceOptions = {}): Promise<Fence> {
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.origin !== origin) throw new Error(`the fence takes an http origin, not ${origin}`);
  const timeoutMs = options.requestTimeoutMs ?? FENCE_REQUEST_TIMEOUT_MS;
  const maxUpstreams = options.maxUpstreams ?? FENCE_MAX_UPSTREAMS;
  const username = "youiyoux-probe";
  const password = randomBytes(24).toString("hex");
  const expected = digest(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const sockets = new Set<Socket | Duplex>();
  const upstreams = new Set<ClientRequest>();
  let closing = false;
  // The listener that hears a refusal can't take the fence down either.
  const tell = (refusal: FenceRefusal): void => {
    try {
      refused(refusal);
    } catch {
      // Ignored: the request is refused all the same.
    }
  };
  const authorised = (req: IncomingMessage): boolean => {
    const given = req.headers["proxy-authorization"];
    return typeof given === "string" && timingSafeEqual(digest(given), expected);
  };
  const CHALLENGE = 'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="youiyoux probe"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n';
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
  const answer = (req: IncomingMessage, res: ServerResponse, status: number, body = ""): void => {
    req.resume();
    res.writeHead(status, { "content-type": "text/plain", connection: "close", ...(status === 407 ? { "proxy-authenticate": 'Basic realm="youiyoux probe"' } : {}) }).end(body);
  };
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // Only this fence's own context: anything without its credentials is challenged, nothing else said.
    if (!authorised(req)) return answer(req, res, 407);
    // A proxy request names its whole address; anything else (no address, one that doesn't parse) isn't the browser's.
    const parsed = addressOf(req.url);
    if (!parsed) {
      tell({ kind: "origin", words: "a request that named no http address was refused" });
      return answer(req, res, 400);
    }
    if (req.headers.upgrade) return refuseSocket(req.socket, parsed.host);
    const verdict = requestVerdict(parsed.href, req.method ?? "GET", origin);
    if (!verdict.allow) {
      tell({ kind: verdict.kind, words: verdict.words });
      return answer(req, res, 403, "blocked by the youiyoux probe");
    }
    // Reads only: a body (any length, or chunked) never leaves, whatever the method says.
    const length = req.headers["content-length"];
    if (req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0")) {
      tell({ kind: "write", words: `the page tried to send data with a ${String(req.method).toUpperCase()} to ${describeUrl(parsed.href, origin)}; nothing was sent` });
      return answer(req, res, 400, "blocked by the youiyoux probe");
    }
    if (closing || upstreams.size >= maxUpstreams) {
      tell({ kind: "busy", words: `the page kept more than ${maxUpstreams} requests open at once; ${describeUrl(parsed.href, origin)} was refused` });
      return answer(req, res, 503);
    }
    const upstream = httpRequest(
      { host: parsed.hostname.replace(/^\[|\]$/g, ""), port: parsed.port || 80, path: `${parsed.pathname}${parsed.search}`, method: req.method, headers: { ...passOn(req.headers), host: parsed.host, connection: "close" }, agent: false },
      (reply) => {
        reply.on("error", () => res.destroy());
        res.writeHead(reply.statusCode ?? 502, passOn(reply.headers));
        reply.pipe(res);
      },
    );
    upstreams.add(upstream);
    // However busy it is, it ends: an endless stream included.
    const timer = setTimeout(() => {
      upstream.destroy();
      res.destroy();
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      upstreams.delete(upstream);
    };
    upstream.on("close", done);
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    // The client going away ends the upstream request with it.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
      done();
    });
    req.on("error", () => upstream.destroy());
    res.on("error", () => upstream.destroy());
    req.resume();
    upstream.end();
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
      if (!authorised(req)) {
        socket.end(CHALLENGE);
        socket.destroy();
        return;
      }
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
    username,
    password,
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        for (const upstream of upstreams) upstream.destroy();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
