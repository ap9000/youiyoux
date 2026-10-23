/**
 * `youiyoux hub serve`: the team's hosted hub, read-only. CI sends each repository's record
 * (youi.record/v1, `youiyoux record --send`); people read every repository's latest, and every
 * System's adoption by version (youi.org/v1). Nothing here changes a repository: approval stays
 * in the design repo's pull requests.
 *
 *   POST /api/records   a record, with the ingest token (Authorization: Bearer)
 *   POST /api/session   { key }: the view key, for a browser: an HttpOnly, SameSite=Strict cookie
 *   DELETE /api/session sign out
 *   GET  /api/org       the organisation view, with that cookie (or the view key as a Bearer)
 *   GET  /api/health    "ok", for the platform's health check; no data
 *   GET  /              the hub's page, in its read-only organisation mode
 *
 * Two secrets, set in the environment: YOUIYOUX_HUB_TOKEN for CI and YOUIYOUX_HUB_VIEW_KEY for
 * people, each 24 characters or more and different. It refuses to start without them. A record
 * holding a path outside its repository or a URL with credentials is refused: `youiyoux record`
 * redacts both, so one that still has them was not made by it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { CiRecord, type OrgView, type ProjectStatus, type ProjectStatusFailure } from "@youiyoux/core";
import type { Store } from "@youiyoux/store";
import { compareVersions } from "./upgrade.ts";

export const VIEW_KEY_ENV = "YOUIYOUX_HUB_VIEW_KEY";
/** The page reads this meta tag: it shows the organisation, from this API, and nothing else. */
export const ORG_META = "youi-org";
const COOKIE = "youi_hub_session";
const MAX_RECORD = 2 * 1024 * 1024;
const MIN_SECRET = 24;
const SESSION_DAYS = 30;

export interface OrgHubOptions {
  readonly store: Store;
  /** For CI: records are accepted only with it. */
  readonly ingestToken: string;
  /** For people: the organisation is shown only with it. */
  readonly viewKey: string;
  /** The built hub (index.html, assets/), or null to serve the API only. */
  readonly dist: string | null;
  readonly host?: string;
  readonly port?: number;
  /** Mark the session cookie Secure (default: true, unless the host is this machine). */
  readonly secureCookies?: boolean;
  readonly now?: () => Date;
}

export interface OrgHub {
  readonly url: string;
  close(): Promise<void>;
}

/** Why the two secrets cannot be used, or null. */
export function secretsProblem(ingest: string | undefined, view: string | undefined): string | null {
  const missing = [!ingest && "YOUIYOUX_HUB_TOKEN", !view && VIEW_KEY_ENV].filter(Boolean);
  if (missing.length > 0) return `set ${missing.join(" and ")} in the environment: a random string of ${MIN_SECRET} characters or more each (openssl rand -base64 32), the token for CI and the view key for people`;
  if (ingest!.length < MIN_SECRET || view!.length < MIN_SECRET) return `YOUIYOUX_HUB_TOKEN and ${VIEW_KEY_ENV} must be ${MIN_SECRET} characters or more (openssl rand -base64 32)`;
  if (ingest === view) return `YOUIYOUX_HUB_TOKEN and ${VIEW_KEY_ENV} must differ: whoever can read the hub must not be able to write to it`;
  return null;
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
/** Equal, in time that does not depend on where they differ. */
const same = (given: string, expected: string): boolean => timingSafeEqual(digest(given), digest(expected));
const bearer = (req: IncomingMessage): string | null => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
const cookie = (req: IncomingMessage, name: string): string | null => {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": csp([]),
};

/** Scripts from this origin only, plus the page's own inline scripts by their hash (its theme is set before first paint). */
function csp(inline: readonly string[]): string {
  const hashes = inline.map((script) => ` 'sha256-${createHash("sha256").update(script).digest("base64")}'`).join("");
  return `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'${hashes}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`a record is at most ${limit / 1024 / 1024} MB`), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Strings `youiyoux record` would have redacted: a path outside the repository, a home directory, a URL with credentials. */
export function unredacted(record: CiRecord): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (/(?:^|[\s"'`(=,:;])(?:~\/|\/(?:Users|home|root)\/)|[A-Za-z]:\\Users\\/.test(node)) found.add("a path outside the repository");
      if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'<>]+(?::[^\s/@"'<>]*)?@/i.test(node) && !node.includes("[redacted]@")) found.add("a URL with credentials");
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(record.products);
  return [...found];
}

const failed = (p: ProjectStatus | ProjectStatusFailure): p is ProjectStatusFailure => "error" in p;

