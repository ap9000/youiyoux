// @vitest-environment jsdom
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { InventoryReport as InventorySchema } from "@youiyoux/core";
import { buildInventory } from "../../../packages/scanner/src/inventory/inventory.ts";
import { familyName, roleRows, shapeChips, uniqueExamples } from "../src/data/inventory.ts";
import type { InventoryReport, Manifest } from "../src/data/types.ts";
import { InventoryView } from "../src/screens/inventory/InventoryScreen.tsx";

const TOOL = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(TOOL, "packages/scanner/test/fixtures/inventory");

let inventory: InventoryReport;
beforeAll(async () => {
  inventory = InventorySchema.parse(await buildInventory([join(FIXTURES, "console"), join(FIXTURES, "site")], { cwd: TOOL }));
});
afterEach(cleanup);

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Inventory page (c3)", () => {
  test("a role × project grid with family and look counts", () => {
    render(<InventoryView inventory={inventory} />);
    const grid = screen.getByTestId("role-grid");
    const headers = within(grid).getAllByRole("columnheader").map(text);
    expect(headers).toEqual(["Role", "console", "site", "Across projects"]);
    const rows = within(grid).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("rowheader").concat(within(row).getAllByRole("cell")).map(text));
    expect(rows.map((r) => r[0])).toEqual(["Buttons", "Links as buttons", "Inputs", "Cards", "Badges", "Dialogs", "Tabs"]);
    expect(rows[0]).toEqual(["Buttons", "5 families · 14 looks", "1 family · 2 looks", "1 shared across projects"]);
    expect(rows[2]).toEqual(["Inputs", "2 families · 2 looks", "—", "none shared"]);
  });

  test("each family is a row with its shape, kits, count, file:line examples and near-duplicates across projects", () => {
    const { container } = render(<InventoryView inventory={inventory} />);
    const button = container.querySelector('[data-family="button-1"]')!;
    expect(button).not.toBeNull();
    // Named by role and shape, with the shape spelled out.
    expect(within(button as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe("Button · 32px · radius 8");
    expect([...within(button as HTMLElement).getByLabelText("Shape").children].map(text)).toEqual(["height 32px", "padding 0 12px", "radius 8px", "size 14px", "weight 500"]);
    expect(text(button)).toContain("10 looks");
    expect(text(button)).toContain("Near-duplicate across projects");
    const sides = within(button as HTMLElement).getByRole("list", { name: "Near-duplicates" });
    // The console's CSS kit, its CVA kit and the ladder's hand-rolled 32px button, then the site's kit.
    expect(sides.children).toHaveLength(4);
    const sideText = within(sides).getAllByRole("listitem").filter((li) => li.parentElement === sides).map(text);
    expect(sideText.some((s) => s.startsWith("consolesrc/browser/ui.css1 look") && s.includes("console:src/browser/toolbar.tsx:8"))).toBe(true);
    expect(sideText.some((s) => s.startsWith("consolesrc/components/ui5 looks") && s.includes("console:src/app/page.tsx:13"))).toBe(true);
    expect(sideText.some((s) => s.startsWith("sitesrc/styles/ui.css2 looks") && s.includes("site:src/pages/docs.astro:14") && s.includes("/docs"))).toBe(true);
    // A family in one kit and one project: its kit, the project and its examples.
    const legacy = container.querySelector('[data-family="button-5"]')!;
    expect(text(legacy)).toContain("src/styles/legacy.css");
    expect(text(legacy)).toContain("console:src/app/settings/page.tsx:14");
    expect(text(legacy)).not.toContain("Near-duplicate");
  });

  test("badges and tabs show their cross-project families; flags and the not-clustered note appear", () => {
    const { container } = render(<InventoryView inventory={inventory} />);
    expect(text(container.querySelector('[data-family="badge-1"]')!)).toContain("Badge · 20px · pill");
    expect(text(container.querySelector('[data-family="badge-1"]')!)).toContain("site:src/pages/pricing.astro:6");
    expect(text(container.querySelector('[data-family="tabs-1"]')!)).toContain("Near-duplicate across projects");
    expect(text(container)).toContain("Badge is defined 3 times");
    expect(text(container)).toContain("console:src/app/settings/page.tsx imports 2 kits’ button in 2 imports");
    expect(text(container)).toContain("LegacyButton, LegacyIconButton from src/styles/legacy.css · line 2");
    expect(text(container)).toMatch(/\d+ breakpoint and state classes recorded, not clustered/);
    expect(screen.getByRole("heading", { name: "Kits and primitives" })).toBeTruthy();
  });

  test("on a phone the grid becomes one section per role", () => {
    render(<InventoryView inventory={inventory} />);
    expect(screen.getByTestId("role-grid").className).toContain("max-md:hidden");
    const stack = screen.getByTestId("role-stack");
    expect(stack.className).toContain("md:hidden");
    const cards = within(stack).getAllByRole("listitem");
    expect(cards.map((c) => /^(.*?)(?:\d+ shared|none shared)/.exec(text(c))?.[1])).toEqual(["Buttons", "Links as buttons", "Inputs", "Cards", "Badges", "Dialogs", "Tabs"]);
    expect(text(cards[0]!)).toContain("console5 families · 14 looks");
    expect(text(cards[0]!)).toContain("site1 family · 2 looks");
  });

  test("with no inventory the page says how to make one", () => {
    render(<InventoryView inventory={null} />);
    expect(screen.getByRole("heading", { name: "No inventory yet" })).toBeTruthy();
    expect(text(document.body)).toContain("youi ui --inventory");
  });
});

