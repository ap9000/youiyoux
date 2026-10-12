import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { InventoryReport, SHAPE_DIMENSIONS, type InventoryShape } from "@youiyoux/core";
import { buildInventory, clusterShapeOf, clusterShapes, compatible, DEFAULT_TOLERANCE, detectRoutes, familiesOf } from "../src/index.ts";
import { readTemplate } from "../src/inventory/astro.ts";
import { applyUtility, resolveClasses, ClassRules, StyleAccumulator } from "../src/inventory/style.ts";
import { buildTheme, readStylesheet, Theme } from "../src/inventory/theme.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/inventory");
const CONSOLE = join(FIXTURES, "console");
const SITE = join(FIXTURES, "site");

/** Every report the tests build, so the no-chaining invariant is checked on all of them. */
const reports: InventoryReport[] = [];

async function inventory(dirs: readonly string[]): Promise<InventoryReport> {
  const report = InventoryReport.parse(await buildInventory(dirs, { cwd: FIXTURES }));
  reports.push(report);
  return report;
}

const shape = (height: number | null, rest: Partial<InventoryShape> = {}): InventoryShape => ({ height, paddingX: 12, paddingY: 0, radius: 8, fontSize: 14, fontWeight: 500, ...rest });

/** The source line a look or example points at. */
function lineAt(project: string, file: string, line: number): string {
  return readFileSync(join(FIXTURES, project, file), "utf8").split("\n")[line - 1] ?? "";
}

let report: InventoryReport;
beforeAll(async () => {
  report = await inventory([CONSOLE, SITE]);
});

