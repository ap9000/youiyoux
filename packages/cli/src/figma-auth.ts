/**
 * Signing in to Figma for `youiyoux library ingest <figma link>`, once per person:
 *
 *   browser   with a team's private Figma OAuth app (FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET, set
 *             by whoever registered it): the authorization code flow with PKCE, through a one-off
 *             callback on 127.0.0.1; the access token is renewed before it lapses (90 days)
 *   token     otherwise, a personal access token the person makes in Figma and pastes, read
 *             without echo
 *
 * Either is kept in the macOS Keychain (written through the security tool's stdin, never its
 * arguments), else in a file only its owner can read. FIGMA_TOKEN in the environment wins over
 * both. Read-only scopes: file_content:read and library_content:read. No token is ever printed.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "@youiyoux/core";

const run = promisify(execFile);
const API = "https://api.figma.com/v1";
export const FIGMA_SCOPES = ["file_content:read", "library_content:read", "current_user:read"] as const;
export const DEFAULT_CALLBACK_PORT = 47823;
/** Renew an OAuth token this long before it lapses. */
const RENEW_MS = 24 * 60 * 60 * 1000;
const KEYCHAIN = { account: "youiyoux", service: "youiyoux-figma" } as const;

export type FigmaCredential =
  | { readonly kind: "token"; readonly token: string; readonly savedAt: string; readonly handle: string | null }
  | { readonly kind: "oauth"; readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: string; readonly clientId: string; readonly savedAt: string; readonly handle: string | null };

export interface CredentialStore {
  readonly where: string;
  get(): Promise<FigmaCredential | null>;
  set(credential: FigmaCredential): Promise<void>;
  delete(): Promise<boolean>;
}

const parse = (text: string | null): FigmaCredential | null => {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as FigmaCredential;
    return value && (value.kind === "token" || value.kind === "oauth") ? value : null;
  } catch {
    return null;
  }
};

/** A file only its owner can read: written atomically, then narrowed to 0600. */
export function fileStore(path: string): CredentialStore {
  return {
    where: path,
    get: async () => parse(await readFile(path, "utf8").catch(() => null)),
    set: async (credential) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, `${JSON.stringify(credential)}\n`);
      await chmod(path, 0o600);
    },
    delete: async () => rm(path).then(() => true, () => false),
  };
}

/** The macOS Keychain, through `security`: the secret goes in on stdin, base64, so it is never an argument another process can read. */
export function keychainStore(): CredentialStore {
  const { account, service } = KEYCHAIN;
  return {
    where: "the macOS Keychain (youiyoux-figma)",
    get: async () => parse(await run("security", ["find-generic-password", "-a", account, "-s", service, "-w"]).then((r) => Buffer.from(r.stdout.trim(), "base64").toString("utf8"), () => null)),
    set: (credential) =>
      new Promise((done, fail) => {
        const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", (c) => (err += String(c)));
        child.on("error", fail);
        child.on("exit", (code) => (code === 0 && !err.trim() ? done() : fail(new Error(`the Keychain refused the credential${err.trim() ? `: ${err.trim()}` : ""}`))));
        child.stdin.end(`add-generic-password -a ${account} -s ${service} -U -w ${Buffer.from(JSON.stringify(credential)).toString("base64")}\n`);
      }),
    delete: async () => run("security", ["delete-generic-password", "-a", account, "-s", service]).then(() => true, () => false),
  };
}

/** Where this person's Figma sign-in is kept: YOUI_FIGMA_CREDENTIALS (a file), else the Keychain on macOS, else a 0600 file in the config folder. */
export function credentialStore(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): CredentialStore {
  if (env.YOUI_FIGMA_CREDENTIALS) return fileStore(env.YOUI_FIGMA_CREDENTIALS);
  if (platform === "darwin") return keychainStore();
  return fileStore(join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "youiyoux", "figma.json"));
}

/** The basic credentials Figma's token endpoints take: the team's own app's id and secret. */
const basic = (id: string, secret: string): string => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

