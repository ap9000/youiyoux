import { describe, expect, test } from "vitest";
import { NAV, NAV_SECTIONS, navGroups } from "../src/app/routes.tsx";
import { STAGES } from "../src/screens/library/LibraryScreen.tsx";

describe("navigation hierarchy", () => {
  test("the System (elements, tokens, live usage) and the Library are separate, labelled groups", () => {
    const groups = navGroups().map((g) => ({ section: g.section, labels: g.items.map((i) => i.label) }));
    expect(groups).toEqual([
      { section: null, labels: ["Home"] },
      { section: "system", labels: ["Elements", "Tokens", "Screens"] },
      { section: "library", labels: ["Library"] },
      { section: null, labels: ["Changes", "Access"] },
    ]);
    expect(NAV_SECTIONS.system.hint).toMatch(/build with/);
    expect(NAV_SECTIONS.library.hint).toMatch(/never build with/);
  });

  test("every screen keeps a unique jump key and the Library is g l", () => {
    const keys = NAV.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(NAV.find((i) => i.href === "/library")?.key).toBe("l");
  });

  test("a section split over two runs stays two groups, so order is never rewritten", () => {
    const [home, elements, , , library] = NAV;
    expect(navGroups([home!, elements!, library!, elements!]).map((g) => g.section)).toEqual([null, "system", "library", "system"]);
  });

  test("the Library page explains every stage, Library stages first", () => {
    expect(Object.keys(STAGES)).toEqual(["library", "candidate", "adopted", "in-use"]);
  });
});
