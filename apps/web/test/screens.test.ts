import { describe, expect, test } from "vitest";
import { buildScreens, countIssues, routeLabel, screenHref, screensOf, screensOfElement, screenSlug } from "../src/data/screens.ts";
import type { Manifest, ScanReport, UsageSite } from "../src/data/types.ts";
import { EVERY_SCREEN, indexUsage, UNROUTED } from "../src/data/usage.ts";

const BUTTON = "youi:demo/component/button";
const CARD = "youi:demo/component/card";
const RAW_COLOR = "youi:demo/rule/color.no-raw-color";

function site(overrides: Partial<UsageSite>): UsageSite {
  return { element: BUTTON, kind: "render", export: "Button", local: "Button", props: {}, spread: false, file: "src/work.tsx", line: 1, column: 1, routes: ["/work"], routeSource: "route-file", fingerprint: "f", ...overrides };
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
  coverage: { filesMatched: 4, filesScanned: 4, failed: [] },
  usages: [
    site({ line: 3 }),
    site({ line: 9, props: { variant: { literal: "ghost" } } }),
    site({ element: CARD, export: "Card", local: "Card", line: 12 }),
    site({ file: "src/shared.tsx", routes: ["/work", "/review"], routeSource: "imported-by" }),
    site({ file: "src/app.tsx", routes: [EVERY_SCREEN], routeSource: "shell" }),
    site({ file: "src/orphan.tsx", routes: [], routeSource: "unrouted" }),
  ],
  unknowns: [{ name: "Btn", reason: "dynamic-component", detail: "computed", candidate: BUTTON, file: "src/shared.tsx", line: 2, column: 3 }],
  suppressed: 0,
  checks: [],
  lookalikes: [{ resembles: BUTTON, local: "Button", resolved: "src/ui/primitives.tsx#Button", file: "src/work.tsx", line: 20, column: 1 }],
  violations: [
    { rule: RAW_COLOR, severity: "error", message: "raw", text: "#fff", file: "src/work.tsx", line: 4, column: 1 },
    { rule: RAW_COLOR, severity: "warn", message: "raw", text: "#000", file: "src/shared.tsx", line: 5, column: 1 },
    { rule: RAW_COLOR, severity: "warn", message: "raw", text: "red", file: "src/styles.css", line: 1, column: 1 },
  ],
};

const shot = { light: { full: "l.webp", thumb: "lt.webp" }, dark: { full: "d.webp", thumb: "dt.webp" } };
const manifest: Manifest = {
  schema: "youiyoux.manifest/v1",
  source: { commit: null },
  systems: [
    {
      id: "demo",
      catalog: "demo.catalog.json",
      usage: [{ project: "demo-app", file: "demo-app.usage.json", screens: { source: "a demo", capturedAt: "2026-10-11", viewport: { width: 1440, height: 900 }, screens: [{ route: "/work", path: "/work", ...shot }] } }],
    },
  ],
};

describe("screen slugs and links", () => {
  test("turn routes into stable, readable URL segments", () => {
    expect(screenSlug("/work")).toBe("work");
    expect(screenSlug("/work (task detail)")).toBe("work-task-detail");
    expect(screenSlug("/user/[id]")).toBe("user-id");
    expect(screenSlug("/")).toBe("root");
    expect(screenSlug(EVERY_SCREEN)).toBe("app-shell");
    expect(screenSlug(UNROUTED)).toBe("unrouted");
    expect(screenHref("demo-app", "/review")).toBe("/screens/demo-app/review");
    expect(routeLabel(EVERY_SCREEN)).toBe("App shell");
  });
});

describe("buildScreens", () => {
  const screens = buildScreens(indexUsage([report]), manifest);
  const at = (route: string) => screens.screens.find((s) => s.route === route)!;

  test("lists the shell first, then routes by name, then sites on no screen", () => {
    expect(screens.screens.map((s) => s.route)).toEqual([EVERY_SCREEN, "/review", "/work", UNROUTED]);
  });

  test("groups each screen's sites by element, most used first", () => {
    const work = at("/work");
    expect(work.sites).toBe(4);
    expect(work.elements.map((e) => [e.id, e.sites.length])).toEqual([
      [BUTTON, 3],
      [CARD, 1],
    ]);
  });

  test("places issues on the screens their file reaches, including a shared file on each of its screens", () => {
    expect(at("/work").issues).toEqual({ errors: 1, warnings: 1, lookalikes: 1, unresolved: 1, total: 4 });
    expect(at("/review").issues).toEqual({ errors: 0, warnings: 1, lookalikes: 0, unresolved: 1, total: 2 });
    expect(at("/work").elements.find((e) => e.id === BUTTON)?.lookalikes).toHaveLength(1);
    expect(at("/review").elements.find((e) => e.id === BUTTON)?.unresolved).toHaveLength(1);
  });

  test("counts issues in files that render no element as not attributed, never guessing a screen", () => {
    expect(screens.unattributed).toEqual({ errors: 0, warnings: 1, lookalikes: 0, unresolved: 0, total: 1 });
  });

  test("attaches the captured screenshot and leaves screens without one empty", () => {
    expect(at("/work").shot?.light?.full).toBe("l.webp");
    expect(at("/review").shot).toBeNull();
    expect(screens.byHref.get("/screens/demo-app/work")).toBe(at("/work"));
  });

  test("screensOf builds once per usage index", () => {
    const index = indexUsage([report]);
    expect(screensOf(index, manifest)).toBe(screensOf(index, manifest));
  });
});

describe("screensOfElement", () => {
  test("ranks an element's routed screens by its sites there, with the app shell last and unrouted sites left out", () => {
    const list = screensOfElement(buildScreens(indexUsage([report]), manifest), BUTTON);
    expect(list.map((s) => [s.screen.route, s.sites])).toEqual([
      ["/work", 3],
      ["/review", 1],
      [EVERY_SCREEN, 1],
    ]);
  });
});

describe("countIssues", () => {
  test("splits errors from warnings and totals every kind", () => {
    const issues = countIssues(
      report.violations.map((v) => ({ ...v, project: "p" })),
      [1],
      [],
    );
    expect(issues).toEqual({ errors: 1, warnings: 2, lookalikes: 1, unresolved: 0, total: 4 });
  });
});