async function postForm(fetcher: typeof fetch, url: string, auth: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const said = [body.message, body.err, body.error].find((v): v is string => typeof v === "string");
  if (!response.ok) throw new Error(`Figma refused (${response.status}): ${said ?? response.statusText}`);
  return body;
}

/** Who a token signs in as (needs current_user:read); null when Figma will not say. */
export async function whoAmI(token: string, bearer: boolean, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; handle: string | null; status: number }> {
  const response = await fetcher(`${API}/me`, { headers: bearer ? { authorization: `Bearer ${token}` } : { "x-figma-token": token }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return { ok: false, handle: null, status: response.status };
  const me = (await response.json().catch(() => ({}))) as { handle?: unknown };
  return { ok: true, handle: typeof me.handle === "string" ? me.handle : null, status: response.status };
}

export interface OAuthApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const oauthAppOf = (env: NodeJS.ProcessEnv): OAuthApp | null => (env.FIGMA_CLIENT_ID && env.FIGMA_CLIENT_SECRET ? { clientId: env.FIGMA_CLIENT_ID, clientSecret: env.FIGMA_CLIENT_SECRET } : null);

export interface BrowserLoginOptions {
  readonly app: OAuthApp;
  readonly port?: number;
  /** Open the sign-in page (default: the system's browser). */
  readonly open?: (url: string) => void;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Told the address to open, should the browser not start. */
  readonly say?: (line: string) => void;
}

export const callbackUrl = (port: number): string => `http://127.0.0.1:${port}/callback`;

/** The system's browser, without a shell: the URL is one argument. */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  spawn(command, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

const page = (title: string, text: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem;max-width:32rem"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;

/**
 * Sign in through the browser with the team's private app: PKCE (S256) and a random state, a
 * callback that answers once on 127.0.0.1 only, the code exchanged for tokens with the app's
 * secret. Returns the credential to keep.
 */
export async function browserLogin(options: BrowserLoginOptions): Promise<FigmaCredential> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const redirect = callbackUrl(port);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("https://www.figma.com/oauth");
  for (const [key, value] of Object.entries({ client_id: options.app.clientId, redirect_uri: redirect, scope: FIGMA_SCOPES.join(","), state, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })) authorize.searchParams.set(key, value);

  const code = await new Promise<string>((done, fail) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, title: string, text: string, outcome: () => void): void => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(title, text));
        clearTimeout(timer);
        server.close();
        outcome();
      };
      // Only the answer to this sign-in: another page cannot finish it with a code of its own.
      if (url.searchParams.get("state") !== state) return finish(400, "Not this sign-in", "This answer is not for the sign-in youiyoux started. Run youiyoux figma login again.", () => fail(new Error("the answer came with another sign-in's state; nothing was kept")));
      const error = url.searchParams.get("error");
      if (error) return finish(400, "Not signed in", "Figma did not sign you in. You can close this tab.", () => fail(new Error(`Figma did not sign you in: ${error}`)));
      const given = url.searchParams.get("code");
      if (!given) return finish(400, "Not signed in", "Figma sent no code. Run youiyoux figma login again.", () => fail(new Error("Figma sent no code")));
      finish(200, "Signed in to Figma", "youiyoux can read your Figma files now. You can close this tab.", () => done(given));
    });
    const timer = setTimeout(() => {
      server.close();
      fail(new Error("no answer from Figma within five minutes; run youiyoux figma login again"));
    }, options.timeoutMs ?? 5 * 60_000);
    server.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new Error(error.code === "EADDRINUSE" ? `port ${port} is taken: pass --port <n>, and register ${callbackUrl(port).replace(String(port), "<n>")} in the Figma app` : error.message));
    });
    server.listen(port, "127.0.0.1", () => {
      options.say?.(`Opening Figma to sign in. If no browser opens, visit:\n  ${authorize.href}`);
      (options.open ?? openBrowser)(authorize.href);
    });
  });

  const tokens = await postForm(fetcher, `${API}/oauth/token`, basic(options.app.clientId, options.app.clientSecret), { redirect_uri: redirect, code, grant_type: "authorization_code", code_verifier: verifier });
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") throw new Error("Figma's answer had no tokens");
  const seconds = typeof tokens.expires_in === "number" ? tokens.expires_in : 90 * 86_400;
  const me = await whoAmI(accessToken, true, fetcher).catch(() => ({ ok: false, handle: null, status: 0 }));
  return { kind: "oauth", accessToken, refreshToken, expiresAt: new Date(now().getTime() + seconds * 1000).toISOString(), clientId: options.app.clientId, savedAt: now().toISOString(), handle: me.handle };
}

