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
 * With workspaces (`workspaces`: the hub's GitHub OAuth App), one hub holds several organisations,
 * kept apart, and people sign in with GitHub instead of a view key:
 *
 *   GET  /auth/github           to GitHub's consent page, with a state kept in a short cookie
 *   GET  /auth/github/callback  back from GitHub: the person, their memberships, a session
 *   GET  /api/me                who is signed in, and the workspaces they are a member of
 *   GET  /api/w/<id>/org        a workspace's view, for its members only (anyone else: 404)
 *   DELETE /api/session         sign out: the session is removed
 *
 * A record goes to the workspace that names its GitHub owner (by numeric id, from GitHub Actions'
 * OIDC token), or whose CI token it comes with (`youiyoux hub token add`); anything else is
 * refused. A member is invited (`youiyoux hub member add`) or let in as an active member of the
 * workspace's GitHub organisation, checked at each sign-in. Sessions are random, kept by their
 * SHA-256 only, in an HttpOnly, SameSite=Strict cookie; GitHub's token is revoked once read.
 *
 * Who may send a record: with YOUIYOUX_HUB_GITHUB_OWNERS set, only GitHub Actions in those
 * owners' repositories, each proving with GitHub's OIDC token that the record's repository, commit
 * and branch are its own (github-oidc.ts); no shared secret. Otherwise whoever holds
 * YOUIYOUX_HUB_TOKEN, which can name any repository: for CI other than GitHub's. People sign in
 * with YOUIYOUX_HUB_VIEW_KEY. Each secret is 24 characters or more, and the two differ; the hub
 * refuses to start without what its mode needs. A record holding a path outside its repository or
 * a URL with credentials is refused (`youiyoux record` redacts both), and so is one dated more
 * than five minutes after it arrives, which would otherwise stay its repository's latest.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { CiRecord, type OrgView, type ProjectStatus, type ProjectStatusFailure } from "@youiyoux/core";
import { DEFAULT_WORKSPACE, type Store } from "@youiyoux/store";
import type { GithubSignIn } from "./github-signin.ts";
import { audienceOf, recordMismatch, type GithubVerifier } from "./github-oidc.ts";
import { compareVersions } from "./upgrade.ts";

export const VIEW_KEY_ENV = "YOUIYOUX_HUB_VIEW_KEY";
export const GITHUB_OWNERS_ENV = "YOUIYOUX_HUB_GITHUB_OWNERS";
export const AUDIENCE_ENV = "YOUIYOUX_HUB_AUDIENCE";
/** The header a record's GitHub Actions OIDC token comes in. */
export const GITHUB_TOKEN_HEADER = "x-youi-github-oidc";
/** How far ahead of the hub's clock a record's generatedAt may be. */
const FUTURE_MS = 5 * 60 * 1000;
/** The page reads this meta tag: it shows the organisation, from this API, and nothing else. */
export const ORG_META = "youi-org";
/** With workspaces, the page is told so: it signs people in with GitHub. */
export const ORG_MODE_META = "youi-org-mode";
const COOKIE = "youi_hub_session";
const STATE_COOKIE = "youi_hub_github_state";
const WORKSPACE_SESSION_DAYS = 14;
const MAX_RECORD = 2 * 1024 * 1024;
const MIN_SECRET = 24;
const SESSION_DAYS = 30;

export interface OrgHubOptions {
  readonly store: Store;
  /** For CI other than GitHub's: records are accepted with it (unused when `github` is set). */
  readonly ingestToken?: string;
  /** GitHub Actions' OIDC tokens: when set, a record is accepted only with one, for its own repository, commit and branch. */
  readonly github?: GithubVerifier;
  /** For people: the organisation is shown only with it. Not used with workspaces. */
  readonly viewKey?: string;
  /** Workspaces, with people signed in by the hub's GitHub OAuth App at its public address (`url`), instead of the view key. */
  readonly workspaces?: { readonly signIn: GithubSignIn; readonly url: string };
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

/** Why the secrets cannot be used, or null. With GitHub's OIDC (`github`), CI needs no ingest token. */
export function secretsProblem(ingest: string | undefined, view: string | undefined, github = false): string | null {
  const missing = [!github && !ingest && "YOUIYOUX_HUB_TOKEN", !view && VIEW_KEY_ENV].filter(Boolean);
  if (missing.length > 0) return `set ${missing.join(" and ")} in the environment: a random string of ${MIN_SECRET} characters or more${missing.length > 1 ? " each" : ""} (openssl rand -base64 32)${github ? "" : `, the token for CI and the view key for people; or ${GITHUB_OWNERS_ENV} and ${AUDIENCE_ENV}, so GitHub Actions proves each record's repository and no CI token is shared`}`;
  if ((ingest !== undefined && ingest.length < MIN_SECRET) || view!.length < MIN_SECRET) return `${ingest !== undefined ? "YOUIYOUX_HUB_TOKEN and " : ""}${VIEW_KEY_ENV} must be ${MIN_SECRET} characters or more (openssl rand -base64 32)`;
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
  const ws = options.workspaces ?? null;
  if (!ws) {
    const problem = secretsProblem(options.github ? undefined : options.ingestToken, options.viewKey, Boolean(options.github));
    if (problem) throw new Error(problem);
  }
  const host = options.host ?? "127.0.0.1";
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  const secure = options.secureCookies ?? !local;
  const now = options.now ?? (() => new Date());
  // A session is the view key's HMAC: changing the key signs everyone out.
  const session = ws ? "" : createHmac("sha256", options.viewKey!).update("youiyoux hub viewer").digest("base64url");
  const meta = ws ? `    <meta name="${ORG_META}" content="/api/me" />\n    <meta name="${ORG_MODE_META}" content="workspaces" />\n` : `    <meta name="${ORG_META}" content="/api/org" />\n`;
  const page = options.dist ? (await readFile(join(options.dist, "index.html"), "utf8")).replace("</head>", `${meta}  </head>`) : null;
  const callback = ws ? `${audienceOf(ws.url)}/auth/github/callback` : "";
  const pagePolicy = csp(page ? [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!) : []);
  const viewer = (req: IncomingMessage): boolean => {
    const given = cookie(req, COOKIE) ?? null;
    const key = bearer(req);
    return (given !== null && same(given, session)) || (key !== null && same(key, options.viewKey!));
  };
  const cookieHeader = (value: string, maxAge: number): string => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  // GitHub sends the person back by a cross-site navigation, which carries Lax cookies, never Strict ones.
  const stateCookie = (value: string, maxAge: number): string => `${STATE_COOKIE}=${value}; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
  const sessionHash = (req: IncomingMessage): string | null => {
    const value = cookie(req, COOKIE);
    return value ? sha256(value) : null;
  };
  /** Who a workspace hub's request is from, or null. */
  const person = async (req: IncomingMessage) => {
    const hash = sessionHash(req);
    return hash ? options.store.sessionUser(hash, now().toISOString()) : null;
  };
  const redirect = (res: ServerResponse, location: string, cookies: string[]): void => {
    res.writeHead(302, { ...HEADERS, Location: location, "Cache-Control": "no-store", "Set-Cookie": cookies });
    res.end();
  };

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
          // Who is sending: with GitHub's OIDC, the token's repository (checked against the record below); else the shared ingest token.
          const oidc = req.headers[GITHUB_TOKEN_HEADER];
          let sender: Awaited<ReturnType<GithubVerifier>> | null = null;
          let workspace = DEFAULT_WORKSPACE;
          if (ws) {
            if (typeof oidc === "string" && options.github) {
              try {
                sender = await options.github(oidc);
              } catch (error: unknown) {
                return send(res, 401, { error: `the GitHub Actions token was refused: ${error instanceof Error ? error.message : String(error)}` });
              }
              const routed = await options.store.workspaceForOwner(sender.repository_owner_id!);
              if (!routed) return send(res, 403, { error: `records from ${sender.repository_owner} (id ${sender.repository_owner_id}) go to no workspace on this hub: its admin runs youiyoux hub owner add <workspace> ${sender.repository_owner}` });
              workspace = routed;
            } else {
              const token = bearer(req);
              const routed = token === null ? null : await options.store.workspaceForToken(sha256(token));
              if (!routed) return send(res, 401, { error: "this hub takes records with GitHub Actions' OIDC token (permissions: id-token: write), or a workspace's CI token (youiyoux hub token add <workspace> <name>)" });
              workspace = routed;
            }
          } else if (options.github) {
            if (typeof oidc !== "string") return send(res, 401, { error: "this hub takes records from GitHub Actions with its OIDC token: give the workflow permissions: id-token: write (youiyoux hooks install --record does)" });
            try {
              sender = await options.github(oidc);
            } catch (error: unknown) {
              return send(res, 401, { error: `the GitHub Actions token was refused: ${error instanceof Error ? error.message : String(error)}` });
            }
          } else {
            const token = bearer(req);
            if (token === null || !same(token, options.ingestToken!)) return send(res, 401, { error: "this hub takes records only with its ingest token (YOUIYOUX_HUB_TOKEN)" });
          }
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
          if (sender) {
            const mismatch = recordMismatch(sender, record.data);
            if (mismatch) return send(res, 403, { error: `${mismatch}: a repository's CI sends only its own record` });
          }
          const received = now();
          if (Date.parse(record.data.generatedAt) > received.getTime() + FUTURE_MS) return send(res, 422, { error: `the record is dated ${record.data.generatedAt}, after the hub's clock (${received.toISOString()}) by more than five minutes: it would stay its repository's latest, so it was not kept` });
          const leaks = unredacted(record.data);
          if (leaks.length > 0) return send(res, 422, { error: `the record holds ${leaks.join(" and ")}, so it was not kept: youiyoux record redacts these` });
          await options.store.putRecord(record.data, received.toISOString(), workspace);
          return send(res, 201, { kept: record.data.repo, products: record.data.products.length, ...(ws ? { workspace } : {}) });
        }
        if (ws) {
          if (path === "/auth/github" && method === "GET") {
            const state = randomBytes(24).toString("base64url");
            return redirect(res, ws.signIn.authorizeUrl(state, callback), [stateCookie(state, 600)]);
          }
          if (path === "/auth/github/callback" && method === "GET") {
            const params = new URL(req.url ?? "/", "http://hub").searchParams;
            const back = (outcome: string | null, cookies: string[] = []): void => redirect(res, outcome ? `/?signin=${outcome}` : "/", [stateCookie("", 0), ...cookies]);
            if (params.has("error")) return back("denied");
            const expected = cookie(req, STATE_COOKIE);
            const given = params.get("state");
            const code = params.get("code");
            // The state this browser was given, so a sign-in someone else started never lands here.
            if (!expected || !given || !code || !same(given, expected)) return back("expired");
            let signedIn: Awaited<ReturnType<GithubSignIn["signIn"]>>;
            try {
              signedIn = await ws.signIn.signIn(code, callback);
            } catch (error: unknown) {
              process.stderr.write(`youiyoux hub: signing in with GitHub failed: ${error instanceof Error ? error.message : String(error)}\n`);
              return back("failed");
            }
            const at = now();
            const { user } = signedIn;
            await options.store.putUser(user, at.toISOString());
            const orgs = new Set(signedIn.orgs.map((o) => o.id));
            for (const w of await options.store.workspaces()) {
              if (!w.githubOrg) continue;
              if (orgs.has(w.githubOrg.id)) await options.store.addMember(w.id, { id: user.githubId, login: user.login }, "member", "org", at.toISOString());
              else await options.store.removeMember(w.id, user.githubId, "org");
            }
            const secret = randomBytes(32).toString("base64url");
            await options.store.addSession(sha256(secret), user.githubId, at.toISOString(), new Date(at.getTime() + WORKSPACE_SESSION_DAYS * 86_400_000).toISOString());
            return back(null, [cookieHeader(secret, WORKSPACE_SESSION_DAYS * 86_400)]);
          }
          if (path === "/api/me" && method === "GET") {
            const user = await person(req);
            if (!user) return send(res, 401, { error: "sign in with GitHub" });
            const memberships = await options.store.memberships(user.githubId);
            return send(res, 200, { user: { login: user.login, name: user.name }, workspaces: memberships.map((m) => ({ id: m.workspace, name: m.name, role: m.role })) });
          }
          const scoped = /^\/api\/w\/([a-z0-9-]{1,40})\/org$/.exec(path);
          if (scoped && method === "GET") {
            const user = await person(req);
            if (!user) return send(res, 401, { error: "sign in with GitHub" });
            // Not a member and no such workspace answer the same: a workspace's name is not given away.
            if (!(await options.store.memberships(user.githubId)).some((m) => m.workspace === scoped[1])) return send(res, 404, { error: `you are not a member of a workspace ${scoped[1]} on this hub` });
            return send(res, 200, orgView(await options.store.latestRecords(scoped[1]), now()));
          }
          if (path === "/api/session" && method === "DELETE") {
            const hash = sessionHash(req);
            if (hash) await options.store.removeSession(hash);
            return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
          }
          if (path === "/api/session" || path === "/api/org") return send(res, 404, { error: "this hub has workspaces, and people sign in with GitHub (/auth/github); a workspace's view is /api/w/<workspace>/org" });
        }
        if (path === "/api/session" && method === "POST") {
          let key: unknown;
          try {
            key = (JSON.parse(await readBody(req, 4096)) as { key?: unknown }).key;
          } catch {
            return send(res, 400, { error: "send { \"key\": \"…\" }" });
          }
          if (typeof key !== "string" || !same(key, options.viewKey!)) return send(res, 401, { error: "that is not this hub's view key" });
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
