import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkPreviewBuild } from "../scripts/preview/check.ts";
import { createPreviewServer } from "../scripts/preview/server.ts";

const SNAPSHOT_PUBLIC = resolve(import.meta.dirname, "../snapshot/public");

/** A stand-in for a hub build: an index.html plus a copy of the committed demo snapshot. */
function fakeBuild(): string {
  const dist = join(mkdtempSync(join(tmpdir(), "youi-preview-")), "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "..", "secret.json"), '{"private":true}');
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>hub</title>");
  cpSync(SNAPSHOT_PUBLIC, dist, { recursive: true });
  return dist;
}

describe("checkPreviewBuild", () => {
  test("passes a build that serves exactly the committed demo snapshot", () => {
    const dist = fakeBuild();
    expect(checkPreviewBuild(dist, SNAPSHOT_PUBLIC)).toEqual([]);
    rmSync(join(dist, ".."), { recursive: true });
  });

  test("fails a build that carries another system's data", () => {
    const dist = fakeBuild();
    writeFileSync(join(dist, "data/private.catalog.0123456789.json"), "{}");
    writeFileSync(join(dist, "data/manifest.json"), JSON.stringify({ systems: [{ id: "demo" }, { id: "private" }] }));
    const problems = checkPreviewBuild(dist, SNAPSHOT_PUBLIC);
    expect(problems).toContain("data/private.catalog.0123456789.json is not part of the committed demo snapshot");
    expect(problems).toContain("data/manifest.json differs from the committed demo snapshot");
    expect(problems).toContain('the build shows systems [demo, private]; a preview shows only "demo"');
    rmSync(join(dist, ".."), { recursive: true });
  });

  test("fails a build missing demo files or index.html", () => {
    const dist = fakeBuild();
    rmSync(join(dist, "previews"), { recursive: true });
    expect(checkPreviewBuild(dist, SNAPSHOT_PUBLIC)).toContain("previews/button.light.webp from the demo snapshot is missing from the build");
    rmSync(join(dist, "index.html"));
    expect(checkPreviewBuild(dist, SNAPSHOT_PUBLIC)[0]).toMatch(/has no index\.html/);
    rmSync(join(dist, ".."), { recursive: true });
  });
});

describe("preview server", () => {
  let dist: string;
  let base: string;
  let close: () => void;

  beforeAll(async () => {
    dist = fakeBuild();
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets/index-abc123.js"), "export {};");
    const server = createPreviewServer(dist);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  afterAll(() => {
    close();
    rmSync(join(dist, ".."), { recursive: true });
  });

  test("serves client routes as index.html and asks not to be indexed", async () => {
    const res = await fetch(`${base}/elements/demo/component/button`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await res.text()).toContain("<title>hub</title>");
  });

  test("caches hashed files for good and revalidates the manifest", async () => {
    expect((await fetch(`${base}/assets/index-abc123.js`)).headers.get("cache-control")).toContain("immutable");
    const manifest = await fetch(`${base}/data/manifest.json`);
    expect(manifest.headers.get("content-type")).toMatch(/^application\/json/);
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
  });

  test("answers the health check, 404s missing files and refuses writes and traversal", async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    expect((await fetch(`${base}/data/missing.json`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    const escape = await fetch(`${base}/..%2fsecret.json`);
    expect(escape.status).toBe(404);
    expect(await escape.text()).not.toContain("private");
  });

  test("refuses to start without a build", () => {
    expect(() => createPreviewServer(join(dist, "assets"))).toThrow(/no index\.html/);
  });
});
