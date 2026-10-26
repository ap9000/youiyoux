/**
 * Records proved by GitHub Actions' OIDC token: the hub takes one only when GitHub signed the
 * token, for this hub, unexpired, from an owner it accepts, and for the repository, commit and
 * branch the record names. GitHub's keys are a test key here; nothing touches the network.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CiRecord } from "@youiyoux/core";
import { openStore, type Store } from "@youiyoux/store";
import { githubVerifier, GITHUB_ISSUER, recordMismatch, requestGithubToken, type Jwks } from "../src/github-oidc.ts";
import { main } from "../src/index.ts";
import { GITHUB_TOKEN_HEADER, secretsProblem, startOrgHub, type OrgHub } from "../src/org-hub.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });

const AUDIENCE = "https://hub.acme.dev";
const VIEW = "view-key-for-tests-0123456789abcdef";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const SHA = "c".repeat(40);

const github = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS: Jwks = { keys: [{ ...github.publicKey.export({ format: "jwk" }), kid: "gh-1", alg: "RS256", use: "sig" }] };

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A token as GitHub Actions writes one; any part can be changed. */
function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = github.privateKey): string {
  const seconds = NOW.getTime() / 1000;
  const head = b64({ alg: "RS256", typ: "JWT", kid: "gh-1", ...header });
  const body = b64({ iss: GITHUB_ISSUER, aud: AUDIENCE, exp: seconds + 300, nbf: seconds - 10, iat: seconds - 10, repository: "acme/billing", repository_owner: "acme", sha: SHA, ref: "refs/heads/main", ...claims });
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}

const verifier = (owners: string[] | "any" = ["acme"]) => githubVerifier({ owners, audience: `${AUDIENCE}/`, jwks: async () => JWKS, now: () => NOW });
const record = (extra: Partial<CiRecord> = {}): CiRecord => ({ schema: "youi.record/v1", repo: "acme/billing", commit: SHA, ref: "main", generatedAt: NOW.toISOString(), tool: "0.1.12", products: [{ root: ".", error: "no youi.project.json", next: "youiyoux adopt" }], ...extra });

let dir: string;
let store: Store;
let hub: OrgHub | null = null;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-oidc-")));
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

