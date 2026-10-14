/**
 * The report in a real browser (c2): the installed headless shell, never downloaded here, with
 * every request intercepted. Loading it asks for nothing; at 1280 and 390 px, light and dark,
 * nothing overflows sideways, and dark mode really is dark. Uses the monorepo fixture too, so a
 * page with several projects is laid out as well.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import { fixtureRepo, monorepoFiles, report, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

const repos: FixtureRepo[] = [];
const pages: Record<string, string> = {};
let browser: Awaited<ReturnType<typeof launchBrowser>>;

beforeAll(async () => {
  for (const [name, files] of [["single", singleFiles()], ["monorepo", monorepoFiles()]] as const) {
    const repo = fixtureRepo(`layout-${name}`, files);
    repos.push(repo);
    await report(repo.dir);
    pages[name] = readFileSync(join(repo.dir, "youiyoux-report.html"), "utf8");
  }
  browser = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false, purpose: { what: "the report layout test", command: "youiyoux report" } });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  for (const repo of repos) repo.remove();
});

const luminance = (rgb: string): number => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number) as [number, number, number];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

describe("youiyoux-report.html in Chromium", () => {
  for (const name of ["single", "monorepo"]) {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1280, 390]) {
        test(`${name}, ${scheme} at ${width} px: no requests, no sideways overflow, the scheme's background`, async () => {
          const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height: 800 } });
          const requests: string[] = [];
          await context.route("**/*", (route) => {
            requests.push(route.request().url());
            return route.abort();
          });
          try {
            const page = await context.newPage();
            await page.setContent(pages[name]!, { waitUntil: "load" });
            const facts = await page.evaluate(() => ({
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              wide: [...document.querySelectorAll("main *")].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((el) => el.tagName).slice(0, 5),
              background: getComputedStyle(document.body).backgroundColor,
              text: getComputedStyle(document.body).color,
              sections: document.querySelectorAll("[data-section=project]").length,
            }));
            expect(requests).toEqual([]);
            expect(facts.overflow).toBe(0);
            expect(facts.wide).toEqual([]);
            if (scheme === "dark") {
              expect(luminance(facts.background)).toBeLessThan(0.15);
              expect(luminance(facts.text)).toBeGreaterThan(0.7);
            } else {
              expect(luminance(facts.background)).toBeGreaterThan(0.9);
              expect(luminance(facts.text)).toBeLessThan(0.2);
            }
            expect(facts.sections).toBe(name === "monorepo" ? 3 : 1);
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
