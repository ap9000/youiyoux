import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hubPlan, main, runHub } from "../src/index.ts";

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

  test("where --json answers from a fresh scan", async () => {
    expect(await main(["where", "button", "--project", FIXTURE, "--json"])).toBe(0);
    const where = JSON.parse(out) as { total: number; byRoute: Array<{ route: string }>; coverage: { status: string } };
    expect(where.total).toBe(7);
    expect(where.byRoute.map((r) => r.route)).toEqual(expect.arrayContaining(["/", "/settings", "/checkout"]));
    expect(where.coverage.status).toBe("partial");
  });

  test("check exits 1 when there are errors, and show prints the contract", async () => {
    expect(await main(["check", "--project", FIXTURE, "--json"])).toBe(1);
    expect((JSON.parse(out) as { errors: number }).errors).toBeGreaterThan(0);
    out = "";
    expect(await main(["show", "input", "--project", FIXTURE, "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ name: "Input", import: "import { Input } from \"@/components/ui\";" });
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
      expect((JSON.parse(out) as { stale: string[] }).stale).toHaveLength(7);
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
    expect(hubPlan(tool, {})).toEqual({ web: "/opt/youi/apps/web", snapshot: null, env: {}, vite: ["/opt/youi/apps/web/node_modules/vite/bin/vite.js"] });
    const plan = hubPlan(tool, { design: "/data/acme-design", project: "/src/acme-app", port: "5180" });
    expect(plan.snapshot).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--design", "/data/acme-design", "--project", "/src/acme-app"]);
    expect(plan.env).toEqual({ YOUI_HUB_SNAPSHOT: "/opt/youi/apps/web/.hub" });
    expect(plan.vite.slice(1)).toEqual(["--port", "5180", "--strictPort"]);
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
    expect(rules.find((r) => r.id.endsWith("components.one-signal-verb"))?.state).toBe("advisory");
    expect(rules.filter((r) => r.state === "enforced")).toHaveLength(5);
    expect(capabilities.builtIn).toHaveLength(5);
    out = "";
    expect(await main(["plan", "--token", "color.ink", "--project", FIXTURE])).toBe(0);
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
