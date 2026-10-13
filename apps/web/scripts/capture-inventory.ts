/**
 * Captures the Inventory page with Playwright: playwright-core driving its headless-shell
 * Chromium (no chrome-devtools-axi, no full browser).
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 *   pnpm dev                                                    # in another terminal, then:
 *   node scripts/capture-inventory.ts [--base http://localhost:5173] [--out screenshots]
 *   node scripts/capture-inventory.ts --serve [--out screenshots]  # or: build and serve a fixture snapshot itself
 *
 * `--serve` snapshots the scanner's six inventory fixtures into apps/web/.capture (console:
 * Tailwind v4 CVA kit; site: BEM class kit and Astro components; widgets: shaped like the Toolroll
 * console, its Tailwind entry built by the CLI and linked from index.html and a server template,
 * its tokens @imported by that entry, so its CVA Button and Badge and its .ui-button draw in
 * their real colours; sketch: Tailwind classes and no stylesheet, so its button shows the
 * shape-only fallback; mobile: a back button whose most used look is display:none at the 1280px
 * desk width; storybook: a CVA Button and Badge with CSF 3 stories beside them, read statically,
 * Storybook never installed or run), builds the hub against it and serves the build with
 * `vite preview`; no app's dev server runs.
 *
 * Writes, light and dark, at 1440×900: inventory.<scheme>.png (filters, the headline and the
 * top of the wall; on a phone, the two-column wall), inventory-filtered.<scheme>.png (a filtered URL: the console's buttons),
 * inventory-compare.<scheme>.png (the 32px button's compare card, its slider dragged to 45% then
 * moved by a key, so its focus ring shows), inventory-lead.<scheme>.png (the mobile project's
 * wall: its back button's hidden phone look skipped for the desktop one),
 * inventory-compare-states.<scheme>.png (that card's States: both sides' strips, one above the
 * other), inventory-fixes.<scheme>.png (the fix list), inventory-drawer.<scheme>.png (that family
 * opened), inventory-states.<scheme>.png (its Variants tab showing States: each look default,
 * hover, focus, pressed and disabled side by side) and inventory-try-tabs.<scheme>.png (the
 * console's Tabs after Try it, its second trigger clicked in the live sandboxed frame, so it is
 * the active tab; `--serve` answers Try it from `vite preview`), inventory-stories-wall.<scheme>.png
 * (the storybook project's buttons: a family's uses and stories counted apart, and a family only
 * stories have) and inventory-stories.<scheme>.png (that family opened on Variants: its
 * Storybook-labeled story tiles beside the discovered looks); and at 390×844 on a touch phone
 * the same as phone-inventory*.png, with
 * phone-inventory-filters.<scheme>.png (the filters' bottom sheet) and
 * phone-inventory-sheet.<scheme>.png (the family's bottom sheet) for the last two. Each waits
 * until every specimen frame on screen has drawn.
 *
 * It also checks, and writes inventory-checks.json (exiting 1 when one fails): on a phone every
 * control on the page, in the filters' sheet and in a family's sheet (each tab) is at least 44px
 * tall; at both widths no family's lead tile (wall, compare and fix) is blank: each draws a
 * specimen with a visible box, or its shape.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";

const APP = resolve(import.meta.dirname, "..");
const TOOL = resolve(APP, "../..");
const FIXTURES = ["console", "site", "widgets", "sketch", "mobile", "storybook"].map((name) => join(TOOL, "packages/scanner/test/fixtures/inventory", name));
const SCHEMES = ["light", "dark"] as const;
const SETTLE_MS = 400;
const FRAMES_TIMEOUT_MS = 20_000;
const PORT = 4796;
/** A phone's smallest tap target (WCAG 2.5.5, Apple's HIG). */
const TAP_MIN = 44;
/** What a finger can press: native controls and anything focusable or given a widget role. */
const CONTROLS = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="slider"], [role="radio"], [role="tab"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
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

/** The open drawer's scroll area, nearest scrollable ancestor of `element`, scrolled so `element` sits `share` of the way down. */
function scrollInDrawer(element: Element, share: number): void {
  let scroller = element.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight * share;
}

/** Every tile wholly inside the open drawer's scroll area has drawn (tiles scrolled under its header do not mount, and are not waited for). */
async function drawerFramesDrawn(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll('[data-testid="family-drawer"] [data-tile]')];
      let scroller = tiles[0]?.parentElement ?? null;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      const area = (scroller ?? document.documentElement).getBoundingClientRect();
      return tiles
        .filter((t) => {
          const r = t.getBoundingClientRect();
          return r.width > 0 && r.top >= area.top && r.bottom <= Math.min(area.bottom, innerHeight);
        })
        .every((t) => (t as HTMLElement).dataset.kind === "shape" || t.querySelector("iframe[data-placed]"));
    },
    undefined,
    { timeout: FRAMES_TIMEOUT_MS },
  );
}

/** Every state strip on screen has drawn its frame. */
async function stripsDrawn(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const strips = [...document.querySelectorAll("[data-strip]")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0;
      });
      return strips.length > 0 && strips.every((t) => t.querySelector("iframe[data-placed]"));
    },
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

