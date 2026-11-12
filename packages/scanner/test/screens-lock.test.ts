/**
 * screens.json's lock, across real processes: writers that race, holders that died, a lock caught
 * the moment it is created. Every writer logs the start and end of its critical section; no two may
 * overlap, and no update may be lost.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { link, open, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { withScreensLock } from "../src/index.ts";

const SPEC_FILE = join(import.meta.dirname, "../src/screens/spec-file.ts");
const scratch = mkdtempSync(join(tmpdir(), "youi-lock-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A pid that was a process here and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

const screens = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "s", capturedAt: "", viewport: { width: 800, height: 600 }, screens: [{ route: "/", path: "/" }], behaviour: { generation: 0 } }));
};

/** Take the lock the way a holder does (a token, linked into place); null if it is held. */
async function plant(lock: string, token: string): Promise<boolean> {
  const temp = `${lock}.planted.${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, token);
  try {
    await link(temp, lock);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

describe("the screens.json lock", () => {
  test("racing writer processes, dead holders and a lock caught empty as it is created: no overlap, no lost update", async () => {
    const dir = join(scratch, "race");
    screens(dir);
    const log = join(scratch, "race.log");
    writeFileSync(log, "");
    const child = join(scratch, "writer.mts");
    // Each writer: under the lock, log start, read, wait a little, write (atomically), log end.
    writeFileSync(
      child,
      `import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withScreensLock } from ${JSON.stringify(SPEC_FILE)};
const [dir, log, count] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < Number(count); i++) {
  await withScreensLock(dir, async () => {
    appendFileSync(log, "start " + process.pid + "\\n");
    const file = join(dir, "screens.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    sleep(1);
    doc.behaviour = { generation: doc.behaviour.generation + 1 };
    writeFileSync(file + "." + process.pid + ".tmp", JSON.stringify(doc));
    renameSync(file + "." + process.pid + ".tmp", file);
    appendFileSync(log, "end " + process.pid + "\\n");
  }, { waitMs: 60000 });
  // A gap between updates, so others (and the test's meddling) get the lock now and then.
  sleep(Math.random() * 6);
}
`,
    );
    const WRITERS = 8;
    const EACH = 15;
    const exits = Array.from({ length: WRITERS }, () =>
      new Promise<number>((resolve) => {
        const p = spawn(process.execPath, [child, dir, log, String(EACH)], { stdio: ["ignore", "ignore", "inherit"] });
        p.on("close", (code) => resolve(code ?? 1));
      }),
    );
    // Meanwhile: holders that died with the lock, and a lock that exists, empty, for a moment as it is made.
    const lock = join(dir, "screens.json.lock");
    let dead = 0;
    let empty = 0;
    let finished = false;
    const meddle = (async () => {
      // Once the writers are writing, until each kind of meddling has happened a few times.
      while (!readFileSync(log, "utf8").includes("start") && !finished) await new Promise((resolve) => setTimeout(resolve, 5));
      for (let round = 0; !finished && (dead < 4 || empty < 4); round++) {
        await new Promise((resolve) => setTimeout(resolve, 3));
        if (round % 2 === 0) {
          if (await plant(lock, JSON.stringify({ pid: deadPid(), host: hostname(), id: Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16) }))) dead++;
        } else {
          const handle = await open(lock, "wx").catch(() => null);
          if (!handle) continue;
          // Held, empty, by this test: its critical section counts like any writer's.
          appendFileSync(log, "start meddler\n");
          await new Promise((resolve) => setTimeout(resolve, 20));
          appendFileSync(log, "end meddler\n");
          await handle.close();
          await unlink(lock);
          empty++;
        }
      }
    })();
    const codes = await Promise.all(exits);
    finished = true;
    await meddle;
    expect(codes).toEqual(Array.from({ length: WRITERS }, () => 0));
    expect(dead).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(0);
    // No two critical sections overlap.
    let inside: string | null = null;
    for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      const [what, who] = line.split(" ");
      if (what === "start") {
        expect(inside, `${who} started while ${inside} was inside`).toBeNull();
        inside = who!;
      } else {
        expect(inside).toBe(who);
        inside = null;
      }
    }
    // Every update landed.
    expect(JSON.parse(readFileSync(join(dir, "screens.json"), "utf8")).behaviour.generation).toBe(WRITERS * EACH);
    // A dead holder planted after the last writer finished is broken by the next writer; then nothing is left behind.
    await withScreensLock(dir, async () => undefined, { waitMs: 2_000 });
    expect(readdirSync(dir).filter((f) => f.startsWith("screens.json."))).toEqual([]);
  }, 120_000);

  test("a live holder's lock is never broken, however long it is held: the writer gives up and says who holds it", async () => {
    const dir = join(scratch, "live");
    screens(dir);
    const lock = join(dir, "screens.json.lock");
    // This process holds it, and has for an hour.
    expect(await plant(lock, JSON.stringify({ pid: process.pid, host: hostname(), id: "ab".repeat(8), since: Date.now() - 3_600_000 }))).toBe(true);
    let ran = false;
    await expect(withScreensLock(dir, async () => void (ran = true), { waitMs: 300 })).rejects.toThrow(new RegExp(`locked by pid ${process.pid}, still running; nothing was written`));
    expect(ran).toBe(false);
    expect(existsSync(lock)).toBe(true);
    // An unreadable lock (empty, or not a token) is never broken either.
    writeFileSync(lock, "");
    await expect(withScreensLock(dir, async () => void (ran = true), { waitMs: 200 })).rejects.toThrow(/a lock youiyoux can't read/);
    expect(ran).toBe(false);
    rmSync(lock);
    // A dead holder's is broken, and the writer goes on.
    expect(await plant(lock, JSON.stringify({ pid: deadPid(), host: hostname(), id: "cd".repeat(8) }))).toBe(true);
    await withScreensLock(dir, async () => void (ran = true), { waitMs: 2_000 });
    expect(ran).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith("screens.json."))).toEqual([]);
  });
});
