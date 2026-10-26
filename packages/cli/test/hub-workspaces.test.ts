/**
 * A hosted hub with workspaces: people sign in with GitHub (the hub's OAuth App, faked here), see
 * only the workspaces they are members of, and CI's records go to the workspace that names their
 * GitHub owner or CI token, never another. The admin commands manage it all on the hub's store.
 * GitHub is a fake: its keys are a test key, its API a function; nothing touches the network.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CiRecord } from "@youiyoux/core";
import { openStore, type Store } from "@youiyoux/store";
import { githubVerifier, GITHUB_ISSUER, type Jwks } from "../src/github-oidc.ts";
import { githubAccount, githubSignIn, type GithubSignIn, type SignedIn } from "../src/github-signin.ts";
import { main } from "../src/index.ts";
import { GITHUB_TOKEN_HEADER, startOrgHub, type OrgHub } from "../src/org-hub.ts";

const AUDIENCE = "https://hub.acme.dev";
const SHA = "d".repeat(40);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS: Jwks = { keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "gh-1", alg: "RS256", use: "sig" }] };
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

let clock = new Date("2026-10-25T12:00:00.000Z");
/** GitHub Actions' token for a repository of `owner` (id `ownerId`). */
function oidc(owner: string, ownerId: string, repo = `${owner}/web`): string {
  const seconds = clock.getTime() / 1000;
  const head = b64({ alg: "RS256", typ: "JWT", kid: "gh-1" });
  const body = b64({ iss: GITHUB_ISSUER, aud: AUDIENCE, exp: seconds + 300, nbf: seconds - 10, repository: repo, repository_owner: owner, repository_owner_id: ownerId, sha: SHA, ref: "refs/heads/main", event_name: "push" });
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}
const record = (repo: string): CiRecord => ({ schema: "youi.record/v1", repo, commit: SHA, ref: "main", generatedAt: clock.toISOString(), tool: "0.1.28", products: [{ root: ".", error: "no youi.project.json", next: "youiyoux adopt" }] });

