/**
 * Signing in to Figma once (`youiyoux figma login`): through the browser with a team's private
 * app (PKCE, a callback on 127.0.0.1 that takes only its own sign-in's answer), or with a pasted
 * personal access token; kept where only its owner can read it, renewed before it lapses, and
 * sent to api.figma.com only. Figma's endpoints are stood in for here.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { PoliteClient } from "@youiyoux/discover";
import { browserLogin, callbackUrl, figmaAccess, fileStore, tokenLogin, type FigmaCredential } from "../src/figma-auth.ts";
import { main } from "../src/index.ts";

const APP = { clientId: "client-123", clientSecret: "secret-456" };
const NOW = new Date("2026-10-24T09:00:00.000Z");
const PAT = `figd_${"x".repeat(40)}`;

let dir: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-figma-"));
  env = { ...process.env };
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/**
 * A sign-in on a port free a moment ago: another test may take it in between, so a taken port is
 * tried again with a new one (never any other failure).
 */
async function onFreePort<T>(login: (port: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await login(await freePort());
    } catch (error: unknown) {
      if (attempt === 5 || !(error instanceof Error && /^port \d+ is taken/.test(error.message))) throw error;
    }
  }
}

/** Figma's token, refresh and me endpoints, recording what they were sent. */
function figma(handle = "ada") {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    if (path === "/v1/oauth/token") return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 7_776_000 });
    if (path === "/v1/oauth/refresh") return Response.json({ access_token: "access-2", expires_in: 7_776_000 });
    if (path === "/v1/me") {
      const headers = init.headers as Record<string, string>;
      if (headers["x-figma-token"] === "figd_forbidden_scope_0000000000") return new Response("{}", { status: 403 });
      if (headers["x-figma-token"]?.startsWith("figd_bad")) return new Response("{}", { status: 401 });
      return Response.json({ handle });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetcher, sent };
}

