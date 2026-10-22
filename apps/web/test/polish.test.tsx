// @vitest-environment jsdom
/** The polish pass: plain placeholders replaced by what the data says, without inventing any of it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { buildModel } from "../src/data/model.ts";
import type { Catalog, Manifest, ScanReport } from "../src/data/types.ts";
import { indexUsage } from "../src/data/usage.ts";
import { WorkflowRequestError } from "../src/data/workflow.ts";
import { ServiceDownPanel } from "../src/screens/changes/ServiceDown.tsx";
import { UsageGlance } from "../src/screens/element/OverviewTab.tsx";
import { fontFacts } from "../src/screens/tokens/TokenValue.tsx";
import { ScreenImage } from "../src/ui/ScreenImage.tsx";

const DATA = join(import.meta.dirname, "../snapshot/public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const model = buildModel(catalog, manifest);
const reports = manifest.systems[0]!.usage!.map(({ file }) => JSON.parse(readFileSync(join(DATA, file), "utf8")) as ScanReport);
const index = indexUsage(reports);

afterEach(cleanup);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();

describe("typography specimen facts", () => {
  test("reads size, weight, line height and the first family from a font shorthand", () => {
    expect(fontFacts("500 13px/1.25 Geist, ui-sans-serif, system-ui")).toEqual({ weight: "500", size: "13px", lineHeight: "1.25", family: "Geist" });
    expect(fontFacts('italic 600 1.5rem/2rem "Inter Display", sans-serif')).toEqual({ weight: "600", size: "1.5rem", lineHeight: "2rem", family: "Inter Display" });
    expect(fontFacts("14px Geist")).toEqual({ weight: "400", size: "14px", lineHeight: "normal", family: "Geist" });
  });

  test("anything it cannot read gives no chips rather than wrong ones", () => {
    expect(fontFacts("var(--font-body)")).toBeNull();
    expect(fontFacts("")).toBeNull();
  });
});

describe("screen pictures", () => {
  test("with no picture, `none` draws nothing and the default keeps the placeholder", () => {
    const none = render(<ScreenImage shot={null} scheme="light" size="thumb" label="demo-app /" whenMissing="none" />);
    expect(none.container.innerHTML).toBe("");
    cleanup();
    render(<ScreenImage shot={null} scheme="light" size="thumb" label="demo-app /" />);
    expect(screen.getByText("No screenshot yet")).toBeTruthy();
  });

  test("a picture that exists is drawn whatever `whenMissing` says", () => {
    const shot = { light: { full: "a.full.webp", thumb: "a.thumb.webp" } } as unknown as Parameters<typeof ScreenImage>[0]["shot"];
    render(<ScreenImage shot={shot} scheme="dark" size="thumb" label="demo-app /" whenMissing="none" />);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("demo-app / (light only)");
  });
});

describe("component overview headline", () => {
  test("one sentence with the counts from the usage map, not a row of stat boxes", () => {
    const contract = model.components.get("youi:demo/component/button")!.contract;
    const sites = index.sitesByElement.get(contract.id)!.length;
    const { container } = render(<UsageGlance model={model} contract={contract} index={index} />);
    const headline = container.querySelector("[data-headline]")!;
    expect(text(headline)).toMatch(new RegExp(`^${sites} uses in \\d+ files? across 1 project, on \\d+ screens? \\(most on /\\S*\\), with (nothing flagged|\\d+ to look at: .+)\\.$`));
    expect(container.querySelectorAll("a").length).toBeGreaterThan(0);
  });
});

describe("Changes without its service", () => {
  test("the offline panel names what to run and offers a retry; another failure shows its message", () => {
    render(<ServiceDownPanel error={new WorkflowRequestError("fetch failed", 0, [], true)} onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: "Start the rule editor to see changes" })).toBeTruthy();
    expect(screen.getByText(/pnpm youiyoux ui --project/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
    cleanup();
    render(<ServiceDownPanel error={new WorkflowRequestError("drafts.json is not valid", 500)} onRetry={() => {}} />);
    expect(screen.getByText("drafts.json is not valid")).toBeTruthy();
  });
});
