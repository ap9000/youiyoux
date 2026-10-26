/**
 * The hosted hub's API (`youiyoux hub serve`): the organisation view (youi.org/v1) once signed in
 * with the hub's view key, which the server keeps as an HttpOnly cookie this page never reads. A
 * hub with workspaces signs people in with GitHub instead (a page navigation to /auth/github), and
 * shows each workspace they are a member of.
 */
import type { OrgView } from "@youiyoux/core";

export class OrgRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) throw new OrgRequestError(response.status, typeof data.error === "string" ? data.error : `the hub answered ${response.status}`);
  return data as T;
}

/** Who is signed in to a hub with workspaces, and theirs. */
export interface Me {
  readonly user: { readonly login: string; readonly name: string | null };
  readonly workspaces: ReadonlyArray<{ readonly id: string; readonly name: string; readonly role: "admin" | "member" }>;
}

/** Where the page goes to sign in with GitHub: the hub's server, which sends it on to GitHub. */
export const GITHUB_SIGN_IN = "/auth/github";

export const orgApi = {
  me: () => call<Me>("GET", "/api/me"),
  workspace: (id: string) => call<OrgView>("GET", `/api/w/${encodeURIComponent(id)}/org`),
  view: (path: string) => call<OrgView>("GET", path),
  signIn: (key: string) => call<{ ok: true }>("POST", "/api/session", { key }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/session"),
};
