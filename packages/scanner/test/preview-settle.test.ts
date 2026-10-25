/**
 * A Discover preview reports what it drew at once, then again once it has stopped changing (a chart
 * animating in), marked settled; something that never stops is settled after SETTLE_MAX_MS. Run
 * in Chromium, where the bundle runs for real.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bundlePreview, SETTLE_MAX_MS } from "../src/index.ts";

const CONSOLE = join(import.meta.dirname, "fixtures/inventory/console");
const scratch = mkdtempSync(join(tmpdir(), "youi-preview-settle-"));
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
});

type Drawn = { html: string; settled: boolean; at: number };

/** The `html` messages a component's bundle posts, with when each came (ms after the page loaded). */
async function drawings(name: string, source: string, waitMs: number): Promise<Drawn[]> {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "ui/x.tsx"), source);
  const built = await bundlePreview({ root: CONSOLE, tsconfig: "tsconfig.json", dir, main: "ui/x.tsx", compose: { export: "X", props: {}, children: [] }, fallback: null });
  if (!("code" in built)) throw new Error(`did not bundle: ${JSON.stringify(built)}`);
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.abort());
    // At the top level `parent` is the page itself, so what the bundle posts arrives here.
    await page.setContent(`<!doctype html><html><body><script>window.__drawn = []; const t0 = performance.now(); addEventListener("message", (e) => { if (e.data && e.data.type === "html") window.__drawn.push({ html: e.data.html, settled: e.data.settled, at: Math.round(performance.now() - t0) }); });</script><div id="youi-specimen"></div><script>${built.code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
    await page.waitForTimeout(waitMs);
    return (await page.evaluate("window.__drawn")) as Drawn[];
  } finally {
    await page.close();
  }
}

test("a drawing that changes for half a second is reported at once, then settled with its last state", async () => {
  const drawn = await drawings("ticks", 'import { useEffect, useState } from "react";\nexport function X() { const [n, setN] = useState(0); useEffect(() => { const t = setInterval(() => setN((v) => (v < 5 ? v + 1 : v)), 100); return () => clearInterval(t); }, []); return <b>tick {n}</b>; }\n', 2500);
  expect(drawn[0]).toMatchObject({ settled: false });
  expect(drawn[0]!.html).toContain("tick 0");
  const settled = drawn.filter((d) => d.settled);
  expect(settled).toHaveLength(1);
  expect(settled[0]!.html).toContain("tick 5");
  // Only after it stopped changing (about 500 ms in), never before.
  expect(settled[0]!.at).toBeGreaterThan(500);
}, 60_000);

test("a drawing that never stops changing is settled after the limit, as it is then", async () => {
  const drawn = await drawings("forever", 'import { useEffect, useState } from "react";\nexport function X() { const [n, setN] = useState(0); useEffect(() => { const t = setInterval(() => setN((v) => v + 1), 50); return () => clearInterval(t); }, []); return <b>tick {n}</b>; }\n', SETTLE_MAX_MS + 1500);
  const settled = drawn.filter((d) => d.settled);
  expect(settled).toHaveLength(1);
  expect(settled[0]!.at).toBeGreaterThanOrEqual(SETTLE_MAX_MS - 200);
  expect(settled[0]!.at).toBeLessThan(SETTLE_MAX_MS + 1000);
}, 60_000);
