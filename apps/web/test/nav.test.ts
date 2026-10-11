import { describe, expect, test } from "vitest";
import { isActive, NAV, NAV_SECTIONS, navGroups } from "../src/app/routes.tsx";
import { STAGES } from "../src/screens/library/LibraryScreen.tsx";

describe("navigation hierarchy", () => {
  test("System, Library and Work are separate, labelled groups", () => {
    const groups = navGroups().map((g) => ({ section: g.section, labels: g.items.map((i) => i.label) }));
    expect(groups).toEqual([
      { section: "system", labels: ["Overview", "Components", "Tokens", "Rules", "Screens"] },
      { section: "library", labels: ["Browse", "Sources"] },
      { section: "work", labels: ["Changes"] },
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
    expect(active("/elements/demo/component/button")).toEqual(["Components"]);
    expect(active("/")).toEqual(["Overview"]);
  });

  test("the Library page explains every stage, Library stages first", () => {
    expect(Object.keys(STAGES)).toEqual(["library", "candidate", "adopted", "in-use"]);
  });
});
