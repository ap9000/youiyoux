/**
 * The guarded behaviour probe (slice 1), in a real headless Chromium against fixture apps served
 * here on loopback ports. Each guard is shown active by what the fixture servers saw: their own
 * request logs prove what was, and wasn't, sent.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import { behaviourConsent, probeRoute, screenUrl, startFence, withBase, type ProbeRouteOptions, type RouteProbe, type TargetScenario } from "../src/index.ts";

const PACKAGE = join(import.meta.dirname, "..");
const CHROMIUM = process.env.YOUI_CHROMIUM ?? chromium.executablePath();
const HAVE_CHROMIUM = existsSync(CHROMIUM);
if (!HAVE_CHROMIUM) console.warn(`behaviour probe tests skipped: no Chromium at ${CHROMIUM} (set YOUI_CHROMIUM, or install the headless shell)`);

describe("consent and the probe's own address", () => {
  const consent = (base: unknown, allowedOrigin?: unknown) => behaviourConsent({ base, ...(allowedOrigin === undefined ? {} : { behaviour: { allowedOrigin } }) });

  test("consent holds only for the exact origin of base, on this machine, over http", () => {
    expect(consent("http://localhost:5173/app", "http://localhost:5173")).toEqual({ ok: true, origin: "http://localhost:5173" });
    expect(consent("http://[::1]:3000", "http://[::1]:3000")).toEqual({ ok: true, origin: "http://[::1]:3000" });
    // No consent: the words people see, and how to switch it on.
    const none = consent("http://127.0.0.1:5173");
    expect(none).toMatchObject({ ok: false, why: expect.stringMatching(/^Probes click buttons that open menus and dialogs in your running app\. Use a dev app with test data\./) });
    expect(!none.ok && none.fix).toMatch(/"allowedOrigin": "http:\/\/127\.0\.0\.1:5173"/);
    // Another origin than base's, even another port or spelling of this machine, is no consent.
    expect(consent("http://127.0.0.1:5173", "http://127.0.0.1:5174")).toMatchObject({ ok: false, why: expect.stringMatching(/switched on for http:\/\/127\.0\.0\.1:5174, but the app now runs at http:\/\/127\.0\.0\.1:5173/) });
    expect(consent("http://127.0.0.1:5173", "http://localhost:5173").ok).toBe(false);
    expect(consent("http://127.0.0.1:5173", "http://127.0.0.1:5173/").ok).toBe(false);
    // Not this machine, not http, credentials, no base, a malformed block: refused.
    expect(consent("http://example.com:5173", "http://example.com:5173")).toMatchObject({ ok: false, why: expect.stringMatching(/on this machine only/) });
    expect(consent("http://10.0.0.2:5173", "http://10.0.0.2:5173").ok).toBe(false);
    expect(consent("http://localhost.:5173", "http://localhost.:5173").ok).toBe(false);
    expect(consent("https://localhost:5173", "https://localhost:5173")).toMatchObject({ ok: false, why: expect.stringMatching(/http dev server/) });
    expect(consent("http://me:pw@localhost:5173", "http://localhost:5173").ok).toBe(false);
    expect(consent(undefined, "http://localhost:5173")).toMatchObject({ ok: false, why: expect.stringMatching(/does not say where the app runs/) });
    expect(behaviourConsent({ base: "http://localhost:5173", behaviour: true }).ok).toBe(false);
    expect(behaviourConsent({ base: "http://localhost:5173", behaviour: { allowedOrigin: "http://localhost:5173", also: 1 } }).ok).toBe(false);
  });

  test("a new base keeps consent only on the origin it names", () => {
    const spec = { project: "x", base: "http://localhost:5173", behaviour: { allowedOrigin: "http://localhost:5173" } };
    expect(withBase(spec, "http://localhost:5173/other")).toEqual({ ...spec, base: "http://localhost:5173/other" });
    const moved = withBase(spec, "http://localhost:6006");
    expect(moved).toEqual({ project: "x", base: "http://localhost:6006" });
    // Even if a block survived a move (an old youiyoux, a hand edit), it is checked against the origin.
    expect(behaviourConsent({ ...spec, base: "http://localhost:6006" }).ok).toBe(false);
  });

  test("a screen's path stays on the consented origin", () => {
    expect(screenUrl("http://localhost:5173", "/settings?tab=1")).toBe("http://localhost:5173/settings?tab=1");
    for (const path of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "settings", "javascript:alert(1)"]) expect(() => screenUrl("http://localhost:5173", path), path).toThrow(/probes open nothing elsewhere/);
  });

  test("the fence takes an http origin only", async () => {
    await expect(startFence("https://localhost:5173", () => undefined)).rejects.toThrow(/http origin/);
  });
});

/** A fixture app: every request and every WebSocket upgrade it receives, logged. */
interface Fixture {
  readonly server: Server;
  readonly origin: string;
  readonly requests: Array<{ method: string; path: string; query: string }>;
  readonly upgrades: string[];
}

