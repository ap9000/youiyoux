/**
 * Captures the Discover page with Playwright (playwright-core and its headless-shell Chromium):
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 *   node scripts/capture-discover.ts [--out screenshots]
 *
 * It builds a Discover cache from recorded responses (discover-fixture.ts: the fixture catalog,
 * and the source of the items it opens, recorded into the cache as an earlier open would have left
 * it), builds the hub against the committed demo snapshot (its inventory and try.json: the
 * console fixture is the user's project) and serves the build with `vite preview` on that cache.
 * Nothing reaches the network: the browser's requests to anything but this machine are aborted
 * and listed, the cache's source/ must hold only what was recorded afterwards, and either fails
 * the capture.
 *
 * Writes, light and dark, at 1440×900 and (prefixed `phone-`) at 390×844 on a touch phone:
 * discover-search.<scheme>.png (a search for "command menu": licences, signals, install
 * commands), discover-preview.<scheme>.png (shadcn's command opened: drawn in the console's theme,
 * light and dark, its state strip, what was and was not themed; on a phone the bottom sheet) and
 * discover-compare.<scheme>.png (Find alternatives from the console's 32px button: the family
 * pinned and shadcn's button beside it, its slider dragged to 48%, and the attribute table).
 * It also checks that on a phone every control on the page and in the candidate's sheet is at
 * least 44px tall, writing discover-checks.json, and exits 1 when one is not.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { discoverFixture, RECORDED_SOURCES } from "./discover-fixture.ts";

const APP = resolve(import.meta.dirname, "..");
const SCHEMES = ["light", "dark"] as const;
const SETTLE_MS = 500;
const DRAW_TIMEOUT_MS = 60_000;
const PORT = 4793;
const TAP_MIN = 44;
const CONTROLS = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="slider"], [role="radio"], [role="tab"], [tabindex]:not([tabindex="-1"])';
const VIEWPORTS = [
  { prefix: "", options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  { prefix: "phone-", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
] as const;
const COMMAND = "lib:shadcn/component/command";
const BUTTON = "lib:shadcn/component/button";

/** Every specimen tile on screen has drawn its frame. */
async function framesDrawn(page: Page, scope = "body"): Promise<void> {
  await page.waitForFunction(
    (scope) =>
      [...document.querySelectorAll(`${scope} [data-tile]`)]
        .filter((t) => {
          const r = t.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && r.width > 0;
        })
        .every((t) => (t as HTMLElement).dataset.kind === "shape" || t.querySelector("iframe[data-placed]")),
    scope,
    { timeout: DRAW_TIMEOUT_MS },
  );
}