describe("youi inventory on two projects (c1)", () => {
  test("needs no design repo and reads both projects, with routes detected from the files", () => {
    expect(report.projects.map((p) => [p.id, p.status, p.routes])).toEqual([
      ["console", "complete", "next-app (src/app/**/page)"],
      ["site", "complete", "astro (src/pages/)"],
    ]);
  });

  test("both kits' 32px buttons form one family across the projects, with file:line examples", () => {
    const cvaButton = report.looks.find((l) => l.definition === "console:src/components/ui/button.tsx#Button" && l.file === "src/app/page.tsx")!;
    const bemButton = report.looks.find((l) => l.project === "site" && l.tag === "Button")!;
    expect(cvaButton.shape).toEqual(shape(32));
    expect(bemButton.shape).toEqual(shape(32));
    expect(cvaButton.family).toBe(bemButton.family);
    const family = report.families.find((f) => f.id === cvaButton.family)!;
    expect(family.role).toBe("button");
    expect(family.projects).toEqual(["console", "site"]);
    expect(family.kits).toEqual(["console:src/browser/ui.css", "console:src/components/ui", "site:src/styles/ui.css"]);
    expect(family.nearDuplicate).toBe(true);
    expect(family.sides.map((s) => [s.project, s.kit])).toEqual(expect.arrayContaining([["console", "console:src/components/ui"], ["site", "site:src/styles/ui.css"]]));
    for (const side of family.sides) {
      for (const ex of side.examples) expect(lineAt(ex.project, ex.file, ex.line), `${ex.file}:${ex.line}`).toContain(`<${ex.tag}`);
    }
    expect(family.examples.find((e) => e.file === "src/app/page.tsx")).toMatchObject({ line: 13, routes: ["/"] });
    expect(family.sides.find((s) => s.project === "site")!.examples[0]).toMatchObject({ file: "src/pages/docs.astro", line: 14, routes: ["/docs"] });
  });

  test("the console's CSS-kit .ui-button and its CVA Button, both 32px with different vertical padding, are one family", () => {
    const cssButton = report.looks.find((l) => l.project === "console" && l.file === "src/browser/toolbar.tsx" && l.tag === "button")!;
    const cvaButton = report.looks.find((l) => l.project === "console" && l.file === "src/app/browser/page.tsx" && l.tag === "Button")!;
    expect(cssButton).toMatchObject({ line: 8, kit: "console:src/browser/ui.css", definition: "console:src/browser/ui.css#.ui-button", derived: [] });
    // The CSS font shorthand gives size and weight; the theme's rounded-md gives the CVA radius.
    expect(cssButton.shape).toEqual(shape(32, { paddingY: 6 }));
    expect(cvaButton.shape).toEqual(shape(32));
    expect(cssButton.family).not.toBeNull();
    expect(cssButton.family).toBe(cvaButton.family);
    const family = report.families.find((f) => f.id === cssButton.family)!;
    expect(family.kits).toEqual(expect.arrayContaining(["console:src/browser/ui.css", "console:src/components/ui"]));
    expect(family.sides.filter((s) => s.project === "console").map((s) => s.kit)).toEqual(expect.arrayContaining(["console:src/browser/ui.css", "console:src/components/ui"]));
    expect(family.range.paddingY).toEqual([0, 6]);
  });

  test("rounded-md is the project's own 8px, not Tailwind's 6px", async () => {
    const theme = await buildTheme(CONSOLE, [await readStylesheet("src/app/globals.css", readFileSync(join(CONSOLE, "src/app/globals.css"), "utf8"))], true);
    expect(resolveClasses(["rounded-md"], "button", theme, new ClassRules()).shape.radius).toBe(8);
    const stock = await buildTheme(SITE, [await readStylesheet("a.css", '@import "tailwindcss";')], true);
    expect(stock.tailwind).toBe(4);
    // The site's tailwind.config.mjs sets md to 8px too; without it, v4's default is 6px.
    const plain = new Theme(new Map([["--radius-md", "0.375rem"]]), 4, []);
    expect(resolveClasses(["rounded-md"], "button", plain, new ClassRules()).shape.radius).toBe(6);
    // The site's link-as-button gets its radius from tailwind.config.mjs, read without running it.
    const link = report.looks.find((l) => l.project === "site" && l.role === "link-as-button")!;
    expect(link.shape.radius).toBe(8);
  });

  test("badges group across projects; the legacy kit's smaller badge is its own family", () => {
    const badges = report.families.filter((f) => f.role === "badge");
    expect(badges.map((f) => [f.projects, f.kits, f.shape])).toEqual([
      [["console", "site"], ["console:src/components/ui", "site:src/styles/marketing.css", "site:src/styles/ui.css"], { height: 20, paddingX: 8, paddingY: 0, radius: 9999, fontSize: 12, fontWeight: 500 }],
      [["console"], ["console:src/styles/legacy.css"], { height: 18, paddingX: 6, paddingY: 0, radius: 4, fontSize: 11, fontWeight: 600 }],
    ]);
  });

  test("a plain .badge class that sets a shape is a class-kit member, and its markup gives badge looks", () => {
    const kit = report.kits.find((k) => k.id === "site:src/styles/marketing.css")!;
    expect(kit).toMatchObject({ kind: "class-kit", path: "src/styles/marketing.css" });
    expect(kit.prefix).toBeUndefined();
    // .tag-list is named like an element but sets no shape: not a member.
    expect(kit.members).toEqual([{ name: ".badge", role: "badge", file: "src/styles/marketing.css", line: 3, variants: { modifier: ["muted"] } }]);
    const looks = report.looks.filter((l) => l.file === "src/pages/pricing.astro");
    expect(looks.map((l) => [l.line, l.tag, l.role, l.kit, l.definition])).toEqual([
      [6, "span", "badge", "site:src/styles/marketing.css", "site:src/styles/marketing.css#.badge"],
      [8, "span", "badge", "site:src/styles/marketing.css", "site:src/styles/marketing.css#.badge"],
    ]);
    for (const look of looks) expect(lineAt("site", look.file, look.line)).toContain('class="badge');
    const family = report.families.find((f) => f.id === looks[0]!.family)!;
    expect(family.role).toBe("badge");
    expect(family.sides.map((s) => s.kit)).toContain("site:src/styles/marketing.css");
  });

  test("tab triggers from Radix (console) and role=tab buttons (site) share a family", () => {
    const tabs = report.families.find((f) => f.role === "tabs" && f.projects.length === 2)!;
    expect(tabs.shape).toEqual(shape(28));
    expect(tabs.sides.map((s) => `${s.project}:${s.looks}`)).toEqual(["console:2", "site:2"]);
    expect(tabs.examples.map((e) => `${e.project}:${e.file}:${e.line}`)).toEqual(["console:src/app/page.tsx:23", "site:src/pages/docs.astro:10", "console:src/app/page.tsx:24", "site:src/pages/docs.astro:12"]);
  });

  test("a component defined three times is flagged with every location", () => {
    const badge = report.flags.find((f) => f.kind === "duplicate-definition" && f.name === "Badge");
    expect(badge).toEqual({
      kind: "duplicate-definition",
      name: "Badge",
      locations: [
        { project: "console", file: "src/components/legacy/badge.tsx", line: 4, kit: "console:src/styles/legacy.css" },
        { project: "console", file: "src/components/ui/badge.tsx", line: 16, kit: "console:src/components/ui" },
        { project: "site", file: "src/components/ui/Badge.astro", line: 1, kit: "site:src/styles/ui.css" },
      ],
    });
  });

  test("a file importing two kits' buttons is flagged with each import statement once, at its line", () => {
    const mixed = report.flags.filter((f) => f.kind === "mixed-kits");
    expect(mixed).toEqual([
      {
        kind: "mixed-kits",
        project: "console",
        file: "src/app/settings/page.tsx",
        role: "button",
        imports: [
          // Two names from one statement are one entry.
          { kit: "console:src/styles/legacy.css", name: "LegacyButton, LegacyIconButton", specifier: "@/components/legacy/legacy-button", line: 2 },
          { kit: "console:src/components/ui", name: "Button", specifier: "@/components/ui/button", line: 3 },
        ],
      },
    ]);
    for (const i of mixed[0]!.imports) expect(lineAt("console", "src/app/settings/page.tsx", i.line)).toContain(i.specifier);
    // The browser page imports one kit's Button and a toolbar with no role: no flag.
    expect(mixed.some((f) => f.file === "src/app/browser/page.tsx")).toBe(false);
  });

  test("the mixed-kit flag needs two kits but lists every import statement, each at its own line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      await mkdir(join(dir, "kit-a"));
      await mkdir(join(dir, "kit-b"));
      for (const kit of ["kit-a", "kit-b"]) {
        await writeFile(join(dir, kit, "button.tsx"), 'import { cva } from "class-variance-authority";\nconst v = cva("h-8");\nexport function Button() {\n  return <button className={v()} />;\n}\nexport function IconButton() {\n  return <button className={v()} />;\n}\n');
      }
      // kit-a's buttons arrive in two statements; kit-b's in one statement that names two.
      await writeFile(join(dir, "page.tsx"), 'import { Button } from "./kit-a/button";\nimport { IconButton } from "./kit-a/button";\nimport { Button as B, IconButton as IB } from "./kit-b/button";\nexport function Page() {\n  return <><Button /><IconButton /><B /><IB /></>;\n}\n');
      await writeFile(join(dir, "single.tsx"), 'import { Button } from "./kit-a/button";\nimport { IconButton } from "./kit-a/button";\nexport function Single() {\n  return <><Button /><IconButton /></>;\n}\n');
      const mixed = (await inventory([dir])).flags.filter((f) => f.kind === "mixed-kits");
      expect(mixed.map((f) => f.kind === "mixed-kits" && f.file)).toEqual(["page.tsx"]);
      expect(mixed[0]).toMatchObject({
        role: "button",
        imports: [
          { kit: expect.stringMatching(/:kit-a$/), name: "Button", specifier: "./kit-a/button", line: 1 },
          { kit: expect.stringMatching(/:kit-a$/), name: "IconButton", specifier: "./kit-a/button", line: 2 },
          { kit: expect.stringMatching(/:kit-b$/), name: "Button, IconButton", specifier: "./kit-b/button", line: 3 },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("kits, their variants and library primitives are listed", () => {
    expect(report.kits.map((k) => [k.id, k.kind])).toEqual([
      ["console:src/browser/ui.css", "class-kit"],
      ["console:src/components/ui", "cva-folder"],
      ["console:src/styles/legacy.css", "class-kit"],
      ["site:src/styles/marketing.css", "class-kit"],
      ["site:src/styles/ui.css", "class-kit"],
    ]);
    const button = report.kits[1]!.members.find((m) => m.name === "Button")!;
    expect(button.variants).toEqual({ variant: ["default", "outline", "ghost"], size: ["default", "sm", "lg", "icon"] });
    expect(report.kits[4]!.members.find((m) => m.name === ".ui-button")).toMatchObject({ role: "button", variants: { modifier: ["sm"] } });
    expect(report.primitives.map((p) => p.package)).toEqual(["@radix-ui/react-dialog", "@radix-ui/react-slot", "@radix-ui/react-tabs", "lucide-react"]);
    expect(report.primitives.find((p) => p.package === "lucide-react")!.sites).toEqual([{ project: "console", file: "src/app/page.tsx", line: 14, column: 11, export: "Plus" }]);
  });

  test("roles come from names and ARIA: an asChild link and a role=button link are links-as-buttons", () => {
    const links = report.looks.filter((l) => l.role === "link-as-button").map((l) => `${l.project}:${l.file}:${l.line} ${l.tag}`);
    expect(links).toEqual(["console:src/app/page.tsx:17 Button", "site:src/pages/index.astro:12 a"]);
    // A definition's own root element is not a site: no look sits inside the kit's files.
    expect(report.looks.filter((l) => l.file.startsWith("src/components/"))).toEqual([]);
  });

  test("breakpoint and state classes are recorded, never clustered; dynamic classes are listed", () => {
    const ladder36 = report.looks.find((l) => l.file === "src/app/ladder/page.tsx" && l.line === 13)!;
    expect(ladder36.shape.height).toBe(36);
    expect(ladder36.responsive).toEqual(["md:h-10"]);
    const siteButton = report.looks.find((l) => l.project === "site" && l.tag === "Button")!;
    expect(siteButton.unresolved).toEqual(["ui-button--${…}"]);
    expect(siteButton.responsive).toEqual(["@media (max-width: 640px) .ui-button"]);
    expect(siteButton.states).toEqual([".ui-button:hover"]);
    expect(report.looks.find((l) => l.file === "src/pages/docs.astro" && l.line === 10)!.unresolved).toEqual(["ui-tab--active (conditional)"]);
    expect(report.summary.notClustered).toBe(report.looks.reduce((n, l) => n + l.responsive.length + l.states.length, 0));
    expect(report.summary.notClustered).toBeGreaterThan(0);
  });

  test("two runs give byte-identical JSON, apart from when the run happened and how long it took", async () => {
    const again = await inventory([CONSOLE, SITE]);
    const stable = (r: InventoryReport): string => JSON.stringify({ ...r, generatedAt: "", durationMs: 0 }, null, 2);
    expect(stable(again)).toBe(stable(report));
  });

  test("a plain .ts file exporting a capitalised name is read without a JSX query, and is not a definition", () => {
    expect(report.projects.find((p) => p.id === "console")!.failed).toEqual([]);
    expect(report.definitions.filter((d) => d.file === "src/lib/config.ts")).toEqual([]);
    expect(report.definitions.some((d) => d.name === "Foo")).toBe(false);
  });

  test("looks no class resolves are listed but not grouped", () => {
    const wrappers = report.looks.filter((l) => l.family === null);
    expect(wrappers.map((l) => l.tag).sort()).toEqual(["Dialog", "Tabs"]);
    for (const look of wrappers) expect(SHAPE_DIMENSIONS.every((d) => look.shape[d] === null)).toBe(true);
    expect(report.summary).toMatchObject({ looks: report.looks.length, unshaped: 2, clustered: report.looks.length - 2 });
  });
});

describe("no chaining (c2)", () => {
  const ladder = [28, 30, 32, 34, 36, 38].map((h) => shape(h));

  test("single-link would chain the 28–38px ladder into one family; complete-link does not", () => {
    expect(clusterShapes(ladder, "single")).toEqual([[0, 1, 2, 3, 4, 5]]);
    const groups = clusterShapes(ladder, "complete");
    expect(groups.length).toBeGreaterThan(1);
    expect(groups).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  test("the fixture ladder lands in several families, and the 28px and 38px buttons never share one", () => {
    const ladder = report.looks.filter((l) => l.file === "src/app/ladder/page.tsx");
    expect(ladder.map((l) => l.shape.height)).toEqual([28, 30, 32, 34, 36, 38]);
    const families = new Set(ladder.map((l) => l.family));
    expect(families.size).toBeGreaterThanOrEqual(3);
    expect(ladder[0]!.family).not.toBe(ladder[5]!.family);
    expect(ladder[0]!.family).not.toBe(ladder[2]!.family);
  });

  test("two fixed heights ignore vertical padding, known or not; a derived height still compares it", () => {
    const fixed = (paddingY: number | null): ReturnType<typeof clusterShapeOf> => ({ ...shape(32, { paddingY }), fixedHeight: true });
    expect(compatible(fixed(0), fixed(6))).toBe(true);
    expect(compatible(fixed(6), fixed(null))).toBe(true);
    expect(compatible(fixed(0), shape(32, { paddingY: 6 }))).toBe(false);
    expect(compatible(shape(32, { paddingY: 0 }), shape(32, { paddingY: 6 }))).toBe(false);
    // The ladder still never chains when every step has a fixed height and its own vertical padding.
    const ladder = [28, 30, 32, 34, 36, 38].map((h, i) => ({ ...shape(h, { paddingY: i * 3 }), fixedHeight: true }));
    expect(clusterShapes(ladder, "single")).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(clusterShapes(ladder, "complete")).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(clusterShapeOf({ shape: shape(32), derived: [] }).fixedHeight).toBe(true);
    expect(clusterShapeOf({ shape: shape(32), derived: ["height"] }).fixedHeight).toBe(false);
  });

  test("unknown matches only unknown", () => {
    expect(compatible(shape(32), shape(null))).toBe(false);
    expect(compatible(shape(null), shape(null))).toBe(true);
    expect(clusterShapes([shape(32), shape(null), shape(33)])).toEqual([[0, 2], [1]]);
  });

  test("each dimension has its own tolerance", () => {
    expect(compatible(shape(32), shape(34))).toBe(true);
    expect(compatible(shape(32), shape(35))).toBe(false);
    expect(compatible(shape(32, { fontSize: 14 }), shape(32, { fontSize: 15 }))).toBe(true);
    expect(compatible(shape(32, { fontSize: 14 }), shape(32, { fontSize: 16 }))).toBe(false);
    expect(compatible(shape(32, { fontWeight: 500 }), shape(32, { fontWeight: 600 }))).toBe(true);
    expect(compatible(shape(32, { fontWeight: 400 }), shape(32, { fontWeight: 600 }))).toBe(false);
  });

  test("a dense random set never forms a family wider than the tolerance, and the order is stable", () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const looks = Array.from({ length: 160 }, (_, i) => ({
      id: `l${i}`,
      role: "button" as const,
      project: i % 2 ? "a" : "b",
      file: `f${i}.tsx`,
      line: 1,
      column: 1,
      routes: [],
      routeSource: "unrouted" as const,
      source: "intrinsic" as const,
      tag: "button",
      definition: null,
      kit: null,
      shape: shape(24 + Math.round(random() * 20), { paddingX: 8 + Math.round(random() * 8), radius: Math.round(random() * 10) }),
      derived: [],
      unresolved: [],
      responsive: [],
      states: [],
    }));
    const first = familiesOf("button", looks);
    for (const { members } of first) for (const a of members) for (const b of members) expect(compatible(a.shape, b.shape)).toBe(true);
    expect(familiesOf("button", [...looks].reverse()).map((f) => f.members.map((m) => m.id).sort())).toEqual(first.map((f) => f.members.map((m) => m.id).sort()));
  });

  test("every family in every inventory built here is within tolerance on every dimension", async () => {
    reports.push(await inventory([SITE, CONSOLE]));
    for (const r of reports) {
      for (const family of r.families) {
        const members = r.looks.filter((l) => l.family === family.id);
        expect(members.length).toBe(family.looks);
        for (const a of members) for (const b of members) expect(compatible(clusterShapeOf(a), clusterShapeOf(b), r.tolerance), `${family.id}: ${a.id} vs ${b.id}`).toBe(true);
        // Vertical padding is compared only where a height is derived; the pairs above cover it.
        const fixed = members.some((l) => clusterShapeOf(l).fixedHeight);
        for (const d of SHAPE_DIMENSIONS) {
          const range = family.range[d];
          if (!range || (d === "paddingY" && fixed)) continue;
          const limit = d === "height" ? r.tolerance.height : d === "radius" ? r.tolerance.radius : d === "fontSize" ? r.tolerance.fontSize : d === "fontWeight" ? r.tolerance.fontWeight : r.tolerance.padding;
          expect(range[1] - range[0]).toBeLessThanOrEqual(limit);
        }
      }
    }
  });
});

describe("style resolution", () => {
  const theme = new Theme(new Map([["--spacing", "0.25rem"], ["--text-sm", "0.875rem"], ["--text-sm--line-height", "calc(1.25 / 0.875)"], ["--font-weight-medium", "500"], ["--radius-md", "calc(var(--radius) - 2px)"], ["--radius", "0.625rem"]]), 4, []);

  test("var() and calc() resolve through the theme", () => {
    expect(theme.length("calc(var(--radius) - 2px)")).toBe(8);
    expect(theme.length("var(--missing, 3px)")).toBe(3);
    expect(theme.length("var(--missing)")).toBeNull();
    expect(theme.length("min(1px, 2px)")).toBeNull();
  });

  test("a missing height is derived from padding, line height and border", () => {
    const resolved = resolveClasses(["py-1.5", "px-3", "text-sm", "border", "rounded-md", "font-medium"], "button", theme, new ClassRules());
    expect(resolved.shape).toEqual({ height: 34, paddingX: 12, paddingY: 6, radius: 8, fontSize: 14, fontWeight: 500 });
    expect(resolved.derived).toEqual(["height"]);
  });

  test("later classes win; colour, layout and unknown names are ignored", () => {
    const style = new StyleAccumulator("button", true);
    for (const name of ["h-8", "text-primary", "flex", "h-[30px]"]) applyUtility(style, name, theme);
    expect(style.finish().shape.height).toBe(30);
    expect(resolveClasses(["h-full", "rounded-t-md"], "div", theme, new ClassRules()).unresolved).toEqual(["h-full", "rounded-t-md"]);
  });

  test("CSS rules apply by specificity and order; pseudo and media rules are recorded", async () => {
    const rules = new ClassRules();
    rules.addSheet(await readStylesheet("k.css", ".k-b { height: 32px; padding: 4px 12px } .k-b.k-b--sm { height: 28px } .k-b:focus-visible { outline: 2px } @media (min-width: 1px) { .k-b { height: 40px } }"));
    const resolved = resolveClasses(["k-b--sm", "k-b"], "button", new Theme(new Map(), null, []), rules);
    expect(resolved.shape).toMatchObject({ height: 28, paddingX: 12, paddingY: 4 });
    expect(resolved.states).toEqual([".k-b:focus-visible"]);
    expect(resolved.responsive).toEqual(["@media (min-width: 1px) .k-b"]);
  });

  test("the font shorthand gives size, weight and line height; what it cannot read stays unknown", async () => {
    const plain = new Theme(new Map(), null, []);
    const font = async (value: string, extra = ""): Promise<ReturnType<typeof resolveClasses>> => {
      const rules = new ClassRules();
      rules.addSheet(await readStylesheet("f.css", `.f { padding: 4px 8px; ${extra} font: ${value} }`));
      return resolveClasses(["f"], "span", plain, rules);
    };
    expect((await font("500 14px/20px system-ui, sans-serif")).shape).toMatchObject({ height: 28, fontSize: 14, fontWeight: 500 });
    expect((await font("italic small-caps bold 0.75rem / 1.5 Inter")).shape).toMatchObject({ height: 26, fontSize: 12, fontWeight: 700 });
    // The shorthand resets the weight to 400; a line height left out is `normal`, unknown.
    const reset = await font("13px Inter", "font-weight: 600;");
    expect(reset.shape).toMatchObject({ height: null, fontSize: 13, fontWeight: 400 });
    for (const value of ["var(--font-ui)", "caption"]) {
      const unknown = await font(value);
      expect(unknown.shape).toMatchObject({ fontSize: null, fontWeight: null, height: null });
      expect(unknown.unresolved).toEqual([`.f { font: ${value} }`]);
    }
  });

  test("without Tailwind's preflight a bare button's padding is unknown, not zero", () => {
    const rules = new ClassRules();
    expect(resolveClasses([], "button", new Theme(new Map(), null, []), rules).shape.paddingX).toBeNull();
  });
});

describe("bare projects", () => {
  test("routes are detected for Expo Router, Next.js and Astro layouts", () => {
    expect(detectRoutes(["app/_layout.tsx", "app/index.tsx"]).source).toBe("expo-router (app/)");
    expect(detectRoutes(["src/app/(auth)/login/page.tsx", "src/app/layout.tsx"]).config).toMatchObject({ strategy: "map", map: [{ file: "src/app/(auth)/login/page.tsx", routes: ["/login"] }], shell: ["src/app/layout.tsx"] });
    expect(detectRoutes(["src/pages/docs/index.astro"]).config.map).toEqual([{ file: "src/pages/docs/index.astro", routes: ["/docs"], evidence: "Astro page" }]);
  });

  test("a directory with no config, package.json or tsconfig still inventories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      await mkdir(join(dir, "ui"));
      await writeFile(join(dir, "ui/Thing.tsx"), 'export function SaveButton() {\n  return <button style={{}}>Save</button>;\n}\nexport function Page() {\n  return <SaveButton />;\n}\n');
      const bare = await inventory([dir]);
      expect(bare.projects[0]).toMatchObject({ routes: "none detected" });
      expect(bare.definitions.map((d) => [d.name, d.role])).toEqual([["SaveButton", "button"], ["Page", null]]);
      expect(bare.looks.map((l) => [l.tag, l.line, l.family])).toEqual([["SaveButton", 5, null]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the Astro template reader keeps lines and columns and finds tags inside expressions", () => {
    const source = '---\nconst a = 1;\n---\n<div class="x">\n  {items.map((i) => (\n    <button role="tab" class={i ? "a" : "b"}>{i}</button>\n  ))}\n</div>\n';
    const { tags } = readTemplate(source, source.indexOf("---", 3) + 3);
    expect(tags.map((t) => [t.tag, t.line, t.column, t.firstChild])).toEqual([["div", 4, 1, "button"], ["button", 6, 5, null]]);
    expect(tags[1]!.attributes).toEqual([{ name: "role", value: { literal: "tab" } }, { name: "class", value: { expression: 'i ? "a" : "b"' } }]);
  });

  test("the tolerance defaults are the settled ones", () => {
    expect(DEFAULT_TOLERANCE).toEqual({ height: 2, padding: 2, radius: 2, fontSize: 1, fontWeight: 100 });
  });
});
