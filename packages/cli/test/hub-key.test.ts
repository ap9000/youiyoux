/** The hub's editing key, kept per product so its link survives a restart, and `youiyoux ui --open`. */
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KEY_FILE, keptKey, openWhenUp, opener } from "../src/hub-key.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-hub-key-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the kept key", () => {
  test("is made once, readable only by you, and the same on every start after", async () => {
    const state = join(dir, "state");
    const first = await keptKey(state);
    expect(first).toEqual({ key: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/), how: "made" });
    expect((await stat(join(state, KEY_FILE))).mode & 0o777).toBe(0o600);
    expect(await keptKey(state)).toEqual({ key: first.key, how: "kept" });
  });

  test("one others could read, a link, or not a key is replaced, saying why; --new-key replaces it on purpose", async () => {
    const file = join(dir, KEY_FILE);
    const { key } = await keptKey(dir);
    await chmod(file, 0o644);
    const open = await keptKey(dir);
    expect([open.how, open.why, open.key === key]).toEqual(["replaced", `${KEY_FILE} could be read by others`, false]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, "not a key\n", { mode: 0o600 });
    expect(await keptKey(dir)).toMatchObject({ how: "replaced", why: `${KEY_FILE} did not hold a key` });
    await rm(file);
    const elsewhere = join(dir, "elsewhere.key");
    await writeFile(elsewhere, "x".repeat(32), { mode: 0o600 });
    await symlink(elsewhere, file);
    expect(await keptKey(dir)).toMatchObject({ how: "replaced", why: `${KEY_FILE} was not a file of its own` });
    // The link's target is left as it was: the new key is written in its place.
    expect(await readFile(elsewhere, "utf8")).toBe("x".repeat(32));
    const now = (await keptKey(dir)).key;
    const fresh = await keptKey(dir, { fresh: true });
    expect([fresh.how, fresh.why, fresh.key === now]).toEqual(["replaced", "--new-key asked for a new one", false]);
  });
});

describe("--open", () => {
  test("opens the signed-in link once the hub answers, and not before", async () => {
    let up = false;
    const server = createServer((_req, res) => res.writeHead(up ? 200 : 503).end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const probe = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      const open = vi.fn();
      setTimeout(() => (up = true), 700);
      expect(await openWhenUp(`${probe}#key=k`, probe, { open })).toBe(true);
      expect(open).toHaveBeenCalledExactlyOnceWith(`${probe}#key=k`);
    } finally {
      server.close();
    }
    const never = vi.fn();
    expect(await openWhenUp("http://127.0.0.1:9/#key=k", "http://127.0.0.1:9/", { open: never, wait: 600 })).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  test("with each platform's own opener", () => {
    expect(opener("http://localhost:5173/#key=k", "darwin")).toEqual({ command: "open", args: ["http://localhost:5173/#key=k"] });
    expect(opener("http://localhost:5173/#key=k", "linux")).toEqual({ command: "xdg-open", args: ["http://localhost:5173/#key=k"] });
    expect(opener("http://localhost:5173/#key=k", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "http://localhost:5173/#key=k"] });
  });
});
