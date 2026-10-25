/** Preview files: one opened item's recorded source, written at safe paths, its registry parts resolved to the project's own or fetched (capped). */
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildsOn, DEMO_RECHECK_MS, demoNames, exportNames, importedNames, preparePreview, safeRelative, syncIndex, type ProjectPart } from "../src/index.ts";
import { fixtureFetcher } from "./fixture-fetcher.ts";

let dir: string;
const options = { sleep: async () => {}, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 };
const CONSOLE = join(import.meta.dirname, "../../scanner/test/fixtures/inventory/console");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "discover-preview-"));
  await syncIndex({ ...options, cacheDir: dir, fetcher: fixtureFetcher().fetcher });
}, 60_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ITEM = (name: string) => `https://ui.shadcn.com/r/styles/new-york-v4/${name}.json`;

/** The console fixture's own parts, as the preview endpoint finds them. */
async function consolePart(name: string): Promise<ProjectPart | null> {
  const file = join(CONSOLE, "src/components/ui", `${name}.tsx`);
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null ? null : { file, display: `src/components/ui/${name}.tsx`, exports: exportNames(text) };
}

test("nothing is written under preview/ by a sync; an opened item fetches only itself and the parts it imports", async () => {
  expect(await readdir(join(dir, "preview")).catch(() => [])).toEqual([]);
  const fixtures = fixtureFetcher();
  const prepared = await preparePreview(dir, "@shadcn/command", { fetcher: fixtures.fetcher });
  // Its demo is asked for by the names registries give demos (there is none here); dialog is imported
  // from @/registry, and the project has none, so it and the button it imports are fetched.
  expect(fixtures.requests.map((r) => r.url)).toEqual([ITEM("command"), ITEM("command-demo"), ITEM("command-demo-1"), ITEM("p-command-1"), ITEM("dialog"), ITEM("button")]);
  expect(prepared.demo).toBeNull();
  expect(prepared.main).toBe("registry/new-york-v4/ui/command.tsx");
  expect(prepared.exports).toEqual(expect.arrayContaining(["Command", "CommandInput", "CommandList", "CommandItem", "CommandGroup"]));
  expect(prepared.parts.map((p) => [p.name, p.from])).toEqual([["dialog", "fetched"], ["button", "fetched"]]);
  const command = await readFile(join(prepared.dir, prepared.main), "utf8");
  expect(command).not.toContain("@/registry/");
  expect(command).toContain('from "../../../parts/dialog/registry/new-york-v4/ui/dialog"');
  expect(prepared.packages).toEqual(["class-variance-authority", "cmdk", "cn", "lucide-react", "radix-ui"]);
  // lucide-react is imported but not declared: what an install would silently need.
  expect(prepared.implicit).toEqual(expect.arrayContaining(["lucide-react"]));
  // A second open reads the cache.
  const again = fixtureFetcher();
  await preparePreview(dir, "@shadcn/command", { fetcher: again.fetcher });
  expect(again.requests).toEqual([]);
});

test("a part the project already has, with every name imported, is used from the project; one that lacks names is fetched and says why", async () => {
  const parts = new Map<string, ProjectPart | null>();
  for (const name of ["dialog", "button"]) parts.set(name, await consolePart(name));
  const prepared = await preparePreview(dir, "@shadcn/command", { fetcher: fixtureFetcher().fetcher, projectPart: (name) => parts.get(name) ?? null });
  const dialog = prepared.parts.find((p) => p.name === "dialog")!;
  expect(dialog.from).toBe("fetched");
  expect(dialog.detail).toMatch(/your src\/components\/ui\/dialog\.tsx has no DialogDescription, DialogHeader, DialogTitle/);
  expect(prepared.parts.find((p) => p.name === "button")).toMatchObject({ from: "project", detail: "button: your src/components/ui/button.tsx" });
  const dialogFile = prepared.files.find((f) => f.startsWith("parts/dialog/"))!;
  expect(await readFile(join(prepared.dir, dialogFile), "utf8")).toContain(`from "${join(CONSOLE, "src/components/ui/button.tsx")}"`);
});

test("parts past the cap are listed as not fetched", async () => {
  const prepared = await preparePreview(dir, "@shadcn/command", { fetcher: fixtureFetcher().fetcher, maxParts: 1 });
  expect(prepared.parts.map((p) => [p.name, p.from])).toEqual([["dialog", "fetched"], ["button", "not-fetched"]]);
  expect(prepared.parts[1]!.detail).toMatch(/at most 1 parts are fetched/);
});