/** Who each sign-in code stands for, as GitHub would say. */
const people = new Map<string, SignedIn>();
const PETER: SignedIn = { user: { githubId: "11", login: "peter", name: "Peter" }, orgs: [{ id: "1001", login: "acme" }] };
const MILTON: SignedIn = { user: { githubId: "12", login: "milton", name: null }, orgs: [] };
const fakeGithub: GithubSignIn = {
  authorizeUrl: (state, redirect) => `https://github.test/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
  signIn: async (code, redirect) => {
    expect(redirect).toBe(`${AUDIENCE}/auth/github/callback`);
    const person = people.get(code);
    if (!person) throw new Error("bad code");
    return person;
  },
};

let dir: string;
let store: Store;
let hub: OrgHub | null = null;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-hub-workspaces-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  env = { ...process.env };
  clock = new Date("2026-10-25T12:00:00.000Z");
  people.clear();
  people.set("peter-code", PETER);
  people.set("milton-code", MILTON);
  store = await openStore({ path: join(dir, `hub-${Math.random().toString(36).slice(2)}.db`), env: {} });
  const at = clock.toISOString();
  await store.addWorkspace({ id: "acme", name: "Acme", githubOrg: { id: "1001", login: "acme" } }, at);
  await store.addWorkspace({ id: "globex", name: "Globex", githubOrg: null }, at);
  await store.addOwner("acme", { id: "1001", login: "acme" }, at);
  await store.addOwner("globex", { id: "2002", login: "globex" }, at);
  await store.addToken("globex", "jenkins", sha256("globex-ci-token-for-tests"), at);
  hub = await startOrgHub({ store, github: githubVerifier({ owners: "any", audience: AUDIENCE, jwks: async () => JWKS, now: () => clock }), workspaces: { signIn: fakeGithub, url: `${AUDIENCE}/` }, dist: null, now: () => clock });
});
afterEach(async () => {
  await hub?.close();
  hub = null;
  await store.close();
  process.env = env;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cookieOf = (response: Response, name: string): string | null => response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;
let lastSessionCookie = "";
/** Sign in as GitHub's `code`, as a browser does: to GitHub and back with the state. The session cookie, as a Cookie header. */
async function signIn(code: string): Promise<string> {
  const start = await fetch(`${hub!.url}/auth/github`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const back = await fetch(`${hub!.url}/auth/github/callback?code=${code}&state=${state}`, { redirect: "manual", headers: { cookie: cookieOf(start, "youi_hub_github_state")!.split(";")[0]! } });
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("/");
  lastSessionCookie = cookieOf(back, "youi_hub_session")!;
  return lastSessionCookie.split(";")[0]!;
}
const get = (path: string, cookie?: string): Promise<Response> => fetch(`${hub!.url}${path}`, { headers: cookie ? { cookie } : {} });
const sendRecord = (body: CiRecord, headers: Record<string, string>): Promise<Response> => fetch(`${hub!.url}/api/records`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("signing in with GitHub", () => {
  test("to GitHub with a state in a Lax cookie, and back: a session in an HttpOnly, Strict cookie, kept by its hash only", async () => {
    const start = await fetch(`${hub!.url}/auth/github`, { redirect: "manual" });
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toMatch(/^https:\/\/github\.test\/login\/oauth\/authorize\?state=[\w-]{32}&redirect_uri=https%3A%2F%2Fhub\.acme\.dev%2Fauth%2Fgithub%2Fcallback$/);
    // Secure beyond this machine; this hub listens on 127.0.0.1.
    expect(cookieOf(start, "youi_hub_github_state")).toMatch(/; Path=\/auth\/github; HttpOnly; SameSite=Lax; Max-Age=600$/);

    const session = await signIn("peter-code");
    expect(lastSessionCookie).toMatch(/^youi_hub_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1209600$/);
    const secret = session.split("=")[1]!;
    expect(await store.sessionUser(sha256(secret), clock.toISOString())).toMatchObject({ login: "peter" });
    expect(await store.sessionUser(secret, clock.toISOString())).toBeNull();
    const me = await get("/api/me", session);
    expect(await me.json()).toEqual({ user: { login: "peter", name: "Peter" }, workspaces: [{ id: "acme", name: "Acme", role: "member" }] });
  });

  test("a callback without this browser's state, with another's, or after the person declined, signs nobody in", async () => {
    const start = await fetch(`${hub!.url}/auth/github`, { redirect: "manual" });
    const mine = cookieOf(start, "youi_hub_github_state")!.split(";")[0]!;
    const cases: Array<[string, Record<string, string>, string]> = [
      ["/auth/github/callback?code=peter-code&state=guessed", { cookie: mine }, "/?signin=expired"],
      [`/auth/github/callback?code=peter-code&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`, {}, "/?signin=expired"],
      ["/auth/github/callback?error=access_denied", { cookie: mine }, "/?signin=denied"],
      [`/auth/github/callback?code=wrong-code&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`, { cookie: mine }, "/?signin=failed"],
    ];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const [path, headers, location] of cases) {
      const back = await fetch(`${hub!.url}${path}`, { redirect: "manual", headers });
      expect(back.headers.get("location"), path).toBe(location);
      expect(cookieOf(back, "youi_hub_session"), path).toBeNull();
    }
    expect((await get("/api/me")).status).toBe(401);
  });

  test("an organisation's members come in at sign-in and leave when they have left it; an invite stays", async () => {
    await signIn("peter-code");
    expect((await store.members("acme")).map((m) => [m.login, m.via])).toEqual([["peter", "org"]]);
    people.set("peter-code", { ...PETER, orgs: [] });
    const session = await signIn("peter-code");
    expect(await store.members("acme")).toEqual([]);
    expect(await (await get("/api/me", session)).json()).toMatchObject({ workspaces: [] });

    await store.addMember("acme", { id: "12", login: "milton" }, "admin", "invite", clock.toISOString());
    await signIn("milton-code");
    expect((await store.members("acme")).map((m) => [m.login, m.role, m.via])).toEqual([["milton", "admin", "invite"]]);
  });

  test("signing out removes the session; a session ends after 14 days", async () => {
    const session = await signIn("peter-code");
    const out = await fetch(`${hub!.url}/api/session`, { method: "DELETE", headers: { cookie: session } });
    expect(cookieOf(out, "youi_hub_session")).toMatch(/^youi_hub_session=; .*Max-Age=0/);
    expect((await get("/api/me", session)).status).toBe(401);

    const later = await signIn("peter-code");
    clock = new Date(clock.getTime() + 14 * 86_400_000 - 1000);
    expect((await get("/api/me", later)).status).toBe(200);
    clock = new Date(clock.getTime() + 2000);
    expect((await get("/api/me", later)).status).toBe(401);
  });
});

describe("workspaces stay apart", () => {
  test("a member reads their workspace; another workspace, or one that does not exist, answers the same 404; nobody signed in, 401", async () => {
    await store.putRecord(record("acme/web"), clock.toISOString(), "acme");
    await store.putRecord(record("globex/web"), clock.toISOString(), "globex");
    const session = await signIn("peter-code");
    const acme = await get("/api/w/acme/org", session);
    expect(acme.status).toBe(200);
    expect(((await acme.json()) as { repos: Array<{ repo: string }> }).repos.map((r) => r.repo)).toEqual(["acme/web"]);
    const globex = await get("/api/w/globex/org", session);
    const nowhere = await get("/api/w/nowhere/org", session);
    expect([globex.status, nowhere.status]).toEqual([404, 404]);
    expect((await globex.json()).error).toBe("you are not a member of a workspace globex on this hub");
    expect((await get("/api/w/acme/org")).status).toBe(401);
    // The single organisation's endpoints are not there: no view key opens anything.
    expect((await get("/api/org", session)).status).toBe(404);
    expect((await fetch(`${hub!.url}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "anything-at-all-0123456789" }) })).status).toBe(404);
  });

  test("CI's record goes to the workspace that names its GitHub owner, or its CI token; an owner or token no workspace names is refused", async () => {
    const byOwner = await sendRecord(record("acme/web"), { [GITHUB_TOKEN_HEADER]: oidc("acme", "1001") });
    expect(byOwner.status).toBe(201);
    expect(await byOwner.json()).toMatchObject({ workspace: "acme" });
    const byToken = await sendRecord(record("anything/goes"), { authorization: "Bearer globex-ci-token-for-tests" });
    expect(await byToken.json()).toMatchObject({ workspace: "globex" });
    expect((await store.latestRecords("acme")).map((l) => l.record.repo)).toEqual(["acme/web"]);
    expect((await store.latestRecords("globex")).map((l) => l.record.repo)).toEqual(["anything/goes"]);
    expect(await store.latestRecords()).toEqual([]);

    const stranger = await sendRecord(record("initech/web"), { [GITHUB_TOKEN_HEADER]: oidc("initech", "3003") });
    expect(stranger.status).toBe(403);
    expect((await stranger.json()).error).toBe("records from initech (id 3003) go to no workspace on this hub: its admin runs youiyoux hub owner add <workspace> initech");
    expect((await sendRecord(record("x/y"), { authorization: "Bearer not-a-token-of-this-hub" })).status).toBe(401);
    expect((await sendRecord(record("x/y"), {})).status).toBe(401);
    // The token's repository is still the record's: acme's CI cannot send globex's record.
    const other = await sendRecord(record("globex/web"), { [GITHUB_TOKEN_HEADER]: oidc("acme", "1001") });
    expect(other.status).toBe(403);
    expect(await store.latestRecords("globex")).toHaveLength(1);
  });
});