describe("signing in through the browser, with the team's private app", () => {
  test("PKCE and a random state; the callback on 127.0.0.1 takes the code, which is exchanged with the app's secret and the verifier", async () => {
    const { fetcher, sent } = figma();
    let authorize: URL | null = null;
    let page = "";
    let port = 0;
    const credential = await onFreePort((free) => {
      port = free;
      return browserLogin({
        app: APP,
        port,
        fetcher,
        now: () => NOW,
        open: (url) => {
          authorize = new URL(url);
          // The browser comes back to the callback with Figma's code and the same state.
          void fetch(`${callbackUrl(port)}?code=the-code&state=${authorize.searchParams.get("state")}`).then(async (r) => (page = await r.text()));
        },
      });
    });
    const asked = authorize!;
    expect(asked.origin + asked.pathname).toBe("https://www.figma.com/oauth");
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ client_id: "client-123", redirect_uri: `http://127.0.0.1:${port}/callback`, scope: "file_content:read,library_content:read,current_user:read", response_type: "code", code_challenge_method: "S256" });
    const exchange = sent.find((s) => s.url.endsWith("/v1/oauth/token"))!;
    expect((exchange.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("client-123:secret-456").toString("base64")}`);
    const form = new URLSearchParams(String(exchange.init.body));
    expect(form.get("code")).toBe("the-code");
    expect(form.get("grant_type")).toBe("authorization_code");
    // The verifier is the one whose hash the sign-in page was given.
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(asked.searchParams.get("code_challenge"));
    expect(credential).toEqual({ kind: "oauth", accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(NOW.getTime() + 7_776_000_000).toISOString(), clientId: "client-123", savedAt: NOW.toISOString(), handle: "ada" });
    await vi.waitFor(() => expect(page).toContain("Signed in to Figma"));
  });

  test("an answer with another sign-in's state is refused, and nothing is exchanged", async () => {
    const { fetcher, sent } = figma();
    await expect(onFreePort((port) => browserLogin({ app: APP, port, fetcher, open: () => void fetch(`${callbackUrl(port)}?code=planted&state=not-ours`) }))).rejects.toThrow("another sign-in's state; nothing was kept");
    expect(sent).toEqual([]);
    await expect(onFreePort((port) => browserLogin({ app: APP, port, fetcher, open: (url) => void fetch(`${callbackUrl(port)}?error=access_denied&state=${new URL(url).searchParams.get("state")}`) }))).rejects.toThrow("Figma did not sign you in: access_denied");
  });
});

describe("signing in with a personal access token", () => {
  test("checked with Figma: a token it does not know is refused; one without the user scope is kept, unchecked", async () => {
    const { fetcher } = figma();
    expect(await tokenLogin(` ${PAT}\n`, { fetcher, now: () => NOW })).toEqual({ credential: { kind: "token", token: PAT, savedAt: NOW.toISOString(), handle: "ada" }, checked: true });
    await expect(tokenLogin("figd_bad_000000000000000000", { fetcher })).rejects.toThrow("Figma does not accept that token (401)");
    expect((await tokenLogin("figd_forbidden_scope_0000000000", { fetcher })).checked).toBe(false);
    await expect(tokenLogin("not a token; rm -rf ~", { fetcher })).rejects.toThrow("does not look like a Figma personal access token");
  });
});

describe("the kept sign-in", () => {
  test("a file only its owner can read, in a folder only its owner can enter, even one that was there before", async () => {
    await mkdir(join(dir, "nested"), { mode: 0o755 });
    await chmod(join(dir, "nested"), 0o755);
    const path = join(dir, "nested", "figma.json");
    const store = fileStore(path);
    const credential: FigmaCredential = { kind: "token", token: PAT, savedAt: NOW.toISOString(), handle: null };
    await store.set(credential);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    expect(await store.get()).toEqual(credential);
    expect(await store.delete()).toBe(true);
    expect(await store.get()).toBeNull();
  });

  test("FIGMA_TOKEN wins; an OAuth token is renewed within a day of lapsing, with the team's app, and kept again", async () => {
    const store = fileStore(join(dir, "renew.json"));
    expect(await figmaAccess({ env: { FIGMA_TOKEN: "from-env" }, store })).toEqual({ token: "from-env", bearer: false, from: "env" });
    expect(await figmaAccess({ env: {}, store })).toBeNull();
    const oauth = (expiresAt: string): FigmaCredential => ({ kind: "oauth", accessToken: "access-1", refreshToken: "refresh-1", expiresAt, clientId: "client-123", savedAt: NOW.toISOString(), handle: "ada" });
    await store.set(oauth("2026-12-01T00:00:00.000Z"));
    const { fetcher, sent } = figma();
    expect(await figmaAccess({ env: {}, store, fetcher, now: () => NOW })).toEqual({ token: "access-1", bearer: true, from: "oauth" });
    expect(sent).toEqual([]);
    // Within a day of lapsing: renewed, and the renewal kept.
    await store.set(oauth("2026-10-24T20:00:00.000Z"));
    expect(await figmaAccess({ env: { FIGMA_CLIENT_ID: APP.clientId, FIGMA_CLIENT_SECRET: APP.clientSecret }, store, fetcher, now: () => NOW })).toEqual({ token: "access-2", bearer: true, from: "oauth" });
    expect(new URLSearchParams(String(sent[0]!.init.body)).get("refresh_token")).toBe("refresh-1");
    expect(await store.get()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
    // Without the app: still used until it lapses, then a plain request to sign in again.
    await store.set(oauth("2026-10-24T20:00:00.000Z"));
    expect((await figmaAccess({ env: {}, store, now: () => NOW }))?.token).toBe("access-1");
    await store.set(oauth("2026-10-01T00:00:00.000Z"));
    await expect(figmaAccess({ env: {}, store, now: () => NOW })).rejects.toThrow("your Figma sign-in has lapsed");
  });

  test("an OAuth token is sent to api.figma.com only, as a Bearer; a personal one as X-Figma-Token", async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init: { headers: Record<string, string> }) => (asked.push({ url, headers: init.headers }), Response.json({}));
    await new PoliteClient({ fetcher, figmaToken: "access-1", figmaBearer: true }).get("https://api.figma.com/v1/me");
    await new PoliteClient({ fetcher, figmaToken: "access-1", figmaBearer: true }).get("https://storybook.acme.dev/index.json");
    await new PoliteClient({ fetcher, figmaToken: PAT }).get("https://api.figma.com/v1/me");
    expect(asked.map((a) => [a.url, a.headers.authorization ?? null, a.headers["x-figma-token"] ?? null])).toEqual([
      ["https://api.figma.com/v1/me", "Bearer access-1", null],
      ["https://storybook.acme.dev/index.json", null, null],
      ["https://api.figma.com/v1/me", null, PAT],
    ]);
  });
});

describe("youiyoux figma status and logout", () => {
  test("say how this person is signed in, never the token, and logout removes it", async () => {
    const path = join(dir, "cli.json");
    process.env.YOUI_FIGMA_CREDENTIALS = path;
    delete process.env.FIGMA_TOKEN;
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
    expect(await main(["figma", "status"])).toBe(1);
    expect(out).toContain("not signed in to Figma: youiyoux figma login");
    await fileStore(path).set({ kind: "token", token: PAT, savedAt: NOW.toISOString(), handle: "ada" });
    out = "";
    expect(await main(["figma", "status"])).toBe(0);
    expect(out).toContain(`signed in as ada with a personal access token, kept in ${path} since 2026-10-24`);
    expect(out).not.toContain(PAT);
    out = "";
    expect(await main(["figma", "logout"])).toBe(0);
    expect(out).toContain("signed out");
    expect(await readFile(path, "utf8").catch(() => null)).toBeNull();
  });
});
