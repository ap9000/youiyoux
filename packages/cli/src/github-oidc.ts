/**
 * GitHub Actions' OIDC token, which says which repository, commit and branch a workflow runs for,
 * signed by GitHub. `youiyoux record --send` asks for one (the workflow needs `permissions:
 * id-token: write`) with the hub's address as its audience, and the hosted hub takes a record only
 * when the token is GitHub's, for this hub, unexpired, from an owner it accepts, and for the
 * repository, commit and branch the record names. No shared secret is involved, so one
 * repository's CI cannot send another's record.
 */
import { createPublicKey, verify } from "node:crypto";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
/** Clock difference allowed between GitHub and the hub. */
const LEEWAY_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_RETRY_MS = 60 * 1000;

export interface GithubClaims {
  readonly repository: string;
  readonly repository_owner: string;
  readonly sha: string;
  readonly ref: string;
  /** The event the run is for (`push`, `workflow_dispatch`, `pull_request`…). */
  readonly event_name?: string;
}

/** One of GitHub's public keys, as its JWKS lists them. */
export interface JsonWebKey {
  readonly kty?: string;
  readonly kid?: string;
  readonly n?: string;
  readonly e?: string;
  readonly [field: string]: unknown;
}
export type Jwks = { readonly keys: readonly JsonWebKey[] };

/** The hub's address as an audience: the same text on both sides, with no trailing slash. */
export const audienceOf = (hub: string): string => hub.trim().replace(/\/+$/, "");

