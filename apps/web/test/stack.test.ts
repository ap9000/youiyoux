// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DetectReport, LibraryEntry } from "@youiyoux/core";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { repoReport } from "../../../packages/detect/src/report.ts";
import { StackEmpty, StackReport } from "../src/screens/stack/StackScreen.tsx";
import fixture from "./fixtures/detect.site.json" with { type: "json" };

const site = DetectReport.parse(fixture);

afterEach(cleanup);

describe("Library > Stack", () => {
  test("shows each library with its confidence and evidence, the coverage, and an element screenshot per type", () => {
    render(createElement(StackReport, { report: site }));
    const shadcn = screen.getByRole("article", { name: "shadcn/ui" });
    expect(within(shadcn).getByText("Medium confidence")).toBeTruthy();
    expect(within(shadcn).getByText("shadcn/ui data-slot names")).toBeTruthy();
    expect(within(shadcn).getByText(/supports, never decides/)).toBeTruthy();
    expect(screen.getByRole("article", { name: "Radix Primitives" }).textContent).toContain("ids starting radix-");
    expect(screen.getByLabelText("Coverage").textContent).toContain("Coverage is per page crawled");
    const shots = screen.getAllByRole("img") as HTMLImageElement[];
    expect(shots.map((img) => [img.alt, new URL(img.src).pathname])).toEqual([
      ["Screenshot: shadcn/ui button", "/data/detect.shot.abc123.png"],
      ["Screenshot: shadcn/ui dialog", "/data/detect.shot.def456.png"],
    ]);
    expect(within(screen.getByRole("article", { name: "shadcn/ui dialog" })).getByText("Also matched: Radix Primitives")).toBeTruthy();
  });

  test("Add to Library drafts a valid youi.library/v1 item: seen on the site, likely the library", () => {
    render(createElement(StackReport, { report: site }));
    fireEvent.click(within(screen.getByRole("article", { name: "shadcn/ui dialog" })).getByRole("button", { name: /Add to Library/ }));
    const dialog = screen.getByRole("dialog", { name: "Draft Library item" });
    expect(dialog.textContent).toContain("Seen on 127.0.0.1:4173, likely shadcn/ui. A draft only: nothing is written.");
    const draft = LibraryEntry.parse(JSON.parse(dialog.querySelector("pre code")!.textContent!));
    expect(draft).toMatchObject({ schema: "youi.library/v1", id: "lib:site-127-0-0-1-4173/component/shadcn-dialog", name: "shadcn/ui Dialog", kind: "component", stage: "library", summary: "Seen on 127.0.0.1:4173, likely shadcn/ui" });
    expect(draft.source.url).toBe("http://127.0.0.1:4173/shadcn.html");
    // Where to save it, in the description and on the code block.
    expect(within(dialog).getAllByText("library/site-127-0-0-1-4173/shadcn-dialog.library.json")).toHaveLength(2);
  });

  test("a repo report lists declared-but-unused packages apart, and its elements have no screenshot", async () => {
    const report = await repoReport(join(import.meta.dirname, "../../../packages/detect/test/fixtures/repos/shadcn-app"));
    render(createElement(StackReport, { report }));
    const rows = screen.getAllByRole("row").slice(1).map((row) => row.querySelector("td")!.textContent);
    expect(rows).toEqual(["@mui/material", "styled-components"]);
    expect(screen.queryByRole("article", { name: "MUI" })).toBeNull();
    expect(screen.getAllByText("Found in the code: no screenshot").length).toBe(report.elements.length);
  });

  test("with no report, the empty state explains youiyoux detect", () => {
    render(createElement(StackEmpty));
    expect(screen.getByText("No stack detected yet")).toBeTruthy();
    expect(document.body.textContent).toContain("youiyoux detect <repo-path|url…>");
    expect(document.body.textContent).toContain("youiyoux ui --detect");
  });
});
