/**
 * Rendered looks (c4). With no Chromium (an empty PLAYWRIGHT_BROWSERS_PATH, no YOUI_CHROMIUM)
 * everything else is there and the report says how to turn the looks on; nothing is downloaded (the
 * stand-in downloader fails the test). --render without a terminal or --yes stops with the
 * instruction and writes nothing; a declined question goes on without looks; --yes downloads
 * (stood in here) without asking. With the installed headless shell, the most-used components'
 * looks are embedded as PNG data URIs, drawn into a temporary specimen cache, never the repo.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SpecimenCache } from "@youiyoux/scanner";
import { fixtureRepo, report, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

let repo: FixtureRepo;
let cache: SpecimenCache;
const html = (): string => readFileSync(join(repo.dir, "youiyoux-report.html"), "utf8");
const written = (): boolean => ["youiyoux-report.html", "youiyoux-card.png", "youiyoux-summary.md"].some((f) => existsSync(join(repo.dir, f)));
const clean = (): void => {
  for (const f of ["youiyoux-report.html", "youiyoux-card.png", "youiyoux-summary.md"]) rmSync(join(repo.dir, f), { force: true });
};

beforeAll(() => {
  repo = fixtureRepo("render", singleFiles(), { link: true });
  cache = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-report-cache-")));
});
afterAll(() => {
  repo.remove();
  rmSync(cache.dir, { recursive: true, force: true });
});

describe("youiyoux report without a browser", () => {
  test("everything but the looks, and how to turn them on; nothing downloaded (c4)", async () => {
    clean();
    const run = await report(repo.dir);
    expect(run.code).toBe(0);
    const page = html();
    for (const section of ["top-fixes", "projects", "libraries", "inventory", "near-duplicates", "hardcoded", "off-library"]) expect(page).toContain(`data-section="${section}"`);
    expect(page).toContain('data-render="off"');
    expect(page).toContain("Rendered looks are off: no Chromium was found. Run npx youiyoux --render");
    expect(page).not.toContain("data:image/png");
    expect(readFileSync(join(repo.dir, "youiyoux-summary.md"), "utf8")).toContain("Run npx youiyoux --render");
    expect(run.stdout.split("\n").at(-1)).toContain("to add rendered looks, run npx youiyoux --render");
  });

  test("--render with no terminal and no --yes stops, says how, and writes nothing", async () => {
    clean();
    const run = await report(repo.dir, { render: true });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Run npx youiyoux --render --yes to allow the download");
    expect(written()).toBe(false);
  });

  test("--render asks first; declined, the report goes on without looks", async () => {
    clean();
    const asked: string[] = [];
    const run = await report(repo.dir, { render: true }, { interactive: true, ask: async (q) => (asked.push(q), false) });
    expect(run.code).toBe(0);
    expect(asked).toEqual(["Download the headless Chromium (~100 MB, once) to draw the most-used components?"]);
    expect(html()).toContain("the download was declined");
  });

  test("--render --yes downloads without asking, and says so when it could not", async () => {
    clean();
    let downloads = 0;
    const run = await report(repo.dir, { render: true, yes: true }, { ask: async () => { throw new Error("asked despite --yes"); }, download: async () => (downloads++, false) });
    expect(run.code).toBe(0);
    expect(downloads).toBe(1);
    expect(run.stderr).toContain("downloading the headless Chromium (~100 MB, once)");
    expect(html()).toContain("The headless Chromium could not be downloaded");
  });
});

describe("youiyoux report with the installed headless shell", () => {
  test("embeds the most-used components' looks, light and dark (c4)", async () => {
    clean();
    const before = repo.snapshot();
    const run = await report(repo.dir, {}, { browsers: "installed", cache });
    expect(run.code).toBe(0);
    const page = html();
    expect(page).toContain('data-render="drawn"');
    const figures = [...page.matchAll(/<figure data-component="([^"]+)">([\s\S]*?)<\/figure>/g)];
    expect(figures.map((f) => f[1])).toContain("Button");
    const button = figures.find((f) => f[1] === "Button")![2]!;
    expect(button).toMatch(/<img alt="Button, light" src="data:image\/png;base64,[A-Za-z0-9+/=]{200,}">/);
    expect(button).toMatch(/<img alt="Button, dark" src="data:image\/png;base64,[A-Za-z0-9+/=]{200,}">/);
    expect(run.stdout).not.toContain("--render");
    // The images came from the specimen cache; the repo gained only the three outputs.
    const added = [...repo.snapshot().keys()].filter((f) => !before.has(f)).sort();
    expect(added).toEqual(["youiyoux-card.png", "youiyoux-report.html", "youiyoux-summary.md"]);
  }, 180_000);
});
