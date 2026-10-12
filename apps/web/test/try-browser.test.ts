/**
 * States and Try it in Chromium (Playwright's headless shell), the way the hub's frames draw them:
 * a state strip of the console's Button paints each state from the project's own CSS, and the
 * console's Radix Tabs, bundled by the scanner's bundleForBrowser and served from a local server,
 * switch tabs inside a frame sandboxed `allow-scripts` only, which cannot read the page around it.
 * `YOUI_SPECIMEN_SHOTS=<dir>` also saves what was drawn.
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/** A DOM for the hub's own code (the strip's disabled cell), without changing this file's environment. */
async function withDom<T>(run: () => T): Promise<T> {
  const { JSDOM } = (await import("jsdom" as string)) as { JSDOM: new (html: string) => { window: { document: Document } } };
  vi.stubGlobal("document", new JSDOM("").window.document);
  try {
    return run();
  } finally {
    vi.unstubAllGlobals();
  }
}
import { bundleForBrowser } from "../../../packages/scanner/src/specimens/client.ts";
import { stateStripDocument } from "../src/screens/inventory/Specimens.tsx";
import { LIVE_SANDBOX, liveDocument } from "../src/screens/inventory/try-live.tsx";
import type { Manifest, InventoryIndex } from "../src/data/types.ts";
import type { TryIndex } from "../scripts/try-server.ts";

const SNAPSHOT = resolve(import.meta.dirname, "../snapshot");
const DATA = join(SNAPSHOT, "public/data");
const SHOTS = process.env.YOUI_SPECIMEN_SHOTS ? resolve(process.env.YOUI_SPECIMEN_SHOTS) : null;

let dir: string;
let browser: Browser;
let server: Server;
let origin: string;
/** What the local server serves, by path. */
const files = new Map<string, { type: string; body: string }>();

