import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { safeId } from "@youiyoux/core";
import { loadInventoryTarget } from "@youiyoux/scanner";
import { main } from "../src/main.ts";

const DEMO = join(import.meta.dirname, "../../../examples/demo-design");

test("build and inventory share the plain-id rule; unsafe builds write nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "youi-build-path-"));
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  let error = "";
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { error += String(chunk); return true; });
  try {
    const design = join(dir, "design");
    const dest = join(dir, "output");
    await cp(DEMO, design, { recursive: true });
    const file = join(design, "youi.config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    // No contracts claim a system id: test the build's boundary rather than graph validation.
    config.systems[0].components = "empty-components";
    config.systems[0].rules = "empty-rules";
    for (const id of ["..", "../escape", "x..y", "x/y", "x\\y", "/absolute", "C:\\escape"]) {
      expect(safeId(id)).toBeNull();
      config.systems[0].id = id;
      await writeFile(file, JSON.stringify(config));
      await writeFile(join(design, "youi.project.json"), JSON.stringify({ id }));
      expect((await loadInventoryTarget(design)).id).toBe("design");
      for (const args of [[], ["--out", dest]]) {
        error = "";
        expect(await main(["build", "--design", design, ...args])).toBe(1);
        expect(error).toContain(`Invalid system id ${JSON.stringify(id)}`);
        expect(error).toContain("plain name");
        expect(await readdir(dir)).toEqual(["design"]);
        expect(await readdir(design)).not.toContain("build");
      }
    }
    const id = "demo-2";
    expect(safeId(id)).toBe(id);
    config.systems[0].id = id;
    await writeFile(file, JSON.stringify(config));
    await writeFile(join(design, "youi.project.json"), JSON.stringify({ id }));
    expect((await loadInventoryTarget(design)).id).toBe(id);
    expect(await main(["build", "--design", design])).toBe(0);
    expect(await readdir(join(design, "build", id))).toEqual(["theme.css", "tokens.css", "tokens.native.ts", "tokens.ts"]);
    await mkdir(dest);
    const outside = join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, join(design, "build", "linked"));
    config.systems[0].id = "linked";
    await writeFile(file, JSON.stringify(config));
    expect(await main(["build", "--design", design])).toBe(1);
    expect(error).toContain("leaves the output directory");
    expect(await readdir(outside)).toEqual([]);
    await symlink(outside, join(dest, "tokens.css"));
    expect(await main(["build", "--design", design, "--out", dest])).toBe(1);
    expect(await readdir(dest)).toEqual(["tokens.css"]);
  } finally {
    out.mockRestore(); err.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
