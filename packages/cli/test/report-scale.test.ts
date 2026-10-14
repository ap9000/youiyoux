/**
 * Monorepos and size (c5): a pnpm workspace gets one section per package with UI files (apps/web,
 * apps/admin, packages/ui; not tools/scripts), and a generated medium repo (about 800 source files,
 * 150 components) is reported without rendering in under 60 s, as measured here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fixtureRepo, mediumFiles, monorepoFiles, report } from "./report-fixtures.ts";

describe("youiyoux report at scale", () => {
  test("a monorepo: one section per project (c5)", async () => {
    const repo = fixtureRepo("monorepo", monorepoFiles());
    try {
      const run = await report(repo.dir);
      expect(run.code).toBe(0);
      expect(run.stdout.split("\n")[0]).toMatch(/^acme-monorepo: 3 projects, /);
      const html = readFileSync(join(repo.dir, "youiyoux-report.html"), "utf8");
      expect([...html.matchAll(/data-section="project" data-project="([^"]+)"/g)].map((m) => m[1])).toEqual(["apps/admin", "apps/web", "packages/ui"]);
      expect(html).toContain("3 workspace packages with UI files (pnpm-workspace.yaml); 1 package without UI files left out (tools/scripts)");
      for (const dir of ["apps/admin", "apps/web"]) expect(html).toContain(`<code>${dir}/src/app.tsx:5</code>`);
      expect(readFileSync(join(repo.dir, "youiyoux-summary.md"), "utf8")).toContain("(apps/");
    } finally {
      repo.remove();
    }
  }, 60_000);

  test("a medium repo, without rendering, in under 60 s (c5)", async () => {
    const files = mediumFiles();
    expect(Object.keys(files).filter((f) => /\.(tsx|ts)$/.test(f)).length).toBeGreaterThanOrEqual(800);
    const repo = fixtureRepo("medium", files, { git: false });
    try {
      const started = performance.now();
      const run = await report(repo.dir);
      const seconds = (performance.now() - started) / 1000;
      expect(run.code).toBe(0);
      expect(run.model!.render.state).toBe("off");
      expect(run.model!.totals.files).toBeGreaterThanOrEqual(800);
      expect(run.model!.totals.definitions).toBeGreaterThanOrEqual(150);
      expect(seconds).toBeLessThan(60);
    } finally {
      repo.remove();
    }
  }, 120_000);
});
