// @vitest-environment jsdom
/** Home and the Elements overview on the demo snapshot: clean rules fold, counts come from the usage map, unknown is a dash. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { elementHref } from "../src/data/ids.ts";
import { buildModel, countByKind } from "../src/data/model.ts";
import type { Catalog, Manifest, ScanReport } from "../src/data/types.ts";
import { indexUsage, type Site } from "../src/data/usage.ts";
import { SystemOverview } from "../src/screens/catalog/CatalogScreen.tsx";
import { SpeedNote, Usage } from "../src/screens/home/HomeScreen.tsx";
import { filesOf } from "../src/screens/home/MostUsed.tsx";

const DATA = join(import.meta.dirname, "../snapshot/public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const model = buildModel(catalog, manifest);
const reports = manifest.systems[0]!.usage!.map(({ file }) => JSON.parse(readFileSync(join(DATA, file), "utf8")) as ScanReport);
const index = indexUsage(reports);
const clean = indexUsage(reports.map((report) => ({ ...report, violations: [] })));

afterEach(cleanup);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const section = (title: string): HTMLElement => screen.getByRole("heading", { name: title }).closest("section")!;

describe("Home: rule health", () => {
  test("lists only the rules with violations; the clean ones fold under one line that still links to each", () => {
    render(<Usage model={model} index={index} scheme="light" />);
    const health = section("Rule health");
    const brokenRules = [...model.rules.values()].filter((rule) => (index.violationsByRule.get(rule.id)?.length ?? 0) > 0);
    const cleanRules = model.rules.size - brokenRules.length;
    expect(brokenRules.length).toBeGreaterThan(0);
    expect(cleanRules).toBeGreaterThan(0);
    const folded = health.querySelector("details")!;
    expect(folded.open).toBe(false);
    expect(text(folded.querySelector("summary")!)).toMatch(new RegExp(`^${cleanRules} rules? clean`));
    expect(within(folded).getAllByRole("link")).toHaveLength(cleanRules);
    const shown = [...health.querySelectorAll(":scope > ul > li")];
    expect(shown.map(text)).toEqual(brokenRules.map((rule) => expect.stringContaining(rule.title)));
  });

  test("with no violations every rule is folded as clean and no bar is drawn", () => {
    render(<Usage model={model} index={clean} scheme="light" />);
    const health = section("Rule health");
    expect(health.querySelector(":scope > ul")).toBeNull();
    expect(text(health.querySelector("summary")!)).toMatch(new RegExp(`^${model.rules.size} rules clean`));
  });

  test("speed is one line that says plainly when there are no samples", () => {
    const { container } = render(<SpeedNote samples={{ search: [], navigation: [] }} />);
    expect(text(container)).toBe("Speed in this tab: search no samples yet; navigation no samples yet.");
    cleanup();
    const over = render(<SpeedNote samples={{ search: [400, 400], navigation: [10] }} />);
    expect(text(over.container)).toMatch(/search 400\.0 ms median, p95 400\.0 ms over its 50 ms budget/);
  });
});

describe("Home: most used components", () => {
  const ranked = [...model.components.values()]
    .map(({ contract }) => ({ contract, sites: index.sitesByElement.get(contract.id) ?? [] }))
    .sort((a, b) => b.sites.length - a.sites.length);

  test("each component with its use count, not a bar; the busiest is chosen first and only its panel shows", () => {
    const { container } = render(<Usage model={model} index={index} scheme="light" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => [...tab.children].map(text))).toEqual(ranked.map(({ contract, sites }) => [contract.name, String(sites.length)]));
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelectorAll("[data-chosen]")).toHaveLength(1);
    expect(section("Most used components").querySelector(".rounded-full")).toBeNull();
  });

  test("the chosen one shows one look, its files with their lines and counts, and the way in", () => {
    const { contract, sites } = ranked[0]!;
    const files = filesOf(sites);
    render(<Usage model={model} index={index} scheme="light" />);
    const panel = screen.getByRole("tabpanel");
    const looks = within(panel).getAllByRole("img");
    expect(looks).toHaveLength(1);
    expect(looks[0]!.getAttribute("src")).toMatch(/previews\/[a-z-]+\.light\.webp$/);
    expect(text(panel.querySelector("[data-uses]")!)).toBe(`${sites.length} uses in ${files.length} ${files.length === 1 ? "file" : "files"}`);
    const rows = [...panel.querySelectorAll("li")];
    expect(rows).toHaveLength(Math.min(files.length, 6));
    expect(text(rows[0]!)).toContain(`${files[0]!.file}:${files[0]!.lines[0]}`);
    expect(text(rows[0]!.lastElementChild!)).toBe(String(files[0]!.lines.length));
    expect(within(panel).getByRole("link", { name: `Open ${contract.name}` }).getAttribute("href")).toBe(elementHref(contract.id));
  });

  test("choosing another component shows its panel instead", () => {
    render(<Usage model={model} index={index} scheme="light" />);
    fireEvent.mouseDown(screen.getAllByRole("tab")[1]!);
    expect(screen.getByRole("tabpanel").querySelector("[data-chosen]")!.getAttribute("data-chosen")).toBe(ranked[1]!.contract.id);
  });

  test("filesOf groups sites by file, the busiest first, lines in order", () => {
    const site = (file: string, line: number, project = "app"): Site => ({ file, line, column: 1, project, commit: null, props: {}, spread: false }) as unknown as Site;
    expect(filesOf([site("b.tsx", 9), site("a.tsx", 30), site("a.tsx", 4), site("c.tsx", 1, "other")])).toEqual([
      { project: "app", file: "a.tsx", lines: [4, 30] },
      { project: "app", file: "b.tsx", lines: [9] },
      { project: "other", file: "c.tsx", lines: [1] },
    ]);
  });
});

describe("Elements: the overview beside an empty selection", () => {
  test("every component with its sites, every token group, every rule with its violations or Clean", () => {
    render(<SystemOverview model={model} index={index} scheme="light" />);
    const components = within(section("Components")).getAllByRole("link");
    expect(components).toHaveLength(model.components.size);
    const card = components.find((link) => text(link).startsWith("Card"))!;
    expect(text(card)).toMatch(new RegExp(`${index.sitesByElement.get("youi:demo/component/card")!.length} sites$`));
    const groups = within(section("Tokens")).getAllByRole("link");
    expect(groups.reduce((sum, link) => sum + Number(text(link).match(/(\d+)$/)![1]), 0)).toBe(countByKind(model.elements).token);
    const rules = within(section("Rules")).getAllByRole("link").map(text);
    expect(rules).toHaveLength(model.rules.size);
    expect(rules.filter((row) => row.endsWith("Clean")).length).toBe([...model.rules.keys()].filter((id) => !index.violationsByRule.get(id)?.length).length);
    expect(rules.some((row) => /1 violation$/.test(row))).toBe(true);
  });

  test("while the usage map is unknown, counts are a dash, never 0 or Clean", () => {
    render(<SystemOverview model={model} index={null} scheme="dark" />);
    for (const title of ["Components", "Rules"]) {
      for (const link of within(section(title)).getAllByRole("link")) expect(text(link)).toMatch(/–$/);
    }
    expect(screen.queryByText("Clean")).toBeNull();
  });
});
