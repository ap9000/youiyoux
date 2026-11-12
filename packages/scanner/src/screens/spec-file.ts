/**
 * Every write to `screens.json` goes through here: under one lock (a lock file beside it, held
 * across processes, a dead or abandoned holder's broken), the file is read again and only the
 * fields the writer owns are changed, then it is replaced atomically. So a writer never puts back
 * an old snapshot of what another one changed meanwhile (capture can't bring back consent the
 * person just switched off).
 */
import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import { checkScreensSpec, type ScreensSpec } from "./capture.ts";

/** A lock held longer than this is abandoned, whoever holds it. */
export const SCREENS_LOCK_STALE_MS = 30_000;
const WAIT_MS = 10_000;
const POLL_MS = 25;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: it exists, and is someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Run `fn` holding `dir`'s screens.json lock; waits for another holder, breaks a dead or abandoned one. */
export async function withScreensLock<T>(dir: string, fn: () => Promise<T>, options: { readonly waitMs?: number; readonly staleMs?: number } = {}): Promise<T> {
  const lock = join(dir, "screens.json.lock");
  const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString("hex")}`;
  const until = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(token);
      await handle.close();
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await readFile(lock, "utf8").catch(() => null);
    if (held !== null) {
      const [pid, at] = held.split(" ").map(Number);
      const stale = !Number.isInteger(pid) || !Number.isFinite(at) || !alive(pid!) || Date.now() - at! > (options.staleMs ?? SCREENS_LOCK_STALE_MS);
      if (stale) {
        // Moved aside, then checked: only the lock that was judged stale is ever removed.
        const aside = `${lock}.${randomBytes(6).toString("hex")}.stale`;
        if (await rename(lock, aside).then(() => true, () => false)) {
          const moved = await readFile(aside, "utf8").catch(() => null);
          if (moved !== held) await rename(aside, lock).catch(() => undefined);
          else await unlink(aside).catch(() => undefined);
        }
        continue;
      }
    }
    if (Date.now() > until) throw new Error(`${join(dir, "screens.json")} is being changed by another youiyoux (pid ${held?.split(" ")[0] ?? "?"}); try again`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    // Only our own lock is removed: one broken as abandoned and taken by another is theirs.
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