/** In a GitHub Actions job allowed `id-token: write`: a token for this audience; null elsewhere. */
export async function requestGithubToken(audience: string, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<string | null> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) return null;
  const request = new URL(url);
  request.searchParams.set("audience", audience);
  const response = await fetcher(request, { headers: { authorization: `bearer ${bearer}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub Actions did not give an OIDC token (${response.status}): does the workflow have permissions: id-token: write?`);
  const { value } = (await response.json()) as { value?: unknown };
  if (typeof value !== "string") throw new Error("GitHub Actions answered without an OIDC token");
  return value;
}

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** The branches a record is taken from when the hub names none: a feature branch must not replace a repository's latest. */
export const DEFAULT_BRANCHES = ["main", "master"] as const;

export interface GithubVerifierOptions {
  /**
   * The owners (organisations or users) whose repositories may send records: GitHub's numeric
   * account id (`gh api orgs/acme --jq .id`), which never passes to another owner, or a name,
   * which a renamed owner gives up for anyone to take.
   */
  readonly owners: readonly string[];
  /** The branches records are taken from (default main and master). */
  readonly branches?: readonly string[];
  /** The audience CI asked for: the hub's address, as YOUIYOUX_HUB_URL names it. */
  readonly audience: string;
  /** GitHub's signing keys (default: fetched from GitHub, kept an hour). */
  readonly jwks?: () => Promise<Jwks>;
  readonly issuer?: string;
  readonly now?: () => Date;
}

/** Checks a token and returns its claims, or throws saying why it is refused. */
export type GithubVerifier = (token: string) => Promise<GithubClaims>;

export function githubVerifier(options: GithubVerifierOptions): GithubVerifier {
  const owners = new Set(options.owners.map((o) => o.trim().toLowerCase()));
  const branches = new Set(options.branches && options.branches.length > 0 ? options.branches : DEFAULT_BRANCHES);
  const issuer = options.issuer ?? GITHUB_ISSUER;
  const audience = audienceOf(options.audience);
  const now = options.now ?? (() => new Date());
  let cached: { keys: Jwks; at: number } | null = null;
  let lastFetch = 0;
  const fetchKeys = options.jwks ?? (async () => (await (await fetch(JWKS_URL, { signal: AbortSignal.timeout(15_000) })).json()) as Jwks);
  const keyFor = async (kid: string | undefined): Promise<JsonWebKey | null> => {
    const find = (jwks: Jwks): JsonWebKey | null => jwks.keys.find((k) => k.kid === kid && k.kty === "RSA") ?? null;
    const fresh = cached && Date.now() - cached.at < JWKS_TTL_MS ? find(cached.keys) : null;
    if (fresh) return fresh;
    // GitHub rotates its keys: an unknown kid fetches them again, at most once a minute.
    if (cached && Date.now() - lastFetch < JWKS_RETRY_MS) return find(cached.keys);
    lastFetch = Date.now();
    cached = { keys: await fetchKeys(), at: Date.now() };
    return find(cached.keys);
  };
  return async (token) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("not a JSON Web Token");
    const [head, body, signature] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = decode(head) as typeof header;
      claims = decode(body) as typeof claims;
    } catch {
      throw new Error("not a JSON Web Token");
    }
    // Only GitHub's algorithm: never `none`, never a key the token names for itself.
    if (header.alg !== "RS256") throw new Error(`signed with ${String(header.alg)}, not GitHub's RS256`);
    const jwk = await keyFor(typeof header.kid === "string" ? header.kid : undefined);
    if (!jwk) throw new Error("not signed by a key GitHub publishes");
    if (!verify("RSA-SHA256", Buffer.from(`${head}.${body}`), createPublicKey({ key: { kty: "RSA", n: String(jwk.n), e: String(jwk.e) }, format: "jwk" }), Buffer.from(signature, "base64url"))) throw new Error("its signature is not GitHub's");
    if (claims.iss !== issuer) throw new Error(`issued by ${String(claims.iss)}, not GitHub Actions`);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((a) => typeof a === "string" && audienceOf(a) === audience)) throw new Error(`issued for ${audiences.map(String).join(", ")}, not this hub (${audience})`);
    const seconds = now().getTime() / 1000;
    if (typeof claims.exp !== "number" || claims.exp < seconds - LEEWAY_SECONDS) throw new Error("expired");
    if (typeof claims.nbf === "number" && claims.nbf > seconds + LEEWAY_SECONDS) throw new Error("not valid yet");
    const { repository, repository_owner: owner, repository_owner_id: ownerId, sha, ref, event_name: event } = claims;
    if (typeof repository !== "string" || typeof owner !== "string" || typeof sha !== "string" || typeof ref !== "string") throw new Error("missing its repository, owner, commit or ref");
    // An owner listed by id matches only that account; one listed by name, whoever holds the name now.
    if (!(typeof ownerId === "string" && owners.has(ownerId)) && !owners.has(owner.toLowerCase())) throw new Error(`from ${owner}${typeof ownerId === "string" ? ` (id ${ownerId})` : ""}, which this hub does not take records from`);
    if (!ref.startsWith("refs/heads/") || !branches.has(ref.slice("refs/heads/".length))) throw new Error(`from ${ref}: this hub takes records from ${[...branches].join(" and ")} only (YOUIYOUX_HUB_BRANCHES)`);
    return { repository, repository_owner: owner, sha, ref, ...(typeof event === "string" ? { event_name: event } : {}) };
  };
}

/** Why a record does not match the token it came with, or null: the repository, commit and branch must be the token's. */
export function recordMismatch(claims: GithubClaims, record: { readonly repo: string; readonly commit: string | null; readonly ref: string | null }): string | null {
  if (claims.repository.toLowerCase() !== record.repo.toLowerCase()) return `the record names ${record.repo}, but it was sent from ${claims.repository}`;
  if (record.commit !== claims.sha) return `the record names commit ${record.commit ?? "none"}, but it was sent from ${claims.sha}`;
  // A branch only, compared exactly: a tag or a pull request named like a branch never stands for it.
  if (!claims.ref.startsWith("refs/heads/")) return `it was sent from ${claims.ref}, not a branch`;
  if (claims.event_name !== undefined && claims.event_name.startsWith("pull_request")) return `it was sent from a ${claims.event_name} run, not a push to the branch`;
  const branch = claims.ref.slice("refs/heads/".length);
  if (record.ref !== branch) return `the record names ${record.ref ?? "no branch"}, but it was sent from ${branch}`;
  return null;
}
