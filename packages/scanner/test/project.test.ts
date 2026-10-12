import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadProject, ProjectRootError, scanProject } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/expo-app");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-root-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The fixture's config, kept in `<dir>/pilot/app/` (as a pilot config beside a design repo is), with `root` set or not. */
async function pilotConfig(root?: string): Promise<string> {
  const config = JSON.parse(await readFile(join(FIXTURE, "youi.project.json"), "utf8")) as Record<string, unknown>;
  const pilot = join(dir, "pilot/app");
  await mkdir(pilot, { recursive: true });
  await writeFile(join(pilot, "youi.project.json"), JSON.stringify({ ...config, source: { path: DEMO }, ...(root ? { root } : {}) }));
  return pilot;
}

describe("product root", () => {
  test("defaults to the --project directory, which is where the config was found", async () => {
    const pilot = await pilotConfig();
    const project = await loadProject(pilot);
    expect(project.root).toBe(pilot);
    expect(project.configFile).toBe(join(pilot, "youi.project.json"));
  });

  test("a config's root is relative to the config file, and --root beats it", async () => {
    const relative = await pilotConfig("../../app");
    await mkdir(join(dir, "app"));
    expect((await loadProject(relative)).root).toBe(join(dir, "app"));
    expect((await loadProject(relative, { productRoot: FIXTURE })).root).toBe(FIXTURE);
    expect((await loadProject(relative, { productRoot: FIXTURE })).rootOverride).toBe(true);
  });

  test("an absolute root is used as it is, also with --config from elsewhere", async () => {
    const pilot = await pilotConfig(FIXTURE);
    const project = await loadProject(dir, { configPath: join(pilot, "youi.project.json") });
    expect(project.root).toBe(FIXTURE);
    expect(project.system.config.id).toBe("demo");
  });

  test("a root that does not exist names itself, the config and how to fix it", async () => {
    const pilot = await pilotConfig("../../missing");
    await expect(loadProject(pilot)).rejects.toThrow(ProjectRootError);
    await expect(loadProject(pilot)).rejects.toThrow(`product root ${join(dir, "missing")} is not a directory (config ${join(pilot, "youi.project.json")}); set "root"`);
  });

  test("a whole-project scan of 0 files is an error, never a clean pass; with the root set it scans the product", async () => {
    const pilot = await pilotConfig();
    const empty = await loadProject(pilot);
    await expect(scanProject(empty)).rejects.toThrow(`product root ${pilot} has 0 files matching app/**/*.tsx, components/**/*.{ts,tsx}, styles/**/*.css and no tsconfig.json`);
    await expect(scanProject(empty)).rejects.toThrow("--root <dir>");
    const scanned = await scanProject(await loadProject(pilot, { productRoot: FIXTURE }));
    expect(scanned.report.coverage.filesMatched).toBeGreaterThan(0);
    expect(scanned.report.usages.length).toBeGreaterThan(0);
  });
});
