/**
 * Every write to `screens.json` goes through here: under one lock (a lock file beside it, held
 * across processes), the file is read again and only the fields the writer owns are changed, then
 * it is replaced atomically. So a writer never puts back an old snapshot of what another one changed
 * meanwhile (capture can't bring back consent the person just switched off).
 *
 * The lock is core's acquireFileLock (file-lock.ts: link-created owner token, a live holder never
 * broken, a dead one by one marker's winner); its argument and accepted residual are written there.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FileLockBusy, withFileLock, writeFileAtomic } from "@youiyoux/core";
import { checkScreensSpec, type ScreensSpec } from "./capture.ts";

const WAIT_MS = 10_000;

/** Run `fn` holding `dir`'s screens.json lock: waits for a live holder, breaks only a dead one. */
export async function withScreensLock<T>(dir: string, fn: () => Promise<T>, options: { readonly waitMs?: number } = {}): Promise<T> {
  const lock = join(dir, "screens.json.lock");
  try {
    return await withFileLock(lock, fn, { waitMs: options.waitMs ?? WAIT_MS });
  } catch (error: unknown) {
    if (error instanceof FileLockBusy) throw new Error(`${join(dir, "screens.json")} is locked by ${error.who}; nothing was written. Try again; if no youiyoux is running, delete ${lock} (and any ${lock}.breaking.* beside it)`);
    throw error;
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
