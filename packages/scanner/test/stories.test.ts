import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InventoryReport, type InventoryLook } from "@youiyoux/core";
import { autoTitle, buildInventory, parseModule, projectSpecimens, readCsf, readDecorator, SpecimenCache, storyConfig, storyId, storyName, type ProjectSpecimens } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/inventory");
const STORYBOOK = join(FIXTURES, "storybook");
const CONSOLE = join(FIXTURES, "console");
const SCANNER_MODULES = join(import.meta.dirname, "../node_modules");
const BUTTON_STORIES = "src/components/ui/button.stories.tsx";
const ANY = { glob: "**/*.stories.tsx", base: "", titlePrefix: "" };

let report: InventoryReport;
let specimens: ProjectSpecimens;
let cacheDir: string;

const story = (name: string): InventoryLook => report.looks.find((l) => l.story?.name === name)!;
const uses = (): InventoryLook[] => report.looks.filter((l) => !l.story);

beforeAll(async () => {
  report = InventoryReport.parse(await buildInventory([STORYBOOK], { cwd: FIXTURES }));
  cacheDir = mkdtempSync(join(tmpdir(), "youi-stories-"));
  specimens = await projectSpecimens({ id: "storybook", root: STORYBOOK, commit: "c0ffee", looks: report.looks }, { cache: new SpecimenCache(cacheDir) });
}, 90_000);

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("CSF stories as authored states of their components (c1)", () => {
  test("each CSF 3 args story is a look of its meta's component, labeled with its Storybook title, name and id", () => {
    const drawn = report.looks.filter((l) => l.story).map((l) => [l.file, l.line, l.story!.title, l.story!.name, l.story!.id]);
    expect(drawn).toEqual([
      ["src/components/ui/badge.stories.tsx", 10, "components/ui/badge", "Neutral", "components-ui-badge--neutral"],
      ["src/components/ui/badge.stories.tsx", 14, "components/ui/badge", "Success", "components-ui-badge--success"],
      [BUTTON_STORIES, 22, "UI/Button", "Primary", "ui-button--primary"],
      [BUTTON_STORIES, 26, "UI/Button", "Outline", "ui-button--outline"],
      [BUTTON_STORIES, 30, "UI/Button", "Large", "ui-button--large"],
      [BUTTON_STORIES, 34, "UI/Button", "Default", "ui-button--default"],
      [BUTTON_STORIES, 36, "UI/Button", "High contrast", "ui-button--contrast"],
      [BUTTON_STORIES, 48, "UI/Button", "System Theme", "ui-button--system-theme"],
    ]);
    for (const look of report.looks.filter((l) => l.story)) {
      expect(look).toMatchObject({ source: "component", routes: [], routeSource: "unrouted" });
      expect(look.recipe?.kind).toBe("component");
    }
  });

  test("args become props and label; meta args fill in what a story leaves out; story args win", () => {
    expect(story("Outline")).toMatchObject({ definition: "storybook:src/components/ui/button.tsx#Button", recipe: { export: "Button", props: { variant: "outline" }, label: "Preview" } });
    expect(story("Default").recipe).toMatchObject({ props: {}, label: "Button" });
    expect(story("Large").recipe).toMatchObject({ props: { size: "lg" }, label: "Get started" });
    // `...Neutral.args` is read from the story it names.
    expect(story("Success").recipe).toMatchObject({ export: "Badge", props: { tone: "success" }, label: "Live" });
    expect(story("Large").shape).toMatchObject({ height: 44, paddingX: 32, fontSize: 16 });
  });

  test("stories sit beside the discovered looks in their family, and never count as its uses", () => {
    const page = uses().find((l) => l.file === "src/app/page.tsx" && l.role === "button")!;
    const family = report.families.find((f) => f.id === page.family)!;
    expect(story("Primary").family).toBe(family.id);
    expect(story("Outline").family).toBe(family.id);
    expect(family).toMatchObject({ looks: 3, stories: 5, nearDuplicate: false, projects: ["storybook"] });
    expect(family.sides.map((s) => s.looks)).toEqual([3]);
    expect(family.examples.every((e) => e.file === "src/app/page.tsx")).toBe(true);
    expect(report.families.find((f) => f.role === "badge")).toMatchObject({ looks: 1, stories: 2 });
    expect(report.summary).toMatchObject({ looks: 4, clustered: 4, unshaped: 0, stories: 8 });
  });

  test("a story whose shape no real look has gets a family of its own, marked authored, numbered after the real ones", () => {
    const large = report.families.find((f) => f.id === story("Large").family)!;
    expect(large).toMatchObject({ id: "button-2", authored: true, looks: 0, stories: 1, sides: [], nearDuplicate: false });
    expect(large.examples.map((e) => `${e.file}:${e.line}`)).toEqual([`${BUTTON_STORIES}:30`]);
  });

  test("story files add no looks of their own: families, looks and summary match the app with its stories removed", async () => {
    const bare = mkdtempSync(join(tmpdir(), "youi-no-stories-"));
    try {
      cpSync(STORYBOOK, bare, { recursive: true, filter: (source) => !/node_modules|\.stories\.|\.storybook/.test(source) });
      const without = InventoryReport.parse(await buildInventory([bare]));
      expect(without.projects[0]!.stories).toBeUndefined();
      expect(without.summary).toEqual({ ...report.summary, stories: undefined, notClustered: without.summary.notClustered });
      expect(uses().map((l) => [l.file, l.line, l.family])).toEqual(without.looks.map((l) => [l.file, l.line, l.family]));
      expect(report.families.filter((f) => !f.authored).map(({ stories: _, ...f }) => f)).toEqual(without.families);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a project-defined provider decorator becomes the recipe's wrappers, meta's outside the story's", () => {
    const provider = { file: "src/components/theme-provider.tsx", export: "ThemeProvider" };
    expect(story("Primary").recipe).toMatchObject({ wrappers: [{ ...provider, props: { theme: "default" } }] });
    expect(story("High contrast").recipe).toMatchObject({
      wrappers: [
        { ...provider, props: { theme: "default" } },
        { ...provider, props: { theme: "contrast" } },
      ],
    });
  });

  test("each story is drawn through the project's own specimen pipeline: its component server-rendered inside its providers", () => {
    const html = (name: string) => specimens.specimens[specimens.looks[story(name).id]!]!;
    expect(html("Primary")).toMatchObject({ kind: "component", html: expect.stringMatching(/^<div data-theme="default"><button class="[^"]*h-8 px-3[^"]*">Publish<\/button><\/div>$/) });
    expect(html("High contrast").html).toMatch(/^<div data-theme="default"><div data-theme="contrast"><button [^>]*>Publish<\/button><\/div><\/div>$/);
    expect(html("Large").html).toMatch(/h-11 px-8 text-base[^"]*">Get started<\/button>/);
    expect(html("Success")).toMatchObject({ kind: "component", html: expect.stringContaining(">Live</span>") });
    for (const look of report.looks.filter((l) => l.story)) expect(specimens.specimens[specimens.looks[look.id]!]?.kind, look.story!.name).toBe("component");
    expect(specimens.warnings.join("\n")).not.toMatch(/did not render/);
  });

  test("Storybook is never installed or run: the fixture has no Storybook package, and main.ts is only read", async () => {
    await expect(import("@storybook/react-vite" as string)).rejects.toThrow();
    expect((await storyConfig(STORYBOOK)).specifiers).toEqual([{ glob: "src/**/*.stories.{ts,tsx}", base: "src", titlePrefix: "" }]);
  });
});

describe("stories that cannot be drawn are skipped with a plain reason (c2)", () => {
  test("every story not drawn is listed with file:line, its name and why; the scan finishes with every other look", () => {
    const stories = report.projects[0]!.stories!;
    expect(stories).toMatchObject({ files: 5, read: 12, drawn: 8 });
    expect(stories.skipped).toEqual([
      { file: BUTTON_STORIES, line: 59, name: "With Icon", reason: "has its own render function; only args stories are drawn" },
      { file: BUTTON_STORIES, line: 67, name: "Legacy", reason: "a CSF 2 function story; only CSF 3 object stories are read" },
      { file: "src/stories/broken.stories.tsx", line: 9, name: "every story in it", reason: "the file did not parse; fix its syntax and run again" },
      { file: "src/stories/introduction.stories.tsx", line: 5, name: "Welcome", reason: "meta names no component" },
      { file: "src/stories/remote-button.stories.tsx", line: 8, name: "From Package", reason: "Button comes from package @acme/ui, not this project" },
    ]);
    expect(uses()).toHaveLength(4);
  });

  test("a story file that does not parse goes into the project's failed list, and the project is partial, not broken", () => {
    expect(report.projects[0]).toMatchObject({ status: "partial", failed: [{ file: "src/stories/broken.stories.tsx", reason: expect.stringContaining("its stories were not read") }] });
  });

  test("a decorator from a package, and global decorators, are noted and left out; the story is still drawn", () => {
    expect(report.projects[0]!.stories!.notes).toEqual([
      ".storybook/preview.tsx has global decorators; they are not applied, so stories are drawn with this project's components and CSS only",
      `${BUTTON_STORIES}: decorator at line 51 skipped: ThemeProvider comes from package next-themes; only providers defined in this project are applied; its stories are drawn without it`,
    ]);
    expect(story("System Theme").recipe).toMatchObject({ props: { variant: "ghost" }, wrappers: [{ export: "ThemeProvider", props: { theme: "default" } }] });
  });

  test("a project with no Storybook gets no stories section, and its inventory is unchanged", async () => {
    const plain = InventoryReport.parse(await buildInventory([CONSOLE]));
    expect(plain.projects[0]!.stories).toBeUndefined();
    expect(plain.summary.stories).toBeUndefined();
    expect(plain.looks.some((l) => l.story)).toBe(false);
  });

  test("odd files never throw: no default export, a non-object meta, unreadable decorators, spreads and computed args", async () => {
    const read = async (source: string) => readCsf((await parseModule("src/x.stories.tsx", source))!, ANY);
    expect((await read(`export const A = { args: {} };`)).stories[0]!.skip).toBe("the file has no default export, so it is not a CSF stories file");
    expect((await read(`export default makeMeta();\nexport const A = {};`)).stories[0]!.skip).toBe("its default export is not a meta object");
    expect((await read(`import { B } from "./b";\nexport default { component: B };\nexport const A = B.bind({});`)).stories[0]!.skip).toBe("a CSF 2 Template.bind story; only CSF 3 object stories are read");
    expect((await read(`import { B } from "./b";\nexport default { component: B, render: () => null };\nexport const A = {};`)).stories[0]!.skip).toBe("the meta has its own render function; only args stories are drawn");
    const odd = await read(`import { B } from "./b";\nimport { base } from "./base";\nexport default { component: B, excludeStories: ["data"] } as Meta;\nexport const data = {};\nexport const A = { ...base, args: { ...base.args, size: sizes[0], children: <b>x</b>, className: "mt-2", onClick: fn() } };`);
    expect(odd.stories.map((s) => s.exportName)).toEqual(["A"]);
    expect(odd.stories[0]).toMatchObject({ skip: null, props: {}, label: null, className: { certain: ["mt-2"] } });
    expect(odd.stories[0]!.unresolved).toEqual(["args.size: sizes[0]", "args.children: <b>x</b> (not plain text; drawn with its own label)", "...base: a spread that cannot be read", "args ...base.args: a spread that cannot be read"]);
  });

  test("decorators: a chain of components around <Story /> is read; anything else says why it is not", async () => {
    const decorator = async (source: string) => readDecorator((await parseModule("d.tsx", `const d = ${source};`))!.root.root().find({ rule: { kind: "variable_declarator" } })!.field("value")!);
    expect(await decorator(`(Story) => <A x="1"><B on><Story /></B></A>`)).toEqual({ line: 1, chain: [{ tag: "A", props: { x: { literal: "1" } } }, { tag: "B", props: { on: { literal: true } } }] });
    expect(await decorator(`(S, ctx) => { return <A>{S()}</A>; }`)).toMatchObject({ chain: [{ tag: "A" }] });
    expect(await decorator(`(Story) => <Story />`)).toEqual({ line: 1, chain: [] });
    expect(await decorator(`withRouter`)).toMatchObject({ reason: "it is not an inline function, so what it wraps cannot be read" });
    expect(await decorator(`(Story) => <A theme={theme}><Story /></A>`)).toMatchObject({ reason: "<A>'s theme is computed (theme={theme}); only literal props are applied" });
    expect(await decorator(`(Story) => <A><Story /><Toaster /></A>`)).toMatchObject({ reason: "<A> wraps more than the story" });
    expect(await decorator(`(Story) => <A {...p}><Story /></A>`)).toMatchObject({ reason: "<A> spreads props, which cannot be read" });
  });

  test("names, ids and auto titles follow Storybook's own rules", () => {
    expect(storyName("WithIcon")).toBe("With Icon");
    expect(storyName("primary_large")).toBe("Primary Large");
    expect(storyId("UI/Button", "WithIcon")).toBe("ui-button--with-icon");
    expect(autoTitle("src/components/Button/Button.stories.tsx", { glob: "src/**/*.stories.tsx", base: "src", titlePrefix: "" })).toBe("components/Button");
    expect(autoTitle("lib/card.stories.tsx", { glob: "lib/**", base: "lib", titlePrefix: "Kit" })).toBe("Kit/card");
  });

  test("main.ts entries: string globs, directory objects with a title prefix; one that leaves the project is noted, not read", async () => {
    const root = mkdtempSync(join(tmpdir(), "youi-storybook-main-"));
    try {
      cpSync(join(STORYBOOK, "src"), join(root, "src"), { recursive: true });
      cpSync(join(STORYBOOK, "tsconfig.json"), join(root, "tsconfig.json"));
      cpSync(join(STORYBOOK, "package.json"), join(root, "package.json"));
      symlinkSync(SCANNER_MODULES, join(root, "node_modules"));
      cpSync(join(STORYBOOK, ".storybook"), join(root, ".storybook"), { recursive: true });
      writeFileSync(join(root, ".storybook/main.ts"), `export default { stories: [{ directory: "../src/components", titlePrefix: "Kit" }, "../../elsewhere/**/*.stories.tsx", ...more] };\n`);
      const config = await storyConfig(root);
      expect(config.specifiers).toEqual([{ glob: "src/components/**/*.stories.{tsx,ts,jsx,js,mjs}", base: "src/components", titlePrefix: "Kit" }]);
      expect(config.notes.filter((n) => n.startsWith(".storybook/main.ts"))).toEqual([".storybook/main.ts:1: stories entry \"../../elsewhere/**/*.stories.tsx\" was not read (computed, or outside the project)", ".storybook/main.ts:1: stories entry ...more was not read (computed, or outside the project)"]);
      const inventory = InventoryReport.parse(await buildInventory([root]));
      expect(inventory.projects[0]!.stories).toMatchObject({ files: 2, drawn: 8 });
      expect(inventory.looks.find((l) => l.story?.name === "Neutral")!.story!.title).toBe("Kit/ui/badge");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
