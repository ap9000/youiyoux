import { join } from "node:path";
import { LibraryEntry, type Library } from "@youiyoux/core";
import { beforeAll, describe, expect, test } from "vitest";
import { adoptionRequest, componentCard, findContract, loadProject, scanProject, searchLibrary, type Project, type ScanResult } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/expo-app");
const library: Library = {
  entries: [
    LibraryEntry.parse({
      schema: "youi.library/v1",
      id: "lib:example/component/pill",
      name: "Pill",
      kind: "component",
      summary: "A rounded status label.",
      source: { name: "Example kit", ingestedAt: "2026-01-01T00:00:00Z" },
      categories: ["status"],
      swapsWith: ["youi:demo/component/card", "youi:demo/component/button"],
    }),
  ],
};

let project: Project;
let scan: ScanResult;
let complete: ScanResult;
beforeAll(async () => {
  project = await loadProject(FIXTURE);
  scan = await scanProject(project);
  complete = { ...scan, report: { ...scan.report, status: "complete" } };
});

describe("Library queries", () => {
  test("search finds Library items and restates the build-with-System rule", () => {
    const result = searchLibrary(library, "status label");
    expect(result.hits.map((h) => h.id)).toEqual(["lib:example/component/pill"]);
    expect(result.note).toMatch(/never import, copy or restyle/);
    expect(searchLibrary({ entries: [] }, "pill").note).toMatch(/Library is empty/);
  });

  test("a request is a draft that carries the live usage of what it would swap in for", () => {
    const request = adoptionRequest(project, library, "Pill", "status chips on checkout", complete);
    expect(request).toMatchObject({ request: "adopt", status: "draft", move: { from: "library", to: "candidate" }, reason: "status chips on checkout" });
    const button = request.swapsWith.find((s) => s.name === "Button");
    expect(button).toMatchObject({ stage: "in-use", sites: 7 });
    expect(request.next).toMatch(/do not import, copy or build with lib:example\/component\/pill/);
  });

  test("swaps with System tokens and rules are named, not labelled as outside the System", () => {
    const token = scan.tokens.tokens[0]!;
    const entry = { ...library.entries[0]!, swapsWith: [`youi:demo/token/${token.id}`, "youi:demo/rule/color.no-raw-color", "youi:other/token/color.x"] };
    const request = adoptionRequest(project, { entries: [entry] }, "Pill", "tokens", complete);
    expect(request.swapsWith.map((s) => [s.name, s.stage])).toEqual([
      [token.id, "unknown"],
      [expect.any(String), "unknown"],
      [null, null],
    ]);
  });

  test("an inventory family is a swap target with no System stage", () => {
    const entry = { ...library.entries[0]!, swapsWith: ["button-2", "youi:demo/component/button"] };
    const request = adoptionRequest(project, { entries: [entry] }, "Pill", "replace the second button look", complete);
    expect(request.swapsWith[0]).toEqual({ element: "button-2", name: null, stage: null, sites: 0, family: true });
    expect(request.swapsWith[1]).toMatchObject({ name: "Button", stage: "in-use" });
    expect(request.next).toContain("button-2");
  });

  test("a partial scan never reports a System element as unused", () => {
    const partial = { ...scan, report: { ...scan.report, status: "partial" as const, usages: [] } };
    const request = adoptionRequest(project, library, "Pill", "partial", partial);
    expect(request.swapsWith.find((s) => s.name === "Button")).toMatchObject({ stage: "unknown", sites: 0 });
    const button = findContract(project, "Button")!;
    expect(componentCard(project, button, partial.report)).not.toHaveProperty("stage");
    expect(componentCard(project, button, complete.report)).toMatchObject({ stage: "in-use" });
  });

  test("a candidate cannot be requested twice", () => {
    const candidate: Library = { entries: [{ ...library.entries[0]!, stage: "candidate" }] };
    expect(() => adoptionRequest(project, candidate, "Pill", "again", scan)).toThrow(/stage candidate, where an agent cannot request adoption/);
  });

  test("System lookups refuse Library ids", () => {
    expect(() => findContract(project, "lib:example/component/pill")).toThrow(/Library item, not a System element/);
    expect(findContract(project, "Button")?.name).toBe("Button");
  });
});
