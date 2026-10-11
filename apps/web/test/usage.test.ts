import { describe, expect, test } from "vitest";
import type { ComponentContract, ScanReport, UsageSite } from "../src/data/types.ts";
import { EVERY_SCREEN, filterSites, groupByScreen, indexUsage, propDistribution, propLabel, screenBoms, summarize, UNROUTED, UNSET } from "../src/data/usage.ts";

const BUTTON = "youi:demo/component/button";
const CARD = "youi:demo/component/card";

function site(overrides: Partial<UsageSite>): UsageSite {
  return { element: BUTTON, kind: "render", export: "Button", local: "Button", props: {}, spread: false, file: "src/a.tsx", line: 1, column: 1, routes: ["/a"], routeSource: "route-file", fingerprint: "f", ...overrides };
}

const report: ScanReport = {
  schema: "youi.usage/v1",
  project: "demo-app",
  system: "demo",
  commit: "abc1234def",
  scanner: "test",
  configDigest: "x",
  generatedAt: "2026-10-11T00:00:00.000Z",
  durationMs: 1,
  status: "complete",
  coverage: { filesMatched: 3, filesScanned: 3, failed: [] },
  usages: [
    site({ props: { variant: { literal: "outline" } }, routes: ["/projects", "/settings"], file: "src/b.tsx", line: 9 }),
    site({ props: { variant: { dynamic: "tone" } }, routes: [EVERY_SCREEN], routeSource: "shell", file: "src/app.tsx" }),
    site({ props: {}, routes: [], routeSource: "unrouted", file: "src/orphan.tsx" }),
    site({ element: CARD, export: "Card", local: "Card", routes: ["/projects"] }),
    site({ kind: "variants", export: "buttonVariants", local: "buttonVariants", routes: ["/projects"], file: "src/c.tsx" }),
  ],
  unknowns: [{ name: "Btn", reason: "dynamic-component", detail: "computed", candidate: BUTTON, file: "src/d.tsx", line: 2, column: 3 }],
  suppressed: 0,
  lookalikes: [{ resembles: BUTTON, local: "Button", resolved: "src/ui/primitives.tsx#Button", file: "src/e.tsx", line: 4, column: 1 }],
  violations: [{ rule: "youi:demo/rule/color.no-raw-color", severity: "error", message: "raw", text: "#fff", file: "src/a.tsx", line: 3, column: 1 }],
};

const contract = {
  props: { variant: { type: "enum", values: ["default", "outline", "ghost"], default: "default" }, children: { type: "node" } },
} as unknown as ComponentContract;

describe("indexUsage", () => {
  test("groups sites by element and carries the project and commit", () => {
    const index = indexUsage([report]);
    expect(index.sitesByElement.get(BUTTON)).toHaveLength(4);
    expect(index.sitesByElement.get(CARD)?.[0]).toMatchObject({ project: "demo-app", commit: "abc1234def" });
  });

  test("indexes violations by rule, lookalikes by the element they resemble and unknowns by candidate", () => {
    const index = indexUsage([report]);
    expect(index.violationsByRule.get("youi:demo/rule/color.no-raw-color")).toHaveLength(1);
    expect(index.lookalikesByElement.get(BUTTON)?.[0]?.resolved).toContain("primitives");
    expect(index.unknownsByCandidate.get(BUTTON)?.[0]?.name).toBe("Btn");
  });
});

describe("summaries and filters", () => {
  const sites = indexUsage([report]).sitesByElement.get(BUTTON)!;

  test("summarize counts routed screens but not the every-screen shell", () => {
    expect(summarize(sites)).toEqual({ projects: 1, sites: 4, screens: 2, files: 4 });
  });

  test("propLabel separates literal, dynamic and unset values", () => {
    expect(propLabel({ literal: "ghost" })).toBe("ghost");
    expect(propLabel({ dynamic: "tone" })).toBe("dynamic");
    expect(propLabel(undefined)).toBe(UNSET);
  });

  test("propDistribution counts rendered sites per enum value, including unset and dynamic", () => {
    const variant = propDistribution(sites, contract).get("variant")!;
    expect(Object.fromEntries(variant.map((v) => [v.value, v.count]))).toEqual({ default: 0, outline: 1, ghost: 0, unset: 1, dynamic: 1 });
    expect(propDistribution(sites, contract).has("children")).toBe(false);
  });

  test("filterSites keeps sites matching every active filter and returns all without filters", () => {
    expect(filterSites(sites, { variant: "outline" })).toHaveLength(1);
    expect(filterSites(sites, {})).toHaveLength(4);
  });
});

describe("groupByScreen", () => {
  test("orders the shell first and unrouted last, listing multi-route sites under each screen", () => {
    const [project] = groupByScreen(indexUsage([report]).sitesByElement.get(BUTTON)!);
    expect(project?.screens.map((s) => s.route)).toEqual([EVERY_SCREEN, "/projects", "/settings", UNROUTED]);
    expect(project?.sites).toBe(4);
    expect(project?.screens.find((s) => s.route === "/projects")?.sites).toHaveLength(2);
  });
});

describe("screenBoms", () => {
  test("lists the elements each screen renders with their counts", () => {
    const work = screenBoms(indexUsage([report])).find((b) => b.route === "/projects");
    expect(work?.elements.get(BUTTON)).toBe(2);
    expect(work?.elements.get(CARD)).toBe(1);
  });
});
