/**
 * A lock that is there but can't be read (a folder in its place, no permission) counts as a live
 * holder: never retried at once, so a no-wait take refuses at once and a waiting one at its
 * deadline, naming the file and why; neither spins (review round 2).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { acquireFileLock, FileLockBusy } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "youi-file-lock-"));
afterAll(() => {
  try {
    chmodSync(join(dir, "denied.lock"), 0o644);
  } catch {
    /* not made */
  }
  rmSync(dir, { recursive: true, force: true });
});

async function refusal(lock: string, waitMs: number): Promise<{ error: unknown; ms: number }> {
  const started = Date.now();
  const error = await acquireFileLock(lock, { waitMs }).then(
    async (held) => {
      await held.release();
      return null;
    },
    (e: unknown) => e,
  );
  return { error, ms: Date.now() - started };
}

describe("an unreadable lock", () => {
  test("a folder in its place: a no-wait take refuses at once, a waiting one at its deadline", async () => {
    const lock = join(dir, "folder.lock");
    mkdirSync(lock);
    const now = await refusal(lock, 0);
    expect(now.error).toBeInstanceOf(FileLockBusy);
    expect((now.error as FileLockBusy).message).toBe(`${lock} is held by a lock youiyoux can't read (EISDIR)`);
    expect(now.ms).toBeLessThan(500);
    const waited = await refusal(lock, 300);
    expect(waited.error).toBeInstanceOf(FileLockBusy);
    expect(waited.ms).toBeGreaterThanOrEqual(300);
    expect(waited.ms).toBeLessThan(2_000);
  }, 10_000);

  test.skipIf(process.getuid?.() === 0)("a lock with no permission to read it: the same", async () => {
    const lock = join(dir, "denied.lock");
    writeFileSync(lock, "{}");
    chmodSync(lock, 0o000);
    const now = await refusal(lock, 0);
    expect((now.error as FileLockBusy).who).toBe("a lock youiyoux can't read (EACCES)");
    expect(now.ms).toBeLessThan(500);
    const waited = await refusal(lock, 300);
    expect(waited.error).toBeInstanceOf(FileLockBusy);
    expect(waited.ms).toBeGreaterThanOrEqual(300);
  }, 10_000);

  test("a lock that has gone is taken at once", async () => {
    const held = await acquireFileLock(join(dir, "free.lock"), { waitMs: 0 });
    expect(await held.holds()).toBe(true);
    await held.release();
    expect(await held.holds()).toBe(false);
  });
});