test("a registry path that climbs out, an absolute one or a symlinked cache directory is refused, and nothing lands outside", async () => {
  expect(safeRelative("registry/ui/x.tsx")).toBe("registry/ui/x.tsx");
  for (const bad of ["../x.tsx", "registry/../../x.tsx", "/etc/x.tsx", "C:/x.tsx", "a/\u0000b", ""]) expect(safeRelative(bad), bad).toBeNull();
  const cache = await mkdtemp(join(tmpdir(), "discover-preview-evil-"));
  try {
    await syncIndex({ ...options, cacheDir: cache, fetcher: fixtureFetcher().fetcher });
    const evil = fixtureFetcher({ override: (url) => (url === ITEM("input") ? { inline: JSON.stringify({ name: "input", type: "registry:ui", files: [{ path: "../../escaped.tsx", content: "export const X = 1;" }] }) } : undefined) });
    await expect(preparePreview(cache, "@shadcn/input", { fetcher: evil.fetcher })).rejects.toThrow(/refused/);
    expect(await readdir(cache)).not.toContain("escaped.tsx");
    const outside = await mkdtemp(join(tmpdir(), "discover-preview-outside-"));
    await rm(join(cache, "preview"), { recursive: true, force: true });
    await symlink(outside, join(cache, "preview"));
    await expect(preparePreview(cache, "@shadcn/button", { fetcher: fixtureFetcher().fetcher })).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("an npm package has no single source to draw: a plain sentence", async () => {
  await expect(preparePreview(dir, "lib:npm/component/sonner", { fetcher: fixtureFetcher().fetcher })).rejects.toThrow(/npm package, not a registry item/);
});

test("export and import names are read from the text", () => {
  expect(exportNames("export function A() {}\nexport const b = 1\nexport { C, D as E, type F }\nexport default G")).toEqual(["A", "b", "C", "E", "default"]);
  expect(importedNames('import { A, B as C } from "@/x"\nimport D, { E } from "@/x"', "@/x")).toEqual(["A", "B", "E", "default"]);
});

test("a block is drawn from its page, as a page, with up to 16 parts and its own data", async () => {
  const page = [
    'import { Input } from "@/registry/new-york-v4/ui/input";',
    'import { Button } from "@/registry/new-york-v4/ui/button";',
    'import { Dialog } from "@/registry/new-york-v4/ui/dialog";',
    'import { Command } from "@/registry/new-york-v4/ui/command";',
    'import { SectionCards } from "@/registry/new-york-v4/blocks/dashboard-01/components/section-cards";',
    'import data from "./data.json";',
    "export default function Page() { return <main><SectionCards /><Input /><Button /><Dialog /><Command />{data.length}</main>; }",
  ].join("\n");
  const block = {
    name: "dashboard-01",
    type: "registry:block",
    files: [
      { path: "registry/new-york-v4/blocks/dashboard-01/components/section-cards.tsx", type: "registry:component", content: "export function SectionCards() { return <section />; }" },
      { path: "registry/new-york-v4/blocks/dashboard-01/page.tsx", type: "registry:page", content: page },
      { path: "registry/new-york-v4/blocks/dashboard-01/data.json", type: "registry:file", content: "[1, 2, 3]" },
    ],
  };
  const fixtures = fixtureFetcher({ override: (url) => (url === ITEM("dashboard-01") ? { inline: JSON.stringify(block) } : undefined) });
  const prepared = await preparePreview(dir, "@shadcn/dashboard-01", { fetcher: fixtures.fetcher });
  // The page, which puts the parts together, not the first component file.
  expect(prepared.main).toBe("registry/new-york-v4/blocks/dashboard-01/page.tsx");
  expect(prepared.page).toBe(true);
  expect(prepared.exports).toContain("default");
  // Four parts, past a component's cap of 3: a block may fetch up to 16.
  expect(prepared.parts.map((p) => [p.name, p.from])).toEqual([["input", "fetched"], ["button", "fetched"], ["dialog", "fetched"], ["command", "fetched"]]);
  expect(prepared.files).toContain("registry/new-york-v4/blocks/dashboard-01/data.json");
  // A block is a page already: no demo is asked for.
  expect(fixtures.requests.map((r) => r.url).filter((u) => /-demo|\/p-/.test(u))).toEqual([]);
  // A component is still a component.
  expect((await preparePreview(dir, "@shadcn/command", { fetcher: fixtureFetcher().fetcher })).page).toBe(false);
});

test("another registry's item: its own lib/utils is cn, and shadcn's components it imports undeclared are shadcn's, whose own parts are shadcn's too", async () => {
  const item = {
    name: "button",
    type: "registry:ui",
    files: [{ path: "registry/default/ui/button.tsx", type: "registry:ui", content: 'import { cn } from "@/registry/default/lib/utils";\nimport { Command } from "@/components/ui/command";\nexport function Button() { return <Command className={cn("a")} />; }' }],
  };
  const fixtures = fixtureFetcher({ override: (url) => (url === "https://coss.com/ui/r/button.json" ? { inline: JSON.stringify(item) } : undefined) });
  const prepared = await preparePreview(dir, "@coss/button", { fetcher: fixtures.fetcher });
  const text = await readFile(join(prepared.dir, "registry/default/ui/button.tsx"), "utf8");
  expect(text).toContain('from "cn"');
  // shadcn's command, and the dialog it imports from shadcn's registry, never coss's (which has none).
  expect(prepared.parts.slice(0, 2).map((p) => [p.name, p.from, p.detail])).toEqual([
    ["command", "fetched", "command: the registry's own @shadcn/command, fetched (your project has none)"],
    ["dialog", "fetched", "dialog: the registry's own @shadcn/dialog, fetched (your project has none)"],
  ]);
  expect(fixtures.requests.map((r) => r.url)).not.toContain("https://coss.com/ui/r/dialog.json");
});


describe("a component drawn from its registry's own demo", () => {
  let cache: string;
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) => ({ ...options, now: () => new Date(Date.parse("2026-10-12T12:00:00Z") + ms) });
  beforeAll(async () => {
    cache = await mkdtemp(join(tmpdir(), "discover-preview-demo-"));
    await syncIndex({ ...options, cacheDir: cache, fetcher: fixtureFetcher().fetcher });
  }, 60_000);
  afterAll(async () => {
    await rm(cache, { recursive: true, force: true });
  });

  test("the demo that builds on it is drawn as written, its import pointed at this copy of the component, and a second open asks nothing", async () => {
    const demo = {
      name: "input-demo",
      type: "registry:example",
      registryDependencies: ["input"],
      dependencies: ["date-fns"],
      files: [{ path: "registry/new-york-v4/examples/input-demo.tsx", type: "registry:example", content: 'import { Input } from "@/registry/new-york-v4/ui/input";\nexport default function InputDemo() { return <Input type="email" placeholder="Email" />; }' }],
    };
    const fixtures = fixtureFetcher({ override: (url) => (url === ITEM("input-demo") ? { inline: JSON.stringify(demo) } : undefined) });
    const prepared = await preparePreview(cache, "@shadcn/input", { ...options, fetcher: fixtures.fetcher });
    expect(fixtures.requests.map((r) => r.url)).toEqual([ITEM("input"), ITEM("input-demo")]);
    expect(prepared.demo).toBe("@shadcn/input-demo");
    expect(prepared.main).toBe("registry/new-york-v4/examples/input-demo.tsx");
    expect(prepared.exports).toEqual(["default"]);
    expect(await readFile(join(prepared.dir, prepared.main), "utf8")).toContain('from "../ui/input"');
    expect(prepared.files).toContain("registry/new-york-v4/ui/input.tsx");
    expect(prepared.parts).toEqual([]);
    // What the demo declares is the preview's to fetch too.
    expect(prepared.declared).toContain("date-fns");
    const again = fixtureFetcher();
    expect((await preparePreview(cache, "@shadcn/input", { ...options, fetcher: again.fetcher })).demo).toBe("@shadcn/input-demo");
    expect(again.requests).toEqual([]);
  });

  test("a demo may fetch up to 8 parts: it shows the component among others", async () => {
    const names = ["calendar", "command", "input", "sonner"];
    const demo = {
      name: "popover-demo",
      type: "registry:example",
      registryDependencies: ["popover"],
      files: [{ path: "registry/new-york-v4/examples/popover-demo.tsx", content: [...names.map((n) => `import * as P${n.length} from "@/registry/new-york-v4/ui/${n}";`), 'import { Popover } from "@/registry/new-york-v4/ui/popover";', "export default function D() { return <Popover />; }"].join("\n") }],
    };
    const popover = { name: "popover", type: "registry:ui", files: [{ path: "registry/new-york-v4/ui/popover.tsx", type: "registry:ui", content: "export function Popover() { return <popover />; }" }] };
    const parts = Object.fromEntries(names.map((n) => [ITEM(n), { name: n, type: "registry:ui", files: [{ path: `registry/new-york-v4/ui/${n}.tsx`, type: "registry:ui", content: `export const X = 1;` }] }]));
    const fixtures = fixtureFetcher({ override: (url) => (url === ITEM("popover-demo") ? { inline: JSON.stringify(demo) } : url === ITEM("popover") ? { inline: JSON.stringify(popover) } : parts[url] ? { inline: JSON.stringify(parts[url]) } : undefined) });
    const prepared = await preparePreview(cache, "@shadcn/popover", { ...options, fetcher: fixtures.fetcher });
    expect(prepared.demo).toBe("@shadcn/popover-demo");
    // Four parts, past a component's own cap of 3.
    expect(prepared.parts.map((p) => [p.name, p.from])).toEqual(names.map((n) => [n, "fetched"]));
  });

  test("an item by a demo's name that does not build on it is not its demo; none is kept as none for a week, then asked again", async () => {
    // button-demo exists but shows a badge; button-demo-1 and p-button-1 do not exist.
    const other = { name: "button-demo", type: "registry:example", registryDependencies: ["badge"], files: [{ path: "registry/new-york-v4/examples/button-demo.tsx", content: 'import { Badge } from "@/registry/new-york-v4/ui/badge";\nexport default function D() { return <Badge />; }' }] };
    const fixtures = fixtureFetcher({ override: (url) => (url === ITEM("button-demo") ? { inline: JSON.stringify(other) } : undefined) });
    const prepared = await preparePreview(cache, "@shadcn/button", { ...options, fetcher: fixtures.fetcher });
    expect(fixtures.requests.map((r) => r.url)).toEqual([ITEM("button"), ITEM("button-demo"), ITEM("button-demo-1"), ITEM("p-button-1")]);
    expect(prepared.demo).toBeNull();
    expect(prepared.main).toBe("registry/new-york-v4/ui/button.tsx");
    const day1 = fixtureFetcher();
    await preparePreview(cache, "@shadcn/button", { ...at(day), fetcher: day1.fetcher });
    expect(day1.requests).toEqual([]);
    // Past the week: asked again (button-demo comes from the cache; the others from the registry).
    const later = fixtureFetcher();
    await preparePreview(cache, "@shadcn/button", { ...at(DEMO_RECHECK_MS + day), fetcher: later.fetcher });
    expect(later.requests.map((r) => r.url)).toEqual([ITEM("button-demo-1"), ITEM("p-button-1")]);
  });

  test("a registry that cannot be reached is no answer: drawn without a demo, and asked again next time", async () => {
    const down = () => fixtureFetcher({ override: (url) => (url === ITEM("dialog-demo") ? { status: 500, inline: "down" } : undefined) });
    const first = down();
    expect((await preparePreview(cache, "@shadcn/dialog", { ...options, fetcher: first.fetcher })).demo).toBeNull();
    const demos = (f: ReturnType<typeof down>) => f.requests.map((r) => r.url).filter((u) => /-demo|\/p-/.test(u));
    expect(demos(first)).toEqual([ITEM("dialog-demo")]);
    const second = down();
    await preparePreview(cache, "@shadcn/dialog", { ...options, fetcher: second.fetcher });
    expect(demos(second)).toEqual([ITEM("dialog-demo")]);
  });

  test("builds on it: named among its registry dependencies in any of the forms registries use, or imported", () => {
    expect(demoNames("accordion")).toEqual(["accordion-demo", "accordion-demo-1", "p-accordion-1"]);
    const files = (content: string) => [{ path: "x.tsx", content }];
    for (const dep of ["command", "@magicui/animated-beam", "https://ui.aceternity.com/registry/3d-card.json"]) {
      const name = dep.replace(/^.*\//, "").replace(/\.json$/, "");
      expect(buildsOn({ registryDependencies: [dep], files: [] }, name), dep).toBe(true);
    }
    expect(buildsOn({ files: files('import { CardBody } from "@/components/ui/3d-card";') }, "3d-card")).toBe(true);
    expect(buildsOn({ registryDependencies: ["@magicui/animated-beam-2"], files: files('import x from "lodash/animated-beam";') }, "animated-beam")).toBe(false);
  });
});
