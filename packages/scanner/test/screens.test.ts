/** `youiyoux screens capture`: where each component is on a page, mapped back to the line that rendered it. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, transform } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import { BRIDGE_VERSION, type BridgeEdited, type BridgeProps, captureScreens, captureText, decodeMap, liveBridge, mapNotes, sourceMapOf, originalPosition, projectPath, readScreensSpec, resolvePlaces, screenSlug, whyNoLines, type BridgeAt, type PlacesFile, type SourceMapCache } from "../src/index.ts";

const PACKAGE = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "youi-screens-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

describe("source maps", () => {
  test("a generated position maps back to the line and column it came from", async () => {
    const source = 'export function App() {\n  const label = "Save";\n  return <Card>\n    <Button kind="primary">{label}</Button>\n  </Card>;\n}\n';
    const out = await transform(source, { loader: "tsx", jsx: "automatic", jsxDev: true, sourcemap: true, sourcefile: "app.tsx", format: "esm" });
    const map = decodeMap(JSON.parse(out.map) as Record<string, unknown>)!;
    const generated = out.code.split("\n");
    const at = generated.findIndex((line) => line.includes("jsxDEV(Button"));
    const column = generated[at]!.indexOf("jsxDEV(Button") + 1;
    expect(originalPosition(map, at + 1, column)).toEqual({ source: "app.tsx", line: 4, column: 5 });
    expect(decodeMap({ sources: ["a.ts"], mappings: "A!" })).toBeNull();
    // An inline map is found however long it is (a development bundle's runs to megabytes).
    const big = { version: 3, sources: ["app.tsx"], sourcesContent: ["x".repeat(400_000)], mappings: "AAAA" };
    const inline = `code();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(big)).toString("base64")}\n`;
    expect((await sourceMapOf("http://localhost/app.js", inline, async () => null))?.sources).toEqual(["app.tsx"]);
    expect(await sourceMapOf("http://localhost/app.js", "const s = 'sourceMappingURL=nope';", async () => null)).toBeNull();
  });

  test("a map's source becomes a project path: beside the module, Vite's /@fs, webpack's, never outside the root", () => {
    expect(projectPath("NavRail.tsx", "http://localhost:5173/src/shell/NavRail.tsx?t=1", null)).toBe("src/shell/NavRail.tsx");
    expect(projectPath("/@fs/Users/me/app/src/x.tsx", "http://localhost:5173/@fs/Users/me/app/src/x.tsx", "/Users/me/app")).toBe("src/x.tsx");
    expect(projectPath("webpack://acme/./src/page.tsx", "http://localhost:3000/_next/static/chunks/app.js", null)).toBe("src/page.tsx");
    expect(projectPath("/Users/someone/else/secret.tsx", "http://localhost:5173/x.js", "/Users/me/app")).toBeNull();
    expect(projectPath("../../outside.tsx", "http://localhost:5173/src/x.js", null)).toBe("outside.tsx");
    // A root reached through a symlink still holds the sources a bundler names by their real path.
    const real = mkdtempSync(join(tmpdir(), "youi-real-"));
    const linked = join(scratch, "linked-root");
    symlinkSync(real, linked);
    expect(projectPath(`${realpathSync(real)}/src/x.tsx`, "http://localhost/x.js", linked)).toBe("src/x.tsx");
    rmSync(real, { recursive: true, force: true });
  });

  test("a place takes the first frame that maps into the project, past React's own in a bundle; with no map, its module path and no line", async () => {
    const map = { version: 3, sources: ["../node_modules/react/cjs/react-jsx-dev-runtime.development.js", "app.tsx"], mappings: "AAAA;ACAA" };
    const module = `x\ny\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
    const fetchText = async (url: string) => (url.startsWith("http://localhost/app.js") ? module : url === "http://localhost/plain.js" ? "no map here" : null);
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const [bundled, plain, none] = await resolvePlaces([
      { name: "Button", owner: "App", frames: [{ url: "http://localhost/app.js", line: 1, column: 1 }, { url: "http://localhost/app.js", line: 2, column: 1 }], box, depth: 1 },
      { name: "Card", owner: null, frames: [{ url: "http://localhost/plain.js", line: 9, column: 3 }], box, depth: 0 },
      { name: "Lib", owner: null, frames: [], box, depth: 2 },
    ], fetchText);
    expect(bundled).toMatchObject({ name: "Button", file: "app.tsx", line: 1, column: 1 });
    expect(plain).toMatchObject({ file: "plain.js", line: null });
    expect(none).toMatchObject({ file: null, line: null });
  });

  test("with a cache, a module served with the same text keeps its decoded map; served differently, it is read again", async () => {
    const inline = (sources: string[]) => `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources, mappings: "AAAA" })).toString("base64")}`;
    let served = inline(["before.tsx"]);
    const fetched: string[] = [];
    const fetchText = async (url: string) => {
      fetched.push(url);
      return served;
    };
    const place = { name: "Button", owner: null, frames: [{ url: "http://localhost/app.js", line: 1, column: 1 }], box: { x: 0, y: 0, width: 1, height: 1 }, depth: 0 };
    const cache: SourceMapCache = new Map();
    expect((await resolvePlaces([place], fetchText, null, undefined, cache))[0]).toMatchObject({ file: "before.tsx" });
    expect((await resolvePlaces([place], fetchText, null, undefined, cache))[0]).toMatchObject({ file: "before.tsx" });
    expect(cache.size).toBe(1);
    // The file was edited: the dev server serves it with a new map, at the same address.
    served = inline(["after.tsx"]);
    expect((await resolvePlaces([place], fetchText, null, undefined, cache))[0]).toMatchObject({ file: "after.tsx" });
    expect(cache.size).toBe(2);
    expect(fetched).toHaveLength(3);
  });

  test("when no component gets a line, what the maps did says why: no map, a map that cannot be read, or files outside the root", async () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const place = (url: string) => ({ name: "Button", owner: null, frames: [{ url, line: 1, column: 1 }], box, depth: 0 });
    const outsideMap = `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ["/Users/someone/elsewhere/app.tsx"], mappings: "AAAA" })).toString("base64")}`;
    const scripts: Record<string, string> = { "http://localhost/bare.js": "no map here", "http://localhost/lost.js": "x\n//# sourceMappingURL=lost.js.map", "http://localhost/out.js": outsideMap };
    const fetchText = async (url: string) => scripts[url] ?? null;
    const notes = (url: string) => {
      const found = mapNotes();
      return resolvePlaces([place(url)], fetchText, "/Users/me/app", found).then(() => whyNoLines(found));
    };
    expect(await notes("http://localhost/bare.js")).toMatch(/^the app's scripts carry no source maps \(such as bare\.js\): build them with source maps in development \(esbuild: sourcemap: "inline"/);
    expect(await notes("http://localhost/lost.js")).toMatch(/^the scripts name source maps that could not be read \(such as the one for lost\.js\)/);
    expect(await notes("http://localhost/out.js")).toMatch(/^the source maps name files outside the product's root \(such as \/Users\/someone\/elsewhere\/app\.tsx\): pass --root/);
    expect(whyNoLines(mapNotes())).toBeNull();
  });
});

describe("screens.json", () => {
  test("a route's file name, and a document that would clash or lacks a field is refused", () => {
    expect(["/", "*", "/flows/[id]", "/Settings"].map(screenSlug)).toEqual(["root", "app-shell", "flows-id", "settings"]);
    const dir = join(scratch, "spec");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "x", source: "s", capturedAt: "", viewport: { width: 800, height: 600 }, screens: [{ route: "/a-b", path: "/" }, { route: "/a/b", path: "/" }] }));
    expect(() => readScreensSpec(dir)).toThrow(/share the file name a-b/);
    writeFileSync(join(dir, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "x", screens: [] }));
    expect(() => readScreensSpec(dir)).toThrow(/needs project, source, viewport/);
    // A path that would open another host is refused before anything is opened.
    for (const path of ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "settings", "javascript:alert(1)"]) {
      writeFileSync(join(dir, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "x", source: "s", capturedAt: "", viewport: { width: 800, height: 600 }, screens: [{ route: "/a", path }] }));
      expect(() => readScreensSpec(dir), path).toThrow(/must start with a single \/ on the app's own address/);
    }
  });
});

describe("capturing a running app", () => {
  // A small app: a card holding a button, a list of three rows rendered by one line, and a form
  // from the server that a component places as HTML (React makes none of its elements).
  const SERVED = '<form><h2>Plan</h2><label>Name <input name="title" value="typed-by-someone"></label><button name="decision">Approve plan</button><button name="send"><svg width="8" height="8"></svg></button><svg width="10" height="10"><rect width="10" height="10"/></svg></form>';
  const APP = [
    'import { createRoot } from "react-dom/client";',
    'import { useState } from "react";',
    'function Button({ children, tone = "plain" }: { children: string; tone?: string }) { return <button data-tone={tone} style={{ padding: 8 }}>{children}</button>; }',
    "function Card({ children }: { children: unknown }) { return <section style={{ margin: 24, padding: 16, border: \"1px solid #ccc\" }}>{children as never}</section>; }",
    "function Row({ label }: { label: string }) { return <li style={{ height: 20 }}>{label}</li>; }",
    "function Served({ html }: { html: string }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }",
    "function App() {",
    "  const [, setRenders] = useState(0);",
    "  (window as unknown as { renderAgain: () => void }).renderAgain = () => setRenders((n) => n + 1);",
    "  return (",
    "    <main>",
    "      <Card>",
    "        <Button>Save</Button>",
    "      </Card>",
    '      <ul>{["a", "b", "c"].map((label) => <Row key={label} label={label} />)}</ul>',
    `      <Served html={${JSON.stringify(SERVED)}} />`,
    "    </main>",
    "  );",
    "}",
    'createRoot(document.getElementById("root")!).render(<App />);',
    "",
  ].join("\n");
  let server: Server;
  let base: string;
  let browser: Browser;
  const app = join(scratch, "app");

  beforeAll(async () => {
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "app.tsx"), APP);
    const bundle = async (mode: "development" | "production") =>
      build({ entryPoints: [join(app, "app.tsx")], bundle: true, write: false, format: "esm", jsx: "automatic", jsxDev: mode === "development", sourcemap: "external", outfile: join(app, `${mode}.js`), define: { "process.env.NODE_ENV": JSON.stringify(mode) }, nodePaths: [join(PACKAGE, "node_modules")], absWorkingDir: app, logLevel: "silent" });
    const files = new Map<string, string>();
    for (const mode of ["development", "production"] as const) for (const file of (await bundle(mode)).outputFiles) files.set(`/${file.path.split("/").pop()}`, file.text);
    const page = (script: string) => `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script type="module" src="/${script}"></script>`;
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path === "/broken") return void req.socket.destroy();
      // /late mounts the app after the capture's first look, as a dev server that reloads mid-way does.
      const late = '<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script type="module">setTimeout(() => import("/development.js"), 1500)</script>';
      // /live is the app with the live bridge, as an app loads it from the hub in development.
      const live = '<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script src="/bridge.js"></script><script type="module" src="/development.js"></script>';
      // /live-late is the app with the bridge added after React loaded, as a line in its entry file adds it.
      const liveLate = '<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script type="module">await import("/development.js"); document.head.append(Object.assign(document.createElement("script"), { src: "/bridge.js" }));</script>';
      if (path === "/bridge.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(liveBridge());
      const body = path === "/" ? page("development.js") : path === "/prod" ? page("production.js") : path === "/nomaps" ? page("development.js?bare=1") : path === "/late" ? late : path === "/live" ? live : path === "/live-late" ? liveLate : files.get(path);
      if (body === undefined) return void res.writeHead(404).end("not found");
      // ?bare serves a script without its source map comment, as a bundle built without maps is.
      const bare = (req.url ?? "").includes("bare");
      res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".map") ? "application/json" : "text/html" }).end(path.endsWith(".js") && !bare ? `${body}\n//# sourceMappingURL=${path.slice(1)}.map` : body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchBrowser(undefined, { download: false });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const screens = (dir: string, list: Array<{ route: string; path: string }>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "a test app", capturedAt: "", viewport: { width: 800, height: 600 }, screens: list }));
  };

  test("each route is photographed light and dark, and each component placed with the line that rendered it", async () => {
    const dir = join(scratch, "dev");
    screens(dir, [{ route: "/", path: "/" }, { route: "/gone", path: "/broken" }]);
    const report = await captureScreens(dir, { base, root: app, browser, now: () => new Date("2026-10-22T12:00:00Z") });
    expect(report.production).toBe(false);
    expect(report.screens.find((s) => s.route === "/")).toMatchObject({ error: null });
    expect(report.screens.find((s) => s.route === "/gone")!.error).toMatch(/ERR_EMPTY_RESPONSE.*\(\/broken\)$/);
    for (const name of ["root.light.webp", "root.dark.webp", "root.light.thumb.webp", "root.dark.thumb.webp", "root.places.json"]) expect(existsSync(join(dir, name)), name).toBe(true);
    expect(readFileSync(join(dir, "root.light.webp")).subarray(8, 12).toString()).toBe("WEBP");

    const places = JSON.parse(readFileSync(join(dir, "root.places.json"), "utf8")) as PlacesFile;
    expect(places).toMatchObject({ schema: "youiyoux.places/v1", route: "/", dev: true, size: { width: 800 } });
    const button = places.places.find((p) => p.name === "Button")!;
    const card = places.places.find((p) => p.name === "Card")!;
    expect(button).toMatchObject({ owner: "App", file: "app.tsx", line: lineOf(APP, "<Button>Save") });
    expect(card).toMatchObject({ owner: "App", file: "app.tsx", line: lineOf(APP, "      <Card>") });
    // The button sits inside the card, in page pixels; the three rows share the line that maps them.
    expect(button.box.x).toBeGreaterThanOrEqual(card.box.x);
    expect(button.box.y + button.box.height).toBeLessThanOrEqual(card.box.y + card.box.height);
    expect(button.depth).toBeGreaterThan(card.depth);
    const rows = places.places.filter((p) => p.name === "Row");
    expect(rows.map((r) => r.line)).toEqual([lineOf(APP, "<Row key"), lineOf(APP, "<Row key"), lineOf(APP, "<Row key")]);
    expect(new Set(rows.map((r) => r.box.y)).size).toBe(3);
    // HTML React did not create is placed too, named by its tag and text (a field by its name, never
    // by what is typed in it), at the line of the component that placed it; what React made is not.
    const html = places.places.filter((p) => p.html);
    const served = places.places.find((p) => p.name === "Served")!;
    expect(html.map((p) => p.name)).toEqual(['form "Plan"', 'h2 "Plan"', 'label "Name"', 'input "title"', 'button "Approve plan"', 'button "send"', "svg", "svg"]);
    expect(html.map((p) => p.html)).toEqual(["form", "h2", "label", "input", "button", "button", "svg", "svg"]);
    for (const p of html) expect(p).toMatchObject({ owner: "Served", file: "app.tsx", line: lineOf(APP, "<Served html") });
    expect(html.find((p) => p.html === "button")!.depth).toBeGreaterThan(html.find((p) => p.html === "form")!.depth);
    expect(html.find((p) => p.html === "form")!.depth).toBeGreaterThan(served.depth);
    expect(JSON.stringify(places)).not.toContain("typed-by-someone");
    expect(JSON.parse(readFileSync(join(dir, "screens.json"), "utf8")).capturedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(captureText(report)).toMatch(/1 of 2 screens of app captured[\s\S]*✓ \/: \d+ components placed, \d+ with their line[\s\S]*✖ \/gone/);
  }, 120_000);

  test("one route can be captured again on its own: the others keep their pictures and the set keeps its time", async () => {
    const dir = join(scratch, "one");
    screens(dir, [{ route: "/", path: "/" }, { route: "/prod", path: "/prod" }]);
    writeFileSync(join(dir, "prod.light.webp"), "untouched");
    const before = readFileSync(join(dir, "screens.json"), "utf8");
    const report = await captureScreens(dir, { base, browser, routes: ["/"] });
    expect(report.screens.map((s) => s.route)).toEqual(["/"]);
    expect(existsSync(join(dir, "root.places.json"))).toBe(true);
    expect(readFileSync(join(dir, "prod.light.webp"), "utf8")).toBe("untouched");
    // The set keeps its time; where the app ran is recorded, so the route can be captured again without asking.
    const after = JSON.parse(readFileSync(join(dir, "screens.json"), "utf8"));
    expect(after).toEqual({ ...JSON.parse(before), base });
    await expect(captureScreens(dir, { base, browser, routes: ["/nope"] })).rejects.toThrow(/has no route \/nope: it lists \/, \/prod/);
  }, 120_000);

  test("a page that mounts React late is looked at again, not recorded as having none", async () => {
    const dir = join(scratch, "late");
    screens(dir, [{ route: "/", path: "/late" }]);
    const report = await captureScreens(dir, { base, browser });
    expect(report.noReact).toBe(false);
    expect(report.screens[0]!.placed).toBeGreaterThan(0);
  }, 120_000);

  test("a development build with no source maps is placed without lines, and says why and what to do", async () => {
    const dir = join(scratch, "nomaps");
    screens(dir, [{ route: "/", path: "/nomaps" }]);
    const report = await captureScreens(dir, { base, root: app, browser });
    expect(report.production).toBe(false);
    expect(report.screens[0]!.placed).toBeGreaterThan(0);
    expect(report.screens[0]!.lined).toBe(0);
    expect(report.noLines).toMatch(/carry no source maps \(such as development\.js\)/);
    expect(captureText(report)).toMatch(/Components are placed but none has its line: the app's scripts carry no source maps/);
  }, 120_000);

  test("a production build is placed without lines, and says so", async () => {
    const dir = join(scratch, "prod");
    screens(dir, [{ route: "/", path: "/prod" }]);
    const report = await captureScreens(dir, { base, browser });
    expect(report.production).toBe(true);
    const places = JSON.parse(readFileSync(join(dir, "root.places.json"), "utf8")) as PlacesFile;
    expect(places.dev).toBe(false);
    expect(places.places.every((p) => p.line === null)).toBe(true);
    expect(captureText(report)).toMatch(/production build: components are placed but have no lines/);
    expect(report.noLines).toBeNull();
  }, 120_000);

  describe("the live bridge", () => {
    /** A hub page at `hub` framing the app's /live, collecting what the frame says. */
    const hubPage = (app: string) => `<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="f" src="${app}/live" style="width:800px;height:600px;border:0"></iframe><script>window.got = []; addEventListener("message", (e) => { if (e.source === document.getElementById("f").contentWindow) window.got.push({ origin: e.origin, data: e.data }); });</script>`;
    let hub: Server;
    let hubOrigin: string;
    /** Chrome without its own check on public pages framing this machine, so the bridge's check is what is tested. */
    let open_: Browser;
    beforeAll(async () => {
      hub = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(hubPage(base)));
      await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
      // localhost, not 127.0.0.1: another origin from the app's on this machine.
      hubOrigin = `http://localhost:${(hub.address() as { port: number }).port}`;
      open_ = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests"] });
    });
    afterAll(async () => {
      hub?.close();
      await open_?.close();
    });
    const open = async (at: "here" | "elsewhere") => {
      const page = await (at === "here" ? browser : open_).newPage({ viewport: { width: 800, height: 600 } });
      if (at === "elsewhere") await page.route("http://elsewhere.example/", (route) => route.fulfill({ contentType: "text/html", body: hubPage(base) }));
      await page.goto(at === "here" ? `${hubOrigin}/` : "http://elsewhere.example/");
      const app = page.frameLocator("#f");
      await app.getByRole("button", { name: "Save" }).waitFor();
      const say = (message: unknown) => page.evaluate(([m, target]) => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage(m, target as string), [message, base] as const);
      const got = () => page.evaluate(() => (window as unknown as { got: Array<{ origin: string; data: { type: string } }> }).got);
      return { page, app, say, got };
    };

    test("a hub on this machine is told where the page is, and which components are under a point, mapped to the line that rendered them", async () => {
      const { page, app, say, got } = await open("here");
      await say({ youiyoux: BRIDGE_VERSION, type: "hello" });
      await expect.poll(async () => (await got()).map((m) => m.data.type)).toContain("view");
      const view = (await got()).find((m) => m.data.type === "view")!;
      expect(view.origin).toBe(base);
      expect(view.data).toMatchObject({ path: "/live", scroll: { x: 0, y: 0 }, viewport: { width: 800, height: 600 } });
      const button = (await app.getByRole("button", { name: "Save" }).boundingBox())!;
      await say({ youiyoux: BRIDGE_VERSION, type: "at", id: 7, x: button.x + 4, y: button.y + 4 });
      await expect.poll(async () => (await got()).some((m) => m.data.type === "at")).toBe(true);
      const at = (await got()).find((m) => m.data.type === "at")!.data as unknown as BridgeAt;
      expect(at).toMatchObject({ id: 7, react: true, dev: true });
      // Smallest first: the button, then the card holding it.
      expect(at.places.map((p) => p.name)).toEqual(["Button", "Card", "App"]);
      const fetchText = (url: string) => fetch(url).then((r) => (r.ok ? r.text() : null), () => null);
      const [placed] = await resolvePlaces(at.places, fetchText, join(scratch, "app"));
      expect(placed).toMatchObject({ name: "Button", file: "app.tsx", line: lineOf(APP, "<Button>Save</Button>") });
      // In the server's HTML: its button, the form holding it, then the component that placed them.
      const served = (await app.getByRole("button", { name: "Approve plan" }).boundingBox())!;
      await say({ youiyoux: BRIDGE_VERSION, type: "at", id: 8, x: served.x + 4, y: served.y + 4 });
      await expect.poll(async () => (await got()).some((m) => m.data.type === "at" && (m.data as unknown as BridgeAt).id === 8)).toBe(true);
      const inServed = (await got()).find((m) => m.data.type === "at" && (m.data as unknown as BridgeAt).id === 8)!.data as unknown as BridgeAt;
      expect(inServed.places.map((p) => p.name)).toEqual(['button "Approve plan"', 'form "Plan"', "Served", "App"]);
      const [html] = await resolvePlaces(inServed.places, fetchText, join(scratch, "app"));
      expect(html).toMatchObject({ html: "button", owner: "Served", file: "app.tsx", line: lineOf(APP, "<Served html") });
      await page.close();
    }, 60_000);

    test("a component is edited in place: its props and text read, set and kept set when its parent renders again, and every edit undone", async () => {
      const { page, app, say, got } = await open("here");
      const reply = async <T,>(type: string, id: number): Promise<T> => {
        await expect.poll(async () => (await got()).some((m) => m.data.type === type && (m.data as unknown as { id: number }).id === id)).toBe(true);
        return (await got()).find((m) => m.data.type === type && (m.data as unknown as { id: number }).id === id)!.data as unknown as T;
      };
      await say({ youiyoux: BRIDGE_VERSION, type: "hello" });
      const at0 = (await app.getByRole("button", { name: "Save" }).boundingBox())!;
      await say({ youiyoux: BRIDGE_VERSION, type: "at", id: 1, x: at0.x + 4, y: at0.y + 4 });
      const button = (await reply<BridgeAt>("at", 1)).places[0]!;
      await say({ youiyoux: BRIDGE_VERSION, type: "props", id: 2, name: button.name, box: button.box, ask: ["tone", "style"] });
      // Only plain values the call passes are read: tone is left to its default, and style is an object.
      expect(await reply<BridgeProps>("props", 2)).toMatchObject({ editable: true, why: null, found: true, props: { tone: null, style: null }, text: "Save" });
      await say({ youiyoux: BRIDGE_VERSION, type: "edit", id: 3, name: button.name, box: button.box, set: { tone: "loud" }, text: "Save changes" });
      expect(await reply<BridgeEdited>("edited", 3)).toMatchObject({ ok: true, why: null });
      const edited = app.locator("button[data-tone]").first();
      await expect.poll(() => edited.getAttribute("data-tone")).toBe("loud");
      expect(await edited.textContent()).toBe("Save changes");
      // The parent renders it again with the old props: the edit is applied again.
      await page.frames()[1]!.evaluate(() => (window as unknown as { renderAgain: () => void }).renderAgain());
      await page.waitForTimeout(200);
      await expect.poll(() => edited.getAttribute("data-tone")).toBe("loud");
      // A prop the bridge never sets (a key, a ref, raw HTML) or a value that is not plain is not an edit.
      await say({ youiyoux: BRIDGE_VERSION, type: "edit", id: 4, name: button.name, box: button.box, set: { dangerouslySetInnerHTML: "x" }, text: null });
      await say({ youiyoux: BRIDGE_VERSION, type: "edit", id: 5, name: button.name, box: button.box, set: { tone: { evil: true } }, text: null });
      await page.waitForTimeout(300);
      expect((await got()).filter((m) => m.data.type === "edited").map((m) => (m.data as unknown as BridgeEdited).id)).toEqual([3]);
      await say({ youiyoux: BRIDGE_VERSION, type: "reset" });
      await expect.poll(() => edited.getAttribute("data-tone")).toBe("plain");
      expect(await edited.textContent()).toBe("Save");
      // Let go once the code says the same: nothing is undone, and nothing applied again.
      await say({ youiyoux: BRIDGE_VERSION, type: "edit", id: 6, name: button.name, box: button.box, set: { tone: "quiet" }, text: null });
      await expect.poll(() => edited.getAttribute("data-tone")).toBe("quiet");
      await say({ youiyoux: BRIDGE_VERSION, type: "forget" });
      await say({ youiyoux: BRIDGE_VERSION, type: "reset" });
      await page.waitForTimeout(300);
      expect(await edited.getAttribute("data-tone")).toBe("quiet");
      await page.close();
    }, 60_000);

    test("loaded after React, the bridge still comments but says why it can't edit", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.goto(`${hubOrigin}/`);
      await page.evaluate((src) => ((document.getElementById("f") as HTMLIFrameElement).src = src), `${base}/live-late`);
      const app = page.frameLocator("#f");
      await app.getByRole("button", { name: "Save" }).waitFor();
      const say = (message: unknown) => page.evaluate(([m, target]) => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage(m, target as string), [message, base] as const);
      const got = () => page.evaluate(() => (window as unknown as { got: Array<{ data: { type: string; id?: number } }> }).got);
      await expect.poll(async () => {
        await say({ youiyoux: BRIDGE_VERSION, type: "hello" });
        return (await got()).some((m) => m.data.type === "view");
      }).toBe(true);
      const at0 = (await app.getByRole("button", { name: "Save" }).boundingBox())!;
      await say({ youiyoux: BRIDGE_VERSION, type: "props", id: 1, name: "Button", box: { x: at0.x, y: at0.y, width: at0.width, height: at0.height }, ask: ["tone"] });
      await expect.poll(async () => (await got()).some((m) => m.data.type === "props")).toBe(true);
      expect((await got()).find((m) => m.data.type === "props")!.data).toMatchObject({ editable: false, why: expect.stringMatching(/loaded after React: load it in the page's head/), found: true });
      await page.close();
    }, 60_000);

    test("a site elsewhere that frames the app learns nothing, and unframed the bridge does nothing", async () => {
      const { page, app, say, got } = await open("elsewhere");
      await say({ youiyoux: BRIDGE_VERSION, type: "hello" });
      const button = (await app.getByRole("button", { name: "Save" }).boundingBox())!;
      await say({ youiyoux: BRIDGE_VERSION, type: "at", id: 1, x: button.x + 4, y: button.y + 4 });
      await page.waitForTimeout(500);
      expect(await got()).toEqual([]);
      await page.goto(`${base}/live`);
      await page.getByRole("button", { name: "Save" }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { __youiyouxBridge?: number }).__youiyouxBridge)).toBeUndefined();
      await page.close();
    }, 60_000);
  });
});