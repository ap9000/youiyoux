// @vitest-environment jsdom
/** Disclosures unfold with a turning chevron and menus grow from their corner, in CSS only. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { buildModel } from "../src/data/model.ts";
import type { Catalog, Manifest, ScanReport } from "../src/data/types.ts";
import { indexUsage } from "../src/data/usage.ts";
import { Usage } from "../src/screens/home/HomeScreen.tsx";
import { Disclosure } from "../src/ui/Disclosure.tsx";
import { MenuButton } from "../src/ui/Menu.tsx";

const DATA = join(import.meta.dirname, "../snapshot/public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const model = buildModel(catalog, manifest);
const reports = manifest.systems[0]!.usage!.map(({ file }) => JSON.parse(readFileSync(join(DATA, file), "utf8")) as ScanReport);
const css = readFileSync(join(import.meta.dirname, "../src/styles/app.css"), "utf8");

afterEach(cleanup);

describe("Disclosure", () => {
  test("is a native details whose summary ends in a chevron that turns when open", () => {
    const { container } = render(
      <Disclosure summary="How grouping works" open>
        <p>Families by shape</p>
      </Disclosure>,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(true);
    const chevron = details.querySelector("summary [data-chevron]")!;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    expect(chevron.getAttribute("class")).toContain("group-open/disclosure:rotate-180");
    expect(details.className).toContain("group/disclosure");
    expect(screen.getByText("Families by shape")).toBeTruthy();
  });

  test("Home's clean rules fold under a chevron, not show/hide text", () => {
    const clean = indexUsage(reports.map((report) => ({ ...report, violations: [] })));
    const { container } = render(<Usage model={model} index={clean} scheme="light" />);
    const summary = container.querySelector("details > summary")!;
    expect(summary.textContent).toMatch(/^\d+ rules? clean$/);
    expect(summary.querySelector("[data-chevron]")).not.toBeNull();
  });

  test("app.css unfolds every details where the browser can, and slides its content in", () => {
    const supports = css.slice(css.indexOf("@supports (interpolate-size: allow-keywords)"));
    expect(supports).toMatch(/details::details-content\s*{[^}]*block-size: 0;[^}]*transition:/);
    expect(supports).toMatch(/details\[open\]::details-content\s*{\s*block-size: auto;/);
    expect(css).toMatch(/details\[open\] > :not\(summary\)\s*{\s*animation: yx-unfold/);
  });
});

describe("MenuButton", () => {
  test("opens growing out of the top-right corner it hangs from", () => {
    render(<MenuButton label="More" items={[{ label: "Copy id", onSelect: () => {} }]}>…</MenuButton>);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More" });
    expect(menu.className).toContain("origin-top-right");
    expect(menu.className).toContain("animate-menu");
    expect(css).toMatch(/@keyframes yx-menu\s*{\s*from\s*{\s*opacity: 0;\s*transform: translateY\(-4px\) scale\(0\.96\);/);
  });
});
