/**
 * The app's fingerprint (every source file hashed) costs: readings for display share one
 * calculation and reuse it briefly, while filing and addressed always compute it anew (review
 * round 1, finding 6). appFingerprint is wrapped to count its calculations.
 */
import { describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { behaviourEvidence, behaviourRouteView } from "../src/index.ts";
import { behaviourSandbox, control, TOOL } from "./behaviour-sandbox.ts";

const counted = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@youiyoux/scanner", async (original) => {
  const real = await original<typeof import("@youiyoux/scanner")>();
  return { ...real, appFingerprint: (...args: Parameters<typeof real.appFingerprint>) => (counted.calls++, real.appFingerprint(...args)) };
});

const s = behaviourSandbox();

describe("the app's fingerprint", () => {
  test("concurrent readings for display share one calculation; acceptance computes it anew each time", async () => {
    control.verdict = "failed";
    await s.runFromHub();
    // Past any reuse window of the run's own reading.
    await new Promise((done) => setTimeout(done, 2_100));
    counted.calls = 0;
    const views = await Promise.all(Array.from({ length: 6 }, () => s.call("GET", "/api/behaviour?route=/x")));
    expect(views.every((v) => v.status === 200)).toBe(true);
    expect(counted.calls).toBe(1);
    // Reused right after, too.
    const project = await loadProject(s.box.project, { designRoot: s.box.design });
    await behaviourRouteView(project, TOOL, "/x");
    expect(counted.calls).toBe(1);
    // Filing and addressed never take the display reading.
    const evidence = behaviourEvidence(async () => project, TOOL);
    const view = (views[0]!.json as { run: { runId: string }; results: Array<{ target: { component: string } }> });
    const index = view.results.findIndex((r) => r.target.component === "UserMenu");
    const { link } = await evidence.failure({ route: "/x", runId: view.run.runId, index });
    expect(counted.calls).toBe(2);
    await evidence.passedSince(link, "2000-01-01T00:00:00.000Z");
    expect(counted.calls).toBe(3);
  }, 30_000);
});
