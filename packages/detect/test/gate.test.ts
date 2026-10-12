import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectChanged, runSiteTests } from "./gate.ts";

describe("site-test gating", () => {
  test("YOUI_DETECT_SITE decides when set, whatever changed", () => {
    for (const flag of ["1", "true", "TRUE"]) expect(runSiteTests(flag, [])).toBe(true);
    for (const flag of ["0", "false", "False"]) expect(runSiteTests(flag, ["packages/detect/src/site.ts"])).toBe(false);
  });

  test("unset, they run only when detect changed", () => {
    expect(runSiteTests(undefined, ["packages/detect/src/fingerprints.ts"])).toBe(true);
    expect(runSiteTests(undefined, ["README.md", "packages/core/src/detect.ts"])).toBe(true);
    expect(runSiteTests("", ["packages/detect/test/fixtures/sites/new.html"])).toBe(true);
    expect(runSiteTests(undefined, ["apps/web/src/app/App.tsx", "packages/core/src/schemas.ts", "packages/cli/src/detect.ts"])).toBe(false);
    expect(runSiteTests(undefined, [])).toBe(false);
  });

  test("unset, they run when git fails", async () => {
    expect(runSiteTests(undefined, null)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "youi-gate-"));
    try {
      expect(detectChanged(dir, {})).toBe(true);
      expect(detectChanged(dir, { YOUI_DETECT_SITE: "0" })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