describe("GitHub Actions' OIDC token", () => {
  test("GitHub's, for this hub, unexpired and from an accepted owner: its repository, commit and branch", async () => {
    expect(await verifier()(token({ event_name: "push" }))).toEqual({ repository: "acme/billing", repository_owner: "acme", sha: SHA, ref: "refs/heads/main", event_name: "push" });
    // Owners match as GitHub names them, in any case.
    expect((await verifier(["ACME"])(token())).repository).toBe("acme/billing");
    // By id, an owner is that account only: whoever takes a renamed owner's old name does not match.
    expect((await verifier(["1234567"])(token({ repository_owner_id: "1234567" }))).repository).toBe("acme/billing");
    await expect(verifier(["1234567"])(token({ repository_owner_id: "7654321" }))).rejects.toThrow("from acme (id 7654321), which this hub does not take records from");
    // An account named with digits does not match an owner listed by that number: an id matches only an id.
    await expect(verifier(["1234567"])(token({ repository_owner: "1234567", repository: "1234567/billing", repository_owner_id: "999" }))).rejects.toThrow("from 1234567 (id 999), which this hub does not take records from");
  });

  test("for a hub with workspaces, any owner, with the owner's id for routing; a token without the id is refused", async () => {
    expect(await verifier("any")(token({ repository_owner_id: "7654321" }))).toMatchObject({ repository: "acme/billing", repository_owner_id: "7654321" });
    await expect(verifier("any")(token())).rejects.toThrow("missing its owner's id");
    await expect(verifier("any")(token({ repository_owner_id: "acme" }))).rejects.toThrow("missing its owner's id");
    // Everything else is still checked: the branch, here.
    await expect(verifier("any")(token({ repository_owner_id: "7654321", ref: "refs/heads/feature" }))).rejects.toThrow("from refs/heads/feature");
  });

  test("anything else is refused, saying why", async () => {
    const refused = (t: string, owners?: string[]) => verifier(owners)(t).then(() => "accepted", (e: Error) => e.message);
    const [head, body] = token().split(".");
    expect(await refused(`${head}.${body}.`)).toBe("its signature is not GitHub's");
    expect(await refused(token({}, {}, stranger.privateKey))).toBe("its signature is not GitHub's");
    expect(await refused(`${b64({ alg: "none", kid: "gh-1" })}.${body}.`)).toBe("signed with none, not GitHub's RS256");
    expect(await refused(token({}, { alg: "HS256" }))).toBe("signed with HS256, not GitHub's RS256");
    expect(await refused(token({}, { kid: "elsewhere" }))).toBe("not signed by a key GitHub publishes");
    expect(await refused(token({ iss: "https://evil.example" }))).toBe("issued by https://evil.example, not GitHub Actions");
    expect(await refused(token({ aud: "https://other-hub.example" }))).toBe("issued for https://other-hub.example, not this hub (https://hub.acme.dev)");
    expect(await refused(token({ exp: NOW.getTime() / 1000 - 120 }))).toBe("expired");
    expect(await refused(token({ nbf: NOW.getTime() / 1000 + 600 }))).toBe("not valid yet");
    expect(await refused(token({ repository_owner: "evil", repository: "evil/billing" }))).toBe("from evil, which this hub does not take records from");
    expect(await refused(token({ sha: undefined }))).toBe("missing its repository, owner, commit or ref");
    expect(await refused("not.a")).toBe("not a JSON Web Token");
    // Only the branches the hub takes records from: a push to a feature branch does not replace the repository's latest.
    expect(await refused(token({ ref: "refs/heads/feature/x" }))).toBe("from refs/heads/feature/x: this hub takes records from main and master only (YOUIYOUX_HUB_BRANCHES)");
    expect(await refused(token({ ref: "refs/tags/main" }))).toBe("from refs/tags/main: this hub takes records from main and master only (YOUIYOUX_HUB_BRANCHES)");
    expect(await githubVerifier({ owners: ["acme"], audience: AUDIENCE, branches: ["trunk"], jwks: async () => JWKS, now: () => NOW })(token({ ref: "refs/heads/trunk" })).then((c) => c.ref)).toBe("refs/heads/trunk");
  });

  test("the record must be the token's own repository, commit and branch", () => {
    const claims = { repository: "acme/billing", repository_owner: "acme", sha: SHA, ref: "refs/heads/main" };
    expect(recordMismatch(claims, record())).toBeNull();
    expect(recordMismatch(claims, record({ repo: "Acme/Billing" }))).toBeNull();
    expect(recordMismatch(claims, record({ repo: "acme/payroll" }))).toBe("the record names acme/payroll, but it was sent from acme/billing");
    expect(recordMismatch(claims, record({ commit: "d".repeat(40) }))).toBe(`the record names commit ${"d".repeat(40)}, but it was sent from ${SHA}`);
    expect(recordMismatch(claims, record({ ref: "release" }))).toBe("the record names release, but it was sent from main");
    // A tag or a pull request named like the branch never stands for it.
    expect(recordMismatch({ ...claims, ref: "refs/tags/main" }, record())).toBe("it was sent from refs/tags/main, not a branch");
    expect(recordMismatch({ ...claims, ref: "refs/pull/7/merge" }, record({ ref: "7/merge" }))).toBe("it was sent from refs/pull/7/merge, not a branch");
    expect(recordMismatch({ ...claims, event_name: "pull_request_target" }, record())).toBe("it was sent from a pull_request_target run, not a push to the branch");
    expect(recordMismatch({ ...claims, event_name: "push" }, record())).toBeNull();
  });

  test("in a job with id-token: write it asks GitHub for a token for the hub's address; elsewhere there is none", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => new Response(JSON.stringify({ value: `token-for ${new URL(String(url)).searchParams.get("audience")} ${(init?.headers as Record<string, string>).authorization}` })));
    expect(await requestGithubToken(AUDIENCE, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner" }, fetcher as typeof fetch)).toBe(`token-for ${AUDIENCE} bearer runner`);
    expect(await requestGithubToken(AUDIENCE, {}, fetcher as typeof fetch)).toBeNull();
  });
});

