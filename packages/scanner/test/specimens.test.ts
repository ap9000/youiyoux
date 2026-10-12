import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InventoryReport } from "@youiyoux/core";
import { buildInventory, buildProjectCss, defaultCacheDir, escapingLinks, forScheme, loadInventoryTarget, markupOf, newStats, pageStylesheets, projectSpecimens, projectTailwind, relativeInside, SpecimenCache, stylesheetLinks, tailwindCliBuilds, within, type ProjectSpecimens } from "../src/index.ts";
import { renderComponents, type ComponentRecipe } from "../src/specimens/render.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/inventory");
const CONSOLE = join(FIXTURES, "console");
const SITE = join(FIXTURES, "site");
const WIDGETS = join(FIXTURES, "widgets");
const SCANNER_MODULES = join(import.meta.dirname, "../node_modules");

/** Every file under a directory: path, size, mtime and content hash; a symlink by its target (not followed). */
function treeDigest(root: string, dir = root): string[] {
  const lines: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) lines.push(`${relative(root, path)} -> ${readlinkSync(path)} ${stat.mtimeMs}`);
    else if (stat.isDirectory()) lines.push(`${relative(root, path)} dir`, ...treeDigest(root, path));
    else lines.push(`${relative(root, path)} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  }
  return lines;
}

/** A fixture copied to a temporary directory, its packages linked as the original's are. */
function copyFixture(from: string, to: string): string {
  cpSync(from, to, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes("node_modules") });
  symlinkSync(SCANNER_MODULES, join(to, "node_modules"));
  return to;
}

let report: InventoryReport;
let cacheDir: string;
const digests = new Map<string, string>();
const built = new Map<string, ProjectSpecimens>();

const projectOf = (id: string, root: string, commit = "c0ffee") => ({ id, root, commit, looks: report.looks.filter((l) => l.project === id) });
const specimenOf = (project: string, file: string, line: number): string => {
  const look = report.looks.find((l) => l.project === project && l.file === file && l.line === line)!;
  const specimens = built.get(project)!;
  return specimens.specimens[specimens.looks[look.id]!]!.html;
};

beforeAll(async () => {
  for (const root of [CONSOLE, SITE, WIDGETS]) digests.set(root, treeDigest(root).join("\n"));
  report = InventoryReport.parse(await buildInventory([CONSOLE, SITE, WIDGETS], { cwd: FIXTURES }));
  cacheDir = mkdtempSync(join(tmpdir(), "youi-specimens-"));
  const cache = new SpecimenCache(cacheDir);
  built.set("console", await projectSpecimens(projectOf("console", CONSOLE), { cache }));
  built.set("site", await projectSpecimens(projectOf("site", SITE), { cache }));
  built.set("widgets", await projectSpecimens(projectOf("widgets", WIDGETS), { cache }));
}, 60_000);

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("specimen CSS: the project's own build (c1)", () => {
  test("stylesheets in the page's order: layouts' imports first, then each component's", () => {
    expect(pageStylesheets(CONSOLE, ["src/browser/toolbar.tsx", "src/app/layout.tsx", "src/app/page.tsx"])).toEqual(["src/app/globals.css", "src/browser/ui.css"]);
    expect(pageStylesheets(SITE, ["src/pages/pricing.astro", "src/layouts/Base.astro"])).toEqual(["src/styles/ui.css", "src/styles/marketing.css"]);
  });

  test("Tailwind v4 compiles the CVA kit's utilities with the project's theme, then its imported and global sheets follow", () => {
    const css = built.get("console")!.css!.light;
    expect(built.get("console")!.tailwind).toMatch(/^Tailwind 4\.\d+\.\d+, the project's own$/);
    for (const utility of [".h-8", ".rounded-md", ".bg-primary", ".bg-red-600", ".data-\\[state\\=active\\]\\:bg-background"]) expect(css).toContain(utility);
    expect(css).toContain("--radius-md: 8px");
    // legacy.css arrives through Tailwind's @import, once; the browser kit's sheet after it.
    expect(css.match(/\.lg-button \{/g)).toHaveLength(1);
    expect(css.indexOf(".lg-button {")).toBeLessThan(css.indexOf(".ui-button {"));
  });

  test("a font loaded from an absolute /fonts path is inlined as a data URI", () => {
    const css = built.get("console")!.css!.dark;
    expect(css).toMatch(/@font-face \{[^}]*font-family: "?Console Mono"?;[^}]*src: url\("data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}"\)/);
    expect(css).not.toContain("/fonts/console-mono.woff2");
  });

  test("light and dark fix prefers-color-scheme to true or false; none is left", () => {
    const { light, dark } = built.get("console")!.css!;
    expect(light).not.toMatch(/prefers-color-scheme/);
    expect(dark).not.toMatch(/prefers-color-scheme/);
    expect(dark).toMatch(/@media \(min-width: 0px\) \{\s*:root \{\s*--color-primary: #fafafa/);
    expect(light).toMatch(/@media \(not \(min-width: 0px\)\) \{\s*:root \{\s*--color-primary: #fafafa/);
    expect(dark).toContain("color-scheme: dark");
    expect(forScheme("@media (prefers-color-scheme: light) and (min-width: 600px) { a { b: c } }", "dark")).toContain("@media (not (min-width: 0px)) and (min-width: 600px)");
  });

  test("a BEM class kit's rules are its stylesheets as written; a declared Tailwind that does not match is not used", () => {
    const site = built.get("site")!;
    expect(site.sheets).toEqual(["src/styles/ui.css", "src/styles/marketing.css"]);
    expect(site.css!.light).toContain(".ui-button {");
    expect(site.css!.light).toContain(".badge--muted {");
    expect(site.warnings.join("\n")).toContain("no stylesheet a page loads is a Tailwind entry");
    // The site asks for Tailwind ^3; its node_modules has v4, so it is never compiled with it.
    expect(projectTailwind(SITE)).toMatchObject({ node: null, note: expect.stringContaining("asks for tailwindcss ^3") });
  });
});

describe("specimen HTML: looks rendered as the app renders them (c1)", () => {
  test("a CVA component renders its table's classes for the site's variant", () => {
    expect(specimenOf("console", "src/app/page.tsx", 16)).toBe('<button class="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:ring-2 disabled:opacity-50 border border-input bg-background hover:bg-accent h-8 px-3">Export</button>');
    expect(built.get("console")!.specimens[built.get("console")!.looks[report.looks.find((l) => l.line === 16 && l.file === "src/app/page.tsx")!.id]!]!.kind).toBe("component");
  });

  test("variant=destructive renders the destructive row of the CVA table", async () => {
    const stats = newStats();
    const scratch = mkdtempSync(join(tmpdir(), "youi-render-"));
    const recipe = { kind: "component" as const, file: "src/components/ui/button.tsx", export: "Button", props: { variant: "destructive", size: "sm" }, label: "Delete", wrappers: [], tag: "button", classes: [] };
    const result = await renderComponents(CONSOLE, "tsconfig.json", [{ key: "d", recipe, label: "Delete" }], scratch, stats);
    rmSync(scratch, { recursive: true, force: true });
    expect(result.failures.size).toBe(0);
    expect(result.html.get("d")).toBe('<button class="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:ring-2 disabled:opacity-50 bg-red-600 text-white hover:bg-red-700 h-7 px-2.5 text-xs">Delete</button>');
  });

  test("Radix TabsTrigger renders data-state active and inactive inside its Tabs and TabsList", () => {
    const runs = specimenOf("console", "src/app/page.tsx", 23);
    const logs = specimenOf("console", "src/app/page.tsx", 24);
    expect(runs).toContain('role="tablist"');
    expect(runs).toMatch(/<button[^>]*role="tab"[^>]*data-state="active"[^>]*>Runs<\/button>/);
    expect(logs).toMatch(/<button[^>]*role="tab"[^>]*data-state="inactive"[^>]*>Logs<\/button>/);
  });

  test("an open Dialog's content renders in place, its portal stubbed", () => {
    expect(specimenOf("console", "src/app/settings/page.tsx", 20)).toMatch(/^<div role="dialog"[^>]*data-state="open"[^>]*class="fixed rounded-lg[^"]*"[^>]*>Are you sure\?<\/div>$/);
  });

  test("an Astro Badge, BEM classes and hand-styled elements are class snippets", () => {
    expect(specimenOf("site", "src/pages/index.astro", 9)).toBe('<span class="ui-badge">New</span>');
    expect(specimenOf("site", "src/pages/pricing.astro", 8)).toBe('<span class="badge badge--muted">Monthly</span>');
    expect(specimenOf("console", "src/browser/toolbar.tsx", 8)).toBe('<button class="ui-button" type="button">Go</button>');
    expect(Object.values(built.get("site")!.specimens).every((s) => s.kind === "markup")).toBe(true);
  });

  test("a component that does not render falls back to its tag and classes, and says so", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "youi-render-"));
    const recipe = { kind: "component" as const, file: "src/components/ui/button.tsx", export: "Nope", props: {}, label: "x", wrappers: [], tag: "button", classes: ["h-8"] };
    const result = await renderComponents(CONSOLE, "tsconfig.json", [{ key: "n", recipe, label: "x" }], scratch, newStats());
    rmSync(scratch, { recursive: true, force: true });
    expect(result.failures.get("n")).toContain("has no export Nope");
    expect(markupOf(recipe, "button")).toBe('<button class="h-8" type="button">x</button>');
    expect(markupOf({ kind: "class", tag: "input", classes: ["ui-input"], label: null }, "input")).toBe('<input class="ui-input" value="">');
  });
});

describe("specimen cache and the read-only guarantee (c2)", () => {
  test("the default cache lives under XDG_CACHE_HOME, outside every project", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/x/cache" })).toBe("/x/cache/youiyoux/specimens");
    expect(defaultCacheDir({ HOME: "/h" })).toMatch(/\.cache\/youiyoux\/specimens$/);
    expect(defaultCacheDir({ YOUI_SPECIMEN_CACHE: "/t" })).toBe("/t");
  });

  test("a second build at the same commit and inputs is a cache hit: no Tailwind compile, no esbuild bundle", async () => {
    const stats = newStats();
    const cache = new SpecimenCache(cacheDir);
    const again = await projectSpecimens(projectOf("console", CONSOLE), { cache, stats });
    expect(stats).toEqual({ tailwindCompiles: 0, bundles: 0, hits: 1, misses: 0 });
    expect(again.cached).toBe(true);
    expect(again.css).toEqual(built.get("console")!.css);
    expect(again.specimens).toEqual(built.get("console")!.specimens);
  });

  test("a new commit or a changed source rebuilds", async () => {
    const cache = new SpecimenCache(cacheDir);
    const stats = newStats();
    await projectSpecimens(projectOf("console", CONSOLE, "another-commit"), { cache, stats });
    expect(stats).toMatchObject({ tailwindCompiles: 1, bundles: 1, misses: 1 });

    // A copy of the fixture whose packages resolve like the original's.
    const copy = mkdtempSync(join(tmpdir(), "youi-console-"));
    try {
      copyFixture(CONSOLE, copy);
      const first = newStats();
      await projectSpecimens(projectOf("console", copy, "copy"), { cache, stats: first });
      const hit = newStats();
      await projectSpecimens(projectOf("console", copy, "copy"), { cache, stats: hit });
      expect([first.misses, hit.hits]).toEqual([1, 1]);
      writeFileSync(join(copy, "src/browser/ui.css"), `${readFileSync(join(copy, "src/browser/ui.css"), "utf8")}\n.ui-button { letter-spacing: 1px; }\n`);
      const changed = newStats();
      const rebuilt = await projectSpecimens(projectOf("console", copy, "copy"), { cache, stats: changed });
      expect(changed).toMatchObject({ misses: 1, tailwindCompiles: 1 });
      expect(rebuilt.css!.light).toContain("letter-spacing: 1px");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 60_000);

  test("building writes nothing into the scanned projects: every file's path, size, mtime and content is unchanged", async () => {
    // Uncached builds too, so Tailwind and esbuild really ran.
    const cache = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-specimens-")));
    await projectSpecimens(projectOf("console", CONSOLE, "fresh"), { cache });
    await projectSpecimens(projectOf("site", SITE, "fresh"), { cache });
    await projectSpecimens(projectOf("widgets", WIDGETS, "fresh"), { cache });
    rmSync(cache.dir, { recursive: true, force: true });
    for (const root of [CONSOLE, SITE, WIDGETS]) expect(treeDigest(root).join("\n")).toBe(digests.get(root));
    expect((await loadInventoryTarget(CONSOLE)).files).not.toContain("bundle.cjs");
  }, 60_000);

  test("a project with no stylesheet gets no CSS and says so", async () => {
    const empty = mkdtempSync(join(tmpdir(), "youi-bare-"));
    try {
      writeFileSync(join(empty, "a.tsx"), "export const A = () => <button className=\"x\">a</button>;\n");
      const css = await buildProjectCss(empty, ["a.tsx"], newStats());
      expect(css).toMatchObject({ light: null, dark: null, warnings: ["no stylesheet a page loads: none is linked from HTML, imported by a module, or a Tailwind entry"] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("stylesheets the way the page gets them (c6)", () => {
  const widgetsCss = (): string => built.get("widgets")!.css!.light;

  test("a console-shaped app: its CLI-built Tailwind entry from the links in index.html and the server template, then its linked plain kit", () => {
    const widgets = built.get("widgets")!;
    expect(widgets.sources).toEqual([
      { sheet: "src/browser/tailwind.css", via: 'link /assets/app.css in index.html, built by package.json "build:css"', as: "tailwind" },
      { sheet: "public/ui.css", via: "link /ui.css in src/server/shell.ts", as: "plain" },
    ]);
    expect(widgets.used).toEqual([
      expect.stringMatching(/^built: src\/browser\/tailwind\.css \(link \/assets\/app\.css in index\.html, built by package\.json "build:css", Tailwind 4\.\d+\.\d+\)$/),
      "inlined: public/ui.css (link /ui.css in src/server/shell.ts)",
    ]);
    expect(widgets.warnings).toEqual([]);
  });

  test("its CVA Button, .ui-button and Badge get their real background colours, light and dark", () => {
    const css = widgetsCss();
    // tokens.css arrives only through the entry's @import: its theme colours back the CVA utilities.
    expect(css).toMatch(/\.bg-brand \{\s*background-color: var\(--color-brand\);/);
    expect(css).toMatch(/--color-brand: #0f766e;/);
    expect(css).toMatch(/\.bg-warning \{\s*background-color: var\(--color-warning\);/);
    expect(css).toMatch(/--color-warning: #fef3c7;/);
    expect(css).toMatch(/\.ui-button \{[^}]*background: var\(--ui-accent\);/);
    expect(css).toMatch(/:root \{\s*--ui-accent: #7c3aed;/);
    expect(css).toMatch(/\.ui-badge \{[^}]*background: #fee2e2;/);
    expect(built.get("widgets")!.css!.dark).toMatch(/@media \(min-width: 0px\) \{\s*:root \{\s*--color-brand: #2dd4bf;/);
    expect(specimenOf("widgets", "src/main.tsx", 8)).toBe('<button class="inline-flex items-center justify-center rounded-md text-sm font-medium bg-brand text-brand-foreground hover:bg-brand/90 h-8 px-3">Sync</button>');
    expect(specimenOf("widgets", "src/main.tsx", 9)).toContain('class="inline-flex h-5 items-center rounded-full px-2 text-xs font-medium bg-warning text-warning-foreground"');
    expect(specimenOf("widgets", "src/main.tsx", 10)).toBe('<button class="ui-button" type="button">Retry</button>');
  });

  test("links and Tailwind CLI scripts are read as the page and package.json have them", () => {
    expect(stylesheetLinks(`<link rel="stylesheet" href="/a.css"><link rel=preload href="/b.css"><link href='/c.css' rel="stylesheet alternate"><link rel="stylesheet" href="\${base}/d.css">`)).toEqual(["/a.css", "/c.css"]);
    expect(tailwindCliBuilds(WIDGETS)).toEqual([{ script: "build:css", input: "src/browser/tailwind.css", output: "public/assets/app.css" }]);
  });

  test("a Tailwind entry nothing links or imports is still built", async () => {
    const copy = copyFixture(WIDGETS, mkdtempSync(join(tmpdir(), "youi-widgets-")));
    try {
      rmSync(join(copy, "index.html"));
      rmSync(join(copy, "src/server/shell.ts"));
      const target = await loadInventoryTarget(copy);
      const css = await buildProjectCss(copy, target.files, newStats(), { templates: target.templates });
      expect(css.sources).toEqual([{ sheet: "src/browser/tailwind.css", via: "a Tailwind entry no module imports", as: "tailwind" }]);
      expect(css.light).toContain("--color-brand: #0f766e");
      // tokens.css is @imported by the entry, so it is not a sheet of its own.
      expect(css.sheets).not.toContain("src/design/tokens.css");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test("specimens.css in youi.project.json is used exactly, in its order", async () => {
    const copy = copyFixture(WIDGETS, mkdtempSync(join(tmpdir(), "youi-widgets-")));
    try {
      writeFileSync(join(copy, "youi.project.json"), JSON.stringify({ specimens: { css: ["public/ui.css", "src/design/tokens.css", "../elsewhere.css"] } }));
      const stats = newStats();
      const built = await projectSpecimens({ id: "widgets", root: copy, commit: "o", looks: [] }, { cache: new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-specimens-"))), stats });
      expect(built.sources).toEqual([
        { sheet: "public/ui.css", via: "specimens.css in youi.project.json", as: "plain" },
        { sheet: "src/design/tokens.css", via: "specimens.css in youi.project.json", as: "plain" },
      ]);
      expect(built.warnings).toContain("youi.project.json specimens.css: refused ../elsewhere.css is outside the project root");
      expect(stats.tailwindCompiles).toBe(0);
      expect(built.css!.light.indexOf(".ui-button {")).toBeLessThan(built.css!.light.indexOf("--ui-accent: #7c3aed"));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------ containment (c4) */

const MARKER = "youi-outside-marker-5c1d";

/**
 * A copy of the console beside directories it must never read: outside/ (stylesheets, a module
 * that leaves a file behind when it runs, classes for Tailwind) and proj-evil/ (a font whose
 * directory shares the project's name as a prefix).
 */
function sandbox(): { root: string; outside: string; ran: string; build: (looks?: SpecimenProjectLooks) => Promise<ProjectSpecimens>; dispose: () => void } {
  const base = mkdtempSync(join(tmpdir(), "youi-contain-"));
  const root = copyFixture(CONSOLE, join(base, "proj"));
  const outside = join(base, "outside");
  const ran = join(base, "ran.txt");
  mkdirSync(join(outside, "lib"), { recursive: true });
  mkdirSync(join(base, "proj-evil"));
  writeFileSync(join(outside, "x.css"), `.leak { content: "${MARKER}"; }\n`);
  writeFileSync(join(outside, "classes.html"), `<div class="bg-[#123456] ${MARKER}"></div>\n`);
  const sideEffect = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "ran");\n`;
  writeFileSync(join(outside, "evil.tsx"), `${sideEffect}export function Evil() { return <b>${MARKER}</b>; }\n`);
  writeFileSync(join(outside, "lib/thing.tsx"), `${sideEffect}export function Thing() { return <b>${MARKER}</b>; }\n`);
  writeFileSync(join(base, "proj-evil/x.woff2"), MARKER.repeat(64));
  return {
    root,
    outside,
    ran,
    build: async (looks = []) => {
      const inventoried = InventoryReport.parse(await buildInventory([root], { cwd: base }));
      return projectSpecimens({ id: "proj", root, commit: "c", looks: [...inventoried.looks, ...looks] }, { cache: new SpecimenCache(join(base, "cache")) });
    },
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}
type SpecimenProjectLooks = ReadonlyArray<{ id: string; role: "button"; recipe: ComponentRecipe }>;

/** Nothing from outside the root in the output, nothing outside ran, and the vector's warning. */
function expectContained(box: ReturnType<typeof sandbox>, built: ProjectSpecimens, warning: RegExp): void {
  const output = JSON.stringify([built.css, built.specimens]);
  expect(output).not.toContain(MARKER);
  expect(output).not.toContain(Buffer.from(MARKER.repeat(64)).toString("base64").slice(0, 40));
  expect(output).not.toContain("#123456");
  expect(existsSync(box.ran)).toBe(false);
  expect(built.warnings.join("\n")).toMatch(warning);
}

describe("specimen builds read and run nothing outside the project root (c4)", () => {
  test("the root check: real paths, separator-aware, refusing .., absolute paths and escaping symlinks", () => {
    const box = sandbox();
    try {
      expect(within(box.root, join(box.root, "src/app/layout.tsx"))).toBe(true);
      expect(within(box.root, join(box.root, "../proj-evil/x.woff2"))).toBe(false);
      expect(within(box.root, `${box.root}-evil/x.woff2`)).toBe(false);
      expect(relativeInside(box.root, "../outside/evil.tsx")).toEqual({ refused: "../outside/evil.tsx is outside the project root" });
      expect(relativeInside(box.root, "src/../../outside/evil.tsx")).toMatchObject({ refused: expect.any(String) });
      expect(relativeInside(box.root, join(box.outside, "evil.tsx"))).toMatchObject({ refused: expect.stringContaining("absolute") });
      symlinkSync(join(box.outside, "evil.tsx"), join(box.root, "src/linked.tsx"));
      expect(relativeInside(box.root, "src/linked.tsx")).toMatchObject({ refused: expect.stringContaining("symlink") });
      expect(escapingLinks(box.root)).toEqual(["src/linked.tsx"]);
    } finally {
      box.dispose();
    }
  });

  test("vector: a relative @import that climbs out of the root (../../x.css)", async () => {
    const box = sandbox();
    try {
      const sheet = join(box.root, "src/browser/ui.css");
      writeFileSync(sheet, `@import "../../../outside/x.css";\n${readFileSync(sheet, "utf8")}`);
      const built = await box.build();
      expectContained(box, built, /src\/browser\/ui\.css: refused @import "\.\.\/\.\.\/\.\.\/outside\/x\.css" is outside the project root/);
      expect(built.css!.light).toContain(".ui-button {");
    } finally {
      box.dispose();
    }
  });

  test("vector: an absolute @import (/abs/file)", async () => {
    const box = sandbox();
    try {
      const sheet = join(box.root, "src/browser/ui.css");
      writeFileSync(sheet, `@import "${join(box.outside, "x.css")}";\n${readFileSync(sheet, "utf8")}`);
      expectContained(box, await box.build(), /src\/browser\/ui\.css: refused @import "[^"]+\/outside\/x\.css" is an absolute path/);
    } finally {
      box.dispose();
    }
  });

  test("vector: a module's CSS import that leaves the root (import '../x.css')", async () => {
    const box = sandbox();
    try {
      const module = join(box.root, "src/browser/toolbar.tsx");
      writeFileSync(module, `import "../../../outside/x.css";\n${readFileSync(module, "utf8")}`);
      expectContained(box, await box.build(), /src\/browser\/toolbar\.tsx: refused import "\.\.\/\.\.\/\.\.\/outside\/x\.css" is outside the project root/);
    } finally {
      box.dispose();
    }
  });

  test("vector: a symlink under public/fonts that leads out of the root", async () => {
    const box = sandbox();
    try {
      const font = join(box.root, "public/fonts/console-mono.woff2");
      unlinkSync(font);
      symlinkSync(join(box.root, "../proj-evil/x.woff2"), font);
      const built = await box.build();
      expectContained(box, built, /refused font \/fonts\/console-mono\.woff2: a symlink that leads outside the project root/);
      expect(built.warnings).toContain("refused public/fonts/console-mono.woff2: a symlink that leads outside the project root (not scanned for classes)");
    } finally {
      box.dispose();
    }
  });

  test("vector: a /fonts/.. path into a sibling that shares the root's name (/fonts/../../../proj-evil/x.woff2)", async () => {
    const box = sandbox();
    try {
      const sheet = join(box.root, "src/app/globals.css");
      writeFileSync(sheet, readFileSync(sheet, "utf8").replace("/fonts/console-mono.woff2", "/fonts/../../../proj-evil/x.woff2"));
      expectContained(box, await box.build(), /refused font \/fonts\/\.\.\/\.\.\/\.\.\/proj-evil\/x\.woff2: it climbs out of the public directory/);
    } finally {
      box.dispose();
    }
  });

  test("vector: a Tailwind @import and @source outside the root", async () => {
    const box = sandbox();
    try {
      const sheet = join(box.root, "src/app/globals.css");
      writeFileSync(sheet, readFileSync(sheet, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss";\n@import "../../../outside/x.css";\n@source "../../../outside";'));
      const built = await box.build();
      expectContained(box, built, /src\/app\/globals\.css: refused @import "\.\.\/\.\.\/\.\.\/outside\/x\.css" is outside the project root/);
      expect(built.warnings.join("\n")).toMatch(/src\/app\/globals\.css: refused @source "\.\.\/outside\/\*\*\/\*": outside the project root, not scanned|src\/app\/globals\.css: refused @source "[^"]*outside[^"]*": outside the project root, not scanned/);
      // The rest of the entry still compiled with the project's Tailwind.
      expect(built.css!.light).toContain(".bg-primary");
    } finally {
      box.dispose();
    }
  });

  test("vector: a recipe file outside the root (../outside/evil.tsx) is never bundled or run", async () => {
    const box = sandbox();
    try {
      const recipe: ComponentRecipe = { kind: "component", file: "../outside/evil.tsx", export: "Evil", props: {}, label: "Evil", wrappers: [], tag: "button", classes: ["h-8"] };
      const built = await box.build([{ id: "evil-look", role: "button", recipe }]);
      expectContained(box, built, /refused recipe \.\.\/outside\/evil\.tsx#Evil: \.\.\/outside\/evil\.tsx is outside the project root: drawn from its classes/);
      expect(built.specimens[built.looks["evil-look"]!]).toEqual({ kind: "markup", html: '<button class="h-8" type="button">Evil</button>' });
      // Even asked directly, the renderer refuses it.
      const scratch = mkdtempSync(join(tmpdir(), "youi-render-"));
      const direct = await renderComponents(box.root, "tsconfig.json", [{ key: "e", recipe, label: "Evil" }], scratch, newStats());
      rmSync(scratch, { recursive: true, force: true });
      expect(direct.failures.get("e")).toBe("refused: ../outside/evil.tsx is outside the project root");
      expect(existsSync(box.ran)).toBe(false);
    } finally {
      box.dispose();
    }
  });

  test("vector: a tsconfig paths entry to ../outside/* fails only the module that imports through it", async () => {
    const box = sandbox();
    try {
      const tsconfig = join(box.root, "tsconfig.json");
      const config = JSON.parse(readFileSync(tsconfig, "utf8")) as { compilerOptions: { paths: Record<string, string[]> } };
      config.compilerOptions.paths["lib/*"] = ["../outside/lib/*"];
      writeFileSync(tsconfig, JSON.stringify(config));
      writeFileSync(join(box.root, "src/components/ui/thing-button.tsx"), `import { Thing } from "lib/thing";\nexport function ThingButton() { return <button><Thing /></button>; }\n`);
      const recipe: ComponentRecipe = { kind: "component", file: "src/components/ui/thing-button.tsx", export: "ThingButton", props: {}, label: null, wrappers: [], tag: "button", classes: ["thing"] };
      const built = await box.build([{ id: "thing-look", role: "button", recipe }]);
      expectContained(box, built, /refused import "lib\/thing" resolves outside the project root \(from src\/components\/ui\/thing-button\.tsx\)/);
      expect(built.specimens[built.looks["thing-look"]!]!.kind).toBe("markup");
      expect(Object.values(built.specimens).filter((s) => s.kind === "component").length).toBeGreaterThan(3);
    } finally {
      box.dispose();
    }
  });

  test("vector: a symlinked source file that leads out of the root, as a recipe and as an import", async () => {
    const box = sandbox();
    try {
      symlinkSync(join(box.outside, "evil.tsx"), join(box.root, "src/components/ui/linked.tsx"));
      writeFileSync(join(box.root, "src/components/ui/uses-linked.tsx"), `import { Evil } from "./linked";\nexport function UsesLinked() { return <button><Evil /></button>; }\n`);
      const linked: ComponentRecipe = { kind: "component", file: "src/components/ui/linked.tsx", export: "Evil", props: {}, label: null, wrappers: [], tag: "button", classes: [] };
      const uses: ComponentRecipe = { ...linked, file: "src/components/ui/uses-linked.tsx", export: "UsesLinked" };
      const built = await box.build([{ id: "linked-look", role: "button", recipe: linked }, { id: "uses-look", role: "button", recipe: uses }]);
      expectContained(box, built, /refused recipe src\/components\/ui\/linked\.tsx#Evil: src\/components\/ui\/linked\.tsx leads outside the project root \(a symlink\)/);
      expect(built.warnings).toContain("refused src/components/ui/linked.tsx: a symlink that leads outside the project root");
      expect(built.warnings.join("\n")).toMatch(/refused import "\.\/linked" resolves outside the project root \(from src\/components\/ui\/uses-linked\.tsx\)/);
      expect(built.specimens[built.looks["uses-look"]!]!.kind).toBe("markup");
    } finally {
      box.dispose();
    }
  });

  test("bare packages come only from the root's own node_modules", async () => {
    const box = sandbox();
    try {
      unlinkSync(join(box.root, "node_modules"));
      // The packages are still in a parent's node_modules, where Node would find them: not used.
      mkdirSync(join(box.root, "../node_modules"));
      symlinkSync(join(SCANNER_MODULES, "react"), join(box.root, "../node_modules/react"));
      const built = await box.build();
      expect(built.warnings).toContain("react and react-dom are not installed in the project's node_modules: component looks are drawn from their classes");
      expect(built.tailwind).toContain("not installed in the project's node_modules");
      expect(Object.values(built.specimens).every((s) => s.kind === "markup")).toBe(true);
    } finally {
      box.dispose();
    }
  });
});

/* ------------------------------------------------------------ isolation and time limits (c8) */

describe("one bad component fails alone; every stage has a time limit (c8)", () => {
  const button: ComponentRecipe = { kind: "component", file: "src/components/ui/button.tsx", export: "Button", props: {}, label: "Save", wrappers: [], tag: "button", classes: [] };
  const badge: ComponentRecipe = { kind: "component", file: "src/components/ui/badge.tsx", export: "Badge", props: {}, label: "New", wrappers: [], tag: "span", classes: [] };
  const own = (file: string, name: string): ComponentRecipe => ({ ...button, file: `src/components/ui/${file}`, export: name, label: null });

  test("a module that throws when it loads, one that does not bundle and a render that never ends each fail only their own look", async () => {
    const base = mkdtempSync(join(tmpdir(), "youi-isolate-"));
    const root = copyFixture(CONSOLE, join(base, "proj"));
    const scratch = join(base, "scratch");
    mkdirSync(scratch);
    try {
      writeFileSync(join(root, "src/components/ui/throws.tsx"), `throw new Error("boom at load");\nexport function Throws() { return <b>x</b>; }\n`);
      writeFileSync(join(root, "src/components/ui/unbundled.tsx"), `import { missing } from "./does-not-exist";\nexport function Unbundled() { return <b>{missing}</b>; }\n`);
      writeFileSync(join(root, "src/components/ui/hang.tsx"), `export function Hang(): null { for (;;) {} }\n`);
      const jobs = [
        { key: "button", recipe: button, label: "Save" },
        { key: "throws", recipe: own("throws.tsx", "Throws"), label: null },
        { key: "unbundled", recipe: own("unbundled.tsx", "Unbundled"), label: null },
        { key: "hang", recipe: own("hang.tsx", "Hang"), label: null },
        { key: "badge", recipe: badge, label: "New" },
      ];
      const stats = newStats();
      const started = Date.now();
      const result = await renderComponents(root, "tsconfig.json", jobs, scratch, stats, { renderTimeoutMs: 1_000 });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(result.html.get("button")).toContain("bg-primary");
      expect(result.html.get("badge")).toContain(">New</span>");
      expect(result.failures.get("throws")).toBe("src/components/ui/throws.tsx threw when it loaded: boom at load");
      expect(result.failures.get("unbundled")).toMatch(/^src\/components\/ui\/unbundled\.tsx did not bundle: .*Could not resolve "\.\/does-not-exist"/);
      expect(result.failures.get("hang")).toBe("timed out after 1s");
      // The whole bundle, then each of its five modules alone to find the one that fails, then the rest.
      expect(stats.bundles).toBe(7);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  test("esbuild that overruns its limit is cancelled: every component look falls back, with a warning", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "youi-render-"));
    try {
      const result = await renderComponents(CONSOLE, "tsconfig.json", [{ key: "b", recipe: button, label: "Save" }], scratch, newStats(), { bundleTimeoutMs: 1 });
      expect(result.failures.get("b")).toMatch(/^bundle failed: esbuild timed out after 1 ms$/);
      expect(result.warnings).toEqual(["the component bundle failed (esbuild timed out after 1 ms): component looks are drawn from their classes"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("Tailwind that overruns its limit is stopped: the entry's global rules are kept, with a warning", async () => {
    const target = await loadInventoryTarget(CONSOLE);
    const css = await buildProjectCss(CONSOLE, target.files, newStats(), { tailwindTimeoutMs: 1 });
    expect(css.warnings).toContain("src/app/globals.css: Tailwind failed (timed out after 1 ms): its global rules only");
    expect(css.sources[0]).toEqual({ sheet: "src/app/globals.css", via: "import in src/app/layout.tsx", as: "plain" });
    expect(css.light).toContain(".lg-button {");
    expect(css.light).not.toContain(".bg-primary");
  });
});
