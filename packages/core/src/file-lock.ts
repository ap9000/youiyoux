/**
 * A lock file held across processes: what screens.json's writers take turns under (slice 1), and
 * what a change request's writers and a route's behaviour run take now. One design, here.
 *
 * Why it excludes (the argument the tests check):
 * - Taking it: the holder's token ({pid, host, id}) is written to a temp file first, then hard-linked
 *   to the lock. link() fails if the lock exists, so the lock never exists without its owner in it
 *   (no empty lock to misjudge), and only one taker succeeds while it exists.
 * - A lock is removed only (1) by its owner, after reading its own token there, or (2) when its
 *   holder's pid is dead on this host, by the one contender that wins an exclusive marker
 *   (`<lock>.breaking.<id>`, created with O_EXCL) for that holder's token, and only after reading that
 *   exact token at the lock again. While the dead holder's lock exists nobody can take a new one, and
 *   the only remover of that token is the marker's winner, so it can never remove a newer, live
 *   holder's lock: a stale reader that wins a later marker reads the new token and leaves it. Nothing
 *   is ever renamed over or restored onto the lock.
 * - A live holder's lock is never broken, however long it is held (no age expiry); a pid on another
 *   host, a lock that can't be read as a token, or one that can't be read at all (no permission, a
 *   folder in its place), counts as live; only a lock that has gone (ENOENT) is retried at once. A
 *   waiting taker gives up after `waitMs` with FileLockBusy, which names the holder (`waitMs: 0`:
 *   one try, no waiting).
 * - Accepted: if a contender dies between winning a marker and removing the dead lock, that lock
 *   stays and takers time out naming both files to remove by hand. Exclusion is kept over progress.
 */
import { randomBytes } from "node:crypto";
import { link, open, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

const POLL_MS = 10;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: it exists, and is someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly id: string;
}

/** A lock's token, or null when it can't be read as one (then it is never broken). */
function holderOf(text: string): LockHolder | null {
  try {
    const value = JSON.parse(text) as Partial<LockHolder>;
    return Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.host === "string" && typeof value.id === "string" && /^[0-9a-f]{16,64}$/.test(value.id) ? (value as LockHolder) : null;
  } catch {
    return null;
  }
}

/** The lock is held by someone else, still: who, in words. */
export class FileLockBusy extends Error {
  override name = "FileLockBusy";
  readonly lock: string;
  readonly holder: LockHolder | null;
  /** "pid 123, still running", "pid 123, which has exited", or "a lock youiyoux can't read". */
  readonly who: string;
  /** `unreadable`: why the lock couldn't be read at all (EACCES, a folder in its place). */
  constructor(lock: string, holder: LockHolder | null, unreadable: string | null = null) {
    const who = holder ? `pid ${holder.pid}${holder.host === hostname() ? "" : ` on ${holder.host}`}, ${holder.host === hostname() && !alive(holder.pid) ? "which has exited" : "still running"}` : unreadable ? `a lock youiyoux can't read (${unreadable})` : "a lock youiyoux can't read";
    super(`${lock} is held by ${who}`);
    this.lock = lock;
    this.holder = holder;
    this.who = who;
  }
}

export interface HeldLock {
  /** Whether the lock is still ours (its file holds our token). */
  holds(): Promise<boolean>;
  /** Let go of it: removes the lock only while it is still ours. */
  release(): Promise<void>;
}

/** The lock's text; null only when it has gone (ENOENT); any other failure is thrown. */
async function readLock(lock: string): Promise<string | null> {
  try {
    return await readFile(lock, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Take `lock` (a file path): waits up to `waitMs` for a live holder, breaks only a dead one. */
export async function acquireFileLock(lock: string, options: { readonly waitMs: number }): Promise<HeldLock> {
  const id = randomBytes(16).toString("hex");
  const token = JSON.stringify({ pid: process.pid, host: hostname(), id });
  const temp = `${lock}.${id}.new`;
  const until = Date.now() + options.waitMs;
  await writeFile(temp, token, { flag: "wx" });
  try {
    for (;;) {
      try {
        await link(temp, lock);
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let held: string | null;
      try {
        held = await readLock(lock);
      } catch (error: unknown) {
        // There, but unreadable (no permission, a folder in its place): a live holder youiyoux can't
        // read, never retried at once and never broken. Waits like any live holder, then refuses.
        if (Date.now() >= until) throw new FileLockBusy(lock, null, (error as NodeJS.ErrnoException).code ?? String(error));
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      // Gone since: try again at once.
      if (held === null) continue;
      const holder = holderOf(held);
      if (holder && holder.host === hostname() && !alive(holder.pid)) {
        // Dead on this host: one contender, the marker's winner, removes exactly that token.
        const marker = `${lock}.breaking.${holder.id}`;
        const won = await open(marker, "wx").then(
          async (handle) => {
            await handle.close();
            return true;
          },
          () => false,
        );
        if (won) {
          try {
            if ((await readFile(lock, "utf8").catch(() => null)) === held) await unlink(lock).catch(() => undefined);
          } finally {
            await unlink(marker).catch(() => undefined);
          }
          continue;
        }
      }
      if (Date.now() >= until) throw new FileLockBusy(lock, holder);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return {
    holds: async () => (await readFile(lock, "utf8").catch(() => null)) === token,
    // Only our own lock is removed (nobody else removes a live holder's).
    release: async () => {
      if ((await readFile(lock, "utf8").catch(() => null)) === token) await unlink(lock).catch(() => undefined);
    },
  };
}

/** Run `fn` holding `lock`. */
export async function withFileLock<T>(lock: string, fn: () => Promise<T>, options: { readonly waitMs: number }): Promise<T> {
  const held = await acquireFileLock(lock, options);
  try {
    return await fn();
  } finally {
    await held.release();
  }
}