async function serve(handler: (req: IncomingMessage, path: string) => { status?: number; type?: string; body: string; headers?: Record<string, string> } | null): Promise<Fixture> {
  const requests: Fixture["requests"] = [];
  const upgrades: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.search });
    const answer = handler(req, url.pathname);
    if (!answer) return void res.writeHead(404).end("not found");
    res.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "text/html", ...answer.headers }).end(answer.body);
  });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, upgrades };
}

describe("the network fence", () => {
  /** A request as a browser sends it to its proxy: the whole address on the request line. */
  const through = (proxy: string, method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(proxy);
      const req = httpRequest({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, ...(res.headers.location ? { location: res.headers.location } : {}) }));
      });
      req.on("error", reject);
      req.end(method === "GET" || method === "HEAD" ? undefined : "x");
    });
  const tunnel = (proxy: string, authority: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(proxy);
      httpRequest({ host: "127.0.0.1", port, method: "CONNECT", path: authority }).on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      }).on("error", reject).end();
    });

  test("reads reach the one origin; writes, other origins, tunnels and upgrades never leave, and a redirect isn't followed", async () => {
    const target = await serve((_req, path) => (path === "/away" ? { status: 302, body: "", headers: { location: "http://127.0.0.1:9/elsewhere" } } : { body: `page ${path}` }));
    const elsewhere = await serve(() => ({ body: "elsewhere" }));
    const refused: string[] = [];
    const fence = await startFence(target.origin, (r) => refused.push(`${r.kind}: ${r.words}`));
    try {
      expect(await through(fence.server, "GET", `${target.origin}/menu?q=1`)).toMatchObject({ status: 200, body: "page /menu" });
      expect(await through(fence.server, "GET", `${target.origin}/away`)).toMatchObject({ status: 302, location: "http://127.0.0.1:9/elsewhere" });
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await through(fence.server, method, `${target.origin}/api/save?secret=1`)).status).toBe(403);
      expect((await through(fence.server, "GET", `${elsewhere.origin}/steal`)).status).toBe(403);
      expect((await through(fence.server, "GET", `${target.origin.replace("127.0.0.1", "localhost")}/x`)).status).toBe(403);
      expect((await through(fence.server, "GET", "/no-address")).status).toBe(400);
      expect(await tunnel(fence.server, new URL(target.origin).host)).toBe(403);
      expect((await through(fence.server, "GET", `${target.origin}/socket`, { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" }).catch(() => ({ status: 0 }))).status).not.toBe(101);
      expect(target.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /menu", "GET /away"]);
      expect(target.upgrades).toEqual([]);
      expect(elsewhere.requests).toEqual([]);
      expect(refused.join("\n")).not.toContain("secret");
      expect(refused).toContain(`write: the page tried to send a POST to /api/save; nothing was sent`);
      expect(refused.some((r) => r.startsWith("socket: "))).toBe(true);
    } finally {
      await fence.close();
      target.server.close();
      elsewhere.server.close();
    }
  });
});

describe.skipIf(!HAVE_CHROMIUM)("the guarded probe in a real browser", () => {
  let browser: Browser;
  let app: Fixture;
  let other: Fixture;
  let shuffles = 0;
  const scratch = mkdtempSync(join(tmpdir(), "youi-behave-"));

  // Every page reports the clicks and keys it sees back to its server, by a GET (all a probed page may send).
  const LOGGER = `<script>
    const report = (q) => { new Image().src = "/log?" + q; };
    document.addEventListener("click", (e) => report("click=" + encodeURIComponent(e.target.closest("[data-log]")?.dataset.log ?? e.target.localName)), true);
    document.addEventListener("keydown", (e) => report("key=" + encodeURIComponent(e.key)), true);
  </script>`;
  /** A Web Worker running `source` (requests from a worker have no page of their own). */
  const worker = (source: string) => `new Worker(window.URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "text/javascript" })));`;
  const page = (body: string, script = "") => `<!doctype html><meta charset="utf-8"><title>fixture</title><body>${LOGGER}${body}<script>${script}</script></body>`;
  /** A menu button that shows its menu (with items) on click; `before` runs first in the click. */
  const menu = (name: string, id: string, before = "", controls = true) =>
    `<button data-log="trigger-${id}" aria-haspopup="menu" aria-expanded="false" ${controls ? `aria-controls="${id}"` : ""} onclick="${before.replace(/"/g, "&quot;")};document.getElementById('${id}').hidden=false;this.setAttribute('aria-expanded','true')">${name}</button>` +
    `<ul role="menu" id="${id}" hidden><li role="menuitem" data-log="item-${id}" onclick="report('item=${id}')">Delete everything</li></ul>`;

  // A React app for contract bindings: its trigger and popup carry no ARIA, only data-part.
  const REACT_APP = [
    'import { createRoot } from "react-dom/client";',
    'import { createPortal } from "react-dom";',
    'import { useState } from "react";',
    "function Menu({ label }: { label: string }) {",
    "  const [open, setOpen] = useState(false);",
    '  return <span><button data-part="trigger" onClick={() => setOpen(true)}>{label}</button>{open ? createPortal(<div data-part="content">Items</div>, document.body) : null}</span>;',
    "}",
    'function Toolbar() { return <nav><button aria-haspopup="menu" aria-controls="tb" onClick={() => document.getElementById("tb")!.removeAttribute("hidden")}>Tools</button><ul role="menu" id="tb" hidden><li role="menuitem">Cut</li></ul></nav>; }',
    'createRoot(document.getElementById("root")!).render(<main><Menu label="Account" /><Toolbar /></main>);',
    "",
  ].join("\n");
  let reactBundle = "";

  beforeAll(async () => {
    mkdirSync(join(scratch, "react"), { recursive: true });
    writeFileSync(join(scratch, "react/app.tsx"), REACT_APP);
    const out = await build({ entryPoints: [join(scratch, "react/app.tsx")], bundle: true, write: false, format: "esm", jsx: "automatic", jsxDev: true, define: { "process.env.NODE_ENV": '"development"' }, nodePaths: [join(PACKAGE, "node_modules")], absWorkingDir: join(scratch, "react"), logLevel: "silent" });
    reactBundle = out.outputFiles[0]!.text;
    other = await serve((_req, path) => ({ body: `other ${path}` }));
    const OTHER = other.origin;
    const OTHER_LOCALHOST = OTHER.replace("127.0.0.1", "localhost");
    const pages: Record<string, () => string> = {
      "/menu": () => page(menu("Actions", "m1")),
      "/menu-noid": () => page(`<button data-log="trigger" aria-haspopup="true" onclick="const m=document.createElement('div');m.setAttribute('role','menu');m.textContent='Items';document.body.append(m)">Options</button><div role="menu">Always here</div>`),
      "/two-dialogs": () => page(`<button aria-haspopup="dialog" onclick="for (const n of [1,2]) { const d=document.createElement('div'); d.setAttribute('role','dialog'); d.setAttribute('aria-modal','true'); d.textContent='Dialog '+n; document.body.append(d); }">Settings</button>`),
      "/popover": () => page(`<button popovertarget="tip">Info</button><div popover id="tip">Some help</div>`),
      "/async": () => page(menu("Later", "m2", "")).replace("document.getElementById('m2').hidden=false", "setTimeout(() => document.getElementById('m2').hidden=false, 300)"),
      "/never": () => page(`<button aria-haspopup="menu" aria-expanded="false" aria-controls="nope">Broken</button>`),
      "/post": () => page(menu("Save menu", "m3", "fetch('/api/save?secret=hunter2', { method: 'POST', body: 'x' })")),
      "/beacon": () => page(menu("Track", "m3b", "navigator.sendBeacon('/api/track?token=abc', 'x')")),
      "/other-port": () => page(menu("Elsewhere", "m4", `fetch('${OTHER}/steal?k=1').catch(() => {}); fetch('${OTHER_LOCALHOST}/steal-localhost').catch(() => {})`)),
      // A GET on the app's own address that redirects to another port: page routing never sees the next hop.
      "/redirect": () => page(menu("Bounce", "m4b", "fetch('/bounce').catch(() => {})")),
      "/bounce": () => "",
      // Both the instance's register and the prototype's (which an init script on the instance alone would miss).
      "/sw": () => page(menu("Cached", "m5"), "navigator.serviceWorker?.register('/sw.js').catch(() => {}); try { ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js?2').catch(() => {}); } catch {} const f = document.createElement('iframe'); document.body.append(f); try { f.contentWindow.ServiceWorkerContainer.prototype.register.call(f.contentWindow.navigator.serviceWorker, '/sw.js?3').catch(() => {}); } catch {}"),
      "/sw.js": () => "self.addEventListener('fetch', () => {});",
      "/ws": () =>
        page(
          menu("Live", "m6"),
          `new WebSocket("ws://" + location.host + "/app-socket");
           // As Vite's client does: closed without opening, it gives up; lost after opening, it reloads.
           let opened = false;
           const hmr = new WebSocket("ws://" + location.host + "/?token=t", "vite-hmr");
           hmr.addEventListener("open", () => { opened = true; }, { once: true });
           hmr.addEventListener("close", ({ wasClean }) => { if (wasClean) return; if (!opened) { report("hmr=gave-up"); return; } location.reload(); });
           ${worker(`new WebSocket("${OTHER.replace("http:", "ws:")}/worker-socket"); fetch("${OTHER}/worker-get").catch(() => {});`)}`,
        ),
      // The worker starts on the click, and posts from there.
      "/worker": () => page(menu("Worker", "m6w", worker(`fetch(${JSON.stringify(app.origin)} + "/worker-post", { method: "POST", body: "x" }).catch(() => {});`))),
      "/navigate": () => page(menu("Go", "m7", "location.href = '/elsewhere?x=1'")),
      "/push": () => page(menu("Push", "m8", "history.pushState({}, '', '/pushed')")),
      "/hash": () => page(menu("Hash", "m8h", "location.hash = 'open'")),
      "/open": () => page(menu("Window", "m9", "window.open('/popup')")),
      "/blank": () => page(menu("Blank", "m10", "const a = document.createElement('a'); a.href = '/popup-blank'; a.target = '_blank'; document.body.append(a); a.click()")),
      "/confirm": () => page(menu("Ask", "m11", "confirm('Sure?')")),
      "/dupes": () => page(menu("More", "d1") + menu("More", "d2") + menu("Less", "d3")),
      "/shuffle": () => (shuffles++ % 2 ? page(menu("Alpha", "s1") + menu("Beta", "s2")) : page(menu("Beta", "s2") + menu("Alpha", "s1"))),
      "/many": () => page(menu("One", "n1") + menu("Two", "n2") + menu("Three", "n3")),
      "/slow-many": () => page(`<button aria-haspopup="menu" aria-controls="x1">One</button><button aria-haspopup="menu" aria-controls="x2">Two</button><button aria-haspopup="menu" aria-controls="x3">Three</button>`),
      "/password": () => page(`<form><input name="u"><input type="password" name="p"></form>${menu("Account", "m12")}`),
      "/login": () => page(`<form><input name="u"><input type="password" name="p"></form>`),
      "/react": () => `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script type="module" src="/react.js"></script></body>`,
      "/react.js": () => reactBundle,
    };
    app = await serve((_req, path) => {
      if (path === "/bounce") return { status: 302, body: "", headers: { location: `${OTHER}/stolen` } };
      if (path === "/account") return { status: 302, body: "", headers: { location: "/login?next=/account" } };
      if (path === "/log") return { type: "image/gif", body: "" };
      const body = pages[path];
      return body ? { body: body(), type: path.endsWith(".js") ? "text/javascript" : "text/html" } : null;
    });
    browser = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    app?.server.close();
    other?.server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const probe = (path: string, extra: Partial<ProbeRouteOptions> = {}): Promise<RouteProbe> =>
    probeRoute({ browser, origin: app.origin, route: path, path, viewport: { width: 800, height: 600 }, checks: ["dismiss-escape"], ...extra });
  const only = (result: RouteProbe): TargetScenario => {
    expect(result.state).toBe("probed");
    expect(result.targets).toHaveLength(1);
    return result.targets[0]!.scenarios[0]!;
  };
  const seen = (fixture: Fixture, path: string) => fixture.requests.filter((r) => r.path === path);
  const logged = (key: string) => app.requests.filter((r) => r.path === "/log" && r.query.startsWith(`?${key}=`)).map((r) => decodeURIComponent(r.query.slice(key.length + 2)));

  test("a menu button with aria-controls opens, and its popup is identified by that relationship; a fresh load per scenario finds it again", async () => {
    const result = await probe("/menu");
    expect(result.coverage).toMatch(/^1 popup trigger found by ARIA markers\. Popups without these markers were not assessed/);
    expect(result.targets[0]!.key).toEqual({ route: "/menu", pattern: "menu-button", component: null, accessibleName: "Actions" });
    expect(only(result)).toMatchObject({ check: "dismiss-escape", state: "opened", popup: { how: "aria-controls", role: "menu" } });
    // Discovery and the scenario each loaded the screen fresh.
    expect(seen(app, "/menu").length).toBe(2);
  }, 60_000);

  test("without aria-controls, the popup is the single newly visible element of the pattern's role; two new dialogs are refused", async () => {
    // A menu that was already showing doesn't count; the new one does.
    expect(only(await probe("/menu-noid"))).toMatchObject({ state: "opened", popup: { how: "role", role: "menu" } });
    expect(only(await probe("/two-dialogs"))).toMatchObject({ state: "incomplete", why: "couldn't tell which of 2 dialogs this button opened" });
  }, 60_000);

  test("a native popover opens through popovertarget; a menu that opens after 300 ms is waited for; one that never opens is incomplete", async () => {
    const popover = await probe("/popover");
    expect(popover.targets[0]!.key.pattern).toBe("popover");
    expect(only(popover)).toMatchObject({ state: "opened", popup: { how: "popovertarget", role: "popover" } });
    expect(only(await probe("/async"))).toMatchObject({ state: "opened", popup: { how: "aria-controls" } });
    expect(only(await probe("/never"))).toMatchObject({ state: "incomplete", why: "clicking the button didn't open anything we could identify", fix: expect.stringMatching(/^Next: /) });
  }, 60_000);

  test("a POST (or a beacon) the click fires is stopped: the server never sees it, and the text names the method and path, never the query", async () => {
    const result = only(await probe("/post"));
    expect(result).toMatchObject({ state: "incomplete", why: "the page tried to send a POST to /api/save; nothing was sent" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(seen(app, "/api/save")).toEqual([]);
    expect(only(await probe("/beacon"))).toMatchObject({ state: "incomplete", why: "the page tried to send a POST to /api/track; nothing was sent" });
    expect(seen(app, "/api/track")).toEqual([]);
  }, 60_000);

  test("another port on this machine is never reached: not by a fetch, not by localhost, not through a redirect", async () => {
    const result = only(await probe("/other-port"));
    expect(result).toMatchObject({ state: "incomplete", why: expect.stringMatching(/^the page tried to reach http:\/\/(?:127\.0\.0\.1|localhost):\d+\/(?:steal|steal-localhost), which isn't http:\/\/127\.0\.0\.1:\d+; nothing was sent$/) });
    expect(JSON.stringify(result)).not.toContain("k=1");
    // The redirect itself was asked for (a GET on the app's own address); its next hop never left.
    const bounced = only(await probe("/redirect"));
    expect(bounced).toMatchObject({ state: "incomplete", why: expect.stringMatching(/^the page tried to reach http:\/\/127\.0\.0\.1:\d+\/stolen, which isn't/) });
    expect(seen(app, "/bounce").length).toBe(1);
    expect(other.requests).toEqual([]);
  }, 60_000);

  test("service workers are blocked: the worker script is never fetched, and the screen still probes", async () => {
    expect(only(await probe("/sw"))).toMatchObject({ state: "opened" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen(app, "/sw.js")).toEqual([]);
  }, 60_000);

  test("every WebSocket is blocked (the app's, a Vite-like hot-reload socket, a worker's to another port), and a dev page still probes", async () => {
    const result = only(await probe("/ws"));
    // The hot-reload client saw a socket that never opened, gave up, and didn't reload the page.
    expect(result).toMatchObject({ state: "opened" });
    expect(result.info.join(" ")).toMatch(/WebSocket or tunnel to 127\.0\.0\.1:\d+; it was blocked/);
    expect(app.upgrades).toEqual([]);
    expect(other.upgrades).toEqual([]);
    expect(other.requests).toEqual([]);
    expect(logged("hmr")).toContain("gave-up");
  }, 60_000);

  test("a worker's POST is stopped like the page's own", async () => {
    expect(only(await probe("/worker"))).toMatchObject({ state: "incomplete", why: "the page tried to send a POST to /worker-post; nothing was sent" });
    expect(seen(app, "/worker-post")).toEqual([]);
  }, 60_000);

  test("a trigger that navigates is stopped before the page leaves; a history or hash change is caught; window.open opens nothing", async () => {
    expect(only(await probe("/navigate"))).toMatchObject({ state: "incomplete", why: "the page tried to leave for /elsewhere; it was stopped before it left" });
    expect(seen(app, "/elsewhere")).toEqual([]);
    expect(only(await probe("/push"))).toMatchObject({ state: "incomplete", why: expect.stringMatching(/^the page's address changed to \/pushed; probes stay on the screen they opened$/) });
    expect(only(await probe("/hash"))).toMatchObject({ state: "incomplete", why: expect.stringMatching(/^the page's address changed to \/hash \(#open\)/) });
    // window.open is a no-op: no page (so no window was even tried), no request.
    expect(only(await probe("/open"))).toMatchObject({ state: "opened" });
    expect(seen(app, "/popup")).toEqual([]);
    // A link opening a new window: the window is closed and its request refused.
    expect(only(await probe("/blank"))).toMatchObject({ state: "incomplete", why: "the page tried to open a new window; none was opened" });
    expect(seen(app, "/popup-blank")).toEqual([]);
    expect(only(await probe("/confirm"))).toMatchObject({ state: "incomplete", why: "the page showed a browser dialog (confirm); it was dismissed" });
  }, 90_000);

  test("only triggers are clicked: never an item inside an opened menu; no key is ever sent", async () => {
    const before = logged("click").length;
    await probe("/menu", { checks: ["dismiss-escape", "focus-into", "arrow-keys"] });
    const clicks = logged("click").slice(before);
    expect(clicks).toEqual(["trigger-m1", "trigger-m1", "trigger-m1"]);
    expect(logged("item")).toEqual([]);
    expect(logged("click").filter((c) => c.startsWith("item"))).toEqual([]);
    expect(logged("key")).toEqual([]);
  }, 60_000);

  test("triggers that share a name are never told apart by position: each is incomplete, and none is clicked", async () => {
    const before = logged("click").length;
    const result = await probe("/dupes");
    const keys = result.targets.map((t) => t.key);
    expect(keys).toEqual([
      { route: "/dupes", pattern: "menu-button", component: null, accessibleName: "More", ordinal: 0 },
      { route: "/dupes", pattern: "menu-button", component: null, accessibleName: "More", ordinal: 1 },
      { route: "/dupes", pattern: "menu-button", component: null, accessibleName: "Less" },
    ]);
    for (const t of result.targets.slice(0, 2)) expect(t.scenarios[0]).toMatchObject({ state: "incomplete", why: "several menus are called 'More' here (2); probes never pick one by its place on the page", fix: expect.stringMatching(/name them apart/) });
    expect(result.targets[2]!.scenarios[0]).toMatchObject({ state: "opened" });
    expect(logged("click").slice(before)).toEqual(["trigger-d3"]);
  }, 60_000);

  test("a target is found again by its identity on a fresh load, wherever it moved", async () => {
    const result = await probe("/shuffle");
    expect(result.targets.map((t) => t.key.accessibleName).sort()).toEqual(["Alpha", "Beta"]);
    for (const t of result.targets) expect(t.scenarios[0]).toMatchObject({ state: "opened" });
  }, 60_000);

  test("over budget: targets past the limit, and scenarios past the route's time, are incomplete and named", async () => {
    const limited = await probe("/many", { budgets: { targets: 2 } });
    expect(limited.coverage).toMatch(/3 popup triggers found .*the first 2 were tested/);
    expect(limited.targets.map((t) => [t.key.accessibleName, t.scenarios[0]!.state])).toEqual([["One", "opened"], ["Two", "opened"], ["Three", "incomplete"]]);
    expect(limited.targets[2]!.scenarios[0]).toMatchObject({ why: "not tested: this screen has more than 2 popup triggers, and a probe tests the first 2" });
    // Three menus that never open, 2 s each, in a 3 s route: the last is never started.
    const timed = await probe("/slow-many", { budgets: { routeMs: 3_000 } });
    const last = timed.targets.at(-1)!.scenarios[0]!;
    expect(last).toMatchObject({ state: "incomplete", why: expect.stringMatching(/time budget \(3 s\) ran out/) });
  }, 60_000);

  test("a screen that needs a sign-in is incomplete with the plan's words: a redirect to sign-in, or a password form", async () => {
    const redirected = await probe("/account");
    expect(redirected).toMatchObject({ state: "incomplete", why: "this screen needs a signed-in session; probing signed-in screens isn't supported yet", targets: [] });
    const form = await probe("/password");
    expect(form).toMatchObject({ state: "incomplete", why: "this screen needs a signed-in session; probing signed-in screens isn't supported yet" });
  }, 60_000);

  test("checks that don't apply to a pattern are not-applicable, never run", async () => {
    const result = await probe("/popover", { checks: ["focus-trap", "dismiss-escape"] });
    expect(result.targets[0]!.scenarios.map((s) => s.state)).toEqual(["not-applicable", "opened"]);
  }, 60_000);

  test("a contract binding places the trigger and popup parts of a React component; DOM claims name their component", async () => {
    const result = await probe("/react", {
      bindings: [{ component: "Menu", binding: { pattern: "menu-button", trigger: { part: "trigger" }, popup: { part: "content" } } }],
    });
    const byName = Object.fromEntries(result.targets.map((t) => [t.key.accessibleName, t]));
    expect(byName.Account!.key).toEqual({ route: "/react", pattern: "menu-button", component: "Menu", accessibleName: "Account" });
    expect(byName.Account!.found.frames.length).toBeGreaterThan(0);
    expect(byName.Account!.scenarios[0]).toMatchObject({ state: "opened", popup: { how: "contract" } });
    expect(byName.Tools!.key).toMatchObject({ component: "Toolbar", pattern: "menu-button" });
    expect(byName.Tools!.scenarios[0]).toMatchObject({ state: "opened", popup: { how: "aria-controls" } });
  }, 60_000);
});
