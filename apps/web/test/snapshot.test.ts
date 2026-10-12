import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { libraries, readInventory, readSource, writeDetect, writeInventory } from "../scripts/snapshot.ts";
import type { InventoryChunk, InventoryIndex } from "../src/data/types.ts";

const TOOL = resolve(import.meta.dirname, "../../..");
const DEMO_APP = join(TOOL, "examples/demo-app");
const DEMO_DESIGN = join(TOOL, "examples/demo-design");

describe("snapshot source", () => {
  // `youi ui --config C --root T`: a pilot config kept beside the design repo, its product elsewhere.
  test("--config with --root and no --project scans the product --root names for the usage map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-pilot-"));
    try {
      const config = { ...(JSON.parse(await readFile(join(DEMO_APP, "youi.project.json"), "utf8")) as Record<string, unknown>), source: { path: DEMO_DESIGN } };
      await writeFile(join(dir, "youi.project.json"), JSON.stringify(config));
      const libs = await libraries();
      const source = await readSource({ config: join(dir, "youi.project.json"), root: DEMO_APP }, libs.core, libs.scanner);
      expect(source.projectDir).toBe(DEMO_APP);
      expect(source.designRoot).toBe(DEMO_DESIGN);
      expect(source.usage).not.toBeNull();
      expect(source.usage!.coverage.filesScanned).toBeGreaterThan(0);
      expect(source.usage!.usages.length).toBeGreaterThan(0);
      for (const site of source.usage!.usages) expect(existsSync(join(DEMO_APP, site.file)), site.file).toBe(true);
      // Without --root the config alone gives the system and no usage map, as before.
      expect((await readSource({ config: join(dir, "youi.project.json") }, libs.core, libs.scanner)).usage).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--inventory is validated against youi.inventory/v1 and written under its content hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-inventory-"));
    try {
      const libs = await libraries();
      const fixtures = join(TOOL, "packages/scanner/test/fixtures/inventory");
      const report = await libs.scanner.buildInventory([join(fixtures, "console"), join(fixtures, "site")]);
      await writeFile(join(dir, "good.json"), JSON.stringify(report));
      const read = await readInventory(join(dir, "good.json"), false, libs);
      const { file, files } = writeInventory(join(dir, "data"), read!);
      expect(file).toMatch(/^inventory\.[0-9a-f]{10}\.json$/);
      const index = JSON.parse(await readFile(join(dir, "data", file), "utf8")) as InventoryIndex;
      expect(index).toMatchObject({ schema: "youiyoux.inventory-index/v1", summary: { looks: read!.looks.length, families: read!.families.length } });
      // Every look is in exactly one project-and-role chunk, under its content hash.
      const chunks = await Promise.all(index.roles.flatMap((r) => Object.values(r.chunks)).map(async (f) => JSON.parse(await readFile(join(dir, "data", f), "utf8")) as InventoryChunk));
      expect(chunks.flatMap((c) => c.looks.map((l) => l.id)).sort()).toEqual(read!.looks.map((l) => l.id).sort());
      expect(files).toContain(index.extras);
      for (const f of files) expect(f).toMatch(/\.[0-9a-f]{10}\.(?:json|css)$/);
      // Without specimens, every project says so and its looks show their shape.
      expect(index.projects.every((p) => p.specimenCss === null)).toBe(true);
      await writeFile(join(dir, "bad.json"), JSON.stringify({ ...(report as object), families: [{ id: 1 }] }));
      await expect(readInventory(join(dir, "bad.json"), false, libs)).rejects.toThrow(/bad\.json: families\.0\./);
      // Only the default snapshot makes an inventory of its own.
      expect(await readInventory(undefined, false, libs)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshot --detect", () => {
  test("copies the report and its screenshots under content hashes, rewriting the screenshot paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-detect-snap-"));
    try {
      const report = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/detect.site.json"), "utf8")) as { elements: Array<{ screenshot?: string }> };
      report.elements[0]!.screenshot = "screenshots/p1-shadcn-button.png";
      report.elements[1]!.screenshot = "screenshots/p1-shadcn-dialog.png";
      await mkdir(join(dir, "in/screenshots"), { recursive: true });
      await writeFile(join(dir, "in/screenshots/p1-shadcn-button.png"), "png bytes");
      await writeFile(join(dir, "in/detect.json"), JSON.stringify(report));
      const libs = await libraries();
      const ref = writeDetect(join(dir, "in/detect.json"), join(dir, "data"), libs.core);
      expect(ref).toMatchObject({ name: "127.0.0.1:4173", kind: "site" });
      expect(ref.file).toMatch(/^detect\.[0-9a-f]{10}\.json$/);
      expect(ref.shots).toEqual([expect.stringMatching(/^detect\.shot\.[0-9a-f]{10}\.png$/)]);
      expect((await readdir(join(dir, "data"))).sort()).toEqual([ref.file, ref.shots[0]].sort());
      const copied = libs.core.DetectReport.parse(JSON.parse(await readFile(join(dir, "data", ref.file), "utf8")));
      expect(copied.elements[0]!.screenshot).toBe(ref.shots[0]);
      // A screenshot that is missing is dropped, never left pointing at nothing.
      expect(copied.elements[1]!.screenshot).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the committed demo snapshot carries no detect report", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../snapshot/public/data/manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.detect).toBeUndefined();
  });
});
