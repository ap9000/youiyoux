/**
 * `youiyoux render`: the CLI over shots.ts. JSON with four screenshots, axe's findings and a diff
 * for a changed component (c1); a second run with nothing changed draws nothing (c2); a render
 * that cannot run exits 1 and says so, never as a pass. Chromium is the installed headless
 * shell, never downloaded here.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { newShotStats, SpecimenCache, type ShotsReport } from "@youiyoux/scanner";
import { eyesRepo, pngSize, regressRadio, unlabelSearch, type EyesRepo } from "../../scanner/test/eyes-repo.ts";
import { main } from "../src/index.ts";

const SEARCH = "src/components/search-input.tsx";
const LONG = 180_000;

let repo: EyesRepo;
let cache: SpecimenCache;
let out = "";
let err = "";

beforeAll(() => {
  repo = eyesRepo();
  unlabelSearch(repo);
  cache = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-render-cache-")));
});
afterAll(() => {
  repo.remove();
  rmSync(cache.dir, { recursive: true, force: true });
});
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("youiyoux render", () => {
  test("--json: light and dark at 1280 and 390, the unlabelled input, and a diff against main, then what to do next (c1)", async () => {
    const stats = newShotStats();
    expect(await main(["render", SEARCH, "--project", repo.dir, "--json"], { render: { cache, stats, download: false } })).toBe(0);
    const report = JSON.parse(out) as ShotsReport & { next: string };
    const [search] = report.components;
    expect(search!.shots.map((s) => `${s.scheme} ${s.width}`)).toEqual(["light 1280", "light 390", "dark 1280", "dark 390"]);
    for (const shot of search!.shots) expect(pngSize(shot.path).width).toBe(shot.width);
    expect(search!.a11y.map((i) => i.rule)).toContain("label");
    expect("shots" in search!.diff).toBe(true);
    if ("shots" in search!.diff) {
      expect(search!.diff.base).toMatch(/^main /);
      for (const d of search!.diff.shots) {
        expect([d.before, d.after, d.diff].every((p) => existsSync(p))).toBe(true);
        expect(d.changed).toBeGreaterThan(0);
      }
    }
    expect(report.next).toBe(`fix the 1 accessibility issue (label), then run youiyoux render ${SEARCH} again`);
    expect(stats).toMatchObject({ renders: 1, baseRenders: 1, browsers: 1 });
  }, LONG);

  test("again with nothing changed: from the cache, with no bundle, no Tailwind and no browser; the text ends with next (c2)", async () => {
    const stats = newShotStats();
    expect(await main(["render", SEARCH, "--project", repo.dir], { render: { cache, stats, download: false } })).toBe(0);
    expect(stats).toEqual({ ...newShotStats(), hits: 1 });
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe(`${SEARCH}: 1 look (SearchInput), light and dark at 1280 and 390 px; from the cache: nothing it uses changed since it was last drawn`);
    expect(lines.filter((l) => /^ {2}(light|dark) (1280|390): \/.+\.png$/.test(l))).toHaveLength(4);
    expect(out).toMatch(/ {4}- Form elements must have labels \(label, critical/);
    expect(lines.at(-1)).toBe(`next: fix the 1 accessibility issue (label), then run youiyoux render ${SEARCH} again`);
  });

  test("a component name finds its file", async () => {
    expect(await main(["render", "SearchInput", "--project", repo.dir, "--json"], { render: { cache, download: false } })).toBe(0);
    expect((JSON.parse(out) as ShotsReport).components[0]).toMatchObject({ component: "SearchInput", file: SEARCH, cached: true });
  });

  test("nothing to draw for the target: exit 1, said plainly", async () => {
    expect(await main(["render", "Nope", "--project", repo.dir], { render: { cache, download: false } })).toBe(1);
    expect(out).toContain('no component or file "Nope" in the project');
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/^next: /);
  });

  test("no Chromium: exit 1, and the message says nothing was checked", async () => {
    const fresh = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-render-cache-")));
    const saved = process.env.YOUI_CHROMIUM;
    process.env.YOUI_CHROMIUM = join(fresh.dir, "no-chromium");
    try {
      expect(await main(["render", SEARCH, "--project", repo.dir], { render: { cache: fresh, download: false } })).toBe(1);
      expect(err).toMatch(/youiyoux render could not run: no Chromium for youiyoux render at .*no-chromium \(YOUI_CHROMIUM\).*Nothing was checked; this is not a pass/);
    } finally {
      if (saved === undefined) delete process.env.YOUI_CHROMIUM;
      else process.env.YOUI_CHROMIUM = saved;
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  }, LONG);

  test("help lists it", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("render [file|component…] [--base ref] [--json]");
  });
});


test("CLI reports only introduced issues in next, with fixed and pre-existing findings explained (c4)", async () => {
  const fixture = eyesRepo({ a11y: true });
  try {
    expect(await main(["render", "RadioCard", "--project", fixture.dir], { render: { cache, download: false } })).toBe(0);
    expect(out).toContain("pre-existing: already at main");
    expect(out.trimEnd().split("\n").at(-1)).not.toContain("fix the");
    regressRadio(fixture);
    out = "";
    expect(await main(["render", "RadioCard", "--project", fixture.dir, "--json"], { render: { cache, download: false } })).toBe(0);
    const report = JSON.parse(out) as ShotsReport & { next: string };
    expect(report.components[0]!.a11y.find((i) => i.rule === "button-name")?.status).toBe("fixed");
    expect(report.components[0]!.a11y.find((i) => i.rule === "label")?.status).toBe("new");
    expect(report.components[0]!.a11y.find((i) => i.rule === "label")?.specimenOnly).toBeNull();
    expect(report.components[0]!.looks.every((l) => l.startsWith("RadioGroup >"))).toBe(true);
    expect(report.next).toContain("label");
    expect(report.next).not.toContain("button-name");
  } finally { fixture.remove(); }
}, LONG);
