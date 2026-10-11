import { cp, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject, type Project } from "@youiyoux/scanner";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BLOCK_BEGIN, BLOCK_END, mcpArgs, mergeThreeWay, readLock, syncProject, verifyLock } from "../src/index.ts";

const DEMO = join(import.meta.dirname, "../../../examples/demo-design");
const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");

let dir: string;
let design: string;
let app: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-sync-"));
  design = join(dir, "design");
  app = join(dir, "app");
  await cp(DEMO, design, { recursive: true });
  await cp(FIXTURE, app, { recursive: true });
  // Start from a project with no owned components yet, so sync delivers them.
  await rm(join(app, "components/ui"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const project = (): Promise<Project> => loadProject(app, { designRoot: design });
const read = (file: string): Promise<string> => readFile(join(app, file), "utf8");
const actionFor = (actions: ReadonlyArray<{ file: string; action: string }>, file: string): string | undefined => actions.find((a) => a.file === file)?.action;

describe("first sync", () => {
  test("delivers generated files, owned components, the agent layer and a lockfile", async () => {
    const { actions, lock } = await syncProject(await project());
    expect(actionFor(actions, "src/design/tokens.css")).toBe("created");
    expect(actionFor(actions, "components/ui/button.tsx")).toBe("created");
    expect(await read("src/design/tokens.css")).toContain("--demo-color-foreground: #1c1c21;");
    expect(await read("DESIGN.md")).toMatch(/^---\nname: Demo\n/);
    expect(await read("DESIGN.md")).toContain("## Components (contracts)");
    expect(await read(".agents/skills/youiyoux/SKILL.md")).toMatch(/^---\nname: youiyoux\ndescription: /);
    expect(await readlink(join(app, ".claude/skills/youiyoux"))).toBe("../../.agents/skills/youiyoux");
    const agents = await read("AGENTS.md");
    expect(agents.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(agents.split("\n").length).toBeLessThanOrEqual(40);
    expect(agents).toContain("`@/components/ui`");
    const mcp = JSON.parse(await read(".mcp.json")).mcpServers.youiyoux as { args: string[] };
    // The test loads the design repo by override, so the server is told where it is.
    expect(mcp.args.slice(1)).toEqual(["mcp", "--project", ".", "--design", "../design"]);
    // The MCP entry runs this tool's CLI, which lives apart from the design repo.
    expect(resolve(app, mcp.args[0]!)).toBe(join(import.meta.dirname, "../bin/youi.js"));
    expect(lock.files["components/ui/utils.ts"]).toMatchObject({ kind: "vendored", elements: ["youi:demo/component/button", "youi:demo/component/card", "youi:demo/component/input"] });
    // The System vs Library rule is stated plainly, and every tool named is a current one.
    expect(agents).toMatch(/\*\*Build only with the System\.\*\*.*never import, copy or restyle code from one.*library_request/);
    const skill = await read(".agents/skills/youiyoux/SKILL.md");
    expect(skill).toContain("## System and Library");
    expect(skill).toContain("`library → candidate → adopted → in-use`");
    for (const text of [agents, skill, await read("DESIGN.md")]) expect(text).not.toMatch(/\byoui_[a-z]/);
    expect(await readLock(app)).toEqual(lock);
  });

  test("rules that tell agents to call a tool the MCP server does not expose are reported", async () => {
    expect((await syncProject(await project(), { dryRun: true })).unknownTools).toEqual([]);
    const file = join(design, "rules/color.no-raw-color.rule.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("look up the role with system_get_tokens", "look up the role with youi_get_tokens or system_get_palette"));
    const { unknownTools } = await syncProject(await project(), { dryRun: true });
    expect(unknownTools).toEqual([
      { rule: "youi:demo/rule/color.no-raw-color", tool: "youi_get_tokens" },
      { rule: "youi:demo/rule/color.no-raw-color", tool: "system_get_palette" },
    ]);
  });

  test("a second sync changes nothing", async () => {
    await syncProject(await project());
    const { actions } = await syncProject(await project());
    expect(actions.filter((a) => a.action !== "unchanged")).toEqual([]);
  });

  test("dry run writes nothing", async () => {
    const { actions } = await syncProject(await project(), { dryRun: true });
    expect(actionFor(actions, "DESIGN.md")).toBe("created");
    await expect(read("DESIGN.md")).rejects.toThrow();
    expect(await readLock(app)).toBeNull();
  });
});

describe("files people own", () => {
  test("the AGENTS.md block is managed; the rest of the file is the project's", async () => {
    await writeFile(join(app, "AGENTS.md"), "# Our agents\n\nKeep this line.\n");
    await syncProject(await project());
    const once = await read("AGENTS.md");
    expect(once).toContain("Keep this line.");
    expect(once).toContain(BLOCK_END);
    await writeFile(join(app, "AGENTS.md"), `${once}\nAdded after the block.\n`);
    await syncProject(await project());
    const twice = await read("AGENTS.md");
    expect(twice.match(new RegExp(BLOCK_BEGIN, "g"))).toHaveLength(1);
    expect(twice).toContain("Added after the block.");
  });

  test("a hand-written DESIGN.md is never overwritten without --adopt", async () => {
    await writeFile(join(app, "DESIGN.md"), "# Our own design notes\n");
    const { actions } = await syncProject(await project());
    expect(actionFor(actions, "DESIGN.md")).toBe("skipped");
    expect(await read("DESIGN.md")).toBe("# Our own design notes\n");
    await syncProject(await project(), { adopt: true });
    expect(await read("DESIGN.md")).toContain("@generated by youi");
  });

  test("an owned file that differs from upstream with no base is a conflict until adopted", async () => {
    await cp(join(FIXTURE, "components/ui"), join(app, "components/ui"), { recursive: true });
    const before = await read("components/ui/button.tsx");
    const first = await syncProject(await project());
    expect(actionFor(first.actions, "components/ui/button.tsx")).toBe("conflict");
    expect(await read("components/ui/button.tsx")).toBe(before);
    expect(await read(".youi/incoming/components/ui/button.tsx")).toContain("buttonVariants");
    const adopted = await syncProject(await project(), { adopt: true });
    expect(actionFor(adopted.actions, "components/ui/button.tsx")).toBe("kept-local");
    expect((await verifyLock(await project()))?.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("updates", () => {
  const upstreamButton = (): string => join(design, "components/button/button.tsx");

  test("upstream changes merge into local edits (3-way), and the lock records the new base", async () => {
    await syncProject(await project());
    const local = (await read("components/ui/button.tsx")).replace(/\n$/, "\n// Local note: kept by the project.\n");
    await writeFile(join(app, "components/ui/button.tsx"), local);
    expect((await verifyLock(await project()))?.map((i) => i.severity)).toEqual(["warn"]);
    const upstream = (await readFile(upstreamButton(), "utf8")).replace("/** Demo Button: every action a person can take. */", "/** Button: every act a person can take. */");
    await writeFile(upstreamButton(), upstream);
    const { actions } = await syncProject(await project());
    expect(actionFor(actions, "components/ui/button.tsx")).toBe("merged");
    const merged = await read("components/ui/button.tsx");
    expect(merged).toContain("/** Button: every act a person can take. */");
    expect(merged).toContain("// Local note: kept by the project.");
    expect(await read(".youi/base/components/ui/button.tsx")).toBe(upstream);
  });

  test("overlapping edits are a conflict: the file is untouched and the markers go to .youi/conflicts", async () => {
    await syncProject(await project());
    const original = await read("components/ui/button.tsx");
    const mine = original.replace("/** Demo Button: every action a person can take. */", "/** Our Button. */");
    await writeFile(join(app, "components/ui/button.tsx"), mine);
    await writeFile(upstreamButton(), original.replace("/** Demo Button: every action a person can take. */", "/** Their Button. */"));
    const lockBefore = await readLock(app);
    const { actions } = await syncProject(await project());
    expect(actionFor(actions, "components/ui/button.tsx")).toBe("conflict");
    expect(await read("components/ui/button.tsx")).toBe(mine);
    const conflict = await read(".youi/conflicts/components/ui/button.tsx");
    expect(conflict).toContain("<<<<<<< project");
    expect(conflict).toContain(">>>>>>> upstream");
    expect((await readLock(app))?.files["components/ui/button.tsx"]).toEqual(lockBefore?.files["components/ui/button.tsx"]);
  });

  test("local edits with no upstream change are kept as drift", async () => {
    await syncProject(await project());
    await writeFile(join(app, "components/ui/card.tsx"), `${await read("components/ui/card.tsx")}// tweak\n`);
    const { actions } = await syncProject(await project());
    expect(actionFor(actions, "components/ui/card.tsx")).toBe("kept-local");
  });

  test("an edited generated file fails the lock check and is regenerated by the next sync", async () => {
    await syncProject(await project());
    await writeFile(join(app, "src/design/tokens.css"), "/* hand edit */\n");
    const issues = await verifyLock(await project());
    expect(issues).toEqual([expect.objectContaining({ file: "src/design/tokens.css", severity: "error" })]);
    const { actions } = await syncProject(await project());
    expect(actions.find((a) => a.file === "src/design/tokens.css")).toMatchObject({ action: "updated", detail: expect.stringContaining("local edits") });
  });
});

test("mergeThreeWay reports clean merges and counts conflicts", async () => {
  expect(await mergeThreeWay("a\nB\nc\nd\ne\n", "a\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n")).toEqual({ text: "a\nB\nc\nd\nE\n", conflicts: 0 });
  expect((await mergeThreeWay("a\nX\nc\n", "a\nb\nc\n", "a\nY\nc\n")).conflicts).toBe(1);
});

describe("the MCP entry", () => {
  test("names a config kept outside the project, and finds the design repo through it", async () => {
    const config = join(dir, "configs/app.youi.json");
    await cp(join(app, "youi.project.json"), config);
    await rm(join(app, "youi.project.json"));
    const text = (await readFile(config, "utf8")).replace(/"path": "[^"]*"/, `"path": "../design"`);
    await writeFile(config, text);
    const external = await loadProject(app, { configPath: config });
    expect(mcpArgs(external).slice(1)).toEqual(["mcp", "--project", ".", "--config", "../configs/app.youi.json"]);
    const server = mcpArgs(external);
    const reloaded = await loadProject(app, { configPath: resolve(app, server[server.indexOf("--config") + 1]!) });
    expect(reloaded.repo.root).toBe(design);
  });
});

describe("review regressions", () => {
  const upstreamCard = (): string => join(design, "components/card/card.tsx");

  test("local edits survive later syncs: kept as drift, then merged when upstream changes", async () => {
    await syncProject(await project());
    await writeFile(join(app, "components/ui/card.tsx"), `${await read("components/ui/card.tsx")}// our tweak\n`);
    expect(actionFor((await syncProject(await project())).actions, "components/ui/card.tsx")).toBe("kept-local");
    const upstream = (await readFile(upstreamCard(), "utf8")).replace("/** Demo Card: a container for one subject, and its parts. */", "/** Card: one subject. */");
    await writeFile(upstreamCard(), upstream);
    const { actions } = await syncProject(await project());
    expect(actionFor(actions, "components/ui/card.tsx")).toBe("merged");
    const merged = await read("components/ui/card.tsx");
    expect(merged).toContain("// our tweak");
    expect(merged).toContain("/** Card: one subject. */");
    expect((await verifyLock(await project()))?.map((i) => `${i.file} ${i.severity}`)).toEqual(["components/ui/card.tsx warn"]);
    // A third sync with nothing new keeps the edit too.
    expect(actionFor((await syncProject(await project())).actions, "components/ui/card.tsx")).toBe("kept-local");
    expect(await read("components/ui/card.tsx")).toContain("// our tweak");
  });

  test("a resolved conflict is recorded with --adopt and then merges normally", async () => {
    await syncProject(await project());
    const original = await read("components/ui/card.tsx");
    const line = "/** Demo Card: a container for one subject, and its parts. */";
    await writeFile(join(app, "components/ui/card.tsx"), original.replace(line, "/** Ours. */"));
    await writeFile(upstreamCard(), original.replace(line, "/** Theirs. */"));
    expect(actionFor((await syncProject(await project())).actions, "components/ui/card.tsx")).toBe("conflict");
    expect(actionFor((await syncProject(await project(), { adopt: true })).actions, "components/ui/card.tsx")).toBe("kept-local");
    expect(actionFor((await syncProject(await project())).actions, "components/ui/card.tsx")).toBe("kept-local");
    expect(await read("components/ui/card.tsx")).toContain("/** Ours. */");
  });
});
