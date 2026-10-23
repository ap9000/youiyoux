import { describe, expect, test } from "vitest";
import { isActive, NAV, NAV_SECTIONS, navGroups } from "../src/app/routes.tsx";
import { STAGES } from "../src/screens/library/LibraryScreen.tsx";

describe("navigation hierarchy", () => {
  test("System, Library and Work are separate, labelled groups", () => {
    const groups = navGroups().map((g) => ({ section: g.section, labels: g.items.map((i) => i.label) }));
    expect(groups).toEqual([
      { section: "system", labels: ["Overview", "Components", "Tokens", "Rules", "Screens"] },
      { section: "library", labels: ["Browse", "Inventory", "Discover", "Gaps", "Stack", "Sources"] },
      { section: "work", labels: ["Style", "Changes", "Workspace"] },
    ]);
    expect(NAV_SECTIONS.system.hint).toMatch(/build with/);
    expect(NAV_SECTIONS.library.hint).toMatch(/never build with/);
  });

  test("every screen keeps a unique jump key", () => {
    const keys = NAV.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the most specific item is the active one", () => {
    const active = (path: string) => NAV.filter((i) => isActive(i, path)).map((i) => i.label);
    expect(active("/library")).toEqual(["Browse"]);
    expect(active("/library/sources")).toEqual(["Sources"]);
    expect(active("/library/stack")).toEqual(["Stack"]);
    expect(active("/library/gaps")).toEqual(["Gaps"]);
    expect(active("/discover")).toEqual(["Discover"]);
    expect(active("/elements/demo/component/button")).toEqual(["Components"]);
    expect(active("/")).toEqual(["Overview"]);
    expect(active("/style/draft/d-0123456789")).toEqual(["Style"]);
    expect(active("/changes/d-0123456789")).toEqual(["Changes"]);
  });

  test("the Library page explains every stage, Library stages first", () => {
    expect(Object.keys(STAGES)).toEqual(["library", "candidate", "adopted", "in-use"]);
  });
});