describe("GitHub's OAuth App, as the hub calls it", () => {
  test("asks for read:org; reads the person and their active organisations, page by page; gives the token back every time", async () => {
    const calls: Array<[string, string]> = [];
    const orgPage = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ state: i === 0 && from === 0 ? "pending" : "active", organization: { id: from + i + 1, login: `org-${from + i + 1}` } }));
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push([init?.method ?? "GET", url.replace(/\?.*/, "")]);
      if (url === "https://github.test/login/oauth/access_token") return Response.json(JSON.parse(String(init!.body)).code === "good" ? { access_token: "gho_test" } : { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      if (url === "https://api.github.test/user") return Response.json({ id: 11, login: "peter", name: "" });
      if (url.startsWith("https://api.github.test/user/memberships/orgs")) return Response.json(new URL(url).searchParams.get("page") === "1" ? orgPage(0, 100) : orgPage(100, 2));
      if (url.endsWith("/token")) return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const app = githubSignIn({ clientId: "Iv1.test", clientSecret: "client-secret-for-tests" }, { fetcher, web: "https://github.test", api: "https://api.github.test" });
    const authorize = new URL(app.authorizeUrl("the-state", `${AUDIENCE}/auth/github/callback`));
    expect(Object.fromEntries(authorize.searchParams)).toEqual({ client_id: "Iv1.test", redirect_uri: `${AUDIENCE}/auth/github/callback`, scope: "read:org", state: "the-state", allow_signup: "false" });

    const signedIn = await app.signIn("good", `${AUDIENCE}/auth/github/callback`);
    expect(signedIn.user).toEqual({ githubId: "11", login: "peter", name: null });
    expect(signedIn.orgs).toHaveLength(101);
    expect(signedIn.orgs[0]).toEqual({ id: "2", login: "org-2" });
    expect(calls.at(-1)).toEqual(["DELETE", "https://api.github.test/applications/Iv1.test/token"]);

    calls.length = 0;
    await expect(app.signIn("bad", `${AUDIENCE}/auth/github/callback`)).rejects.toThrow("GitHub did not sign you in: The code passed is incorrect or expired.");
    expect(calls.map((c) => c[0])).toEqual(["POST"]);
  });

  test("an account by login, by id, or as id:login without asking GitHub", async () => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL) => {
      asked.push(String(input));
      if (String(input).endsWith("/users/acme") || String(input).endsWith("/user/1001")) return Response.json({ id: 1001, login: "acme", type: "Organization" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    expect(await githubAccount("@acme", { fetcher })).toEqual({ id: "1001", login: "acme", type: "Organization" });
    expect(await githubAccount("1001", { fetcher })).toEqual({ id: "1001", login: "acme", type: "Organization" });
    expect(await githubAccount("1001:acme", { fetcher })).toEqual({ id: "1001", login: "acme", type: null });
    expect(asked).toEqual(["https://api.github.com/users/acme", "https://api.github.com/user/1001"]);
    await expect(githubAccount("ghost", { fetcher })).rejects.toThrow("GitHub has no account ghost");
    await expect(githubAccount("../evil", { fetcher })).rejects.toThrow("is not a GitHub login or account id");
  });
});

