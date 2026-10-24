/** Atomic writes: a new temporary file beside the target, renamed into place, with its permissions from the start when asked. */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeFileAtomic } from "../src/index.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-files-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("with a mode, the file has it as written: renamed from a temporary file made with it, never narrowed after", async () => {
    const secret = join(dir, "secret.json");
    await writeFileAtomic(secret, "{}\n", { mode: 0o600 });
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    // Rewriting keeps it so, and leaves no temporary file behind.
    await writeFileAtomic(secret, '{"a":1}\n', { mode: 0o600 });
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    expect(await readFile(secret, "utf8")).toBe('{"a":1}\n');
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("without one, the usual permissions", async () => {
    const plain = join(dir, "plain.txt");
    await writeFileAtomic(plain, "x");
    expect((await stat(plain)).mode & 0o777).toBe(0o666 & ~process.umask());
  });
});
