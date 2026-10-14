/** Real browser measurements through both public rendering paths, with no network. */
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { expect, test, vi } from "vitest";
import { buildInventory, buildProjectCss, newStats, projectSpecimens, SpecimenCache } from "@youiyoux/scanner";
import { main } from "../../cli/src/main.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const boxes = (page: Page) => page.locator("[data-sizing]").evaluateAll((elements) => elements.map((element) => {
  const { width, height } = element.getBoundingClientRect();
  return { name: element.getAttribute("data-sizing"), width, height };
}));
const expected = [
  { name: "radio", width: 16, height: 16 },
  { name: "badge", width: 24, height: 24 },
  { name: "icon", width: 20, height: 20 },
];

test("ignored component sources retain size, width and height utilities in specimens and youi render", async () => {
  const dir = mkdtempSync(join(tmpdir(), "youi-sizing-"));
  const root = join(dir, "app");
  cpSync(join(TOOL, "packages/scanner/test/fixtures/inventory/sizing"), root, { recursive: true });
  symlinkSync(join(TOOL, "packages/scanner/node_modules"), join(root, "node_modules"));
  // Vendored/generated components can be ignored by git but are still inventoried and rendered.
  writeFileSync(join(root, ".gitignore"), "src/radio-card.tsx\n");
  const cache = new SpecimenCache(join(dir, "cache"));
  let browser: Browser | undefined;
  try {
    const { frameDocument } = await import(join(TOOL, "apps/web/src/screens/inventory/Specimens.tsx")) as { frameDocument(html: string, css: string, scheme: string): string };
    const report = await buildInventory([root]);
    const specimens = await projectSpecimens({ id: "sizing", root, commit: null, looks: report.looks }, { cache });
    const look = report.looks.find((look) => look.recipe?.kind === "component" && look.recipe.export === "RadioCard")!;
    expect(look).toBeDefined();
    const specimen = specimens.specimens[specimens.looks[look.id]!]!;
    expect(specimen.kind).toBe("component");
    const missing = await buildProjectCss(root, ["src/app.tsx", "src/app.css"], newStats());
    browser = await chromium.launch({ headless: true });
    const before = await browser.newPage();
    await before.route("**/*", (route) => route.abort());
    await before.setContent(frameDocument(specimen.html, `data:text/css;base64,${Buffer.from(missing.light!).toString("base64")}`, "light"));
    expect((await boxes(before))[0]).toEqual({ name: "radio", width: 26, height: 44 });
    await before.close();
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ colorScheme: scheme });
      await page.route("**/*", (route) => route.abort());
      const css = `data:text/css;base64,${Buffer.from(specimens.css![scheme]).toString("base64")}`;
      await page.setContent(frameDocument(specimen.html, css, scheme));
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 480 });
        expect(await boxes(page)).toEqual(expected);
      }
      await page.close();
    }
    // Measure the actual CLI page immediately before each screenshot, preserving the render.
    const measured: Awaited<ReturnType<typeof boxes>>[] = [];
    const launch = chromium.launch.bind(chromium);
    vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
      const drawing = await launch(options);
      const newContext = drawing.newContext.bind(drawing);
      vi.spyOn(drawing, "newContext").mockImplementation(async (options) => {
        const context = await newContext(options);
        context.on("page", (page) => {
          const screenshot = page.screenshot.bind(page);
          vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
            measured.push(await boxes(page));
            return screenshot(options);
          });
        });
        return context;
      });
      return drawing;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["render", "RadioCard", "--project", root, "--json"], { render: { cache, download: false } })).toBe(0);
    expect(measured).toHaveLength(4);
    for (const measurement of measured) expect(measurement).toEqual(expected);
  } finally {
    vi.restoreAllMocks();
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