describe("inventory data", () => {
  test("rows skip roles with no looks and count looks no shape resolved", () => {
    const rows = roleRows(inventory);
    expect(rows.find((r) => r.role === "dialog")).toMatchObject({ looks: 2, unshaped: 1 });
    expect(shapeChips({ height: null, paddingX: 1, paddingY: 0, radius: 9999, fontSize: 12, fontWeight: 500 }).map((c) => `${c.label} ${c.value}`)).toEqual(["height ?", "padding 0 1px", "radius pill", "size 12px", "weight 500"]);
    expect(shapeChips({ height: 32, paddingX: 12, paddingY: 6, radius: null, fontSize: null, fontWeight: null }).map((c) => `${c.label} ${c.value}`)).toEqual(["height 32px", "padding 6px 12px", "radius ?", "size ?", "weight ?"]);
  });

  test("families are named by role and shape; unknown parts are left out", () => {
    expect(familyName({ role: "button", shape: { height: 32, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500 } })).toBe("Button · 32px · radius 8");
    expect(familyName({ role: "badge", shape: { height: 20, paddingX: 8, paddingY: 0, radius: 9999, fontSize: 12, fontWeight: 500 } })).toBe("Badge · 20px · pill");
    expect(familyName({ role: "card", shape: { height: null, paddingX: 24, paddingY: 24, radius: 12, fontSize: null, fontWeight: null } })).toBe("Card · radius 12");
    expect(familyName({ role: "link-as-button", shape: { height: null, paddingX: null, paddingY: null, radius: null, fontSize: null, fontWeight: null } })).toBe("Link as button");
  });

  test("a family row lists each file:line once, even with two looks on one line", () => {
    const example = (column: number) => ({ project: "p", file: "a.tsx", line: 3, column, tag: "Button", routes: [] });
    expect(uniqueExamples([example(5), example(20), { ...example(1), line: 4 }]).map((e) => `${e.line}:${e.column}`)).toEqual(["3:5", "4:1"]);
    const family = { ...inventory.families[0]!, nearDuplicate: false, examples: [example(5), example(20)] };
    const { container } = render(<InventoryView inventory={{ ...inventory, families: [family] }} />);
    const row = container.querySelector(`[data-family="${family.id}"]`)!;
    expect(text(row).match(/p:a\.tsx:3/g)).toHaveLength(1);
  });

  test("the committed snapshot names a valid inventory of both fixtures", () => {
    const data = join(import.meta.dirname, "../snapshot/public/data");
    const manifest = JSON.parse(readFileSync(join(data, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.inventory).toMatch(/^inventory\.[0-9a-f]{10}\.json$/);
    const committed = InventorySchema.parse(JSON.parse(readFileSync(join(data, manifest.inventory!), "utf8")));
    expect(committed.projects.map((p) => p.id)).toEqual(["console", "site"]);
    expect(committed.families.map((f) => f.id)).toEqual(inventory.families.map((f) => f.id));
  });
});
