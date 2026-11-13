/**
 * rules add's temp file never outlives a write that fails part-way (slice 5 review round 2): the
 * write is inside the try whose finally removes it. node:fs/promises' writeFile is wrapped so that
 * writing a temp file writes half of it, then fails as a full disk would.
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getSystem, loadDesignRepo } from "@youiyoux/core";

const failing = { on: false };
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      const [file, data] = args;
      if (failing.on && String(file).endsWith(".tmp")) {
        await real.writeFile(file, String(data).slice(0, 10), { flag: "wx" });
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return real.writeFile(...args);
    },
  };
});

const { addRulePack, RULE_PACKS } = await import("../src/rule-packs.ts");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-rule-temp-"));
  await cp(DEMO, join(dir, "design"), { recursive: true });
});
afterEach(async () => {
  failing.on = false;
  await rm(dir, { recursive: true, force: true });
});

test("a temp file whose write fails part-way is removed, and the failure is told", async () => {
  const design = join(dir, "design");
  const before = (await readdir(join(design, "rules"))).sort();
  failing.on = true;
  await expect(addRulePack({ root: design, system: getSystem(await loadDesignRepo(design)) }, RULE_PACKS[0]!)).rejects.toThrow("no space left on device");
  expect((await readdir(join(design, "rules"))).sort()).toEqual(before);
});
