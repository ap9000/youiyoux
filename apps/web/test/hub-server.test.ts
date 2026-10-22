/**
 * The hub the npm package ships, with no Vite: the preview frame built from a snapshot's demos
 * (scripts/frame.ts) and the hub's own server (scripts/hub-server.ts), then the frame drawn in
 * Chromium from that server, as `youiyoux ui` from npm shows it.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildFrame, buildFrameKit, classCandidates, frameIsCurrent } from "../scripts/frame.ts";
import { createHubServer, EVENTS_PATH, LIVE_META, listen } from "../scripts/hub-server.ts";

const SNAPSHOT = resolve(import.meta.dirname, "../snapshot");

let work = "";
let kit = "";

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "youi-hub-server-"));
  kit = join(work, "kit");
  await buildFrameKit(kit);
}, 60_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A copy of the committed demo snapshot (public/ and preview/), to build a frame in. */
function demoSnapshot(name: string): string {
  const dir = join(work, name);
  for (const part of ["public", "preview"]) cpSync(join(SNAPSHOT, part), join(dir, part), { recursive: true });
  return dir;
}

/** GET (or another method) against a server on this machine, with the Host header it is given. */
function fetchFrom(port: number, path: string, init: { host?: string; method?: string; body?: string } = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: init.host ?? `localhost:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
    });
    req.on("error", fail);
    req.end(init.body);
  });
}

describe("the preview frame without Vite", () => {
  test("class names are read with and without their parentheses", () => {
    const words = classCandidates('cn("px-2 disabled:opacity-(--x-opacity)", active && "bg-[url(a.png)]", `${tone}`)');
    expect(words).toContain("px-2");
    expect(words).toContain("disabled:opacity-(--x-opacity)");
    expect(words).toContain("bg-[url(a.png)]");
  });

  test("each demo is bundled, its packages left to the kit, and the sheet holds every class its components use", async () => {
    const snapshot = demoSnapshot("demo");
    const out = join(snapshot, "frame");
    expect(await buildFrame(snapshot, kit, out)).toEqual({ demos: ["button", "card", "input"], errors: {} });
    const button = readFileSync(join(out, "button.demo.js"), "utf8");
    expect(button).toContain('"/kit/react-jsx-runtime.js"');
    expect(button).toContain('"/kit/lucide-react.js"');
    expect(button).not.toContain("createElement(\"svg\""); // lucide stays in the kit, not copied into each demo
    expect(readFileSync(join(out, "demos.js"), "utf8")).toContain('"button": () => import("./button.demo.js")');
    const css = readFileSync(join(out, "frame.css"), "utf8");
    // A class with parentheses, from the system's button, and the system's own variables.
    expect(css).toContain("disabled\\:opacity-\\(--demo-button-disabled-opacity\\)");
    expect(css).toContain("--demo-color-accent");
    expect(css).toContain("url(/kit/fonts/geist-latin-wght-normal.woff2)");
    expect(frameIsCurrent(snapshot, out)).toBe(true);
  });

  test("a demo that imports a package the kit lacks, or a file outside the components, says so and the rest still build", async () => {
    const snapshot = demoSnapshot("refused");
    const components = join(snapshot, "preview/components");
    writeFileSync(join(components, "chart.demo.tsx"), 'import { LineChart } from "recharts";\nexport default function Demo() { return <LineChart />; }\n');
    writeFileSync(join(components, "escape.demo.tsx"), 'import secret from "../../../secret";\nexport default function Demo() { return <p>{secret}</p>; }\n');
    writeFileSync(join(snapshot, "secret.ts"), "export default 1;\n");
    const built = await buildFrame(snapshot, kit, join(snapshot, "frame"));
    expect(built.demos).toEqual(["button", "card", "input"]);
    expect(built.errors.chart).toMatch(/^it imports recharts, which the hub's preview frame does not carry/);
    expect(built.errors.escape).toMatch(/outside the system's component files/);
    expect(readFileSync(join(snapshot, "frame/demos.js"), "utf8")).toContain('"chart":"it imports recharts');
  });

  test("a snapshot reached through a symlink builds (macOS's /var is /private/var)", async () => {
    const real = demoSnapshot("real");
    const link = join(work, "link");
    symlinkSync(real, link);
    expect((await buildFrame(link, kit, join(link, "frame"))).errors).toEqual({});
  });

  test("a frame older than the system's sheet is not current", async () => {
    const snapshot = demoSnapshot("stale");
    await buildFrame(snapshot, kit, join(snapshot, "frame"));
    const later = new Date(Date.now() + 5_000);
    const system = join(snapshot, "preview/system.css");
    writeFileSync(system, readFileSync(system, "utf8"));
    const { utimesSync } = await import("node:fs");
    utimesSync(system, later, later);
    expect(frameIsCurrent(snapshot, join(snapshot, "frame"))).toBe(false);
  });
});

describe("the hub's own server", () => {
  let dist = "";
  let snapshot = "";
  let port = 0;
  let hub: Awaited<ReturnType<typeof createHubServer>>;
  let api: Server;

  beforeAll(async () => {
    dist = join(work, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>hub</title></head><body>hub</body></html>");
    writeFileSync(join(dist, "assets/app-abc.js"), "export {};");
    mkdirSync(join(dist, "data"), { recursive: true });
    writeFileSync(join(dist, "data/manifest.json"), '{"from":"build"}');
    snapshot = demoSnapshot("served");
    writeFileSync(join(snapshot, "public/data/manifest.json"), '{"from":"snapshot"}');
    api = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/api/echo" ? { headers: req.headers } : { method: req.method, url: req.url }));
    });
    const apiPort = await listen(api, 0);
    hub = await createHubServer({ dist, kit, snapshot, api: `http://127.0.0.1:${apiPort}`, live: true, buildFrame: true, log: () => {} });
    port = await listen(hub.server, 0);
  }, 30_000);

  afterAll(async () => {
    await hub?.close();
    await new Promise((done) => api?.close(done));
  });

  test("client routes get the hub, with the event stream named when live", async () => {
    const page = await fetchFrom(port, "/elements/demo/component/button");
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<meta name="${LIVE_META}" content="${EVENTS_PATH}" />`);
    expect((await fetchFrom(port, "/tokens/color.accent")).body).toContain("hub");
  });

  test("the snapshot's files win over the build's; a missing file is a 404, never the hub", async () => {
    expect(JSON.parse((await fetchFrom(port, "/data/manifest.json")).body)).toEqual({ from: "snapshot" });
    expect((await fetchFrom(port, "/assets/app-abc.js")).status).toBe(200);
    expect((await fetchFrom(port, "/assets/missing.js")).status).toBe(404);
    expect((await fetchFrom(port, "/data/missing.json")).status).toBe(404);
    expect((await fetchFrom(port, "/frame/missing.js")).status).toBe(404);
  });

  test("the frame is served from the kit and the snapshot, and the kit's build inputs are not", async () => {
    expect((await fetchFrom(port, "/preview.html")).body).toContain('src="/kit/frame.js"');
    expect((await fetchFrom(port, "/kit/frame.js")).type).toContain("text/javascript");
    expect((await fetchFrom(port, "/frame/demos.js")).body).toContain("button.demo.js");
    expect((await fetchFrom(port, "/kit/frame.css.src")).status).toBe(404);
    expect((await fetchFrom(port, "/kit/candidates.json")).status).toBe(404);
  });

  test("only this machine is answered, and nothing outside the served directories", async () => {
    expect((await fetchFrom(port, "/", { host: "evil.example" })).status).toBe(403);
    expect((await fetchFrom(port, "/%2e%2e/%2e%2e/secret.ts")).body).not.toContain("export default");
    expect((await fetchFrom(port, "/kit/..%2f..%2fserved/secret.ts")).status).toBe(404);
  });

  test("/api never goes anywhere but the workflow service, and passes on only the headers it reads", async () => {
    // A request target naming another host is refused, not resolved against the service's address.
    const elsewhere = await new Promise<{ status: number }>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "//evil.example/api/x", headers: { host: `localhost:${port}` } }, (res) => {
        res.resume();
        done({ status: res.statusCode ?? 0 });
      });
      req.on("error", fail);
      req.end();
    });
    expect(elsewhere.status).toBe(400);
    const seen = await new Promise<Record<string, unknown>>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/echo", headers: { host: `localhost:${port}`, cookie: "secret=1", authorization: "Bearer x", "x-youi-session": "k" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => done(JSON.parse(body) as Record<string, unknown>));
      });
      req.on("error", fail);
      req.end();
    });
    expect(seen.headers).toMatchObject({ "x-youi-session": "k" });
    expect(seen.headers).not.toHaveProperty("cookie");
    expect(seen.headers).not.toHaveProperty("authorization");
  });

  test("/api goes to the workflow service; with none it answers as the dev server's proxy does, not JSON", async () => {
    const answer = await fetchFrom(port, "/api/requests?status=open", { method: "POST", body: "{}" });
    expect(JSON.parse(answer.body)).toEqual({ method: "POST", url: "/api/requests?status=open" });
    const alone = await createHubServer({ dist, kit, snapshot, log: () => {} });
    const alonePort = await listen(alone.server, 0);
    try {
      const offline = await fetchFrom(alonePort, "/api/requests");
      expect(offline.status).toBe(502);
      expect(offline.type).not.toContain("json");
      expect(offline.body).toContain("youiyoux ui --project");
    } finally {
      await alone.close();
    }
  });

  test("a new snapshot generation is announced on the event stream", async () => {
    const event = new Promise<string>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: EVENTS_PATH, headers: { host: `localhost:${port}` } }, (res) => {
        let seen = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          seen += chunk;
          if (seen.includes("event: snapshot")) {
            done(seen);
            req.destroy();
          } else if (seen.includes(": live")) {
            // Connected: write a new manifest the way the snapshot does (a rename).
            const data = join(snapshot, "public/data");
            writeFileSync(join(data, "manifest.json.tmp"), '{"from":"generation 2"}');
            renameSync(join(data, "manifest.json.tmp"), join(data, "manifest.json"));
          }
        });
      });
      req.on("error", fail);
      req.end();
    });
    await expect(event).resolves.toContain("event: snapshot");
  });

  test("the frame draws the system's own component in Chromium", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`http://localhost:${port}/preview.html?c=button&scheme=light`);
      await page.locator("[data-preview-ready]").waitFor();
      const publish = page.getByRole("button", { name: "Publish" });
      expect(await publish.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(79, 70, 229)");
      expect(await publish.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Geist Variable");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("the hub reads the event stream index.html names", () => {
  test("a built hub with the live meta tag listens; without it, it does not", async () => {
    const opened: string[] = [];
    class FakeEventSource {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener(): void {}
    }
    const { JSDOM } = (await import("jsdom" as string)) as { JSDOM: new (html: string) => { window: { document: Document } } };
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      vi.stubGlobal("document", new JSDOM("<head></head>").window.document);
      vi.resetModules();
      await import("../src/data/store.ts");
      expect(opened).toEqual([]);
      vi.stubGlobal("document", new JSDOM(`<head><meta name="${LIVE_META}" content="${EVENTS_PATH}"></head>`).window.document);
      vi.resetModules();
      await import("../src/data/store.ts");
      expect(opened).toEqual([EVENTS_PATH]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
