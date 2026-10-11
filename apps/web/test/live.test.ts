import { describe, expect, test } from "vitest";
import type { Manifest } from "../src/data/types.ts";
import { liveSummary } from "../src/shell/LiveStatus.tsx";

const base: Manifest = { schema: "youiyoux.manifest/v1", source: { commit: null }, systems: [] };
const at = "2026-10-11T22:30:05.000Z";

describe("live snapshot status", () => {
  test("hidden for a one-off snapshot", () => {
    expect(liveSummary({ manifest: base, error: null })).toBeNull();
    expect(liveSummary({ manifest: null, error: null })).toBeNull();
  });

  test("live when the latest re-scan was complete, with the rules it used", () => {
    const summary = liveSummary({ manifest: { ...base, live: { generation: 3, status: "complete", updatedAt: at, rules: "demo@1.0.0 · defs abc" } }, error: null });
    expect(summary).toMatchObject({ tone: "live", detail: "demo@1.0.0 · defs abc" });
    expect(summary!.label).toMatch(/^Live: re-checked at /);
  });

  test("partial scans and failed runs never look live", () => {
    expect(liveSummary({ manifest: { ...base, live: { generation: 2, status: "partial", updatedAt: at } }, error: null })!.tone).toBe("incomplete");
    const failed = liveSummary({ manifest: { ...base, live: { generation: 4, status: "failed", updatedAt: at, message: "rules/x.rule.yaml: severity: invalid" } }, error: null })!;
    expect(failed).toMatchObject({ tone: "failed", detail: "rules/x.rule.yaml: severity: invalid" });
    expect(failed.label).toContain("showing the last good results");
  });

  test("a generation that could not be loaded is reported over whatever is on screen", () => {
    const summary = liveSummary({ manifest: { ...base, live: { generation: 3, status: "complete", updatedAt: at } }, error: "Could not load x (HTTP 404)." })!;
    expect(summary).toMatchObject({ tone: "failed", detail: "Could not load x (HTTP 404)." });
  });
});
