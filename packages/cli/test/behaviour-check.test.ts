/**
 * `youiyoux check` reading stored behaviour results: a behaviour rule ran only when every route
 * has a fresh, complete result; fresh failures count by severity (filtered by --rule and --quiet,
 * never accepted by a baseline); missing or stale routes keep it incomplete, named. `check --diff`
 * reports fresh failures by popup identity. The stored runs are written as `youiyoux behave` writes
 * them, with each freshness part computed from the copied project now (the browser side is proven
 * in the workflow and scanner tests, and end to end in behave-cli.test.ts).
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BEHAVIOUR_ROUTE_SCHEMA, BehaviourRouteRun, type BehaviourPattern } from "@youiyoux/core";
import { appFingerprint, behaviourConfigDigest, loadProject, ruleDigest } from "@youiyoux/scanner";
import { behaviourFile } from "@youiyoux/workflow";
import { main } from "../src/index.ts";
import { behaviourTool } from "../src/version.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");
const ORIGIN = "http://127.0.0.1:5173";
const RULE_ID = "youi:demo/rule/popup.escape";

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
  dir = await mkdtemp(join(tmpdir(), "youi-behaviour-check-"));
  app = join(dir, "app");
  design = join(dir, "design");
  await cp(FIXTURE, app, { recursive: true });
  // The fixture's deliberately unparsable screen would make every check incomplete on its own.
  await rm(join(app, "app/broken.tsx"));
  await cp(DEMO, design, { recursive: true });
  await rule("error");
  await mkdir(join(app, ".youi/screens"), { recursive: true });
  await writeFile(join(app, ".youi/screens/screens.json"), JSON.stringify(SCREENS));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const SCREENS = { schema: "youiyoux.screens/v1", project: "app", source: "the fixture", capturedAt: "", viewport: { width: 800, height: 600 }, base: ORIGIN, behaviour: { allowedOrigin: ORIGIN, generation: 1 }, screens: [{ route: "/", path: "/" }, { route: "/settings", path: "/settings" }] };

const rule = (severity: "error" | "warn") =>
  writeFile(join(design, "rules/popup.escape.rule.yaml"), ["schema: youi.rule/v1", `id: ${RULE_ID}`, "title: Esc closes popups", `severity: ${severity}`, "statement: Esc closes every popup.", "agent: Close popups on Esc.", "check:", "  engine: behaviour", "  id: dismiss-escape", ""].join("\n"));

interface Target {
  readonly state: "passed" | "failed" | "incomplete";
  readonly name: string;
  readonly pattern?: BehaviourPattern;
  readonly file?: string;
  readonly line?: number;
}

/** A route's run as `youiyoux behave` stores it, its freshness computed from the project as it is now. */
async function stored(route: string, targets: readonly Target[]): Promise<void> {
  const project = await loadProject(app, { designRoot: design });
  const spec = JSON.parse(await readFile(join(app, ".youi/screens/screens.json"), "utf8")) as typeof SCREENS;
  const r = project.system.rules.find((x) => x.id === RULE_ID)!;
  const freshness = { rule: ruleDigest(r), tool: behaviourTool(), origin: ORIGIN, config: behaviourConfigDigest(spec, route), app: await appFingerprint(project) };
  const at = "2026-11-12T10:00:00.000Z";
  const results = targets.map((t) => {
    const pattern = t.pattern ?? "menu-button";
    return {
      runId: "run1",
      at,
      viewport: spec.viewport,
      route,
      rule: RULE_ID,
      target: { route, pattern, component: "Menu", accessibleName: t.name, ...(t.file ? { file: t.file, line: t.line } : {}) },
      pattern,
      check: "dismiss-escape",
      state: t.state,
      why: t.state === "passed" ? "Esc closed the menu" : t.state === "failed" ? "Esc did nothing: the menu was still open after 1.5 s" : "focus couldn't be placed inside the menu, so Esc wasn't pressed",
      fix: t.state === "failed" ? "Close the menu when Esc is pressed while focus is in it." : "Nothing to do: Esc closes it.",
      freshness,
    };
  });
  const run = BehaviourRouteRun.parse({ schema: BEHAVIOUR_ROUTE_SCHEMA, route, runId: "run1", at, origin: ORIGIN, viewport: spec.viewport, state: "probed", why: null, fix: null, coverage: `${targets.length} popup triggers found by ARIA markers.`, rules: [{ rule: RULE_ID, check: "dismiss-escape", freshness }], results });
  await mkdir(join(app, ".youi/behaviour"), { recursive: true });
  await writeFile(join(app, behaviourFile(route)), JSON.stringify(run));
}