describe("youiyoux hub: the admin commands, on the hub's store", () => {
  let out = "";
  let err = "";
  const db = (): string => join(dir, "admin.db");
  const run = async (...args: string[]): Promise<number> => {
    out = "";
    err = "";
    return main(["hub", ...args, "--db", db()]);
  };
  beforeEach(async () => {
    await rm(db(), { force: true });
    delete process.env.DATABASE_URL;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const accounts: Record<string, { id: number; login: string; type: string }> = { acme: { id: 1001, login: "acme", type: "Organization" }, peter: { id: 11, login: "peter", type: "User" } };
      const found = accounts[String(input).split("/").pop()!];
      return found ? Response.json(found) : new Response("{}", { status: 404 });
    });
  });

  test("a workspace, its owner, an admin and a CI token shown once; listed; removed only with --yes", async () => {
    expect(await run("workspace", "add", "acme", "--name", "Acme Inc", "--org", "acme")).toBe(0);
    expect(out).toContain("added the workspace acme; active members of acme come in at sign-in");
    expect(await run("owner", "add", "acme", "acme")).toBe(0);
    expect(await run("member", "add", "acme", "peter", "--admin")).toBe(0);
    expect(await run("token", "add", "acme", "jenkins")).toBe(0);
    const token = /\b(yxh_[\w-]{43})\b/.exec(out)![1]!;
    expect(out).toContain("It is shown once, here; the hub keeps only its hash");

    const check = await openStore({ path: db(), env: {} });
    expect(await check.workspaceForToken(sha256(token))).toBe("acme");
    expect(await check.workspaceForToken(token)).toBeNull();
    expect(await check.members("acme")).toMatchObject([{ login: "peter", role: "admin", via: "invite" }]);
    await check.close();

    expect(await run("workspace", "list")).toBe(0);
    expect(out).toContain("acme  Acme Inc · members of acme let in");
    expect(out).toContain("owners: acme · 1 member · CI tokens: jenkins");
    expect(await run("member", "list", "acme", "--json")).toBe(0);
    expect(JSON.parse(out)).toMatchObject([{ login: "peter", role: "admin" }]);

    expect(await run("workspace", "remove", "acme")).toBe(2);
    expect(err).toContain("youiyoux hub workspace remove acme --yes");
    expect(await run("workspace", "remove", "acme", "--yes")).toBe(0);
    expect(await run("workspace", "list")).toBe(0);
    expect(out).toContain("no workspace yet");
  });

  test("refuses what would be wrong, saying why", async () => {
    expect(await run("workspace", "add", "Acme_Inc")).toBe(2);
    expect(err).toContain("a workspace id is lowercase letters, digits and hyphens");
    expect(await run("workspace", "add", "acme", "--org", "peter")).toBe(2);
    expect(err).toContain("peter is a person's account, not an organisation");
    await run("workspace", "add", "acme");
    await run("workspace", "add", "globex");
    expect(await run("workspace", "add", "acme")).toBe(2);
    expect(err).toContain("there is a workspace acme already");
    await run("owner", "add", "acme", "acme");
    expect(await run("owner", "add", "globex", "acme")).toBe(2);
    expect(err).toContain("acme's records go to the workspace acme already");
    expect(await run("member", "add", "acme", "acme")).toBe(2);
    expect(err).toContain("acme is an organisation: members are people");
    expect(await run("member", "add", "nowhere", "peter")).toBe(2);
    expect(err).toContain("there is no workspace nowhere on this hub");
    expect(await run("member", "add", "acme", "ghost")).toBe(2);
    expect(err).toContain("GitHub has no account ghost");
    expect(await run("token", "remove", "acme", "jenkins")).toBe(2);
    expect(err).toContain("acme has no CI token named jenkins");
    expect(await run("workspace")).toBe(2);
  });
});