const attribute = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/** A hub page holding one frame, recording the messages it gets (from that frame, by source). */
const hubPage = (srcdoc: string, sandbox: string): string =>
  `<!doctype html><html><head><title>hub</title></head><body><p id="secret">hub only</p><iframe id="frame" sandbox="${sandbox}" style="width:1280px;height:480px;border:0" srcdoc="${attribute(srcdoc)}"></iframe><script>window.got = []; addEventListener("message", (e) => { if (e.source === document.getElementById("frame").contentWindow) window.got.push(e.data); });</script></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "youi-try-browser-"));
  const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
  const index = JSON.parse(readFileSync(join(DATA, manifest.inventory!), "utf8")) as InventoryIndex;
  const console_ = index.projects.find((p) => p.id === "console")!;
  files.set("/light.css", { type: "text/css", body: readFileSync(join(DATA, console_.specimenCss!.light), "utf8") });
  server = createServer((req, res) => {
    const file = files.get(req.url ?? "");
    res.statusCode = file ? 200 : 404;
    res.setHeader("Content-Type", file?.type ?? "text/plain");
    res.end(file?.body ?? "not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((done) => server?.close(done));
  rmSync(dir, { recursive: true, force: true });
});

describe("a state strip from the project's own CSS (c1)", () => {
  test("the console's Button: hover, focus, pressed and disabled each paint as the sheet's twins say", async () => {
    const html = '<button class="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:ring-2 disabled:opacity-50 border border-input bg-background hover:bg-accent h-8 px-3">Export</button>';
    const strip = await withDom(() => stateStripDocument(html, `${origin}/light.css`, "light"));
    files.set("/strip.html", { type: "text/html", body: strip });
    for (const touch of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 300 }, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
      try {
        await page.goto(`${origin}/strip.html`);
        const styles = await page.locator("[data-youi-state] > button").evaluateAll((buttons) => buttons.map((b) => ({ background: getComputedStyle(b).backgroundColor, shadow: getComputedStyle(b).boxShadow, opacity: getComputedStyle(b).opacity, disabled: (b as HTMLButtonElement).disabled })));
        const [plain, hover, focus, pressed, disabled] = styles;
        expect(styles).toHaveLength(5);
        // A phone (hover: none) shows the forced hover too, from the sheet's (hover: none) copy.
        expect(hover!.background).not.toBe(plain!.background);
        expect(focus!.shadow).not.toBe(plain!.shadow);
        expect(pressed!.background).toBe(plain!.background);
        expect(disabled).toMatchObject({ opacity: "0.5", disabled: true });
        expect(plain!.opacity).toBe("1");
        if (SHOTS && !touch) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: join(SHOTS, "state-strip.png") });
        }
      } finally {
        await page.close();
      }
    }
  });
});

describe("Try it: the console's Radix Tabs live in a sandboxed frame (c2)", () => {
  test("bundled by bundleForBrowser, clicking the second trigger makes it the active tab; the frame cannot read the hub", async () => {
    const tryIndex = JSON.parse(readFileSync(join(SNAPSHOT, "try.json"), "utf8")) as TryIndex;
    const project = tryIndex.projects.console!;
    const entry = Object.values(project.specimens).find((s) => s.look.recipe.export === "TabsTrigger" && s.look.label === "Runs")!;
    const bundle = await bundleForBrowser(resolve(SNAPSHOT, project.root), project.tsconfig, entry.look as never, entry.siblings as never);
    if ("error" in bundle) throw new Error(bundle.error);
    files.set(`/__youi/try/${bundle.hash}.js`, { type: "text/javascript", body: bundle.code });
    const staticHtml = '<div dir="ltr" data-orientation="horizontal"><div role="tablist">Tab</div></div>';
    const srcdoc = liveDocument(staticHtml, `${origin}/light.css`, "light", `${origin}/__youi/try/${bundle.hash}.js`);
    expect(LIVE_SANDBOX).toBe("allow-scripts");
    files.set("/hub.html", { type: "text/html", body: hubPage(srcdoc, LIVE_SANDBOX) });
    const page = await browser.newPage({ viewport: { width: 1300, height: 520 } });
    try {
      await page.goto(`${origin}/hub.html`);
      expect(await page.locator("#frame").getAttribute("sandbox")).toBe("allow-scripts");
      const frame = page.frameLocator("#frame");
      const triggers = frame.locator('[role="tab"]');
      await expect.poll(() => triggers.count(), { timeout: 10_000 }).toBe(2);
      expect(await triggers.evaluateAll((t) => t.map((e) => `${e.textContent}:${e.getAttribute("data-state")}`))).toEqual(["Runs:active", "Logs:inactive"]);
      await triggers.nth(1).click();
      await expect.poll(() => triggers.evaluateAll((t) => t.map((e) => `${e.textContent}:${e.getAttribute("data-state")}`))).toEqual(["Runs:inactive", "Logs:active"]);
      // Its box reached the hub, as finite numbers; and Escape, which tabs do not use, is posted.
      await expect.poll(() => page.evaluate(() => (window as unknown as { got: Array<{ type: string }> }).got.some((m) => m.type === "box"))).toBe(true);
      await triggers.nth(1).press("Escape");
      await expect.poll(() => page.evaluate(() => (window as unknown as { got: Array<{ type: string }> }).got.some((m) => m.type === "escape"))).toBe(true);
      // Opaque origin: the hub's document, storage and cookies are out of reach.
      const reach = await frame.locator("body").evaluate(() => {
        const attempt = (read: () => unknown): string => {
          try {
            read();
            return "read";
          } catch (error) {
            return (error as Error).name;
          }
        };
        return { document: attempt(() => parent.document.getElementById("secret")!.textContent), storage: attempt(() => localStorage.length), cookie: attempt(() => document.cookie), origin: location.origin };
      });
      expect(reach).toEqual({ document: "SecurityError", storage: "SecurityError", cookie: "SecurityError", origin: "null" });
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, "try-tabs.png") });
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});