const check = async (...args: string[]): Promise<number> => {
  out = "";
  return main(["check", "--project", app, "--design", design, ...args]);
};
const checkJson = async (...args: string[]) => {
  const code = await check(...args, "--json");
  return { code, json: JSON.parse(out) as { errors: number; incomplete: boolean; notRun: Array<{ rule: string; state: string; reason: string }>; behaviour: Array<{ rule: string; severity: string; result: { route: string; state: string } }>; checks: Array<{ rule: string; state: string; findings?: number }> } };
};
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("check reads stored behaviour results", () => {
  test("fresh passes on every route: the rule ran, nothing fails, exit 0", async () => {
    await stored("/", [{ state: "passed", name: "Actions" }]);
    await stored("/settings", []);
    const { code, json } = await checkJson("--rule", "popup.escape");
    expect(json.checks.find((c) => c.rule === RULE_ID)).toEqual({ rule: RULE_ID, state: "ran", findings: 0 });
    expect(json).toMatchObject({ errors: 0, incomplete: false, notRun: [], behaviour: [] });
    expect(code).toBe(0);
    expect(await check("--rule", "popup.escape")).toBe(0);
    expect(plain(out)).toContain("✓ 0 errors · 0 warnings");
  });

  test("a route with no fresh result keeps the rule incomplete, naming it, exit 1", async () => {
    await stored("/", [{ state: "passed", name: "Actions" }]);
    const { code, json } = await checkJson("--rule", "popup.escape");
    expect(code).toBe(1);
    expect(json.incomplete).toBe(true);
    expect(json.notRun).toEqual([{ rule: RULE_ID, state: "incomplete", reason: "no fresh, complete probe results on 1 of 2 routes: /settings was never probed. Run youiyoux behave --route /settings (for popup.escape), then youiyoux check again" }]);
    expect(await check("--rule", "popup.escape")).toBe(1);
    expect(plain(out)).toContain("Next: run `youiyoux behave` to probe this app's menus, dialogs and popovers for popup.escape");
    expect(plain(out)).not.toContain("✓");
  });

  test("a fresh failure on an error rule is an error (exit 1): in text, in JSON and as a GitHub annotation on its line", async () => {
    await stored("/", [{ state: "failed", name: "Actions", file: "components/menu.tsx", line: 12 }, { state: "passed", name: "Filter" }]);
    await stored("/settings", []);
    const { code, json } = await checkJson("--rule", "popup.escape");
    expect(code).toBe(1);
    expect(json).toMatchObject({ errors: 1, incomplete: false, behaviour: [{ rule: RULE_ID, severity: "error", result: { route: "/", state: "failed" } }] });
    expect(json.checks.find((c) => c.rule === RULE_ID)).toEqual({ rule: RULE_ID, state: "ran", findings: 1 });
    expect(await check("--rule", "popup.escape")).toBe(1);
    const text = plain(out);
    expect(text).toContain("behaviour (probed in the running app by youiyoux behave)");
    expect(text).toContain("/ menu 'Actions' (components/menu.tsx:12) dismiss-escape: Esc did nothing: the menu was still open after 1.5 s");
    expect(text).toContain("✖ 1 error · 0 warnings in 0 files and 1 screen");
    expect(await check("--rule", "popup.escape", "--format", "github")).toBe(1);
    expect(out).toMatch(/^::error file=components\/menu\.tsx,line=12,title=youi popup\.escape::\/ menu 'Actions'/m);
  });

  test("once stale (a scanned file changed) the failure no longer counts and the rule is incomplete, naming the route", async () => {
    await stored("/", [{ state: "failed", name: "Actions" }]);
    await stored("/settings", []);
    await writeFile(join(app, "app/settings/index.tsx"), `${await readFile(join(app, "app/settings/index.tsx"), "utf8")}\n// edited\n`);
    const { code, json } = await checkJson("--rule", "popup.escape");
    expect(code).toBe(1);
    expect(json).toMatchObject({ errors: 0, incomplete: true, behaviour: [] });
    expect(json.notRun[0]!.reason).toMatch(/^no fresh, complete probe results on 2 of 2 routes: \/ is stale \(the code changed since its run\); \/settings is stale/);
  });

  test("--rule and --quiet filter behaviour failures like violations; a warning counts but doesn't fail", async () => {
    await rule("warn");
    await stored("/", [{ state: "failed", name: "Actions" }]);
    await stored("/settings", []);
    const warned = await checkJson("--rule", "popup.escape");
    expect(warned).toMatchObject({ code: 0, json: { errors: 0, incomplete: false, behaviour: [{ severity: "warn" }] } });
    expect(await check("--rule", "popup.escape")).toBe(0);
    expect(plain(out)).toContain("✓ 0 errors · 1 warning in 0 files and 1 screen");
    expect((await checkJson("--rule", "popup.escape", "--quiet")).json.behaviour).toEqual([]);
    const other = await checkJson("--rule", "raw-color");
    expect(other.json.behaviour).toEqual([]);
    expect(other.json.notRun.filter((r) => r.rule === RULE_ID)).toEqual([]);
  });

  test("a baseline never accepts a behaviour failure: it still counts as an error", async () => {
    expect(await main(["baseline", "--project", app, "--design", design, "--force"])).toBe(0);
    await stored("/", [{ state: "failed", name: "Actions" }]);
    await stored("/settings", []);
    const { code, json } = await checkJson("--rule", "popup.escape", "--baseline");
    expect(json).toMatchObject({ errors: 1, behaviour: [{ result: { state: "failed" } }] });
    expect(code).toBe(1);
  });

  test("an incomplete result on a route keeps the rule incomplete, though the route's fresh failures still count", async () => {
    await stored("/", [{ state: "failed", name: "Actions" }, { state: "incomplete", name: "Filter" }]);
    await stored("/settings", []);
    const { code, json } = await checkJson("--rule", "popup.escape");
    expect(code).toBe(1);
    expect(json).toMatchObject({ errors: 1, incomplete: true });
    expect(json.notRun[0]!.reason).toMatch(/\/ has 1 popup that couldn't be decided \(focus couldn't be placed inside the menu/);
  });
});

