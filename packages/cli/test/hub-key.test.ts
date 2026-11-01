/** The hub's editing key, kept per product so its link survives a restart, and `youiyoux ui --open`. */
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readyProof } from "@youiyoux/workflow";
import { isOurs, KEY_FILE, keptKey, openWhenUp, opener, portFree } from "../src/hub-key.ts";

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
  /** A hub answering ready with a proof signed by `key`, or nothing until `up`. */
  const hub = async (key: string) => {
    const state = { up: false };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (!state.up || url.pathname !== "/api/ready") return void res.writeHead(503).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof: readyProof(key, url.searchParams.get("c") ?? "") }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { state, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  };

  test("opens the signed-in link once the hub proves it holds the key, and not before", async () => {
    const ours = await hub("k".repeat(32));
    try {
      const open = vi.fn();
      setTimeout(() => (ours.state.up = true), 700);
      expect(await openWhenUp(`${ours.base}/#key=k`, () => isOurs(ours.base, "k".repeat(32)), { open })).toBe(true);
      expect(open).toHaveBeenCalledExactlyOnceWith(`${ours.base}/#key=k`);
    } finally {
      ours.server.close();
    }
  });

  test("a server that took the port, without the key, is never handed the link; a port in use is seen before the hub starts", async () => {
    const squatter = await hub("someone-else's-key-0000000000000");
    squatter.state.up = true;
    try {
      const open = vi.fn();
      expect(await isOurs(squatter.base, "k".repeat(32))).toBe(false);
      expect(await openWhenUp(`${squatter.base}/#key=k`, () => isOurs(squatter.base, "k".repeat(32)), { open, wait: 1200 })).toBe(false);
      expect(open).not.toHaveBeenCalled();
      const port = Number(new URL(squatter.base).port);
      expect(await portFree(port)).toBe(false);
    } finally {
      squatter.server.close();
    }
  });

  test("with each platform's own opener", () => {
    expect(opener("http://localhost:5173/#key=k", "darwin")).toEqual({ command: "open", args: ["http://localhost:5173/#key=k"] });
    expect(opener("http://localhost:5173/#key=k", "linux")).toEqual({ command: "xdg-open", args: ["http://localhost:5173/#key=k"] });
    expect(opener("http://localhost:5173/#key=k", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "http://localhost:5173/#key=k"] });
  });
});
