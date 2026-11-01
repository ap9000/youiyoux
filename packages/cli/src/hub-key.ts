/**
 * The hub's editing key, kept per product, and opening the hub with it.
 *
 * Every change the hub makes needs the key, which travels only in the link's fragment. A key made
 * fresh on each start meant a new link after every restart; so it is kept in the product's
 * workflow state folder (`session.key`), readable only by you, and the link you opened keeps
 * working. A key file anyone else could read, a link, or anything that isn't a key is replaced
 * with a new key, and says so; `youiyoux ui --new-key` replaces it on purpose, which cuts off
 * every tab that had the old one.
 *
 * `youiyoux ui --open` opens it in the default browser, signed in, only when the port was free before
 * the hub started and the page there proves it reaches this hub's own service (a random challenge
 * signed with the key): a server that took the port is never handed the key.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import { READY_PATH, readyProof } from "@youiyoux/workflow";

export const KEY_FILE = "session.key";
const KEY = /^[A-Za-z0-9_-]{32}$/;
/** How long --open waits for the hub to answer. */
export const OPEN_WAIT_MS = 120_000;

export interface KeptKey {
  readonly key: string;
  /** made: there was none; kept: the one from before; replaced: the old one was unsafe or asked to go, with why. */
  readonly how: "made" | "kept" | "replaced";
  readonly why?: string;
}

/** This product's key: the kept one when it is safe to use, else a new one, written readable only by you. */
export async function keptKey(stateDir: string, options: { readonly fresh?: boolean } = {}): Promise<KeptKey> {
  const file = join(stateDir, KEY_FILE);
  const stat = await lstat(file).catch(() => null);
  let why: string | null = null;
  if (stat && options.fresh) why = "--new-key asked for a new one";
  else if (stat && !stat.isFile()) why = `${KEY_FILE} was not a file of its own`;
  else if (stat && (stat.mode & 0o077) !== 0) why = `${KEY_FILE} could be read by others`;
  else if (stat && typeof process.getuid === "function" && stat.uid !== process.getuid()) why = `${KEY_FILE} belonged to someone else`;
  else if (stat) {
    const kept = (await readFile(file, "utf8")).trim();
    if (KEY.test(kept)) return { key: kept, how: "kept" };
    why = `${KEY_FILE} did not hold a key`;
  }
  const key = randomBytes(24).toString("base64url");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${key}\n`, { mode: 0o600 });
  return stat ? { key, how: "replaced", why: why! } : { key, how: "made" };
}

/** The command that opens an address in the default browser, on this platform. */
export function opener(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Whether nothing listens on this port, on either loopback address the hub's name reaches. */
export async function portFree(port: number): Promise<boolean> {
  const tryOn = (host: string): Promise<boolean> =>
    new Promise((done) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => done(error.code !== "EADDRINUSE"));
      server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
    });
  return (await tryOn("127.0.0.1")) && (await tryOn("::1"));
}

/** Whether the page at `base` reaches the service holding `key`: it signs a fresh challenge with it. */
export async function isOurs(base: string, key: string): Promise<boolean> {
  const challenge = randomBytes(16).toString("hex");
  const answer = await fetch(`${base}${READY_PATH}?c=${challenge}`, { signal: AbortSignal.timeout(2_000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ proof?: unknown }>) : null))
    .catch(() => null);
  return answer?.proof === readyProof(key, challenge);
}

/**
 * Open `url` once `ready` says the hub is up and is ours: asked every half second, for at most
 * `wait`. Resolves with whether it was opened; never throws, so the hub runs on either way.
 */
export async function openWhenUp(url: string, ready: () => Promise<boolean>, options: { readonly wait?: number; readonly open?: (url: string) => void } = {}): Promise<boolean> {
  const until = Date.now() + (options.wait ?? OPEN_WAIT_MS);
  while (Date.now() < until) {
    if (await ready().catch(() => false)) {
      const open =
        options.open ??
        ((address: string) => {
          const { command, args } = opener(address);
          spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
        });
      open(url);
      return true;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}
