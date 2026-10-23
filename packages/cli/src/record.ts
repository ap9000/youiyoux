/**
 * `youiyoux record`: what CI tells the team's hosted hub about this repository (youi.record/v1):
 * every product's status, as `youiyoux status` reads it, each string through the shareable
 * report's Redactor (repo-relative paths, no home, username, env or .env values, no credentials
 * in URLs) and refused if anything sensitive survives. No source code is in a status.
 *
 * With --send it is posted to the hub (YOUIYOUX_HUB_URL, or --hub). In GitHub Actions with
 * `id-token: write`, it carries GitHub's OIDC token for the hub's address, which proves the
 * repository, commit and branch (github-oidc.ts); otherwise YOUIYOUX_HUB_TOKEN, read from the
 * environment only, so it never sits in a command line or a log.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CiRecord, RepoName } from "@youiyoux/core";
import { githubSlug } from "./hooks-install.ts";
import { GITHUB_TOKEN_HEADER } from "./org-hub.ts";
import { Redactor } from "./report/safe.ts";
import { workspaceStatus } from "./status.ts";
import { TOOL_ROOT } from "./tool.ts";
import { plural, style } from "./ui.ts";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string | null> => run("git", args, { cwd }).then((r) => r.stdout.trim() || null, () => null);

export const HUB_URL_ENV = "YOUIYOUX_HUB_URL";
export const HUB_TOKEN_ENV = "YOUIYOUX_HUB_TOKEN";

/** This tool's version: the youiyoux package's, from a checkout or from the package itself. */
export function toolVersion(root = TOOL_ROOT): string | null {
  for (const file of [join(root, "packages/youiyoux/package.json"), join(root, "../package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "youiyoux" && pkg.version) return pkg.version;
    } catch {
      /* not this layout */
    }
  }
  return null;
}

export interface RecordOptions {
  /** owner/name; else GITHUB_REPOSITORY, else the origin remote's. */
  readonly repo?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** The record for the git checkout `cwd` is in: its products, as status finds them from its top. */
export async function buildRecord(cwd: string, options: RecordOptions = {}): Promise<CiRecord> {
  const env = options.env ?? process.env;
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error("youiyoux record runs in a git checkout: the record names its repository and commit");
  const repo = options.repo ?? env.GITHUB_REPOSITORY ?? githubSlug((await git(top, ["remote", "get-url", "origin"])) ?? "");
  if (!repo || !RepoName.safeParse(repo).success) throw new Error(`${repo ? `"${repo}" is not` : "no repository name found: pass"} --repo owner/name${repo ? "" : " (or run where GITHUB_REPOSITORY is set, or with a GitHub origin remote)"}`);
  const commit = env.GITHUB_SHA ?? (await git(top, ["rev-parse", "HEAD"]));
  const branch = env.GITHUB_REF_NAME ?? (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const report = await workspaceStatus(top);
  if (report.projects.length === 0) throw new Error("no product here: no youi.project.json at the top of this repository, no youi.workspace.json, and none below it");
  // The repository's own name, commit and branch are what the record is about, and CI holds them in its environment: only the products are redacted.
  const redactor = await Redactor.forRepo(top, { env });
  const products = JSON.parse(redactor.scrub(JSON.stringify(redactor.model(report.projects)))) as CiRecord["products"];
  return CiRecord.parse({ schema: "youi.record/v1", repo, commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, ref: branch && branch !== "HEAD" ? branch : null, generatedAt: new Date().toISOString(), tool: toolVersion() ?? "unknown", products });
}

/** Where a record goes: https, or http to this machine only (the token must never cross a network in the clear). */
export function recordsUrl(hub: string): URL {
  let url: URL;
  try {
    url = new URL(hub);
  } catch {
    throw new Error(`${HUB_URL_ENV} "${hub}" is not a URL: expected the hub's address, such as https://design-hub.acme.dev`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`the hub must be https (${url.protocol}//${url.host} would send the token in the clear); http is only for this machine`);
  if (url.username || url.password) throw new Error(`${HUB_URL_ENV} carries a user name or password: the token goes in ${HUB_TOKEN_ENV}`);
  return new URL(`${url.pathname.replace(/\/+$/, "")}/api/records`, url.origin);
}

/** How the record proves who sent it: the hub's ingest token, GitHub's OIDC token, or both (the hub uses the one its mode needs). */
export interface Credentials {
  readonly token?: string | null;
  readonly github?: string | null;
}

export async function sendRecord(record: CiRecord, hub: string, credentials: Credentials, fetcher: typeof fetch = fetch): Promise<string> {
  const url = recordsUrl(hub);
  const headers: Record<string, string> = { "content-type": "application/json", ...(credentials.token ? { authorization: `Bearer ${credentials.token}` } : {}), ...(credentials.github ? { [GITHUB_TOKEN_HEADER]: credentials.github } : {}) };
  const response = await fetcher(url, { method: "POST", headers, body: JSON.stringify(record), redirect: "error", signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
    throw new Error(`could not reach the hub at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (response.ok) return url.origin;
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  const why = typeof body.error === "string" ? body.error : response.statusText;
  throw new Error(`the hub at ${url.origin} refused the record (${response.status}): ${why}`);
}

export function renderRecord(record: CiRecord, sentTo: string | null): string {
  const failed = record.products.filter((p) => "error" in p).length;
  const head = `${style.ok(sentTo ? "sent" : "recorded")} ${record.repo}${record.commit ? style.dim(` at ${record.commit.slice(0, 7)}`) : ""}${record.ref ? style.dim(` on ${record.ref}`) : ""}: ${plural(record.products.length, "product")}${failed > 0 ? style.warn(` (${failed} could not be read)`) : ""}${sentTo ? ` to ${sentTo}` : ""}`;
  return [head, style.dim("  redacted as the shareable report is: repo-relative paths, no home, username, env values or credentials; no code")].join("\n");
}
