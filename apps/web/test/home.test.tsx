// @vitest-environment jsdom
/** Home and the Elements overview on the demo snapshot: clean rules fold, counts come from the usage map, unknown is a dash. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { buildModel, countByKind } from "../src/data/model.ts";
import type { Catalog, Manifest, ScanReport } from "../src/data/types.ts";
import { indexUsage } from "../src/data/usage.ts";
import { SystemOverview } from "../src/screens/catalog/CatalogScreen.tsx";
import { SpeedNote, Usage } from "../src/screens/home/HomeScreen.tsx";

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
    render(<Usage model={model} index={index} />);
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
    render(<Usage model={model} index={clean} />);
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
