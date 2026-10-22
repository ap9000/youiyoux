/** `youiyoux screens capture`: where each component is on a page, mapped back to the line that rendered it. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, transform } from "esbuild";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import { captureScreens, captureText, decodeMap, mapNotes, sourceMapOf, originalPosition, projectPath, readScreensSpec, resolvePlaces, screenSlug, whyNoLines, type PlacesFile } from "../src/index.ts";

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
  });
});

describe("capturing a running app", () => {
  // A small app: a card holding a button, and a list of three rows rendered by one line.
  const APP = [
    'import { createRoot } from "react-dom/client";',
    "function Button({ children }: { children: string }) { return <button style={{ padding: 8 }}>{children}</button>; }",
    "function Card({ children }: { children: unknown }) { return <section style={{ margin: 24, padding: 16, border: \"1px solid #ccc\" }}>{children as never}</section>; }",
    "function Row({ label }: { label: string }) { return <li style={{ height: 20 }}>{label}</li>; }",
    "function App() {",
    "  return (",
    "    <main>",
    "      <Card>",
    "        <Button>Save</Button>",
    "      </Card>",
    '      <ul>{["a", "b", "c"].map((label) => <Row key={label} label={label} />)}</ul>',
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
      const body = path === "/" ? page("development.js") : path === "/prod" ? page("production.js") : path === "/nomaps" ? page("development.js?bare=1") : path === "/late" ? late : files.get(path);
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
});
