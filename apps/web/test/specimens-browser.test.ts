/**
 * Specimens drawn in Chromium (Playwright's headless shell) the way the hub's frames draw them
 * (frameDocument): a console whose design tokens reach the page only through its server's
 * readFileSync must paint its primary button in its accent colour, not transparent.
 * `YOUI_SPECIMEN_SHOTS=<dir>` also saves what was drawn, light and dark.
 *
 *   pnpm exec playwright-core install chromium-headless-shell   # once
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSpecimens, libraries } from "../scripts/snapshot.ts";
import { frameDocument } from "../src/screens/inventory/Specimens.tsx";
import type { SplitSpecimens } from "../src/data/inventory-split.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const SERVED = join(TOOL, "packages/scanner/test/fixtures/inventory/served");
const TRANSPARENT = "rgba(0, 0, 0, 0)";
const SHOTS = process.env.YOUI_SPECIMEN_SHOTS ? resolve(process.env.YOUI_SPECIMEN_SHOTS) : null;

let dir: string;
let browser: Browser;
let found: SplitSpecimens;
let tokensLeftOut: SplitSpecimens;
/** The specimen HTML for the look at a line of the fixture's toolbar. */
let at: (specimens: SplitSpecimens, line: number) => string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "youi-specimens-browser-"));
  process.env.YOUI_SPECIMEN_CACHE = join(dir, "cache");
  const libs = await libraries();
  const inventory = libs.core.InventoryReport.parse(await libs.scanner.buildInventory([SERVED]));
  const roots = new Map([["served", SERVED]]);
  found = (await buildSpecimens(inventory, roots, libs.scanner, null, () => {})).served!;
  // What the finder drew before: the Tailwind output and the kit, without the tokens the server inlines.
  tokensLeftOut = (await buildSpecimens(inventory, roots, libs.scanner, { root: SERVED, sheets: ["src/browser/tailwind.css", "src/browser/ui.css"], from: "a list without the tokens" }, () => {})).served!;
  at = (specimens, line) => {
    const look = inventory.looks.find((l) => l.file === "src/browser/toolbar.tsx" && l.line === line)!;
    return specimens.specimens[specimens.looks[look.id]!]!.html;
  };
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The look's computed background and colour in a hub frame for one scheme; saved as a picture when YOUI_SPECIMEN_SHOTS is set. */
async function drawn(specimens: SplitSpecimens, scheme: "light" | "dark", shot: string): Promise<Array<{ background: string; color: string }>> {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 }, deviceScaleFactor: 2, colorScheme: scheme });
  try {
    const cssFile = join(dir, `${shot}.css`);
    writeFileSync(cssFile, specimens.css![scheme]);
    const html = [8, 9, 10].map((line) => at(specimens, line)).join(" ");
    const docFile = join(dir, `${shot}.html`);
    writeFileSync(docFile, frameDocument(html, pathToFileURL(cssFile).href, scheme));
    await page.goto(pathToFileURL(docFile).href);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${shot}.png`) });
    }
    return await page.locator("#youi-specimen > *").evaluateAll((elements) => elements.map((e) => ({ background: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color })));
  } finally {
    await page.close();
  }
}

describe("a console whose tokens only its server reads, drawn in Chromium", () => {
  test("its CVA Button, Badge and .ui-button paint with the accent colour, light and dark", async () => {
    const [button, badge, kit] = await drawn(found, "light", "served-light");
    expect(button!.background).not.toBe(TRANSPARENT);
    expect(button!.background).toBe("rgb(37, 99, 235)");
    expect(button!.color).toBe("rgb(255, 255, 255)");
    expect(badge!.background).toBe("rgb(37, 99, 235)");
    expect(kit!.background).toBe("rgb(37, 99, 235)");
    const dark = await drawn(found, "dark", "served-dark");
    expect(dark.map((d) => d.background)).toEqual(["rgb(96, 165, 250)", "rgb(96, 165, 250)", "rgb(96, 165, 250)"]);
  });

  test("without the sheet the server reads, the same button is transparent: the tokens are what colour it", async () => {
    const [button, badge, kit] = await drawn(tokensLeftOut, "light", "served-without-tokens");
    expect([button!.background, badge!.background, kit!.background]).toEqual([TRANSPARENT, TRANSPARENT, TRANSPARENT]);
  });
});