/** Each repository's latest record, and every System's adoption by the version its products have synced. */
export function orgView(latest: ReadonlyArray<{ record: CiRecord; receivedAt: string }>, now: Date): OrgView {
  const systems = new Map<string, { name: string; latest: string; versions: Map<string | null, Array<{ repo: string; id: string }>> }>();
  let products = 0;
  let unreadable = 0;
  for (const { record } of latest) {
    for (const product of record.products) {
      products++;
      if (failed(product)) {
        unreadable++;
        continue;
      }
      const system = systems.get(product.system.id) ?? { name: product.system.name, latest: product.system.version, versions: new Map() };
      if (compareVersions(product.system.version, system.latest) > 0) system.latest = product.system.version;
      const version = product.lock?.systemVersion ?? null;
      system.versions.set(version, [...(system.versions.get(version) ?? []), { repo: record.repo, id: product.id }]);
      systems.set(product.system.id, system);
    }
  }
  const statuses = latest.flatMap(({ record }) => record.products.filter((p): p is ProjectStatus => !failed(p)));
  const behind = statuses.filter((p) => p.lock === null || p.lock.systemVersion !== systems.get(p.system.id)!.latest).length;
  return {
    schema: "youi.org/v1",
    generatedAt: now.toISOString(),
    repos: latest.map(({ record, receivedAt }) => ({ repo: record.repo, commit: record.commit, ref: record.ref, generatedAt: record.generatedAt, receivedAt, products: record.products })),
    systems: [...systems].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => ({
      id,
      name: s.name,
      latest: s.latest,
      versions: [...s.versions].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : compareVersions(b, a))).map(([version, list]) => ({ version, products: list })),
    })),
    totals: { repos: latest.length, products, unreadable, behind, failing: statuses.filter((p) => p.check.errors > 0 || p.check.incomplete).length },
  };
}

const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };

export async function startOrgHub(options: OrgHubOptions): Promise<OrgHub> {
  const problem = secretsProblem(options.ingestToken, options.viewKey);
  if (problem) throw new Error(problem);
  const host = options.host ?? "127.0.0.1";
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  const secure = options.secureCookies ?? !local;
  const now = options.now ?? (() => new Date());
  // A session is the view key's HMAC: changing the key signs everyone out.
  const session = createHmac("sha256", options.viewKey).update("youiyoux hub viewer").digest("base64url");
  const page = options.dist
    ? (await readFile(join(options.dist, "index.html"), "utf8")).replace("</head>", `    <meta name="${ORG_META}" content="/api/org" />\n  </head>`)
    : null;
  const pagePolicy = csp(page ? [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!) : []);
  const viewer = (req: IncomingMessage): boolean => {
    const given = cookie(req, COOKIE) ?? null;
    const key = bearer(req);
    return (given !== null && same(given, session)) || (key !== null && same(key, options.viewKey));
  };
  const cookieHeader = (value: string, maxAge: number): string => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  const serveFile = async (res: ServerResponse, path: string): Promise<void> => {
    const root = join(options.dist!, "assets");
    const file = normalize(join(options.dist!, path));
    if (!(file.startsWith(`${root}${sep}`) || file === join(options.dist!, "favicon.svg"))) return send(res, 404, { error: "not found" });
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, { error: "not found" });
    res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0]!;
      const method = req.method ?? "GET";
      try {
        if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true });
        if (path === "/api/records" && method === "POST") {
          const token = bearer(req);
          if (token === null || !same(token, options.ingestToken)) return send(res, 401, { error: "this hub takes records only with its ingest token (YOUIYOUX_HUB_TOKEN)" });
          if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "a record is JSON (content-type: application/json)" });
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readBody(req, MAX_RECORD));
          } catch (error: unknown) {
            const status = (error as { status?: number }).status;
            return send(res, status ?? 400, { error: status ? (error as Error).message : "a record is JSON" });
          }
          const record = CiRecord.safeParse(parsed);
          if (!record.success) return send(res, 422, { error: `not a youi.record/v1: ${record.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ")}` });
          const leaks = unredacted(record.data);
          if (leaks.length > 0) return send(res, 422, { error: `the record holds ${leaks.join(" and ")}, so it was not kept: youiyoux record redacts these` });
          await options.store.putRecord(record.data, now().toISOString());
          return send(res, 201, { kept: record.data.repo, products: record.data.products.length });
        }
        if (path === "/api/session" && method === "POST") {
          let key: unknown;
          try {
            key = (JSON.parse(await readBody(req, 4096)) as { key?: unknown }).key;
          } catch {
            return send(res, 400, { error: "send { \"key\": \"…\" }" });
          }
          if (typeof key !== "string" || !same(key, options.viewKey)) return send(res, 401, { error: "that is not this hub's view key" });
          return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(session, SESSION_DAYS * 86_400) });
        }
        if (path === "/api/session" && method === "DELETE") return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
        if (path === "/api/org" && method === "GET") {
          if (!viewer(req)) return send(res, 401, { error: "sign in with the hub's view key" });
          return send(res, 200, orgView(await options.store.latestRecords(), now()));
        }
        if (path.startsWith("/api/")) return send(res, 404, { error: "this hub is read-only: it shows the organisation, and takes records from CI" });
        if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "read-only" });
        if (!page) return send(res, 404, { error: "the hub's page is not built here; the API answers at /api/org" });
        if (path.startsWith("/assets/") || path === "/favicon.svg") return await serveFile(res, path);
        res.writeHead(200, { ...HEADERS, "Content-Security-Policy": pagePolicy, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(page);
      } catch (error: unknown) {
        // A store failure is said as one, never a page of zeros; its detail goes to the log, not to the browser.
        process.stderr.write(`youiyoux hub: ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}\n`);
        send(res, 500, { error: "the hub could not read its store; its log says why" });
      }
    })();
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, host, done);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
