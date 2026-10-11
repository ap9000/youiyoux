import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadProject, ProjectWatcher, scanProject, staticBase, type ScanResult, type WatchUpdate } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const RAW_COLOR = `export function Extra() {\n  return <p style={{ color: "#ff0000" }}>Paid</p>;\n}\n`;

let dir = "";
let app = "";
let watcher: ProjectWatcher<ScanResult> | null = null;
const updates: Array<WatchUpdate<ScanResult>> = [];

/** Wait until `count` updates have arrived (file events are asynchronous). */
async function updatesReach(count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (updates.length < count) {
    if (Date.now() > deadline) throw new Error(`only ${updates.length} of ${count} updates arrived`);
    await new Promise((done) => setTimeout(done, 25));
  }
  await watcher?.idle();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-watch-"));
  app = join(dir, "demo-app");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  updates.length = 0;
  watcher = await ProjectWatcher.start({ root: app, debounceMs: 60, job: (project, cache) => scanProject(project, { cache }), onUpdate: (u) => updates.push(u) });
});
afterEach(async () => {
  watcher?.close();
  await rm(dir, { recursive: true, force: true });
});

const last = (): WatchUpdate<ScanResult> => updates.at(-1)!;
const violationsOf = (u: WatchUpdate<ScanResult>) => (u.status === "ok" ? u.result.report.violations : []);

describe("watch mode", () => {
  test("the first run scans the project", () => {
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ generation: 1, status: "ok", reloaded: true });
  });

  test("a burst of edits is one coalesced re-scan of the edited file", async () => {
    for (const i of [1, 2, 3]) await writeFile(join(app, "components/extra.tsx"), `${RAW_COLOR}// ${i}\n`);
    await updatesReach(2);
    expect(updates).toHaveLength(2);
    // (`reloaded` may be true: macOS replays the fixture copy's events to a new watcher; an unchanged digest keeps every cache.)
    expect(last()).toMatchObject({ status: "ok", changed: ["components/extra.tsx"] });
    expect(violationsOf(last()).filter((v) => v.file === "components/extra.tsx")).toHaveLength(1);
  });

  test("results match a fresh full scan after edits", async () => {
    await writeFile(join(app, "components/extra.tsx"), RAW_COLOR);
    await updatesReach(2);
    const update = last();
    if (update.status !== "ok") throw new Error(update.error);
    const fresh = await scanProject(await loadProject(app));
    expect(update.result.report.violations).toEqual(fresh.report.violations);
    expect(update.result.report.usages).toEqual(fresh.report.usages);
  });

  test("a rule change reloads the definitions and re-checks everything", async () => {
    const rule = join(dir, "demo-design/rules/color.no-raw-color.rule.yaml");
    const before = violationsOf(last()).length;
    await writeFile(rule, (await readFile(rule, "utf8")).replace(/^severity: error$/m, "severity: off"));
    await updatesReach(2);
    expect(last()).toMatchObject({ status: "ok", reloaded: true });
    expect(violationsOf(last()).length).toBeLessThan(before);
    expect(violationsOf(last()).some((v) => v.rule.endsWith("color.no-raw-color"))).toBe(false);
  });

  test("an invalid rule is a failed update, not a stale pass, until it is fixed", async () => {
    const rule = join(dir, "demo-design/rules/color.no-raw-color.rule.yaml");
    const good = await readFile(rule, "utf8");
    await writeFile(rule, good.replace(/^severity: error$/m, "severity: sometimes"));
    await updatesReach(2);
    expect(last().status).toBe("failed");
    await writeFile(join(app, "components/extra.tsx"), RAW_COLOR);
    await updatesReach(3);
    expect(last().status).toBe("failed");
    await writeFile(rule, good);
    await updatesReach(4);
    expect(last()).toMatchObject({ status: "ok", reloaded: true });
  });

  test("static bases of include globs", () => {
    expect(staticBase("src/browser/**/*.{ts,tsx}")).toBe("src/browser");
    expect(staticBase("app/index.tsx")).toBe("app");
    expect(staticBase("**/*.tsx")).toBe(".");
  });
});
