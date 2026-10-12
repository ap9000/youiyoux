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
 * Writes, light and dark, at 1440×900: inventory.<scheme>.png (filters, the headline and the
 * top of the wall; on a phone, the two-column wall), inventory-filtered.<scheme>.png (a filtered URL: the console's buttons),
 * inventory-compare.<scheme>.png (the 32px button's compare card, its slider dragged to 45%),
 * inventory-fixes.<scheme>.png (the fix list) and inventory-drawer.<scheme>.png (that family
 * opened); and at 390×844 on a touch phone the same as phone-inventory*.png, with
 * phone-inventory-filters.<scheme>.png (the filters' bottom sheet) and
 * phone-inventory-sheet.<scheme>.png (the family's bottom sheet) for the last two. Each waits
 * until every specimen frame on screen has drawn.
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
  await framesDrawn(page);
  await page.waitForTimeout(SETTLE_MS);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Every specimen tile on screen has drawn its frame (or shows its shape). */
async function framesDrawn(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-tile]")]
        .filter((t) => {
          const r = t.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && r.width > 0;
        })
        .every((t) => (t as HTMLElement).dataset.kind === "shape" || t.querySelector("iframe[data-placed]")),
    undefined,
    { timeout: FRAMES_TIMEOUT_MS },
  );
}

/** Scroll an element to the top of the page's scroll area. */
async function scrollTo(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector).first();
  await target.waitFor();
  await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
}

async function open(page: Page, base: string, query = ""): Promise<void> {
  await page.goto(`${base}/inventory${query}`, { waitUntil: "networkidle" });
  await page.getByTestId("inventory-headline").waitFor();
  await page.locator("[data-family]").first().waitFor();
}

async function capture(browser: Browser, base: string, out: string): Promise<string[]> {
  const files: string[] = [];
  for (const { prefix, options } of VIEWPORTS) {
    const phone = prefix.startsWith("phone");
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({ ...options, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      await open(page, base);
      // A phone shows the two-column wall; a desktop has room for the headline above it.
      if (phone) await scrollTo(page, '[data-role="button"]');
      files.push(await shoot(page, out, `${prefix}.${scheme}`));

      await open(page, base, "?type=button&project=console");
      if (phone) {
        await page.getByTestId("filter-phone").getByRole("button", { name: /Filters/ }).click();
        await page.getByRole("dialog", { name: "Filters" }).waitFor();
        files.push(await shoot(page, out, `${prefix}-filters.${scheme}`));
        await page.keyboard.press("Escape");
      } else files.push(await shoot(page, out, `inventory-filtered.${scheme}`));

      await open(page, base);
      await scrollTo(page, '[data-compare="button-1"]');
      const stage = page.locator('[data-compare="button-1"] [data-testid="compare-stage"]');
      const box = (await stage.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      files.push(await shoot(page, out, `${prefix}-compare.${scheme}`));

      await scrollTo(page, "#inventory-fixes");
      files.push(await shoot(page, out, `${prefix}-fixes.${scheme}`));

      await scrollTo(page, '[data-family="button-1"]');
      await page.locator('[data-family="button-1"]').getByRole("button", { name: /^Open / }).click();
      await page.getByTestId("family-drawer").getByRole("list", { name: "Every use" }).waitFor();
      files.push(await shoot(page, out, phone ? `${prefix}-sheet.${scheme}` : `${prefix}-drawer.${scheme}`));
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