interface Checks {
  /** Per viewport and place: controls under TAP_MIN tall on a phone. */
  small: Array<{ viewport: string; where: string; control: string; height: number }>;
  /** Controls measured on a phone, per place. */
  measured: Record<string, number>;
  /** Lead tiles that drew nothing: no visible box and no shape. */
  blank: Array<{ viewport: string; scheme: string; tile: string }>;
  /** Lead tiles looked at, per viewport and scheme. */
  leads: Record<string, number>;
  /** What the mobile back button's wall tile drew, per viewport and scheme. */
  mobileLead: Record<string, string>;
}

/** Every visible control inside `root` (the Inventory screen, or an open sheet) shorter than TAP_MIN. */
async function smallControls(page: Page, root: string): Promise<{ count: number; small: Array<{ control: string; height: number }> }> {
  return page.evaluate(
    ({ root, selector, min }) => {
      const scope = document.querySelector(root);
      if (!scope) throw new Error(`${root} is not on the page`);
      const controls = [...scope.querySelectorAll<HTMLElement>(selector)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[inert]");
      });
      const name = (e: HTMLElement): string => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`;
      return { count: controls.length, small: controls.filter((e) => e.getBoundingClientRect().height < min).map((e) => ({ control: name(e), height: Math.round(e.getBoundingClientRect().height * 10) / 10 })) };
    },
    { root, selector: CONTROLS, min: TAP_MIN },
  );
}

/** Every lead tile, scrolled to in turn: the specimen it drew, or `shape`, or null when it drew nothing visible. */
async function leadTiles(page: Page): Promise<Array<{ tile: string; drew: string | null }>> {
  const selector = '[data-family] > [data-tile], [data-compare] [data-tile], [data-fix] [data-tile]';
  const count = await page.locator(selector).count();
  const results: Array<{ tile: string; drew: string | null }> = [];
  for (let i = 0; i < count; i++) {
    const tile = page.locator(selector).nth(i);
    await tile.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await framesDrawn(page);
    results.push(
      await tile.evaluate((element) => {
        const key = (element as HTMLElement).dataset.tile!;
        if ((element as HTMLElement).dataset.kind === "shape") return { tile: key, drew: "shape" };
        const doc = element.querySelector("iframe")?.contentDocument;
        const root = doc?.getElementById("youi-specimen");
        const seen = root ? [root, ...root.querySelectorAll("*")].find((e) => e !== root && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0) : undefined;
        return { tile: key, drew: seen ? seen.outerHTML.slice(0, 120) : null };
      }),
    );
  }
  return results;
}

async function check(page: Page, phone: boolean, viewport: string, scheme: string, checks: Checks): Promise<void> {
  // Every row loaded, so the compare cards and fix list are there too.
  await page.locator("[data-compare]").first().waitFor();
  const leads = await leadTiles(page);
  checks.leads[`${viewport}.${scheme}`] = leads.length;
  for (const lead of leads) if (lead.drew === null) checks.blank.push({ viewport, scheme, tile: lead.tile });
  checks.mobileLead[`${viewport}.${scheme}`] = leads.find((l) => l.tile.startsWith("wall:") && /so-(?:phone-)?back/.test(l.drew ?? ""))?.drew ?? "not found";
  if (!phone || scheme !== "light") return;
  const measure = async (where: string, root: string): Promise<void> => {
    const { count, small } = await smallControls(page, root);
    checks.measured[where] = count;
    checks.small.push(...small.map((s) => ({ viewport, where, ...s })));
  };
  await measure("page", '[data-screen="inventory"]');
  await page.getByTestId("filter-phone").getByRole("button", { name: /Filters/ }).click();
  await page.getByRole("dialog", { name: "Filters" }).waitFor();
  await page.getByRole("dialog").getByRole("searchbox").fill("button");
  await measure("filters sheet", '[role="dialog"]');
  await page.getByRole("dialog").getByRole("button", { name: /^Show / }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  // Clear filters shows only while a filter is on.
  await measure("page, filtered", '[data-screen="inventory"]');
  await page.getByTestId("filter-phone").getByRole("button", { name: "Clear filters" }).click();
  await page.locator('[data-family="button-1"]').getByRole("button", { name: /^Open / }).click();
  const sheet = page.getByTestId("family-drawer");
  await sheet.getByRole("list", { name: "Every use" }).waitFor();
  for (const tab of ["Usage", "Variants", "Code"]) {
    await sheet.getByRole("tab", { name: new RegExp(tab) }).click();
    await measure(`family sheet, ${tab}`, '[role="dialog"]');
  }
  await page.keyboard.press("Escape");
}

async function capture(browser: Browser, base: string, out: string, checks: Checks): Promise<string[]> {
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
      // A key moves it on, so its focus ring shows.
      await stage.getByRole("slider").focus();
      await page.keyboard.press("ArrowRight");
      files.push(await shoot(page, out, `${prefix}-compare.${scheme}`));
      // The same pair state by state.
      await page.locator('[data-compare="button-1"]').getByRole("radiogroup", { name: "Compare as" }).getByRole("radio", { name: "States" }).click();
      await scrollTo(page, '[data-compare="button-1"]');
      await stripsDrawn(page);
      await page.waitForTimeout(SETTLE_MS);
      const compareStates = join(out, `${prefix}-compare-states.${scheme}.png`);
      await page.screenshot({ path: compareStates });
      files.push(compareStates);

      await scrollTo(page, "#inventory-fixes");
      files.push(await shoot(page, out, `${prefix}-fixes.${scheme}`));

      await scrollTo(page, '[data-family="button-1"]');
      await page.locator('[data-family="button-1"]').getByRole("button", { name: /^Open / }).click();
      await page.getByTestId("family-drawer").getByRole("list", { name: "Every use" }).waitFor();
      files.push(await shoot(page, out, phone ? `${prefix}-sheet.${scheme}` : `${prefix}-drawer.${scheme}`));
      // Its looks in each state, from each project's own CSS.
      const drawer = page.getByTestId("family-drawer");
      await drawer.getByRole("tab", { name: /Variants/ }).click();
      await drawer.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /States/ }).click();
      await stripsDrawn(page);
      await page.waitForTimeout(SETTLE_MS);
      const statesFile = join(out, `${prefix}-states.${scheme}.png`);
      await page.screenshot({ path: statesFile });
      files.push(statesFile);
      await page.keyboard.press("Escape");

      // Try it: the console's Tabs, live; its second trigger clicked.
      await open(page, base, "?type=tabs&project=console");
      await scrollTo(page, '[data-role="tabs"]');
      const tabs = page.locator('[data-family="tabs-1"]');
      await framesDrawn(page);
      await tabs.getByRole("button", { name: /^Try / }).click();
      await tabs.locator('[data-live="drawn"]').waitFor({ timeout: FRAMES_TIMEOUT_MS });
      const live = page.frameLocator('[data-family="tabs-1"] iframe[data-live-frame]');
      await live.getByRole("tab").nth(1).click();
      await live.locator('[role="tab"][data-state="active"]').nth(0).waitFor();
      if ((await live.getByRole("tab").nth(1).getAttribute("data-state")) !== "active") throw new Error("Try it: the second tab did not become active");
      await page.waitForTimeout(SETTLE_MS);
      const tryFile = join(out, `${prefix}-try-tabs.${scheme}.png`);
      await page.screenshot({ path: tryFile });
      files.push(tryFile);
      await tabs.getByRole("button", { name: /^Done / }).click();

      await open(page, base, "?project=mobile");
      await scrollTo(page, '[data-role="button"]');
      files.push(await shoot(page, out, `${prefix}-lead.${scheme}`));

      // Storybook stories as authored states: counted apart on the wall, labeled tiles beside the uses.
      await open(page, base, "?type=button&project=storybook");
      await scrollTo(page, '[data-role="button"]');
      files.push(await shoot(page, out, `${prefix}-stories-wall.${scheme}`));
      const storied = page.locator("[data-family]").filter({ has: page.locator("[data-uses]", { hasText: /uses? · .* stor(?:y|ies)$/ }) }).first();
      await storied.getByRole("button", { name: /^Open / }).click();
      const stories = page.getByTestId("family-drawer");
      await stories.getByRole("list", { name: "Storybook stories" }).waitFor();
      await stories.getByRole("tab", { name: /Variants/ }).click();
      const firstStory = stories.locator("[data-story]").first();
      await firstStory.waitFor();
      // Only the drawer's own scroll area moves, so the wall behind it stays where it was.
      await firstStory.evaluate(scrollInDrawer, phone ? 0.1 : 0.4);
      await drawerFramesDrawn(page);
      await page.waitForTimeout(SETTLE_MS);
      const storiesFile = join(out, `${prefix}-stories.${scheme}.png`);
      await page.screenshot({ path: storiesFile });
      files.push(storiesFile);
      await page.keyboard.press("Escape");

      await open(page, base);
      await check(page, phone, prefix, scheme, checks);
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
  // The preview server answers Try it from this snapshot's try.json (vite.config.ts reads it at load).
  process.env.YOUI_HUB_SNAPSHOT = out;
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
  const checks: Checks = { small: [], measured: {}, blank: [], leads: {}, mobileLead: {} };
  try {
    for (const file of await capture(browser, (served?.base ?? values.base).replace(/\/$/, ""), out, checks)) process.stdout.write(`${file}\n`);
  } finally {
    await browser.close();
    await served?.close();
  }
  writeFileSync(join(out, "inventory-checks.json"), `${JSON.stringify(checks, null, 2)}\n`);
  const failed = [...checks.small.map((s) => `${s.viewport} ${s.where}: ${s.control} is ${s.height}px tall, under ${TAP_MIN}px`), ...checks.blank.map((b) => `${b.viewport} ${b.scheme}: lead tile ${b.tile} is blank`)];
  process.stdout.write(failed.length === 0 ? `checks passed: ${JSON.stringify(checks.measured)} controls of ${TAP_MIN}px or more on a phone; ${JSON.stringify(checks.leads)} lead tiles, none blank\n` : `${failed.join("\n")}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
