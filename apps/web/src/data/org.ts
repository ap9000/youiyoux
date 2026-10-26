/**
 * The hosted hub's API (`youiyoux hub serve`): the organisation view (youi.org/v1) once signed in
 * with the hub's view key, which the server keeps as an HttpOnly cookie this page never reads. A
 * hub with workspaces signs people in with GitHub instead (a page navigation to /auth/github), and
 * shows each workspace they are a member of; to its admins, who is in it, whose CI sends it
 * records, and its CI tokens, each changeable.
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

export type Role = "admin" | "member";

export interface Member {
  readonly githubId: string;
  readonly login: string;
  readonly role: Role;
  /** Invited here, or in by the workspace's GitHub organisation (checked at each sign-in). */
  readonly via: "invite" | "org";
  readonly addedAt: string;
}

export interface GithubAccount {
  readonly id: string;
  readonly login: string;
}

/** A workspace as its admin manages it. CI tokens are names only: the hub keeps no token. */
export interface WorkspaceAdmin {
  readonly workspace: { readonly id: string; readonly name: string; readonly githubOrg: GithubAccount | null };
  /** The signed-in admin's GitHub id. */
  readonly you: string;
  readonly members: readonly Member[];
  readonly owners: readonly GithubAccount[];
  readonly tokens: readonly string[];
}

/** Where the page goes to sign in with GitHub: the hub's server, which sends it on to GitHub. */
export const GITHUB_SIGN_IN = "/auth/github";

const admin = (id: string, ...rest: string[]): string => [`/api/w/${encodeURIComponent(id)}/admin`, ...rest.map(encodeURIComponent)].join("/");

export const orgApi = {
  me: () => call<Me>("GET", "/api/me"),
  workspace: (id: string) => call<OrgView>("GET", `/api/w/${encodeURIComponent(id)}/org`),
  admin: (id: string) => call<WorkspaceAdmin>("GET", admin(id)),
  invite: (id: string, account: string, role: Role) => call<{ member: Member }>("POST", admin(id, "members"), { account, role }),
  setRole: (id: string, githubId: string, role: Role) => call<{ member: Member }>("PATCH", admin(id, "members", githubId), { role }),
  removeMember: (id: string, githubId: string) => call<{ removed: string; returns?: string }>("DELETE", admin(id, "members", githubId)),
  addOwner: (id: string, account: string) => call<{ owner: GithubAccount }>("POST", admin(id, "owners"), { account }),
  removeOwner: (id: string, ownerId: string) => call<{ removed: string }>("DELETE", admin(id, "owners", ownerId)),
  addToken: (id: string, name: string) => call<{ name: string; token: string }>("POST", admin(id, "tokens"), { name }),
  removeToken: (id: string, name: string) => call<{ removed: string }>("DELETE", admin(id, "tokens", name)),
  view: (path: string) => call<OrgView>("GET", path),
  signIn: (key: string) => call<{ ok: true }>("POST", "/api/session", { key }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/session"),
};
