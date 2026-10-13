/**
 * `youi render` / ui_render underneath: a changed component drawn in headless Chromium (the
 * installed headless shell; never downloaded here), light and dark at desktop and phone width,
 * with axe's findings and a diff against the base commit (c1); and nothing drawn again that did
 * not change (c2). The fixture is the `eyes` app, copied into a fresh git repository.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadInventoryTarget, newShotStats, renderShots, SHOT_WIDTHS, shotsText, SpecimenCache, type ShotsReport, type ShotStats } from "../src/index.ts";
import { eyesRepo, pngSize, regressRadio, unlabelSearch, type EyesRepo } from "./eyes-repo.ts";

const SEARCH = "src/components/search-input.tsx";
const LONG = 180_000;

let repo: EyesRepo;
let cache: SpecimenCache;
let first: ShotsReport;
let firstStats: ShotStats;

const render = async (targets: readonly string[], dir = repo.dir, base?: string): Promise<{ report: ShotsReport; stats: ShotStats }> => {
  const stats = newShotStats();
  const report = await renderShots(dir, targets, { cache, stats, download: false, ...(base ? { base } : {}) });
  return { report, stats };
};

beforeAll(async () => {
  repo = eyesRepo();
  cache = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-shots-cache-")));
  unlabelSearch(repo);
  ({ report: first, stats: firstStats } = await render([SEARCH]));
}, LONG);

afterAll(() => {
  repo.remove();
  rmSync(cache.dir, { recursive: true, force: true });
});

describe("a changed component, seen (c1)", () => {
  test("light and dark screenshots at desktop and phone width, as PNGs that exist at those widths", () => {
    const [search] = first.components;
    expect(search).toMatchObject({ component: SEARCH, file: SEARCH, cached: false, looks: ["SearchInput"] });
    expect(search!.shots.map((s) => `${s.scheme} ${s.width}`)).toEqual(["light 1280", "light 390", "dark 1280", "dark 390"]);
    for (const shot of search!.shots) {
      expect(existsSync(shot.path)).toBe(true);
      expect(pngSize(shot.path).width).toBe(shot.width);
      // Outside the project: nothing is written into it.
      expect(shot.path.startsWith(cache.dir)).toBe(true);
    }
    const light = search!.shots.find((s) => s.scheme === "light" && s.width === 1280)!;
    const dark = search!.shots.find((s) => s.scheme === "dark" && s.width === 1280)!;
    expect(readFileSync(light.path).equals(readFileSync(dark.path))).toBe(false);
    expect(SHOT_WIDTHS).toEqual([1280, 390]);
  });

  test("accessibility issues from axe name the rule and the element: the unlabelled input", () => {
    const label = first.components[0]!.a11y.find((i) => i.rule === "label");
    expect(label).toBeDefined();
    expect(label).toMatchObject({ impact: "critical", schemes: ["light", "dark"], widths: [1280, 390], count: 1 });
    expect(label!.targets[0]!.html).toMatch(/^<input type="search"/);
    expect(label!.help).toMatch(/label/i);
  });

  test("a before/after diff against the base commit: before, after and diff images, and the share of pixels that changed", () => {
    const { diff } = first.components[0]!;
    expect("shots" in diff).toBe(true);
    if (!("shots" in diff)) return;
    expect(diff.base).toMatch(/^main \([0-9a-f]{7}\)$/);
    expect(diff.shots).toHaveLength(4);
    for (const shot of diff.shots) {
      for (const path of [shot.before, shot.after, shot.diff]) expect(existsSync(path)).toBe(true);
      expect(shot.changed).toBeGreaterThan(0);
      expect(shot.changed).toBeLessThan(0.05);
      expect(pngSize(shot.diff).width).toBe(shot.width);
    }
    expect(first.components[0]!.notes).toContain(`drawn from main: ${SEARCH}`);
    expect(firstStats).toMatchObject({ renders: 1, baseRenders: 1, browsers: 1, bundles: 2, tailwindCompiles: 1 });
  });

  test("the plain text names every image and ends with what to do next", () => {
    const text = shotsText(first);
    for (const shot of first.components[0]!.shots) expect(text).toContain(shot.path);
    expect(text).toMatch(/before\/after against main \([0-9a-f]{7}\): pixels changed [\d.]+% in light 1280/);
    expect(text).toMatch(/Form elements must have labels \(label, critical, 1 element in light and dark\): <input type="search"/);
    expect(text.split("\n").at(-1)).toBe(`next: fix the 1 accessibility issue (label), then run youi render ${SEARCH} again`);
  });

  test("by component name, outside git: its file is found, and the diff says there is no base", async () => {
    const plain = eyesRepo({ git: false });
    try {
      const { report, stats } = await render(["Badge"], plain.dir);
      expect(report.base).toBeNull();
      expect(report.components[0]).toMatchObject({ component: "Badge", file: "src/components/badge.tsx", diff: { none: "no base: not a git checkout" }, a11y: [] });
      expect(report.components[0]!.shots).toHaveLength(4);
      expect(stats.renders).toBe(1);
      expect(shotsText(report).split("\n").at(-1)).toBe("next: look at the screenshots and check them against what you meant; no accessibility issues were found");
    } finally {
      plain.remove();
    }
  }, LONG);

  test("a new component has no before render, and says so", async () => {
    repo.write("src/components/chip.tsx", `export function Chip() {\n  return <span className="rounded-full bg-slate-200 px-2 text-xs text-slate-900">Chip</span>;\n}\n`);
    try {
      const { report } = await render(["src/components/chip.tsx"]);
      expect(report.components[0]).toMatchObject({ file: "src/components/chip.tsx", looks: ["Chip"], diff: { none: "new component: src/components/chip.tsx is not in main, so there is no before render" } });
      expect(report.components[0]!.notes).toContain("no site in the project renders Chip yet: drawn with no props");
    } finally {
      rmSync(join(repo.dir, "src/components/chip.tsx"));
    }
  }, LONG);

  test("a target that matches nothing is said plainly, with no browser started", async () => {
    const { report, stats } = await render(["Nope"]);
    expect(report.components[0]).toMatchObject({ component: "Nope", shots: [], notes: ['no component or file "Nope" in the project: pass a file path inside it or an exported component name'] });
    expect(stats).toMatchObject({ browsers: 0, renders: 0, bundles: 0 });
    expect(shotsText(report).split("\n").at(-1)).toBe("next: pass a file that defines or uses a component, or an exported component name");
  });
});

describe("unchanged components are not drawn again (c2)", () => {
  test("the same target again, nothing changed: from the cache, with no bundle, no Tailwind and no browser", async () => {
    const { report, stats } = await render([SEARCH]);
    expect(report.components[0]!.cached).toBe(true);
    expect(report.components[0]!.shots).toEqual(first.components[0]!.shots);
    expect(stats).toEqual({ ...newShotStats(), hits: 1 });
    expect(shotsText(report)).toContain("from the cache: nothing it uses changed since it was last drawn");
  });

  test("with no target, only components whose files changed are drawn; after editing one of two, only that one", async () => {
    repo.edit("src/components/button.tsx", "bg-blue-700", "bg-blue-900");
    repo.edit("src/components/badge.tsx", "bg-emerald-700", "bg-emerald-800");
    const both = await render([]);
    expect(both.report.components.map((c) => [c.file, c.cached])).toEqual([
      ["src/components/badge.tsx", false],
      ["src/components/button.tsx", false],
      [SEARCH, true],
    ]);
    expect(both.stats).toMatchObject({ renders: 2, baseRenders: 2, browsers: 1 });

    repo.edit("src/components/badge.tsx", "bg-emerald-800", "bg-emerald-900");
    const one = await render([]);
    expect(one.report.components.map((c) => [c.file, c.cached])).toEqual([
      ["src/components/badge.tsx", false],
      ["src/components/button.tsx", true],
      [SEARCH, true],
    ]);
    // The badge alone is drawn; its base side was drawn last time and is reused.
    expect(one.stats).toMatchObject({ renders: 1, baseRenders: 0, browsers: 1, hits: 2, misses: 1 });
    const badge = one.report.components[0]!;
    expect("shots" in badge.diff && badge.diff.shots.every((s) => s.changed > 0)).toBe(true);
  }, LONG);

  test("with nothing changed since the base: nothing drawn, no browser, and the unchanged components listed", async () => {
    const fresh = eyesRepo();
    try {
      const { report, stats } = await render([], fresh.dir);
      expect(report.components).toEqual([]);
      expect(report.unchanged).toEqual(["src/components/badge.tsx", "src/components/button.tsx", SEARCH]);
      expect(stats).toEqual(newShotStats());
      const text = shotsText(report).split("\n");
      expect(text[0]).toMatch(/^unchanged since main \([0-9a-f]{7}\), not re-rendered: 3 component files \(src\/components\/badge\.tsx, /);
      expect(text.at(-1)).toBe("next: nothing changed since the base; nothing to do");
    } finally {
      fresh.remove();
    }
  });
});


describe("accessibility attribution (c3, c4)", () => {
  test("representative names and required parents expose label regressions; unsuppliable names remain specimen-only", async () => {
    const fixture = eyesRepo({ a11y: true });
    try {
      const initial = await render(["IconButton", "RadioCard", "LinkedButton"], fixture.dir);
      const icon = initial.report.components[0]!;
      expect(icon.a11y.find((i) => i.rule === "button-name")).toBeUndefined();
      expect(initial.report.components[2]!.a11y.find((i) => i.rule === "button-name")).toMatchObject({ status: "pre-existing", specimenOnly: ["aria-labelledby"] });
      expect(shotsText(initial.report)).toContain("specimen-only: real usages pass aria-labelledby, which the specimen cannot supply");
      expect(shotsText(initial.report).split("\n").at(-1)).not.toContain("fix the");
      const radio = initial.report.components[1]!;
      expect(radio.looks.every((l) => l.startsWith("RadioGroup >"))).toBe(true);
      expect(radio.notes.join(" ")).not.toMatch(/did not render|drawn from its tag/);
      expect(radio.a11y.some((i) => i.rule === "label")).toBe(false);
      expect(radio.a11y.find((i) => i.rule === "button-name")).toMatchObject({ status: "pre-existing", specimenOnly: null });
      expect(shotsText(initial.report)).toContain("already at main");
      expect(initial.stats.baseRenders).toBe(0);

      // A visual edit must not turn an existing name issue into a regression.
      fixture.edit("src/components/radio-card.tsx", "p-4", "p-6");
      const styled = await render(["RadioCard"], fixture.dir);
      expect(styled.report.components[0]!.a11y.find((i) => i.rule === "button-name")?.status).toBe("pre-existing");
      expect(shotsText(styled.report).split("\n").at(-1)).not.toContain("fix the");

      regressRadio(fixture);
      const changed = await render(["RadioCard"], fixture.dir);
      const issues = changed.report.components[0]!.a11y;
      expect(issues.find((i) => i.rule === "label")).toMatchObject({ status: "new", specimenOnly: null });
      expect(issues.find((i) => i.rule === "color-contrast")).toMatchObject({ status: "new", specimenOnly: null });
      expect(issues.find((i) => i.rule === "button-name")).toMatchObject({ status: "fixed", specimenOnly: null });
      expect(changed.stats.baseRenders).toBe(0);
      const text = shotsText(changed.report);
      expect(text).toContain("fixed by this change");
      expect(text.split("\n").at(-1)).toContain("color-contrast");
      expect(text.split("\n").at(-1)).toContain("label");
      expect(text.split("\n").at(-1)).not.toContain("button-name");
      const cached = await render(["RadioCard"], fixture.dir);
      expect(cached.report.components[0]!.a11y).toEqual(issues);
      expect(cached.stats).toEqual({ ...newShotStats(), hits: 1 });
    } finally { fixture.remove(); }
  }, LONG);

  test("mixed usages never hide a real name issue, and expression-only metadata invalidates the cache", async () => {
    const fixture = eyesRepo({ a11y: true });
    try {
      const first = await render(["IconButton"], fixture.dir);
      expect(first.report.components[0]!.a11y.some((i) => i.rule === "button-name")).toBe(false);
      fixture.edit("src/app.tsx", "<div><LinkedButton", "<div><IconButton /><LinkedButton");
      const mixed = await render(["IconButton"], fixture.dir);
      expect(mixed.report.components[0]!.looks).toHaveLength(2);
      expect(mixed.report.components[0]!.cached).toBe(false);
      expect(mixed.report.components[0]!.a11y.find((i) => i.rule === "button-name")!.specimenOnly).toBeNull();
    } finally { fixture.remove(); }
  }, LONG);

  test("without a base findings are not-compared and never presented as introduced by the change", async () => {
    const fixture = eyesRepo({ a11y: true, git: false });
    try {
      const { report } = await render(["RadioCard"], fixture.dir);
      expect(report.components[0]!.a11y.find((i) => i.rule === "button-name")?.status).toBe("not-compared");
      expect(shotsText(report).split("\n").at(-1)).toContain("choose a valid git base");
    } finally { fixture.remove(); }
  }, LONG);
});

describe("a cloned repo cannot steer where renders are written", () => {
  test("a configured id is used only when it is a plain name; otherwise the derived id", async () => {
    const fixture = eyesRepo({ git: false });
    try {
      for (const [id, kept] of [["shop-web", true], ["shop.web_2", true], ["../../escape", false], ["a/b", false], ["..", false], ["x..y", false], ["/abs", false], ["", false]] as const) {
        fixture.write("youi.project.json", JSON.stringify({ id }));
        const target = await loadInventoryTarget(fixture.dir);
        expect(target.id === id).toBe(kept);
        expect(target.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/i);
      }
    } finally {
      fixture.remove();
    }
  });

  test("a youi.project.json id of ../../escape renders, and every path stays inside the cache", async () => {
    const fixture = eyesRepo();
    const parent = mkdtempSync(join(tmpdir(), "youi-shots-escape-"));
    const contained = new SpecimenCache(join(parent, "cache"));
    try {
      fixture.write("youi.project.json", JSON.stringify({ id: "../../escape" }));
      const report = await renderShots(fixture.dir, [SEARCH], { cache: contained, stats: newShotStats(), download: false });
      const [search] = report.components;
      expect(search!.shots).toHaveLength(4);
      const paths = [...search!.shots.map((s) => s.path), ...("shots" in search!.diff ? search!.diff.shots.flatMap((s) => [s.before, s.after, s.diff]) : [])];
      for (const path of paths) expect(resolve(path).startsWith(`${resolve(contained.dir)}${sep}`)).toBe(true);
      // Nothing was created next to the cache (where "shots/../../escape-…" would land) or in the project.
      expect(readdirSync(parent)).toEqual(["cache"]);
      expect(readdirSync(join(contained.dir, "shots")).every((name) => !name.includes(".."))).toBe(true);
      expect(existsSync(join(fixture.dir, "..", "escape"))).toBe(false);
    } finally {
      fixture.remove();
      rmSync(parent, { recursive: true, force: true });
    }
  }, LONG);
});