describe("check --diff reports behaviour findings by popup", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: app, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });

  test("each fresh failure is a finding of kind behaviour, keyed by route, pattern, component, name and ordinal, never merged by file and line; exit 0 unless --strict", async () => {
    git("init", "--quiet", "--initial-branch=main");
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    // The change: a line added to a screen. The runs are made after it, so they are fresh.
    await writeFile(join(app, "app/settings/index.tsx"), `${await readFile(join(app, "app/settings/index.tsx"), "utf8")}\n// changed\n`);
    // Two popups at the same (untouched) file and line, told apart by name; one with no line at all.
    await stored("/", [{ state: "failed", name: "Actions", file: "components/menu.tsx", line: 3 }, { state: "failed", name: "More", file: "components/menu.tsx", line: 3 }, { state: "passed", name: "Filter" }]);
    await stored("/settings", [{ state: "failed", name: "Sort", pattern: "combobox-listbox" }]);
    expect(await check("--diff", "--rule", "popup.escape", "--json")).toBe(0);
    const diff = JSON.parse(out) as { findings: Array<{ kind: string; target: Record<string, unknown>; file: string | null; line: number | null; rule: string; severity: string }>; incomplete: boolean };
    expect(diff.incomplete).toBe(false);
    expect(diff.findings.filter((f) => f.kind === "behaviour")).toEqual([
      expect.objectContaining({ target: { route: "/", pattern: "menu-button", component: "Menu", accessibleName: "Actions" }, file: "components/menu.tsx", line: 3, rule: "popup.escape", severity: "error" }),
      expect.objectContaining({ target: { route: "/", pattern: "menu-button", component: "Menu", accessibleName: "More" }, file: "components/menu.tsx", line: 3 }),
      expect.objectContaining({ target: { route: "/settings", pattern: "combobox-listbox", component: "Menu", accessibleName: "Sort" }, file: null, line: null }),
    ]);
    expect(await check("--diff", "--rule", "popup.escape")).toBe(0);
    expect(plain(out)).toContain("/settings 'Sort'  behaviour rule popup.escape  dismiss-escape on the listbox 'Sort' on /settings: Esc did nothing");
    expect(await check("--diff", "--rule", "popup.escape", "--strict")).toBe(1);
  });
});
