/**
 * The rule draft's breadcrumb at a phone's width, laid out by Chromium with Tailwind's own
 * utilities: one line, the rule's long title truncated, never "All changes" on two lines.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";
import { Router } from "wouter";
import { classCandidates } from "../scripts/frame.ts";
import { DraftBreadcrumb } from "../src/screens/rules/RulesScreen.tsx";

test("at 390px every crumb stays on one line and the title gives way", async () => {
  const markup = renderToStaticMarkup(
    <Router ssrPath="/rules/draft/d-1">
      <DraftBreadcrumb title="Native form controls are replaced by the System's own components everywhere" href="/rules/no-native-controls" />
    </Router>,
  );
  const tailwind = dirname(createRequire(import.meta.url).resolve("tailwindcss/package.json"));
  const compiler = await compile('@import "tailwindcss";', { base: tailwind, loadStylesheet: async (id: string) => ({ path: join(tailwind, "index.css"), base: tailwind, content: id === "tailwindcss" ? readFileSync(join(tailwind, "index.css"), "utf8") : readFileSync(join(tailwind, id.replace(/^tailwindcss\//, "").replace(/^\.\//, "")), "utf8") }) });
  const css = compiler.build([...classCandidates(markup)]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><style>${css}</style><body style="margin:0">${markup}</body>`);
    const lines = await page.$$eval("[data-draft-breadcrumb] > *", (crumbs) => crumbs.map((crumb) => ({ text: crumb.textContent, height: crumb.getBoundingClientRect().height, width: crumb.getBoundingClientRect().width, scroll: crumb.scrollWidth })));
    const lineHeight = lines.find((l) => l.text === "Rules")!.height;
    for (const crumb of lines) expect(crumb.height, crumb.text ?? "").toBe(lineHeight);
    const title = lines.find((l) => l.text?.startsWith("Native"))!;
    expect(title.scroll).toBeGreaterThan(title.width);
    const nav = await page.$eval("[data-draft-breadcrumb]", (el) => ({ width: el.getBoundingClientRect().width, scroll: el.scrollWidth }));
    expect(nav.scroll).toBeLessThanOrEqual(nav.width);
  } finally {
    await browser.close();
  }
}, 30_000);
