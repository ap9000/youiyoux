import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { libraries, readInventory, readSource, writeInventory } from "../scripts/snapshot.ts";

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
      const file = writeInventory(join(dir, "data"), read!);
      expect(file).toMatch(/^inventory\.[0-9a-f]{10}\.json$/);
      expect(JSON.parse(await readFile(join(dir, "data", file), "utf8"))).toEqual(read);
      await writeFile(join(dir, "bad.json"), JSON.stringify({ ...(report as object), families: [{ id: 1 }] }));
      await expect(readInventory(join(dir, "bad.json"), false, libs)).rejects.toThrow(/bad\.json: families\.0\./);
      // Only the default snapshot makes an inventory of its own.
      expect(await readInventory(undefined, false, libs)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