/** A personal access token a person pasted: checked with Figma, then the credential to keep. */
export async function tokenLogin(token: string, options: { fetcher?: typeof fetch; now?: () => Date } = {}): Promise<{ credential: FigmaCredential; checked: boolean }> {
  const clean = token.trim();
  if (!/^[\w-]{20,200}$/.test(clean)) throw new Error("that does not look like a Figma personal access token (figd_…)");
  const me = await whoAmI(clean, false, options.fetcher);
  // 403: valid, without current_user:read; 401: not a token Figma knows.
  if (!me.ok && me.status !== 403) throw new Error(`Figma does not accept that token (${me.status}): make a new one`);
  return { credential: { kind: "token", token: clean, savedAt: (options.now ?? (() => new Date()))().toISOString(), handle: me.handle }, checked: me.ok };
}

export interface FigmaAccess {
  readonly token: string;
  /** An OAuth access token, sent as a Bearer; a personal one goes in X-Figma-Token. */
  readonly bearer: boolean;
  readonly from: "env" | "token" | "oauth";
}

/**
 * The token to read Figma with: FIGMA_TOKEN, else this person's sign-in, an OAuth token renewed
 * when it is within a day of lapsing (with the team's app), and kept again. Null when signed out.
 */
export async function figmaAccess(options: { env?: NodeJS.ProcessEnv; store?: CredentialStore; fetcher?: typeof fetch; now?: () => Date } = {}): Promise<FigmaAccess | null> {
  const env = options.env ?? process.env;
  if (env.FIGMA_TOKEN) return { token: env.FIGMA_TOKEN, bearer: false, from: "env" };
  const store = options.store ?? credentialStore(env);
  const stored = await store.get();
  if (!stored) return null;
  if (stored.kind === "token") return { token: stored.token, bearer: false, from: "token" };
  const now = (options.now ?? (() => new Date()))();
  if (Date.parse(stored.expiresAt) - now.getTime() > RENEW_MS) return { token: stored.accessToken, bearer: true, from: "oauth" };
  const app = oauthAppOf(env);
  if (!app || app.clientId !== stored.clientId) {
    if (Date.parse(stored.expiresAt) > now.getTime()) return { token: stored.accessToken, bearer: true, from: "oauth" };
    throw new Error("your Figma sign-in has lapsed, and renewing it needs your team's Figma app (FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET): set them and run youiyoux figma login");
  }
  const renewed = await postForm(options.fetcher ?? fetch, `${API}/oauth/refresh`, basic(app.clientId, app.clientSecret), { refresh_token: stored.refreshToken });
  if (typeof renewed.access_token !== "string") throw new Error("Figma did not renew the sign-in: run youiyoux figma login");
  const seconds = typeof renewed.expires_in === "number" ? renewed.expires_in : 90 * 86_400;
  await store.set({ ...stored, accessToken: renewed.access_token, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() });
  return { token: renewed.access_token, bearer: true, from: "oauth" };
}

/** A line read from the terminal without echoing it; from a pipe, the first line. */
export async function readSecret(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) {
      text += String(chunk);
      if (text.includes("\n")) break;
    }
    return text.split(/\r?\n/)[0] ?? "";
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((done, fail) => {
    let value = "";
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(() => done(value));
        if (char === "\u0003") return finish(() => fail(new Error("cancelled")));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    const finish = (then: () => void): void => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      then();
    };
    input.on("data", onData);
  });
}
