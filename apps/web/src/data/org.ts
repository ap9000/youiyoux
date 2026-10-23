/**
 * The hosted hub's API (`youiyoux hub serve`): the organisation view (youi.org/v1) once signed in
 * with the hub's view key, which the server keeps as an HttpOnly cookie this page never reads.
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

export const orgApi = {
  view: (path: string) => call<OrgView>("GET", path),
  signIn: (key: string) => call<{ ok: true }>("POST", "/api/session", { key }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/session"),
};
