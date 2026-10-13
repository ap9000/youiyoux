/** Preview files: one opened item's recorded source, written at safe paths, its registry parts resolved to the project's own or fetched (capped). */
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { exportNames, importedNames, preparePreview, safeRelative, syncIndex, type ProjectPart } from "../src/index.ts";
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
  // dialog is imported from @/registry; the project has none, so it and the button it imports are fetched.
  expect(fixtures.requests.map((r) => r.url)).toEqual([ITEM("command"), ITEM("dialog"), ITEM("button")]);
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
