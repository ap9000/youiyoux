/**
 * Captures the Inventory page with Playwright: playwright-core driving its headless-shell
 * Chromium (no chrome-devtools-axi, no full browser).
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 *   pnpm dev                                                    # in another terminal, then:
 *   node scripts/capture-inventory.ts [--base http://localhost:5173] [--out screenshots]
 *   node scripts/capture-inventory.ts --serve [--out screenshots]  # or: build and serve a fixture snapshot itself
 *
 * `--serve` snapshots the scanner's four inventory fixtures into apps/web/.capture (console:
 * Tailwind v4 CVA kit; site: BEM class kit and Astro components; widgets: shaped like the Toolroll
 * console, its Tailwind entry built by the CLI and linked from index.html and a server template,
 * its tokens @imported by that entry, so its CVA Button and Badge and its .ui-button draw in
 * their real colours; sketch: Tailwind classes and no stylesheet, so its button shows the
 * shape-only fallback), builds the hub against it and serves the build with `vite preview`; no
 * app's dev server runs.
 *
 * Writes, light and dark: inventory.<scheme>.png (1440×900, the top: roles by project and
 * flags), inventory-families.<scheme>.png (scrolled to the button families and their
 * near-duplicates), inventory-buttons.<scheme>.png and inventory-badges.<scheme>.png (the 32px
 * button family and the pill badge family once every specimen frame has drawn), and the same
 * four at 390×844 on a touch phone as phone-inventory*.png.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

const APP = resolve(import.meta.dirname, "..");
const TOOL = resolve(APP, "../..");
const FIXTURES = ["console", "site", "widgets", "sketch"].map((name) => join(TOOL, "packages/scanner/test/fixtures/inventory", name));
const SCHEMES = ["light", "dark"] as const;
const SETTLE_MS = 400;
const FRAMES_TIMEOUT_MS = 20_000;
const PORT = 4796;
const VIEWPORTS = [
  { prefix: "inventory", options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  { prefix: "phone-inventory", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
] as const;

async function shoot(page: Page, out: string, name: string): Promise<string> {
  await page.waitForTimeout(SETTLE_MS);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Scroll to a family's role (its chunks load as it nears), then the family's row to the top; wait until every tile with a specimen has drawn it. */
async function showFamily(page: Page, family: string): Promise<void> {
  await page.locator(`#inventory-${family.replace(/-\d+$/, "")}`).evaluate((section) => section.scrollIntoView({ block: "start" }));
  const row = page.locator(`[data-family="${family}"]`);
  await row.waitFor();
  await row.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForFunction(
    (id) => {
      const tiles = [...document.querySelectorAll(`[data-family="${id}"] [data-tile]`)].filter((t) => t.getBoundingClientRect().top < innerHeight);
      return tiles.length > 0 && tiles.every((t) => (t as HTMLElement).dataset.kind === "shape" || t.querySelector("iframe[data-placed]"));
    },
    family,
    { timeout: FRAMES_TIMEOUT_MS },
  );
}

async function capture(browser: Browser, base: string, out: string): Promise<string[]> {
  const files: string[] = [];
  for (const { prefix, options } of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({ ...options, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(`${base}/inventory`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Roles by project" }).waitFor();
      files.push(await shoot(page, out, `${prefix}.${scheme}`));
      await page.locator("#inventory-button").evaluate((section) => section.scrollIntoView({ block: "start" }));
      files.push(await shoot(page, out, `${prefix}-families.${scheme}`));
      await showFamily(page, "button-1");
      files.push(await shoot(page, out, `${prefix}-buttons.${scheme}`));
      await showFamily(page, "badge-1");
      files.push(await shoot(page, out, `${prefix}-badges.${scheme}`));
      await context.close();
    }
  }
  return files;
}

/** The fixtures' snapshot (specimens included) built into the hub and served; returns its URL and how to stop it. */
async function serveFixtures(): Promise<{ base: string; close: () => Promise<void> }> {
  const libs = await (await import("./snapshot.ts")).libraries();
  const work = join(APP, ".capture");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const report = libs.core.InventoryReport.parse(await libs.scanner.buildInventory(FIXTURES, { cwd: TOOL }));
  writeFileSync(join(work, "inventory.json"), JSON.stringify(report));
  const out = join(work, "snapshot");
  const dist = join(work, "dist");
  execFileSync(process.execPath, [join(APP, "scripts/snapshot.ts"), "--out", out, "--inventory", join(work, "inventory.json")], { cwd: TOOL, stdio: ["ignore", "inherit", "inherit"] });
  execFileSync(process.execPath, [join(APP, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: APP, env: { ...process.env, YOUI_HUB_SNAPSHOT: out }, stdio: ["ignore", "ignore", "inherit"] });
  const { preview } = await import("vite");
  const server = await preview({ root: APP, configFile: join(APP, "vite.config.ts"), build: { outDir: dist }, preview: { port: PORT, strictPort: true }, logLevel: "error" });
  return { base: `http://localhost:${PORT}`, close: () => server.close() };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { base: { type: "string", default: "http://localhost:5173" }, out: { type: "string", default: "screenshots" }, serve: { type: "boolean", default: false } } });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const served = values.serve ? await serveFixtures() : null;
  // Playwright's own headless shell; `pnpm exec playwright-core install chromium-headless-shell` fetches it.
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of await capture(browser, (served?.base ?? values.base).replace(/\/$/, ""), out)) process.stdout.write(`${file}\n`);
  } finally {
    await browser.close();
    await served?.close();
  }
}

await main();
