/**
 * Captures the Inventory page with Playwright: playwright-core driving its headless-shell
 * Chromium (no chrome-devtools-axi, no full browser).
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 *   pnpm dev                                                    # in another terminal
 *   node scripts/capture-inventory.ts [--base http://localhost:5173] [--out screenshots]
 *
 * Writes, light and dark: inventory.<scheme>.png (1440×900, the top: roles by project and
 * flags), inventory-families.<scheme>.png (scrolled to the button families and their
 * near-duplicates), and the same two at 390×844 on a touch phone as phone-inventory*.png.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

const SCHEMES = ["light", "dark"] as const;
const SETTLE_MS = 400;
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
      await context.close();
    }
  }
  return files;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { base: { type: "string", default: "http://localhost:5173" }, out: { type: "string", default: "screenshots" } } });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  // Playwright's own headless shell; `pnpm exec playwright-core install chromium-headless-shell` fetches it.
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of await capture(browser, values.base.replace(/\/$/, ""), out)) process.stdout.write(`${file}\n`);
  } finally {
    await browser.close();
  }
}

await main();
