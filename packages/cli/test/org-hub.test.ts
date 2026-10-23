/**
 * The team's hosted hub (`youiyoux hub serve`): CI sends records with the ingest token, people read
 * the organisation with the view key, and nothing else is answered. `youiyoux record` makes the
 * record from a repository, redacted, and sends it. Everything here is local: a temp SQLite store
 * and a server on 127.0.0.1.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CiRecord, OrgView, type ProjectStatus } from "@youiyoux/core";
import { openStore, type Store } from "@youiyoux/store";
import { installRecordWorkflow, recordWorkflowText } from "../src/hooks-install.ts";
import { main } from "../src/index.ts";
import { orgView, secretsProblem, startOrgHub, unredacted, type OrgHub } from "../src/org-hub.ts";
import { buildRecord, recordsUrl, toolVersion } from "../src/record.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });

const INGEST = "ingest-token-for-tests-0123456789";
const VIEW = "view-key-for-tests-0123456789abcdef";

const status = (id: string, version: string, synced: string | null, extra: Partial<ProjectStatus> = {}): ProjectStatus => ({
  id,
  root: id === "web" ? "." : `apps/${id}`,
  system: { id: "acme", name: "Acme", version, source: "package @acme/design", linked: false, commit: null },
  lock: synced ? { systemVersion: synced, syncedAt: "2026-10-22T12:00:00.000Z" } : null,
  sync: { state: synced ? "current" : "never", changes: [] },
  drift: [],
  check: { errors: 0, warnings: 1, baseline: null, incomplete: false },
  components: { system: 12, used: 9, sites: 204 },
  requests: { open: 0, addressed: 0, unreadable: 0 },
  next: "nothing to do",
  ...extra,
});
const record = (repo: string, products: CiRecord["products"], minute = 0): CiRecord => ({ schema: "youi.record/v1", repo, commit: "a".repeat(40), ref: "main", generatedAt: new Date(Date.UTC(2026, 9, 23, 12, minute)).toISOString(), tool: "0.1.10", products });

let dir: string;
let store: Store;
let hub: OrgHub | null = null;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-org-hub-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  env = { ...process.env };
  store = await openStore({ path: join(dir, `hub-${Math.random().toString(36).slice(2)}.db`), env: {} });
});
afterEach(async () => {
  await hub?.close();
  hub = null;
  await store.close();
  process.env = env;
  vi.restoreAllMocks();
});

/** A built hub: index.html with an inline script, and one asset. */
async function dist(): Promise<string> {
  const root = join(dir, `dist-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), `<!doctype html><html><head><script>document.documentElement.dataset.theme = "light";</script><script type="module" src="/assets/main.js"></script></head><body><div id="root"></div></body></html>`);
  await writeFile(join(root, "assets/main.js"), "export {};");
  await writeFile(join(dir, "secret.txt"), "not served");
  return root;
}

/** A GET with its path exactly as given. */
const raw = (base: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((done, fail) => {
    const { hostname, port } = new URL(base);
    request({ hostname, port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    }).on("error", fail).end();
  });

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(`${hub!.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("the hosted hub's two secrets", () => {
  test("both are required, 24 characters or more, and different", () => {
    expect(secretsProblem(undefined, VIEW)).toMatch(/^set YOUIYOUX_HUB_TOKEN in the environment/);
    expect(secretsProblem(INGEST, undefined)).toMatch(/^set YOUIYOUX_HUB_VIEW_KEY/);
    expect(secretsProblem("short", VIEW)).toMatch(/24 characters or more/);
    expect(secretsProblem(VIEW, VIEW)).toMatch(/must differ/);
    expect(secretsProblem(INGEST, VIEW)).toBeNull();
  });

  test("youiyoux hub serve refuses to start without them, and says how to make them", async () => {
    delete process.env.YOUIYOUX_HUB_TOKEN;
    delete process.env.YOUIYOUX_HUB_VIEW_KEY;
    let err = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
    expect(await main(["hub", "serve"])).toBe(2);
    expect(err).toContain("openssl rand -base64 32");
  });
});

describe("the hosted hub", () => {
  test("records come in only with the ingest token, as valid, redacted youi.record/v1; the organisation goes out only with the view key", async () => {
    hub = await startOrgHub({ store, ingestToken: INGEST, viewKey: VIEW, dist: null, now: () => new Date("2026-10-23T13:00:00.000Z") });
    const good = record("acme/billing", [status("web", "2.0.0", "1.4.0"), status("admin", "2.0.0", "2.0.0", { check: { errors: 2, warnings: 0, baseline: null, incomplete: false } })]);

    expect((await post("/api/records", good)).status).toBe(401);
    expect((await post("/api/records", good, { authorization: `Bearer ${VIEW}` })).status).toBe(401);
    const auth = { authorization: `Bearer ${INGEST}` };
    expect((await post("/api/records", good, { ...auth, "content-type": "text/plain" })).status).toBe(415);
    const invalid = await post("/api/records", { ...good, schema: "youi.status/v1" }, auth);
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: string }).error).toMatch(/^not a youi.record\/v1: schema/);
    // A record youiyoux record did not redact is refused, whoever holds the token.
    const leaky = await post("/api/records", record("acme/leaky", [status("web", "2.0.0", "2.0.0", { system: { ...status("web", "2.0.0", null).system, source: "path /Users/ada/acme/design" } })]), auth);
    expect(leaky.status).toBe(422);
    expect(((await leaky.json()) as { error: string }).error).toBe("the record holds a path outside the repository, so it was not kept: youiyoux record redacts these");
    const huge = await post("/api/records", JSON.stringify({ ...good, pad: "x".repeat(2 * 1024 * 1024 + 1) }), auth);
    expect(huge.status).toBe(413);
    const kept = await post("/api/records", good, auth);
    expect(kept.status).toBe(201);
    expect(await kept.json()).toEqual({ kept: "acme/billing", products: 2 });
    await post("/api/records", record("acme/site", [status("site", "1.9.0", null), { root: "packages/old", error: "no youi.project.json", next: "youiyoux adopt" }], 5), auth);

    // Reading: the ingest token cannot, the view key can, as a Bearer or a session cookie.
    expect((await fetch(`${hub.url}/api/org`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/org`, { headers: { authorization: `Bearer ${INGEST}` } })).status).toBe(401);
    expect((await post("/api/session", { key: "not-the-key" })).status).toBe(401);
    const signedIn = await post("/api/session", { key: VIEW });
    const cookie = signedIn.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^youi_hub_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    expect(cookie).not.toContain(VIEW);
    const answer = await fetch(`${hub.url}/api/org`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const view = OrgView.parse(await answer.json());
    expect(view.repos.map((r) => [r.repo, r.receivedAt])).toEqual([["acme/billing", "2026-10-23T13:00:00.000Z"], ["acme/site", "2026-10-23T13:00:00.000Z"]]);
    expect(view.systems).toEqual([{ id: "acme", name: "Acme", latest: "2.0.0", versions: [{ version: "2.0.0", products: [{ repo: "acme/billing", id: "admin" }] }, { version: "1.4.0", products: [{ repo: "acme/billing", id: "web" }] }, { version: null, products: [{ repo: "acme/site", id: "site" }] }] }]);
    expect(view.totals).toEqual({ repos: 2, products: 4, unreadable: 1, behind: 2, failing: 1 });
    expect((await fetch(`${hub.url}/api/org`, { headers: { authorization: `Bearer ${VIEW}` } })).status).toBe(200);

    const out = await fetch(`${hub.url}/api/session`, { method: "DELETE" });
    expect(out.headers.get("set-cookie")).toMatch(/^youi_hub_session=; .*Max-Age=0/);
    // Nothing else is answered: the hub is read-only.
    for (const path of ["/api/drafts", "/api/workspace/open"]) expect((await post(path, {}, auth)).status).toBe(404);
    expect((await fetch(`${hub.url}/api/health`)).status).toBe(200);
  });

  test("the page is the built hub in its organisation mode, its inline script allowed by hash and nothing else; only its assets are served", async () => {
    hub = await startOrgHub({ store, ingestToken: INGEST, viewKey: VIEW, dist: await dist() });
    const page = await fetch(`${hub.url}/anything`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta name="youi-org" content="/api/org" />');
    const policy = page.headers.get("content-security-policy")!;
    expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'; /);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect((await fetch(`${hub.url}/assets/main.js`)).status).toBe(200);
    // Sent as written (fetch would tidy the dots away first): a path out of assets/ is not found.
    for (const path of ["/assets/../../secret.txt", "/assets/..%2f..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const answer = await raw(hub.url, path);
      expect(answer.body).not.toContain("not served");
      expect(answer.status, path).toBe(404);
    }
    expect((await fetch(`${hub.url}/`, { method: "POST" })).status).toBe(405);
  });

  test("the session cookie is Secure when the hub listens beyond this machine", async () => {
    hub = await startOrgHub({ store, ingestToken: INGEST, viewKey: VIEW, dist: null, secureCookies: true });
    expect((await post("/api/session", { key: VIEW })).headers.get("set-cookie")).toMatch(/; Secure$/);
  });
});

describe("the organisation view", () => {
  test("versions newest first and never synced last; a product is behind when it has not synced its System's newest version", () => {
    const view = orgView([{ record: record("acme/a", [status("one", "1.10.0", "1.9.0"), status("two", "1.10.0", "1.10.0"), status("three", "1.2.0", "1.2.0")]), receivedAt: "2026-10-23T12:00:00.000Z" }], new Date("2026-10-23T12:00:00.000Z"));
    expect(view.systems[0]!.latest).toBe("1.10.0");
    expect(view.systems[0]!.versions.map((v) => v.version)).toEqual(["1.10.0", "1.9.0", "1.2.0"]);
    expect(view.totals.behind).toBe(2);
  });

  test("a path outside the repository or a URL with credentials is found anywhere in a product", () => {
    expect(unredacted(record("a/b", [status("x", "1.0.0", "1.0.0", { drift: [{ file: "a", severity: "warn", message: "see /home/runner/work/a" }] })]))).toEqual(["a path outside the repository"]);
    expect(unredacted(record("a/b", [status("x", "1.0.0", "1.0.0", { system: { ...status("x", "1.0.0", null).system, source: "git https://bot:s3cret@github.com/acme/design at v1" } })]))).toEqual(["a URL with credentials"]);
    expect(unredacted(record("a/b", [status("x", "1.0.0", "1.0.0", { system: { ...status("x", "1.0.0", null).system, source: "git https://[redacted]@github.com/acme/design at v1" } })]))).toEqual([]);
  });
});

describe("youiyoux record", () => {
  /** The demo app in a git repository of its own, following a design checkout outside it. */
  async function repo(name: string): Promise<string> {
    const root = join(dir, name);
    const design = join(dir, `${name}-design`);
    await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
    await cp(join(EXAMPLES, "demo-design"), design, { recursive: true });
    const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: design } }));
    await git(root, "init", "--quiet", "--initial-branch=main");
    await git(root, "remote", "add", "origin", "git@github.com:acme/demo-app.git");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "start");
    return root;
  }

  test("the repository from the origin remote, its commit and branch, and its products, with every path outside it redacted", async () => {
    const root = await repo("record-app");
    const made = await buildRecord(root, { env: { PATH: process.env.PATH } });
    expect(CiRecord.safeParse(made).success).toBe(true);
    expect(made).toMatchObject({ repo: "acme/demo-app", ref: "main", tool: toolVersion() });
    expect(made.commit).toBe((await git(root, "rev-parse", "HEAD")).stdout.trim());
    expect((made.products[0] as ProjectStatus).id).toBe("demo-app");
    // The design checkout is outside the repository: its path is not in the record, nor is any absolute path.
    const text = JSON.stringify(made);
    expect((made.products[0] as ProjectStatus).system.source).toBe("path [path outside the repo]");
    expect(text).not.toContain(dir);
    expect(unredacted(made)).toEqual([]);
    // CI names the repository and commit in its environment, and they are kept as named, not redacted as env values.
    const ci = await buildRecord(root, { env: { PATH: process.env.PATH, GITHUB_REPOSITORY: "acme/renamed", GITHUB_REF_NAME: "release-2", GITHUB_SHA: "b".repeat(40) } });
    expect(ci).toMatchObject({ repo: "acme/renamed", ref: "release-2", commit: "b".repeat(40) });
    await expect(buildRecord(root, { repo: "not a repo" })).rejects.toThrow('"not a repo" is not --repo owner/name');
  });

  test("--send posts it to the hub with the token from the environment; the hub then shows it", async () => {
    const root = await repo("record-send");
    hub = await startOrgHub({ store, ingestToken: INGEST, viewKey: VIEW, dist: null });
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
    let err = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
    process.env.YOUIYOUX_HUB_URL = hub.url;
    delete process.env.YOUIYOUX_HUB_TOKEN;
    // Outside CI: GitHub Actions would name its own repository, commit and branch here (and does, when this suite runs there).
    for (const name of ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF_NAME"]) delete process.env[name];
    expect(await main(["record", "--send", "--project", root])).toBe(2);
    expect(err).toContain("YOUIYOUX_HUB_TOKEN (from the environment only, never a flag)");
    process.env.YOUIYOUX_HUB_TOKEN = "wrong-token-but-long-enough-000000";
    expect(await main(["record", "--send", "--project", root])).toBe(1);
    expect(err).toMatch(/refused the record \(401\)/);
    process.env.YOUIYOUX_HUB_TOKEN = INGEST;
    expect(await main(["record", "--send", "--project", root])).toBe(0);
    expect(out).toMatch(/sent acme\/demo-app at [0-9a-f]{7} on main: 1 product to http:\/\/127\.0\.0\.1:\d+/);
    expect((await store.latestRecords()).map((r) => r.record.repo)).toEqual(["acme/demo-app"]);
  });

  test("the hub's address: https, or http to this machine only, never with credentials in it", () => {
    expect(recordsUrl("https://hub.acme.dev/design/").href).toBe("https://hub.acme.dev/design/api/records");
    expect(recordsUrl("http://127.0.0.1:8080").href).toBe("http://127.0.0.1:8080/api/records");
    expect(() => recordsUrl("http://hub.acme.dev")).toThrow("the hub must be https");
    expect(() => recordsUrl("https://ci:token@hub.acme.dev")).toThrow("carries a user name or password");
    expect(() => recordsUrl("hub.acme.dev")).toThrow("is not a URL");
  });
});

describe("youiyoux hooks install --record", () => {
  test("a workflow for the default branch, pinned to this version, installing with the repository's lockfile; a file it did not write is kept unless --force", async () => {
    const root = join(dir, "hooks-record");
    await mkdir(root);
    await git(root, "init", "--quiet", "--initial-branch=trunk");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const first = await installRecordWorkflow(root, "0.1.10", false);
    expect(first.action).toBe("created");
    const text = await readFile(join(root, ".github/workflows/youiyoux-record.yml"), "utf8");
    expect(text).toBe(recordWorkflowText({ branch: "trunk", version: "0.1.10", install: "      - run: corepack enable && pnpm install --frozen-lockfile --ignore-scripts\n" }));
    // Only GitHub's own actions run beside the token, and the package is pinned.
    expect([...text.matchAll(/uses: ([\w-]+)\//g)].map((m) => m[1])).toEqual(["actions", "actions"]);
    await expect(installRecordWorkflow(root, null, true)).rejects.toThrow("could not be pinned");
    expect(text).toContain('branches: ["trunk"]');
    expect(text).toContain("run: npx -y youiyoux@0.1.10 record --send");
    // The secrets reach the step only through its environment.
    expect(text).toContain("YOUIYOUX_HUB_TOKEN: ${{ secrets.YOUIYOUX_HUB_TOKEN }}");
    expect((await installRecordWorkflow(root, "0.1.10", false)).action).toBe("unchanged");
    await writeFile(join(root, ".github/workflows/youiyoux-record.yml"), "name: ours\n");
    await expect(installRecordWorkflow(root, "0.1.10", false)).rejects.toThrow("was not written by youiyoux; pass --force");
    expect((await installRecordWorkflow(root, "0.1.10", true)).action).toBe("updated");
  });
});
