/**
 * Signing in to a hub with workspaces through GitHub: the hub's own OAuth App (one per hub, its
 * client id and secret in the environment) asks for `read:org`, so the hub can see which
 * organisations a person is an active member of, by GitHub's numeric id. The access token is used
 * for that once, at sign-in, then revoked: the hub never keeps it. Also, for the admin commands,
 * an account looked up by login or id.
 */
import type { GithubAccount, HubUser } from "@youiyoux/store";

export const CLIENT_ID_ENV = "YOUIYOUX_HUB_GITHUB_CLIENT_ID";
export const CLIENT_SECRET_ENV = "YOUIYOUX_HUB_GITHUB_CLIENT_SECRET";
const WEB = "https://github.com";
const API = "https://api.github.com";
/** Organisations read at sign-in: 100 a page, at most this many pages. */
const ORG_PAGES = 10;

export interface GithubApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SignedIn {
  readonly user: HubUser;
  /** The organisations the person is an active member of. */
  readonly orgs: readonly GithubAccount[];
}

export interface GithubSignIn {
  /** Where to send the person: GitHub's consent page for this hub's app. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** The person GitHub's code stands for, and their organisations; throws saying why not. */
  signIn(code: string, redirectUri: string): Promise<SignedIn>;
}

export interface GithubOptions {
  readonly fetcher?: typeof fetch;
  /** github.com and api.github.com, for a test server or GitHub Enterprise. */
  readonly web?: string;
  readonly api?: string;
}

const apiHeaders = (token?: string): Record<string, string> => ({ accept: "application/vnd.github+json", "user-agent": "youiyoux-hub", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) });
const timeout = (): AbortSignal => AbortSignal.timeout(15_000);
const idOf = (value: unknown): string | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" && /^\d+$/.test(value) ? value : null);

export function githubSignIn(app: GithubApp, options: GithubOptions = {}): GithubSignIn {
  const fetcher = options.fetcher ?? fetch;
  const web = options.web ?? WEB;
  const api = options.api ?? API;
  const json = async <T>(url: string, init: RequestInit, what: string): Promise<T> => {
    const response = await fetcher(url, { ...init, signal: timeout() });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${what}`);
    return (await response.json()) as T;
  };
  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL(`${web}/login/oauth/authorize`);
      url.searchParams.set("client_id", app.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:org");
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "false");
      return url.toString();
    },
    async signIn(code, redirectUri) {
      const exchanged = await json<{ access_token?: unknown; error?: unknown; error_description?: unknown }>(`${web}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "youiyoux-hub" }, body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }) }, "the sign-in code");
      if (typeof exchanged.access_token !== "string") throw new Error(`GitHub did not sign you in: ${typeof exchanged.error_description === "string" ? exchanged.error_description : typeof exchanged.error === "string" ? exchanged.error : "no access token"}`);
      const token = exchanged.access_token;
      try {
        const me = await json<{ id?: unknown; login?: unknown; name?: unknown }>(`${api}/user`, { headers: apiHeaders(token) }, "your account");
        const githubId = idOf(me.id);
        if (!githubId || typeof me.login !== "string") throw new Error("GitHub answered without an account id and login");
        const orgs: GithubAccount[] = [];
        for (let page = 1; page <= ORG_PAGES; page++) {
          const list = await json<Array<{ state?: unknown; organization?: { id?: unknown; login?: unknown } }>>(`${api}/user/memberships/orgs?state=active&per_page=100&page=${page}`, { headers: apiHeaders(token) }, "your organisations");
          for (const m of list) {
            const id = idOf(m.organization?.id);
            if (m.state === "active" && id && typeof m.organization?.login === "string") orgs.push({ id, login: m.organization.login });
          }
          if (list.length < 100) break;
        }
        return { user: { githubId, login: me.login, name: typeof me.name === "string" && me.name ? me.name : null }, orgs };
      } finally {
        // The hub keeps nothing of GitHub's: the token goes back as soon as it has been used.
        await fetcher(`${api}/applications/${encodeURIComponent(app.clientId)}/token`, { method: "DELETE", headers: { ...apiHeaders(), authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify({ access_token: token }), signal: timeout() }).catch(() => undefined);
      }
    },
  };
}

/**
 * A GitHub account by its login or numeric id, as GitHub has it now; throws when there is none.
 * `id:login` is taken as given, without asking GitHub (its type is then unknown, null).
 */
export async function githubAccount(loginOrId: string, options: GithubOptions = {}): Promise<GithubAccount & { readonly type: "User" | "Organization" | null }> {
  const fetcher = options.fetcher ?? fetch;
  const api = options.api ?? API;
  const given = loginOrId.trim().replace(/^@/, "");
  const pair = /^(\d+):([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/.exec(given);
  if (pair) return { id: pair[1]!, login: pair[2]!, type: null };
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(given)) throw new Error(`"${loginOrId}" is not a GitHub login or account id`);
  const url = /^\d+$/.test(given) ? `${api}/user/${given}` : `${api}/users/${encodeURIComponent(given)}`;
  const response = await fetcher(url, { headers: apiHeaders(), signal: timeout() }).catch((error: unknown) => {
    throw new Error(`GitHub could not be reached to look up ${given} (${error instanceof Error ? error.message : String(error)}): give its numeric id and login as id:login instead`);
  });
  if (response.status === 404) throw new Error(`GitHub has no account ${given}`);
  if (!response.ok) throw new Error(`GitHub answered ${response.status} looking up ${given}`);
  const body = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown };
  const id = idOf(body.id);
  if (!id || typeof body.login !== "string" || (body.type !== "User" && body.type !== "Organization")) throw new Error(`GitHub's answer for ${given} has no account id, login and type`);
  return { id, login: body.login, type: body.type };
}