async function shoot(page: Page, out: string, name: string): Promise<string> {
  await framesDrawn(page);
  await page.waitForTimeout(SETTLE_MS);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function smallControls(page: Page, root: string): Promise<{ count: number; small: Array<{ control: string; height: number }> }> {
  return page.evaluate(
    ({ root, selector, min }) => {
      const scope = document.querySelector(root);
      if (!scope) throw new Error(`${root} is not on the page`);
      const controls = [...scope.querySelectorAll<HTMLElement>(selector)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[inert]") && !e.closest("[aria-hidden=true]");
      });
      const name = (e: HTMLElement): string => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`;
      return { count: controls.length, small: controls.filter((e) => e.getBoundingClientRect().height < min).map((e) => ({ control: name(e), height: Math.round(e.getBoundingClientRect().height * 10) / 10 })) };
    },
    { root, selector: CONTROLS, min: TAP_MIN },
  );
}

interface Checks {
  small: Array<{ where: string; control: string; height: number }>;
  measured: Record<string, number>;
  /** Requests the browser tried to anything but this machine (aborted). */
  offsite: string[];
}

async function capture(browser: Browser, base: string, out: string, checks: Checks): Promise<string[]> {
  const files: string[] = [];
  for (const { prefix, options } of VIEWPORTS) {
    const phone = prefix === "phone-";
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({ ...options, colorScheme: scheme, reducedMotion: "reduce" });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
        checks.offsite.push(url.href);
        return route.abort();
      });
      const page = await context.newPage();

      // Search by need: listings only.
      await page.goto(`${base}/discover?q=command%20menu`, { waitUntil: "networkidle" });
      await page.locator(`[data-hit="${COMMAND}"]`).waitFor();
      files.push(await shoot(page, out, `${prefix}discover-search.${scheme}`));
      if (phone && scheme === "light") {
        const page1 = await smallControls(page, '[data-screen="discover"]');
        checks.measured.page = page1.count;
        checks.small.push(...page1.small.map((s) => ({ where: "page", ...s })));
      }

      // Opened: shadcn's command, in the console's theme.
      await page.locator(`[data-hit="${COMMAND}"]`).getByRole("button", { name: /^Preview / }).click();
      const drawer = page.getByTestId("candidate-drawer");
      await drawer.locator("[data-drawn]").waitFor({ timeout: DRAW_TIMEOUT_MS });
      await framesDrawn(page, '[data-testid="candidate-drawer"]');
      await drawer.locator("[data-strip] iframe[data-placed]").waitFor({ timeout: DRAW_TIMEOUT_MS });
      files.push(await shoot(page, out, `${prefix}discover-preview.${scheme}`));
      if (phone && scheme === "light") {
        const sheet = await smallControls(page, '[role="dialog"]');
        checks.measured.sheet = sheet.count;
        checks.small.push(...sheet.small.map((s) => ({ where: "candidate sheet", ...s })));
      }
      await page.keyboard.press("Escape");

      // Find alternatives from the console's 32px button: pinned, and shadcn's button beside it.
      await page.goto(`${base}/inventory`, { waitUntil: "networkidle" });
      await page.locator('[data-family="button-1"]').getByRole("button", { name: /^Open / }).click();
      await page.getByRole("link", { name: /Find alternatives/ }).click();
      await page.waitForURL(/\/discover\?/);
      await page.locator('[data-pinned="button-1"] [data-tile]').waitFor();
      await page.locator(`[data-hit="${BUTTON}"]`).getByRole("button", { name: /^Preview / }).click();
      await page.getByTestId("candidate-drawer").locator("[data-drawn]").waitFor({ timeout: DRAW_TIMEOUT_MS });
      await page.keyboard.press("Escape");
      // Focus goes back to the result that opened it (which scrolls it into view): only then scroll to the pin.
      await page.getByTestId("candidate-drawer").waitFor({ state: "detached" });
      await page.waitForTimeout(SETTLE_MS);
      const compare = page.locator(`[data-pinned-compare="${BUTTON}"]`);
      await compare.locator('[data-layer="top"] iframe[data-placed]').waitFor({ timeout: DRAW_TIMEOUT_MS });
      await page.locator('[data-pinned="button-1"]').evaluate((element) => element.scrollIntoView({ block: "start" }));
      const stage = compare.getByTestId("pinned-stage");
      const box = (await stage.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.48, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      files.push(await shoot(page, out, `${prefix}discover-compare.${scheme}`));
      await context.close();
    }
  }
  return files;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string", default: "screenshots" } } });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const work = join(APP, ".capture-discover");
  rmSync(work, { recursive: true, force: true });
  const { cache } = await discoverFixture(join(work, "discover"), RECORDED_SOURCES);
  const recorded = readdirSync(join(cache, "source")).sort();
  const dist = join(work, "dist");
  execFileSync(process.execPath, [join(APP, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: APP, stdio: ["ignore", "ignore", "inherit"] });
  process.env.YOUI_DISCOVER_CACHE = cache;
  const { preview } = await import("vite");
  const server = await preview({ root: APP, configFile: join(APP, "vite.config.ts"), build: { outDir: dist }, preview: { port: PORT, strictPort: true }, logLevel: "error" });
  const browser = await chromium.launch({ headless: true });
  const checks: Checks = { small: [], measured: {}, offsite: [] };
  try {
    for (const file of await capture(browser, `http://localhost:${PORT}`, out, checks)) process.stdout.write(`${file}\n`);
  } finally {
    await browser.close();
    await server.close();
  }
  const fetched = readdirSync(join(cache, "source")).sort().filter((f) => !recorded.includes(f));
  writeFileSync(join(out, "discover-checks.json"), `${JSON.stringify({ ...checks, fetchedSources: fetched }, null, 2)}\n`);
  rmSync(work, { recursive: true, force: true });
  const failed = [...checks.small.map((s) => `phone ${s.where}: ${s.control} is ${s.height}px tall, under ${TAP_MIN}px`), ...checks.offsite.map((u) => `a request left this machine: ${u}`), ...fetched.map((f) => `a source was fetched during the capture: ${f}`)];
  process.stdout.write(failed.length === 0 ? `checks passed: ${JSON.stringify(checks.measured)} controls of ${TAP_MIN}px or more on a phone; no request left this machine; nothing fetched\n` : `${failed.join("\n")}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