describe("youiyoux hub serve with workspaces", () => {
  test("needs both halves of the OAuth App and the hub's https address, and refuses the single organisation's settings beside them", async () => {
    for (const name of ["YOUIYOUX_HUB_GITHUB_CLIENT_ID", "YOUIYOUX_HUB_GITHUB_CLIENT_SECRET", "YOUIYOUX_HUB_AUDIENCE", "YOUIYOUX_HUB_GITHUB_OWNERS", "YOUIYOUX_HUB_TOKEN", "YOUIYOUX_HUB_VIEW_KEY"]) delete process.env[name];
    let err = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
    const serve = async (vars: Record<string, string>): Promise<string> => {
      err = "";
      Object.assign(process.env, vars);
      expect(await main(["hub", "serve", "--db", join(dir, "serve.db")])).toBe(2);
      for (const name of Object.keys(vars)) delete process.env[name];
      return err;
    };
    expect(await serve({ YOUIYOUX_HUB_GITHUB_CLIENT_ID: "Iv1.test" })).toContain("set both YOUIYOUX_HUB_GITHUB_CLIENT_ID and YOUIYOUX_HUB_GITHUB_CLIENT_SECRET");
    const app = { YOUIYOUX_HUB_GITHUB_CLIENT_ID: "Iv1.test", YOUIYOUX_HUB_GITHUB_CLIENT_SECRET: "client-secret-for-tests" };
    expect(await serve(app)).toContain("with workspaces, set YOUIYOUX_HUB_AUDIENCE");
    expect(await serve({ ...app, YOUIYOUX_HUB_AUDIENCE: "http://hub.acme.dev" })).toContain("the hub's https address (http only on localhost)");
    expect(await serve({ ...app, YOUIYOUX_HUB_AUDIENCE: AUDIENCE, YOUIYOUX_HUB_VIEW_KEY: "view-key-for-tests-0123456789abcdef", YOUIYOUX_HUB_GITHUB_OWNERS: "1001" })).toContain("with workspaces, YOUIYOUX_HUB_GITHUB_OWNERS and YOUIYOUX_HUB_VIEW_KEY are not used");
  });

  test("the page is told to sign people in with GitHub", async () => {
    await hub!.close();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const built = join(dir, `dist-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(built, "assets"), { recursive: true });
    await writeFile(join(built, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    hub = await startOrgHub({ store, workspaces: { signIn: fakeGithub, url: AUDIENCE }, dist: built });
    const page = await (await get("/")).text();
    expect(page).toContain('<meta name="youi-org" content="/api/me" />');
    expect(page).toContain('<meta name="youi-org-mode" content="workspaces" />');
  });
});
