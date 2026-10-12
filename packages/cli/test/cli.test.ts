import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { generatedPrefix, hubPlan, loadOptions, main, runHub } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("youi", () => {
  test("help and unknown commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("youi <command>");
    expect(await main(["frobnicate"])).toBe(2);
    expect(err).toContain("unknown command");
    expect(await main(["where"])).toBe(2);
    expect(err).toContain("usage: youi where <component>");
  });

  test("help separates System commands from Library commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toMatch(/System\b.*build only with these[\s\S]*Library\b.*never build with/);
  });

  test("System commands refuse Library ids", async () => {
    expect(await main(["show", "lib:example/component/pill", "--project", FIXTURE])).toBe(1);
    expect(err).toContain("is a Library item, not a System element");
  });

  test("youi library browses an empty Library and needs a reason to draft a request", async () => {
    expect(await main(["library", "search", "date", "picker", "--project", FIXTURE, "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ hits: [], total: 0 });
    expect(await main(["library", "request", "lib:example/component/pill", "--project", FIXTURE])).toBe(2);
    expect(err).toContain("--reason");
    expect(await main(["library", "request", "lib:example/component/pill", "--reason", "status chips", "--project", FIXTURE])).toBe(1);
    expect(err).toContain("Library is empty");
  });

  test("where --json answers from a fresh scan", async () => {
    expect(await main(["where", "button", "--project", FIXTURE, "--json"])).toBe(0);
    const where = JSON.parse(out) as { total: number; byRoute: Array<{ route: string }>; coverage: { status: string } };
    expect(where.total).toBe(7);
    expect(where.byRoute.map((r) => r.route)).toEqual(expect.arrayContaining(["/", "/settings", "/checkout"]));
    expect(where.coverage.status).toBe("partial");
  });

  test("bom names the screen's files, and a route no file reaches is an error, not an empty screen", async () => {
    expect(await main(["bom", "/settings", "--project", FIXTURE])).toBe(0);
    expect(out).toContain("app/settings/index.tsx");
    expect(await main(["bom", "/setings", "--project", FIXTURE])).toBe(1);
    expect(err).toContain('no screen "/setings"; known: /, /checkout, /settings');
  });

  test("check exits 1 when there are errors, and show prints the contract", async () => {
    expect(await main(["check", "--project", FIXTURE, "--json"])).toBe(1);
    expect((JSON.parse(out) as { errors: number }).errors).toBeGreaterThan(0);
    out = "";
    expect(await main(["show", "input", "--project", FIXTURE, "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ name: "Input", import: "import { Input } from \"@/components/ui\";" });
  });

  test("a config kept outside its product says the root is wrong, then checks the product once root or --root names it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-pilot-"));
    try {
      const pilot = join(dir, "pilot/app");
      await (await import("node:fs/promises")).mkdir(pilot, { recursive: true });
      const config = { ...(JSON.parse(await readFile(join(FIXTURE, "youi.project.json"), "utf8")) as Record<string, unknown>), source: { path: DEMO } };
      await writeFile(join(pilot, "youi.project.json"), JSON.stringify(config));
      expect(await main(["check", "--project", pilot])).toBe(1);
      expect(err).toContain(`product root ${pilot} has 0 files matching`);
      expect(err).toContain('set "root" in the config (relative to it, or absolute) or pass --root <dir>');
      expect(out).not.toContain("0 errors");
      out = "";
      expect(await main(["check", "--project", pilot, "--root", FIXTURE, "--json"])).toBe(1);
      const flagged = JSON.parse(out) as { errors: number; coverage: { filesMatched: number } };
      expect(flagged.coverage.filesMatched).toBeGreaterThan(0);
      expect(flagged.errors).toBeGreaterThan(0);
      await writeFile(join(pilot, "youi.project.json"), JSON.stringify({ ...config, root: relative(pilot, FIXTURE) }));
      out = "";
      expect(await main(["check", "--project", pilot, "--json"])).toBe(1);
      expect(JSON.parse(out)).toMatchObject({ errors: flagged.errors, coverage: { filesMatched: flagged.coverage.filesMatched } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty --root is the current directory, not unset: the config's own root does not win", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-pilot-"));
    try {
      const config = { ...(JSON.parse(await readFile(join(FIXTURE, "youi.project.json"), "utf8")) as Record<string, unknown>), source: { path: DEMO }, root: "../no-such-product" };
      await writeFile(join(dir, "youi.project.json"), JSON.stringify(config));
      expect(loadOptions({ root: "" })).toEqual({ productRoot: "." });
      expect(loadOptions({})).toEqual({});
      const p = await loadProject(dir, loadOptions({ config: join(dir, "youi.project.json"), root: "" }));
      expect(p.root).toBe(process.cwd());
      expect(p.rootOverride).toBe(true);
      await expect(loadProject(dir, loadOptions({ config: join(dir, "youi.project.json") }))).rejects.toThrow(/no-such-product is not a directory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bad component name is an error with the known names", async () => {
    expect(await main(["show", "carousel", "--project", FIXTURE])).toBe(1);
    expect(err).toContain("known: Button, Card, Input");
  });

  test("init writes a project config from what it finds, then syncs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-init-"));
    try {
      await cp(join(FIXTURE, "app"), join(dir, "app"), { recursive: true });
      await cp(join(FIXTURE, "tsconfig.json"), join(dir, "tsconfig.json"));
      await (await import("node:fs/promises")).writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/mobile", dependencies: { "expo-router": "6.0.0" } }));
      expect(await main(["init", "--project", dir])).toBe(2);
      expect(err).toContain("youi init --design <dir>");
      expect(await main(["init", "--project", dir, "--design", DEMO])).toBe(0);
      const config = JSON.parse(await readFile(join(dir, "youi.project.json"), "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({ id: "mobile", system: "demo", source: { path: relative(dir, DEMO) }, componentsDir: "components/ui", importFrom: "@/components/ui", routes: { strategy: "expo-router", appDir: "app" } });
      expect(String(config.$schema)).toMatch(/schema\/youi\.project\.schema\.json$/);
      expect(await readFile(join(dir, "components/ui/button.tsx"), "utf8")).toContain("buttonVariants");
      expect(await main(["init", "--project", dir, "--design", DEMO])).toBe(1);
      expect(err).toContain("already exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("init keeps the variable prefix of tokens youi already generated in the product", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-init-prefix-"));
    try {
      await cp(join(FIXTURE, "app"), join(dir, "app"), { recursive: true });
      await (await import("node:fs/promises")).mkdir(join(dir, "src/design"), { recursive: true });
      await writeFile(join(dir, "src/design/tokens.css"), "/* @generated by youi from the Signal design language v1.0.0. */\n:root {\n  --so-accent: #171717;\n  --so-space-sm: 8px;\n}\n");
      expect(await main(["init", "--project", dir, "--design", DEMO, "--dry-run"])).toBe(0);
      const config = JSON.parse(await readFile(join(dir, "youi.project.json"), "utf8")) as { outputs: { cssVarPrefix: string } };
      expect(config.outputs.cssVarPrefix).toBe("so");
      expect(out).toContain('generated with the prefix "so"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the generated prefix is the variable name less the system's own token name", () => {
    const css = (...vars: string[]): string => `/* @generated by youi */\n:root {\n${vars.map((v) => `  ${v}: red;`).join("\n")}\n}\n`;
    // Every token in one group: the common prefix would be acme-color, which sync would rename.
    expect(generatedPrefix(css("--acme-color-bg", "--acme-color-fg"), ["color-bg", "color-fg"])).toBe("acme");
    expect(generatedPrefix(css("--so-accent", "--so-accent-hover", "--so-space-sm"), ["accent", "accent-hover", "space-sm"])).toBe("so");
    expect(generatedPrefix(css("--demo-color-accent", "--demo-radius-md"), ["color-accent", "radius-md"])).toBe("demo");
    // No generated mark, or no variable that ends in one of the system's tokens: no guess.
    expect(generatedPrefix(":root {\n  --so-accent: red;\n}", ["accent"])).toBeNull();
    expect(generatedPrefix(css("--acme-color-bg"), ["radius-md"])).toBeNull();
    expect(generatedPrefix(null, ["accent"])).toBeNull();
  });

  test("design-repo commands read --design, and refuse a directory that is not a design repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-build-"));
    try {
      expect(await main(["build", "--design", DEMO, "--out", dir, "--prefix", "demo", "--json"])).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ files: ["tokens.css", "theme.css", "tokens.ts", "tokens.native.ts"], tokens: 19 });
      expect(await readFile(join(dir, "tokens.css"), "utf8")).toContain("--demo-color-accent:");
      expect(await main(["build", "--design", dir])).toBe(1);
      expect(err).toContain("not a design repo");
      expect(await main(["show", "button", "--project", FIXTURE, "--design", dir])).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schema --check compares a design repo's copies with this youi's schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-schema-"));
    try {
      expect(await main(["schema", "--check"])).toBe(0);
      out = "";
      expect(await main(["schema", "--check", "--design", dir, "--json"])).toBe(1);
      expect((JSON.parse(out) as { stale: string[] }).stale).toHaveLength(9);
      expect(await main(["schema", "--write", "--design", dir])).toBe(0);
      out = "";
      expect(await main(["schema", "--check", "--design", dir])).toBe(0);
      expect(out).toContain("matches");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ui shows the committed demo by default, and snapshots a named system into a gitignored dir", () => {
    const tool = "/opt/youi";
    expect(hubPlan(tool, {})).toEqual({ web: "/opt/youi/apps/web", snapshot: null, env: {}, vite: ["/opt/youi/apps/web/node_modules/vite/bin/vite.js"], watch: null });
    const plan = hubPlan(tool, { design: "/data/acme-design", project: "/src/acme-app", port: "5180" });
    expect(plan.snapshot).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--design", "/data/acme-design", "--project", "/src/acme-app"]);
    expect(plan.env).toEqual({ YOUI_HUB_SNAPSHOT: "/opt/youi/apps/web/.hub" });
    expect(plan.vite.slice(1)).toEqual(["--port", "5180", "--strictPort"]);
    expect(plan.watch).toBeNull();
    // A config beside the design repo: the snapshot scans the product --root names.
    expect(hubPlan(tool, { project: "/data/acme-design/pilot", root: "/src/acme-app" }).snapshot).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--project", "/data/acme-design/pilot", "--root", "/src/acme-app"]);
    expect(hubPlan(tool, { project: "/src/acme-app", watch: true }).watch).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--project", "/src/acme-app", "--watch"]);
    // Watching with nothing named watches the demo project into .hub, never the committed snapshot.
    expect(hubPlan(tool, { watch: true }).watch).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--project", "/opt/youi/examples/demo-app", "--watch"]);
    // The rule editor `youi ui --project` starts is what the dev server proxies at /api.
    expect(hubPlan(tool, { project: "/src/acme-app", api: "http://127.0.0.1:50123" }).env).toEqual({ YOUI_HUB_SNAPSHOT: "/opt/youi/apps/web/.hub", YOUI_API: "http://127.0.0.1:50123" });
  });

  test("ui explains missing hub dependencies instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-hub-"));
    try {
      await expect(runHub(dir, { design: DEMO })).rejects.toThrowError(/dependencies are not installed: run `pnpm install`/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rules lists how each rule is checked; plan --token reports a lower bound", async () => {
    expect(await main(["rules", "--project", FIXTURE, "--json"])).toBe(0);
    const { rules, capabilities } = JSON.parse(out) as { rules: Array<{ id: string; state: string }>; capabilities: { builtIn: unknown[] } };
    expect(rules.find((r) => r.id.endsWith("components.one-primary-action"))?.state).toBe("advisory");
    expect(rules.filter((r) => r.state === "enforced")).toHaveLength(5);
    expect(capabilities.builtIn).toHaveLength(5);
    out = "";
    expect(await main(["plan", "--token", "color.muted", "--project", FIXTURE])).toBe(0);
    expect(out).toContain("none found (not proof of none: see limits)");
    expect(out).toContain("counts are a lower bound");
  });

  test("a rule youi cannot run makes check incomplete, and rules --preview shows no clean result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-rules-"));
    try {
      const design = join(dir, "design");
      await cp(DEMO, design, { recursive: true });
      const broken = ["schema: youi.rule/v1", "id: youi:demo/rule/test.broken", "title: Broken", "severity: error", "statement: Never matches", "agent: Nothing", "check:", "  engine: ast-grep", "  language: tsx", "  rule:", "    kind: not_a_kind", ""].join("\n");
      await writeFile(join(design, "rules/test.broken.rule.yaml"), broken);
      expect(await main(["check", "--project", FIXTURE, "--design", design, "--json"])).toBe(1);
      const check = JSON.parse(out) as { incomplete: boolean; notRun: Array<{ rule: string; state: string }> };
      expect(check.incomplete).toBe(true);
      expect(check.notRun).toEqual([expect.objectContaining({ rule: "youi:demo/rule/test.broken", state: "unsupported" })]);
      out = "";
      expect(await main(["rules", "--project", FIXTURE, "--design", design, "--preview", join(design, "rules/test.broken.rule.yaml")])).toBe(1);
      expect(out).toContain("this is not a clean result");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
