import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DetectReport } from "@youiyoux/core";
import { BrowserMissingError, launchBrowser, siteReport } from "../src/site.ts";
import { serveFixtures } from "./serve.ts";

let server: Awaited<ReturnType<typeof serveFixtures>>;
let out: string;
beforeAll(async () => {
  server = await serveFixtures();
  out = await mkdtemp(join(tmpdir(), "youi-detect-site-"));
  // On a machine without the headless shell (CI), this first launch downloads it, once.
  await (await launchBrowser()).close();
}, 300_000);
afterAll(async () => {
  await server.close();
  await rm(out, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Detect one fixture page into its own directory. */
async function detect(page: string, expose = false): Promise<{ report: DetectReport; dir: string }> {
  const dir = join(out, page.replace(/\W/g, "-"));
  return { report: await siteReport([server.url(page)], { out: dir, expose }), dir };
}

/** Every detected element type has exactly one screenshot, a real PNG beside the report. */
async function expectOneScreenshotPerType(report: DetectReport, dir: string): Promise<void> {
  expect(report.elements.length).toBeGreaterThan(0);
  const types = report.elements.map((e) => e.type);
  expect(new Set(types).size).toBe(types.length);
  for (const element of report.elements) {
    expect(element.screenshot, `${element.type} screenshot`).toMatch(/^screenshots\/p1-[a-z-]+\.png$/);
    expect((await readFile(join(dir, element.screenshot!))).subarray(0, 4)).toEqual(PNG);
  }
  expect((await readdir(join(dir, "screenshots"))).length).toBe(report.elements.length);
}

describe("website detection on fixture pages", () => {
  test("MUI: Mui* classes and --mui-* variables name MUI, with high confidence", async () => {
    const { report, dir } = await detect("mui.html");
    const top = report.libraries[0]!;
    expect(top).toMatchObject({ id: "mui", name: "MUI", confidence: "high" });
    expect(top.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["class-prefix", "css-var"]));
    expect(top.evidence.find((e) => e.kind === "css-var")?.samples).toContain("--mui-palette-primary-main");
    expect(report.elements.map((e) => e.type).sort()).toEqual(["badge", "button", "card", "input", "tabs"]);
    expect(report.elements.every((e) => e.library === "mui")).toBe(true);
    await expectOneScreenshotPerType(report, dir);
    expect(report.fonts[0]?.family).toBe("Roboto");
  });

  test("shadcn/Radix: shadcn's data-slot names first, Radix ids beside it, and --expose opens the dialog portal", async () => {
    const closed = await detect("shadcn.html");
    expect(closed.report.elements.map((e) => e.type)).not.toContain("dialog");
    expect(closed.report.coverage).toContain("pass --expose");

    const { report, dir } = await detect("shadcn.html", true);
    expect(report.libraries.slice(0, 2).map((l) => l.id)).toEqual(["shadcn", "radix"]);
    const shadcn = report.libraries[0]!;
    expect(shadcn.evidence.find((e) => e.kind === "data-slot")).toMatchObject({ strength: "strong" });
    expect(shadcn.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["tailwind", "radix-colors"]));
    expect(report.libraries.find((l) => l.id === "radix")?.evidence[0]).toMatchObject({ kind: "id-prefix", samples: expect.arrayContaining(["radix-«r2»"]) });
    // The Password tab and the dialog trigger; the selected tab is left alone.
    expect(report.pages[0]!.exposed).toBe(2);
    const dialog = report.elements.find((e) => e.type === "dialog");
    expect(dialog).toMatchObject({ library: "shadcn", also: ["radix"] });
    expect(report.elements.map((e) => e.type).sort()).toEqual(["badge", "button", "card", "dialog", "input", "tabs"]);
    expect(shadcn.evidence.find((e) => e.kind === "data-slot")?.count).toBeGreaterThanOrEqual(30);
    expect(report.notes.join(" ")).not.toMatch(/not shadcn\/ui's/);
    await expectOneScreenshotPerType(report, dir);
  });

  test("Base UI: base-ui- ids name Base UI, and its menu shows only when opened", async () => {
    const { report, dir } = await detect("base-ui.html", true);
    expect(report.libraries.map((l) => l.id)).toEqual(["base-ui"]);
    expect(report.libraries[0]!.evidence[0]).toMatchObject({ kind: "id-prefix", strength: "strong", samples: expect.arrayContaining(["base-ui-:r1:"]) });
    expect(report.elements.map((e) => e.type).sort()).toEqual(["checkbox", "input", "menu", "switch", "tabs"]);
    await expectOneScreenshotPerType(report, dir);
  });

  test("styled-components: sc- classes and the data-styled style tag", async () => {
    const { report, dir } = await detect("styled-components.html");
    expect(report.libraries.map((l) => l.id)).toEqual(["styled-components"]);
    expect(report.libraries[0]).toMatchObject({ confidence: "high" });
    expect(report.libraries[0]!.evidence.map((e) => e.kind).sort()).toEqual(["class-prefix", "style-tag"]);
    expect(report.elements.map((e) => e.type).sort()).toEqual(["button", "card", "input"]);
    await expectOneScreenshotPerType(report, dir);
  });

  test("the geist-icon false positive: no shadcn verdict, the slot is noted as not counted", async () => {
    const { report } = await detect("geist.html", true);
    expect(report.libraries.map((l) => l.id)).not.toContain("shadcn");
    expect(report.libraries).toMatchObject([{ id: "geist", confidence: "low" }]);
    expect(report.elements).toEqual([]);
    expect(report.notes.join(" ")).toContain("geist-icon (3)");
  });

  test("several URLs: coverage is per page crawled, and each library lists the pages it was seen on", async () => {
    const dir = join(out, "several");
    const urls = [server.url("mui.html"), server.url("styled-components.html"), server.url("missing.html")];
    const report = await siteReport(urls, { out: dir });
    expect(report.pages.map((p) => p.status)).toEqual(["ok", "ok", "failed"]);
    expect(report.pages[2]!.error).toBe("HTTP 404");
    expect(report.coverage).toMatch(/^Coverage is per page crawled: 2 of 3 pages loaded \(1 failed\)/);
    expect(report.libraries.find((l) => l.id === "mui")?.pages).toEqual([urls[0]]);
    expect(report.libraries.find((l) => l.id === "styled-components")?.pages).toEqual([urls[1]]);
    // One verdict per element type across the pages: MUI's input (page 1) wins, styled-components' is listed beside it.
    expect(report.elements.find((e) => e.type === "input")).toMatchObject({ library: "mui", also: ["styled-components"], page: urls[0], screenshot: "screenshots/p1-mui-input.png" });
  });

  test("a missing YOUI_CHROMIUM fails plainly, without downloading", async () => {
    await expect(siteReport([server.url("mui.html")], { out: join(out, "nobrowser"), executablePath: join(out, "no-such-chromium") })).rejects.toThrowError(BrowserMissingError);
    await expect(siteReport([server.url("mui.html")], { out: join(out, "nobrowser"), executablePath: join(out, "no-such-chromium") })).rejects.toThrowError(/no Chromium for website detection at .*no-such-chromium \(YOUI_CHROMIUM\)/);
  });
});

describe.runIf(process.env.YOUI_DETECT_LIVE === "1")("live smoke", () => {
  test("a public MUI site names MUI", async () => {
    const url = process.env.YOUI_DETECT_LIVE_URL ?? "https://mui.com/material-ui/getting-started/";
    const report = await siteReport([url], { out: join(out, "live"), timeoutMs: 60_000 });
    expect(report.pages[0]!.status).toBe("ok");
    expect(report.libraries.map((l) => l.id)).toContain("mui");
  }, 120_000);
});
