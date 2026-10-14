import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const RAW_COLOR = `export function Extra() {\n  return <p style={{ color: "#ff0000" }}>Paid, then gone</p>;\n}\n`;

let dir = "";
let app = "";
let out = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-baseline-"));
  app = join(dir, "demo-app");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_STEP_SUMMARY;
  await rm(dir, { recursive: true, force: true });
});

const check = async (...args: string[]): Promise<number> => {
  out = "";
  return main(["check", "--project", app, ...args]);
};

describe("youiyoux baseline and check --baseline", () => {
  test("without a baseline every error fails; with one, only new errors do", async () => {
    expect(await check()).toBe(1);
    expect(await check("--baseline")).toBe(1);
    expect(await main(["baseline", "--project", app, "--json"])).toBe(0);
    const recorded = JSON.parse(await readFile(join(app, "youi.baseline.json"), "utf8")) as { schema: string; totals: { errors: number; warnings: number } };
    expect(recorded).toMatchObject({ schema: "youi.baseline/v1", totals: { errors: 1, warnings: 2 } });
    expect(await check("--baseline")).toBe(0);
    await writeFile(join(app, "components/extra.tsx"), RAW_COLOR);
    expect(await check("--baseline", "--json")).toBe(1);
    const result = JSON.parse(out) as { errors: number; baseline: { comparison: { new: Array<{ file: string }>; known: unknown[] } } };
    expect(result.errors).toBe(1);
    expect(result.baseline.comparison.new.map((v) => v.file)).toEqual(["components/extra.tsx"]);
    expect(result.baseline.comparison.known).toHaveLength(3);
  });

  test("ratchets down and never accepts new debt unless forced", async () => {
    await main(["baseline", "--project", app]);
    await writeFile(join(app, "components/extra.tsx"), RAW_COLOR);
    out = "";
    expect(await main(["baseline", "--project", app, "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ action: "ratcheted", notAdded: 1, totals: { errors: 1 } });
    expect(await check("--baseline")).toBe(1);
    out = "";
    expect(await main(["baseline", "--project", app, "--force", "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ action: "rewritten", notAdded: 0, totals: { errors: 2 } });
    expect(await check("--baseline")).toBe(0);
  });

  test("--format github annotates new findings on their lines and states the rules version", async () => {
    await main(["baseline", "--project", app]);
    await writeFile(join(app, "components/extra.tsx"), RAW_COLOR);
    const summary = join(dir, "summary.md");
    process.env.GITHUB_STEP_SUMMARY = summary;
    expect(await check("--baseline", "--format", "github")).toBe(1);
    const annotations = out.split("\n").filter((l) => l.startsWith("::"));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatch(/^::error file=components\/extra\.tsx,line=2,col=\d+,title=youi color\.no-raw-color::/);
    const markdown = await readFile(summary, "utf8");
    expect(markdown).toContain("youiyoux check: ❌ 1 error");
    expect(markdown).toMatch(/\| Rules \| `demo@\d+\.\d+\.\d+`, definitions `[0-9a-f]{12}` \|/);
    expect(markdown).toContain("3 accepted · 1 new");
  });

  test("a missing baseline is an error, not a silent pass", async () => {
    expect(await main(["check", "--project", app, "--baseline-file", join(dir, "nope.json")])).toBe(1);
  });
});
