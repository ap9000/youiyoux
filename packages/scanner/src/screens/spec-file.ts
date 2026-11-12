/**
 * Every write to `screens.json` goes through here: under one lock (a lock file beside it, held
 * across processes), the file is read again and only the fields the writer owns are changed, then
 * it is replaced atomically. So a writer never puts back an old snapshot of what another one changed
 * meanwhile (capture can't bring back consent the person just switched off).
 *
 * Why the lock excludes (the argument the tests check):
 * - Taking it: the holder's token ({pid, host, id}) is written to a temp file first, then hard-linked
 *   to `screens.json.lock`. link() fails if the lock exists, so the lock never exists without its
 *   owner in it (no empty lock to misjudge), and only one taker succeeds while it exists.
 * - A lock is removed only (1) by its owner, after reading its own token there, or (2) when its
 *   holder's pid is dead on this host, by the one contender that wins an exclusive marker
 *   (`screens.json.lock.breaking.<id>`, created with O_EXCL) for that holder's token, and only after
 *   reading that exact token at the lock again. While the dead holder's lock exists nobody can take
 *   a new one, and the only remover of that token is the marker's winner, so it can never remove a
 *   newer, live holder's lock: a stale reader that wins a later marker reads the new token and leaves
 *   it. Nothing is ever renamed over or restored onto the lock.
 * - A live holder's lock is never broken, however long it is held (no age expiry); a pid on another
 *   host, or a lock that can't be read as a token, counts as live. A waiting writer gives up after
 *   10 s with an error that names the holder and what to do.
 * - Accepted: if a contender dies between winning a marker and removing the dead lock, that lock
 *   stays and writers time out with an error naming both files to remove by hand. Exclusion is kept
 *   over progress.
 */
import { randomBytes } from "node:crypto";
import { link, open, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import { checkScreensSpec, type ScreensSpec } from "./capture.ts";

const WAIT_MS = 10_000;
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

interface Holder {
  readonly pid: number;
  readonly host: string;
  readonly id: string;
}

/** A lock's token, or null when it can't be read as one (then it is never broken). */
function holderOf(text: string): Holder | null {
  try {
    const value = JSON.parse(text) as Partial<Holder>;
    return Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.host === "string" && typeof value.id === "string" && /^[0-9a-f]{16,64}$/.test(value.id) ? (value as Holder) : null;
  } catch {
    return null;
  }
}

/** Run `fn` holding `dir`'s screens.json lock: waits for a live holder, breaks only a dead one. */
export async function withScreensLock<T>(dir: string, fn: () => Promise<T>, options: { readonly waitMs?: number } = {}): Promise<T> {
  const lock = join(dir, "screens.json.lock");
  const id = randomBytes(16).toString("hex");
  const token = JSON.stringify({ pid: process.pid, host: hostname(), id });
  const temp = `${lock}.${id}.new`;
  const until = Date.now() + (options.waitMs ?? WAIT_MS);
  await writeFile(temp, token, { flag: "wx" });
  try {
    for (;;) {
      try {
        await link(temp, lock);
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const held = await readFile(lock, "utf8").catch(() => null);
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
      if (Date.now() > until) {
        const who = holder ? `pid ${holder.pid}${holder.host === hostname() ? "" : ` on ${holder.host}`}, ${holder.host === hostname() && !alive(holder.pid) ? "which has exited" : "still running"}` : "a lock youiyoux can't read";
        throw new Error(`${join(dir, "screens.json")} is locked by ${who}; nothing was written. Try again; if no youiyoux is running, delete ${lock} (and any ${lock}.breaking.* beside it)`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  try {
    return await fn();
  } finally {
    // Only our own lock is removed (nobody else removes a live holder's).
    if ((await readFile(lock, "utf8").catch(() => null)) === token) await unlink(lock).catch(() => undefined);
  }
}

/**
 * Change `dir`'s screens.json under its lock: `change` gets the file as it is now (checked) and
 * returns the whole new document; the fields it doesn't touch stay exactly as the file has them.
 */
export async function updateScreensSpec(dir: string, change: (now: ScreensSpec & Record<string, unknown>) => Record<string, unknown>): Promise<ScreensSpec & Record<string, unknown>> {
  return withScreensLock(dir, async () => {
    const file = join(dir, "screens.json");
    let value: Partial<ScreensSpec>;
    try {
      value = JSON.parse(await readFile(file, "utf8")) as Partial<ScreensSpec>;
    } catch (error: unknown) {
      throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    const next = checkScreensSpec(change(checkScreensSpec(value, file) as ScreensSpec & Record<string, unknown>) as Partial<ScreensSpec>, file) as ScreensSpec & Record<string, unknown>;
    await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
