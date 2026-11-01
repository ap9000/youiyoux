/** Live screens, the service's side: where the product's app runs, and its components' frames mapped to lines from that app only. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LiveApp } from "../src/index.ts";

/** A module whose first line came from src/Button.tsx line 1, by its inline map. */
const MODULE = `render(Button)\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ["src/Button.tsx"], mappings: "AAAA" })).toString("base64")}`;

let root: string;
let app: Server;
let other: Server;
let base: string;
let elsewhere: string;
const served: string[] = [];

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "youi-live-"));
  other = createServer((req, res) => {
    served.push(`other ${req.url}`);
    res.writeHead(200, { "content-type": "text/javascript" }).end(MODULE);
  });
  elsewhere = await listen(other);
  app = createServer((req, res) => {
    served.push(`app ${req.url}`);
    if (req.url === "/app.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(MODULE);
    // A redirect to another address is not followed.
    if (req.url === "/moved.js") return void res.writeHead(302, { location: `${elsewhere}/app.js` }).end();
    res.writeHead(404).end();
  });
  base = await listen(app);
});
afterAll(() => {
  app.close();
  other.close();
  rmSync(root, { recursive: true, force: true });
});

const screens = (doc: Record<string, unknown>) => {
  mkdirSync(join(root, ".youi/screens"), { recursive: true });
  writeFileSync(join(root, ".youi/screens/screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "a test app", capturedAt: "", viewport: { width: 1440, height: 900 }, screens: [{ route: "/settings", path: "/settings" }], ...doc }));
};
const place = (url: string) => ({ name: "Button", owner: "Page", frames: [{ url, line: 1, column: 1 }], box: { x: 0, y: 0, width: 10, height: 10 }, depth: 1 });

describe("where the app runs", () => {
  test("from the last capture's screens.json; before any capture, or without base, it says how to record it", () => {
    rmSync(join(root, ".youi"), { recursive: true, force: true });
    const live = new LiveApp(root, "app");
    expect(live.info()).toMatchObject({ project: "app", base: null, screens: [], why: expect.stringMatching(/youiyoux screens capture --base/) });
    screens({});
    expect(live.info()).toMatchObject({ base: null, viewport: { width: 1440, height: 900 }, screens: [{ route: "/settings", path: "/settings" }], why: expect.stringMatching(/does not say where the app runs/) });
    screens({ base: "javascript:alert(1)" });
    expect(live.info().base).toBeNull();
    screens({ base: `${base}/` });
    expect(live.info()).toEqual({ project: "app", base, viewport: { width: 1440, height: 900 }, screens: [{ route: "/settings", path: "/settings" }] });
  });
});

describe("a live component's line", () => {
  test("is read from the app's own scripts and maps; a frame on another address, or a redirect to one, is never fetched there and gets no line", async () => {
    screens({ base });
    const live = new LiveApp(root, "app");
    served.length = 0;
    const [own, foreign, moved] = await live.resolve([place(`${base}/app.js`), place(`${elsewhere}/app.js`), place(`${base}/moved.js`)]);
    expect(own).toMatchObject({ name: "Button", file: "src/Button.tsx", line: 1 });
    expect(foreign).toMatchObject({ line: null });
    expect(moved).toMatchObject({ line: null });
    expect(served.filter((s) => s.startsWith("other"))).toEqual([]);
  });

  test("without a known address it is refused, saying how to record one", async () => {
    screens({});
    await expect(new LiveApp(root, "app").resolve([place(`${base}/app.js`)])).rejects.toThrow(/youiyoux screens capture --base/);
  });
});
