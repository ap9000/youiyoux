import { describe, expect, test } from "vitest";
import type { AdoptionRequest, LibrarySearch } from "@youiyoux/scanner";
import { renderAdoptionRequest, renderLibrarySearch } from "../src/library.ts";

const hit = { id: "lib:example/component/pill", name: "Pill", kind: "component", stage: "library", summary: "A rounded status label.", source: "Example kit", categories: ["status"], swapsWith: ["youi:signal/component/badge"] } as const;

describe("youi library output", () => {
  test("an empty Library says so and points back at the System", () => {
    const text = renderLibrarySearch({ hits: [], total: 0, note: "" }, "pill");
    expect(text).toContain("empty: no sources are connected yet");
    expect(text).toContain("Build with System elements");
  });

  test("hits show their stage and what they could swap in for, then the rule", () => {
    const result: LibrarySearch = { hits: [hit, { ...hit, id: "lib:example/component/tag", stage: "candidate", swapsWith: [] }], total: 5, note: "" };
    const text = renderLibrarySearch(result, "status");
    expect(text).toContain("2 matches for \"status\" in 5 items");
    expect(text).toMatch(/lib:example\/component\/pill +library +A rounded status label\. · swaps with badge/);
    expect(text).toMatch(/lib:example\/component\/tag +candidate/);
    expect(text).toContain("never import, copy or restyle");
  });

  test("a request reads as a draft with the live usage of what it would replace", () => {
    const request: AdoptionRequest = {
      request: "adopt",
      status: "draft",
      item: hit,
      move: { from: "library", to: "candidate" },
      reason: "status chips",
      swapsWith: [
        { element: "youi:signal/component/badge", name: "Badge", stage: "in-use", sites: 3 },
        { element: "youi:other/component/chip", name: null, stage: null, sites: 0 },
      ],
      next: "Put this draft in your summary.",
    };
    const text = renderAdoptionRequest(request);
    expect(text).toContain("draft, nothing filed");
    expect(text).toContain("library → candidate");
    expect(text).toContain("Badge  in use · 3 sites");
    expect(text).toContain("youi:other/component/chip  not in this System");
    expect(text.endsWith("Put this draft in your summary.")).toBe(true);
  });
});