describe("a hub that takes records from GitHub Actions", () => {
  test("needs no ingest token; a record comes only with a token for its own repository, commit and branch", async () => {
    expect(secretsProblem(undefined, VIEW, true)).toBeNull();
    expect(secretsProblem(undefined, VIEW, false)).toMatch(/YOUIYOUX_HUB_GITHUB_OWNERS and YOUIYOUX_HUB_AUDIENCE/);
    hub = await startOrgHub({ store, github: verifier(), viewKey: VIEW, dist: null, now: () => NOW });
    const post = (body: CiRecord, headers: Record<string, string>) => fetch(`${hub!.url}/api/records`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const none = await post(record(), {});
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: string }).error).toMatch(/permissions: id-token: write/);
    expect((await post(record(), { authorization: "Bearer any-shared-token-0123456789abcdef" })).status).toBe(401);
    const forged = await post(record(), { [GITHUB_TOKEN_HEADER]: token({}, {}, stranger.privateKey) });
    expect(((await forged.json()) as { error: string }).error).toBe("the GitHub Actions token was refused: its signature is not GitHub's");
    // acme/payroll's CI cannot send acme/billing's record.
    const spoofed = await post(record(), { [GITHUB_TOKEN_HEADER]: token({ repository: "acme/payroll", sha: SHA }) });
    expect(spoofed.status).toBe(403);
    expect(((await spoofed.json()) as { error: string }).error).toBe("the record names acme/billing, but it was sent from acme/payroll: a repository's CI sends only its own record");
    expect((await post(record(), { [GITHUB_TOKEN_HEADER]: token() })).status).toBe(201);
    expect((await store.latestRecords()).map((r) => r.record.repo)).toEqual(["acme/billing"]);
  });

  test("youiyoux record --send, in a job with id-token: write, proves its repository with no ingest token", async () => {
    const root = join(dir, "app");
    await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
    const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: join(EXAMPLES, "demo-design") } }));
    await git(root, "init", "--quiet", "--initial-branch=main");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "start");
    const sha = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    // GitHub Actions' token endpoint, as the runner offers it: a token for the audience asked for.
    let asked = "";
    const actions: Server = createServer((req, res) => {
      asked = new URL(req.url!, "http://x").searchParams.get("audience") ?? "";
      res.end(JSON.stringify({ value: token({ aud: asked, sha }) }));
    });
    await new Promise<void>((done) => actions.listen(0, "127.0.0.1", done));
    try {
      // The hub's audience is its own address, known once it listens.
      let audience = "";
      hub = await startOrgHub({ store, github: (t) => githubVerifier({ owners: ["acme"], audience, jwks: async () => JWKS, now: () => NOW })(t), viewKey: VIEW, dist: null });
      audience = hub.url;
      const port = (actions.address() as { port: number }).port;
      process.env = { ...env, YOUIYOUX_HUB_URL: hub.url, GITHUB_REPOSITORY: "acme/billing", GITHUB_SHA: sha, GITHUB_REF_NAME: "main", ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner" };
      delete process.env.YOUIYOUX_HUB_TOKEN;
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await main(["record", "--send", "--project", root])).toBe(0);
      expect(asked).toBe(hub.url);
      expect((await store.latestRecords()).map((r) => [r.record.repo, r.record.commit])).toEqual([["acme/billing", sha]]);
    } finally {
      await new Promise<void>((done) => actions.close(() => done()));
    }
  });
});

describe("a record dated in the future", () => {
  test("is refused: it would stay its repository's latest", async () => {
    hub = await startOrgHub({ store, ingestToken: "ingest-token-for-tests-0123456789", viewKey: VIEW, dist: null, now: () => NOW });
    const post = (body: CiRecord) => fetch(`${hub!.url}/api/records`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ingest-token-for-tests-0123456789" }, body: JSON.stringify(body) });
    const ahead = await post(record({ generatedAt: "2099-01-01T00:00:00.000Z" }));
    expect(ahead.status).toBe(422);
    expect(((await ahead.json()) as { error: string }).error).toMatch(/^the record is dated 2099-01-01T00:00:00.000Z, after the hub's clock .* by more than five minutes/);
    // A few minutes of clock difference is fine.
    expect((await post(record({ generatedAt: new Date(NOW.getTime() + 4 * 60_000).toISOString() }))).status).toBe(201);
  });
});
