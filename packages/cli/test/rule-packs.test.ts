/**
 * Starter rules are offered, never installed: `youiyoux rules add` lists the packs, `rules add
 * behaviour` writes its six rule files (and only those) into the System's rules folder, never over a
 * rule or file already there, and only into a System edited here. Adopt and scan never add them, and
 * once added `youiyoux check` says they are incomplete until a probe has run.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BEHAVIOUR_CHECK_IDS, getSystem, loadDesignRepo, renderJsonSchemas, RuleSpec } from "@youiyoux/core";
import { main } from "../src/index.ts";
import { addRulePack, RULE_PACKS, RULES_LOCK, ruleYaml } from "../src/rule-packs.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");
const SIX = BEHAVIOUR_CHECK_IDS.map((check) => `behaviour.${check}.rule.yaml`);

let out = "";
let err = "";
let dir = "";
let app = "";
let design = "";
beforeEach(async () => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
  dir = await mkdtemp(join(tmpdir(), "youi-rule-packs-"));
  app = join(dir, "app");
  design = join(dir, "design");
  await cp(FIXTURE, app, { recursive: true });
  // The fixture's deliberately unparsable screen would make every check incomplete on its own.
  await rm(join(app, "app/broken.tsx"));
  await cp(DEMO, design, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const run = (...args: string[]): Promise<number> => {
  out = "";
  err = "";
  return main(args);
};
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const rulesIn = async (folder: string): Promise<string[]> => (await readdir(folder)).sort();
const validate = (() => {
  const schema = renderJsonSchemas().find((s) => s.file === "youi.rule.schema.json")!;
  return new Ajv2020({ strict: false, validateFormats: false }).compile(JSON.parse(schema.content) as object);
})();

describe("the behaviour pack", () => {
  test("is six warnings, one per behaviour check, each valid against the Zod schema and the published JSON Schema", () => {
    const pack = RULE_PACKS.find((p) => p.name === "behaviour")!;
    const rules = pack.rules("acme");
    expect(rules.map((r) => r.file)).toEqual(SIX);
    for (const { file, spec } of rules) {
      const yaml: unknown = parseYaml(ruleYaml(spec));
      expect(RuleSpec.parse(yaml), file).toEqual(spec);
      expect(validate(yaml), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(spec).toMatchObject({ id: `youi:acme/rule/${file.replace(".rule.yaml", "")}`, severity: "warn", check: { engine: "behaviour" } });
      expect(spec.agent, file).toContain("ui_behave");
      expect(spec.agent, file).toContain("youiyoux behave --route <route>");
      expect(spec.examples.bad.length, file).toBeGreaterThan(0);
      expect(spec.examples.good.length, file).toBeGreaterThan(0);
    }
    expect(rules.map((r) => (r.spec.check as { id: string }).id)).toEqual([...BEHAVIOUR_CHECK_IDS]);
  });
});

describe("youiyoux rules add", () => {
  test("alone, lists what's on offer (six behaviour rules) and writes nothing", async () => {
    const before = await rulesIn(join(design, "rules"));
    expect(await run("rules", "add", "--project", app, "--design", design)).toBe(0);
    const text = plain(out);
    expect(text).toContain("Starter rules on offer (never added unless you ask):");
    for (const file of SIX) expect(text).toContain(file.replace(".rule.yaml", ""));
    expect(text).toContain("Next: youiyoux rules add <pack>");
    expect(await rulesIn(join(design, "rules"))).toEqual(before);
    expect(await run("rules", "add", "--json")).toBe(0);
    const { packs } = JSON.parse(out) as { packs: Array<{ name: string; rules: unknown[] }> };
    expect(packs.map((p) => [p.name, p.rules.length])).toEqual([["behaviour", 6]]);
  });

  test("behaviour writes the six rule files into the System's rules folder, which load; check then says they are incomplete", async () => {
    const before = await rulesIn(join(design, "rules"));
    expect(await run("rules", "add", "behaviour", "--project", app, "--design", design, "--dry-run")).toBe(0);
    expect(plain(out)).toContain("would add 6 behaviour rules, as warnings, to demo");
    expect(await rulesIn(join(design, "rules"))).toEqual(before);

    expect(await run("rules", "add", "behaviour", "--project", app, "--design", design)).toBe(0);
    expect(plain(out)).toContain("added 6 behaviour rules, as warnings, to demo");
    expect(plain(out)).toContain("Until a probe has run, youiyoux check says these rules are incomplete.");
    // Those six files and nothing else.
    expect(await rulesIn(join(design, "rules"))).toEqual([...before, ...SIX].sort());
    for (const file of SIX) expect(validate(parseYaml(await readFile(join(design, "rules", file), "utf8")))).toBe(true);

    expect(await run("rules", "--project", app, "--design", design, "--json")).toBe(0);
    const { rules } = JSON.parse(out) as { rules: Array<{ id: string; state: string }> };
    for (const check of BEHAVIOUR_CHECK_IDS) expect(rules.find((r) => r.id === `youi:demo/rule/behaviour.${check}`)?.state).toBe("probe");

    expect(await run("check", "--project", app, "--design", design, "--json")).toBe(1);
    const result = JSON.parse(out) as { incomplete: boolean; notRun: Array<{ rule: string; state: string }> };
    expect(result.incomplete).toBe(true);
    expect(result.notRun.filter((r) => r.rule.includes("/rule/behaviour.")).map((r) => [r.rule, r.state]).sort()).toEqual(BEHAVIOUR_CHECK_IDS.map((c) => [`youi:demo/rule/behaviour.${c}`, "incomplete"]).sort());
  });

  test("never writes over a rule already there: the same id in another file, or a file of the same name, is kept as it is", async () => {
    // A hand-written dismiss-escape rule under its own file name, and a file named like focus-trap's.
    const mine = ["schema: youi.rule/v1", "id: youi:demo/rule/behaviour.dismiss-escape", "title: Mine", "severity: error", "statement: Esc closes popups.", "agent: Close on Esc.", "check:", "  engine: behaviour", "  id: dismiss-escape", ""].join("\n");
    await writeFile(join(design, "rules/my-escape.rule.yaml"), mine);
    const trap = mine.replace("behaviour.dismiss-escape", "behaviour.my-trap").replace("dismiss-escape\n", "focus-trap\n");
    await writeFile(join(design, "rules/behaviour.focus-trap.rule.yaml"), trap);
    expect(await run("rules", "add", "behaviour", "--project", app, "--design", design)).toBe(0);
    const text = plain(out);
    expect(text).toContain("added 4 behaviour rules");
    expect(text).toContain("kept behaviour.dismiss-escape.rule.yaml: youi:demo/rule/behaviour.dismiss-escape is already a rule of demo, left as it is");
    expect(text).toContain("kept behaviour.focus-trap.rule.yaml: behaviour.focus-trap.rule.yaml is already in the rules folder, left as it is");
    expect(await readFile(join(design, "rules/my-escape.rule.yaml"), "utf8")).toBe(mine);
    expect(await readFile(join(design, "rules/behaviour.focus-trap.rule.yaml"), "utf8")).toBe(trap);
    await expect(readFile(join(design, "rules/behaviour.dismiss-escape.rule.yaml"), "utf8")).rejects.toThrow();
    // Run again: nothing left to add, nothing changed.
    const after = await Promise.all((await rulesIn(join(design, "rules"))).map(async (f) => [f, await readFile(join(design, "rules", f), "utf8")]));
    expect(await run("rules", "add", "behaviour", "--project", app, "--design", design)).toBe(0);
    expect(plain(out)).toContain("nothing to add: every behaviour rule is already in demo");
    expect(await Promise.all((await rulesIn(join(design, "rules"))).map(async (f) => [f, await readFile(join(design, "rules", f), "utf8")]))).toEqual(after);
  });

  test("a System from an npm package or a git repository isn't edited here: refused, nothing written", async () => {
    const pkg = join(app, "node_modules/@acme/design");
    await mkdir(join(app, "node_modules/@acme"), { recursive: true });
    await cp(DEMO, pkg, { recursive: true });
    const config = JSON.parse(await readFile(join(app, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(app, "youi.project.json"), JSON.stringify({ ...config, source: { package: "@acme/design" } }));
    const before = await rulesIn(join(pkg, "rules"));
    expect(await run("rules", "add", "behaviour", "--project", app)).toBe(1);
    expect(err).toContain("comes from the npm package @acme/design, which isn't edited here: add the rules in its own repository (youiyoux rules add there), or link your checkout of it first (youiyoux link <dir>)");
    expect(await rulesIn(join(pkg, "rules"))).toEqual(before);
    // A folder source (an adopted System, a sibling checkout) is edited here.
    await writeFile(join(app, "youi.project.json"), JSON.stringify({ ...config, source: { path: "../design" } }));
    expect(await run("rules", "add", "behaviour", "--project", app)).toBe(0);
    expect(await rulesIn(join(design, "rules"))).toEqual(expect.arrayContaining(SIX));
  });

  test("a git source is refused before anything is resolved: nothing fetched, the systems cache untouched, with or without --dry-run", async () => {
    const cache = join(dir, "systems-cache");
    vi.stubEnv("YOUI_SYSTEMS_CACHE", cache);
    const config = JSON.parse(await readFile(join(app, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(app, "youi.project.json"), JSON.stringify({ ...config, source: { git: `file://${join(dir, "no-such-design.git")}`, ref: "v1" } }));
    for (const dry of [[], ["--dry-run"]]) {
      expect(await run("rules", "add", "behaviour", "--project", app, ...dry)).toBe(1);
      expect(err).toContain(`the System demo comes from the git repository file://${join(dir, "no-such-design.git")}, which isn't edited here`);
      expect(err).toContain("nothing was fetched or written");
      await expect(readdir(cache)).rejects.toThrow();
    }
    vi.unstubAllEnvs();
  });

  test("in a design repo it adds to that repo's System; a rules folder that leads outside it is refused", async () => {
    const outside = join(dir, "elsewhere");
    await mkdir(outside);
    const config = JSON.parse(await readFile(join(design, "youi.config.json"), "utf8")) as { systems: Array<Record<string, unknown>> };
    await writeFile(join(design, "youi.config.json"), JSON.stringify({ ...config, systems: [{ ...config.systems[0], rules: "linked-rules" }] }));
    // The System's own rules, kept through a link to a folder outside the repo.
    await cp(join(design, "rules"), outside, { recursive: true });
    const held = await rulesIn(outside);
    await symlink(outside, join(design, "linked-rules"));
    expect(await run("rules", "add", "behaviour", "--design", design)).toBe(1);
    expect(err).toContain("the rules folder linked-rules leads outside the design repo");
    expect(await rulesIn(outside)).toEqual(held);
    // A rules folder that doesn't exist yet, under a link that leads outside, is refused too (a System with no components or rules yet).
    await rm(join(design, "linked-rules"));
    const empty = join(dir, "empty");
    await mkdir(empty);
    await symlink(empty, join(design, "parent"));
    await writeFile(join(design, "youi.config.json"), JSON.stringify({ ...config, systems: [{ ...config.systems[0], components: "none-yet", rules: "parent/rules" }] }));
    expect(await run("rules", "add", "behaviour", "--design", design)).toBe(1);
    expect(err).toContain("the rules folder parent/rules leads outside the design repo");
    expect(await readdir(empty)).toEqual([]);
    // Its own folder: written there.
    await rm(join(design, "parent"));
    await writeFile(join(design, "youi.config.json"), JSON.stringify(config));
    expect(await run("rules", "add", "behaviour", "--design", design)).toBe(0);
    expect(plain(out)).toContain("products following this System get them at their next youiyoux sync");
    expect(await rulesIn(join(design, "rules"))).toEqual(expect.arrayContaining(SIX));
  });

  test("an unknown pack is a usage error naming what's on offer", async () => {
    expect(await run("rules", "add", "colour", "--project", app, "--design", design)).toBe(2);
    expect(err).toContain('there is no pack called "colour"; on offer: behaviour');
  });
});

describe("nothing else adds them", () => {
  test("scan and check leave the rules folder as it was", async () => {
    const before = await rulesIn(join(design, "rules"));
    await run("scan", "--project", app, "--design", design, "--out", join(dir, "usage.json"));
    await run("check", "--project", app, "--design", design, "--json");
    expect(await rulesIn(join(design, "rules"))).toEqual(before);
    expect(before.some((f) => f.startsWith("behaviour."))).toBe(false);
  });
});

describe("rules add under concurrency", () => {
  const pack = RULE_PACKS.find((p) => p.name === "behaviour")!;
  const target = async () => ({ root: design, system: getSystem(await loadDesignRepo(design)) });
  const mine = (id: string, check: string) => ["schema: youi.rule/v1", `id: youi:demo/rule/${id}`, "title: Mine", "severity: error", "statement: Mine.", "agent: Mine.", "check:", "  engine: behaviour", `  id: ${check}`, ""].join("\n");

  test("a file another writer makes between the check and the write is kept, never replaced", async () => {
    const theirs = mine("theirs", "focus-into");
    const added = await addRulePack(await target(), pack, {
      beforePublish: async (file) => {
        if (file === "behaviour.focus-into.rule.yaml") await writeFile(join(design, "rules", file), theirs);
      },
    });
    expect(added.added).toEqual(SIX.filter((f) => f !== "behaviour.focus-into.rule.yaml"));
    expect(added.kept).toEqual([{ file: "behaviour.focus-into.rule.yaml", why: "behaviour.focus-into.rule.yaml was made by someone else meanwhile" }]);
    expect(await readFile(join(design, "rules/behaviour.focus-into.rule.yaml"), "utf8")).toBe(theirs);
    // No temp file or lock is left behind.
    expect((await readdir(join(design, "rules"))).filter((f) => f.startsWith(".") || f === RULES_LOCK)).toEqual([]);
  });

  test("ids are read again under the lock: a rule with one of the pack's ids, added after the System was loaded, is kept", async () => {
    const loaded = await target();
    await writeFile(join(design, "rules/my-escape.rule.yaml"), mine("behaviour.dismiss-escape", "dismiss-escape"));
    const added = await addRulePack(loaded, pack);
    expect(added.kept).toEqual([{ file: "behaviour.dismiss-escape.rule.yaml", why: "youi:demo/rule/behaviour.dismiss-escape is already a rule of demo" }]);
    await expect(readFile(join(design, "rules/behaviour.dismiss-escape.rule.yaml"), "utf8")).rejects.toThrow();
    // The System still loads: no id is there twice.
    expect(getSystem(await loadDesignRepo(design)).rules.filter((r) => r.id.endsWith("/behaviour.dismiss-escape"))).toHaveLength(1);
  });

  test("two at once take turns: the second waits for the first's lock, then finds every rule there and writes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let entered!: () => void;
    const inside = new Promise<void>((done) => (entered = done));
    const first = addRulePack(await target(), pack, {
      beforePublish: async () => {
        entered();
        await gate;
      },
    });
    await inside;
    let secondDone = false;
    const second = addRulePack(await target(), pack).then((r) => ((secondDone = true), r));
    await new Promise((done) => setTimeout(done, 300));
    // The first holds the lock between its check and its writes: the second hasn't run.
    expect(secondDone).toBe(false);
    release();
    expect((await first).added).toEqual(SIX);
    const after = await second;
    expect(after.added).toEqual([]);
    expect(after.kept.map((k) => k.why)).toEqual(SIX.map((f) => `youi:demo/rule/${f.replace(".rule.yaml", "")} is already a rule of demo`));
  });
});
