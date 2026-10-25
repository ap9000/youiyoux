import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { allowHosts, builtHubPlan, generatedPrefix, hubPlan, loadOptions, main, previewsPlan, runHub } from "../src/index.ts";

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
    expect(out).toContain("youiyoux <command>");
    expect(await main(["frobnicate"])).toBe(2);
    expect(err).toContain("unknown command");
    expect(await main(["where"])).toBe(2);
    expect(err).toContain("usage: youiyoux where <component>");
  });

  test("help separates System commands from Library commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toMatch(/System\b.*build only with these[\s\S]*Library\b.*never build with/);
  });

  test("System commands refuse Library ids", async () => {
    expect(await main(["show", "lib:example/component/pill", "--project", FIXTURE])).toBe(1);
    expect(err).toContain("is a Library item, not a System element");
  });

  test("youiyoux library browses an empty Library and needs a reason to draft a request", async () => {
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
      expect(err).toContain("youiyoux init --design <dir|package>");
      expect(await main(["init", "--project", dir, "--design", DEMO])).toBe(0);
      const config = JSON.parse(await readFile(join(dir, "youi.project.json"), "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({ id: "mobile", system: "demo", source: { path: relative(dir, DEMO) }, componentsDir: "components/ui", importFrom: "@/components/ui/{file}", routes: { strategy: "expo-router", appDir: "app" } });
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
      expect(JSON.parse(out)).toMatchObject({ files: ["tokens.css", "theme.css", "tokens.ts", "tokens.native.ts"], tokens: 29 });
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
      expect((JSON.parse(out) as { stale: string[] }).stale).toHaveLength(18);
      expect(await main(["schema", "--write", "--design", dir])).toBe(0);
      out = "";
      expect(await main(["schema", "--check", "--design", dir])).toBe(0);
      expect(out).toContain("matches");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discover previews runs the hub's capture against a hub on this machine: official items by default", () => {
    const tool = "/opt/youi";
    expect(previewsPlan(tool, {})).toEqual({ web: "/opt/youi/apps/web", args: ["/opt/youi/apps/web/scripts/capture-discover-thumbs.ts", "--hub", "http://localhost:5173", "--registry", "@shadcn"] });
    expect(previewsPlan(tool, { port: "5180", registry: "all", role: "dialog", limit: "12", force: true }).args.slice(1)).toEqual(["--hub", "http://localhost:5180", "--role", "dialog", "--limit", "12", "--force"]);
    expect(previewsPlan(tool, { registry: "@coss" }).args).toContain("@coss");
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
    // The rule editor `youiyoux ui --project` starts is what the dev server proxies at /api.
    expect(hubPlan(tool, { project: "/src/acme-app", api: "http://127.0.0.1:50123" }).env).toEqual({ YOUI_HUB_SNAPSHOT: "/opt/youi/apps/web/.hub", YOUI_API: "http://127.0.0.1:50123" });
    // A detect report alone snapshots the demo system plus the report, into .hub.
    expect(hubPlan(tool, { detect: "/tmp/acme/detect.json" }).snapshot).toEqual(["/opt/youi/apps/web/scripts/snapshot.ts", "--out", "/opt/youi/apps/web/.hub", "--detect", "/tmp/acme/detect.json"]);
  });

  test("from the npm package, ui serves the built hub with its own server: the demo as shipped, a named system snapshotted to a temporary directory", () => {
    const tool = "/opt/pkg/dist";
    expect(builtHubPlan(tool, {}, "/tmp/hub-1")).toEqual({
      snapshot: null,
      server: ["/opt/pkg/dist/hub-server.js", "--dist", "/opt/pkg/dist/hub", "--kit", "/opt/pkg/dist/hub/kit", "--snapshot", "/opt/pkg/dist/hub-demo"],
      env: {},
      watch: null,
    });
    const plan = builtHubPlan(tool, { design: "/data/acme-design", project: "/src/acme-app", port: "5180", api: "http://127.0.0.1:50123", watch: true }, "/tmp/hub-1");
    expect(plan.snapshot).toEqual(["/opt/pkg/dist/hub-snapshot.js", "--out", "/tmp/hub-1", "--design", "/data/acme-design", "--project", "/src/acme-app"]);
    // The snapshot's frame is built from its demos; the rule editor is proxied; --watch makes it live.
    expect(plan.server).toEqual(["/opt/pkg/dist/hub-server.js", "--dist", "/opt/pkg/dist/hub", "--kit", "/opt/pkg/dist/hub/kit", "--snapshot", "/tmp/hub-1", "--build-frame", "--port", "5180", "--api", "http://127.0.0.1:50123", "--live"]);
    expect(plan.watch).toEqual([...plan.snapshot!, "--watch"]);
    // The package carries no demo project to watch.
    expect(() => builtHubPlan(tool, { watch: true }, "/tmp/hub-1")).toThrowError(/name it with --design or --project/);
    // --allow-host reaches the hub's own server as the environment its endpoints read.
    expect(builtHubPlan(tool, { allowHosts: ["my-mac.example.ts.net"] }, "/tmp/hub-1").env).toEqual({ YOUI_ALLOW_HOSTS: "my-mac.example.ts.net" });
  });

  test("ui --allow-host takes plain host names only, and passes them to the hub's servers", () => {
    expect(allowHosts(["My-Mac.example.ts.net", "server"])).toEqual(["my-mac.example.ts.net", "server"]);
    for (const bad of ["*", "*.ts.net", "https://my-mac.example.ts.net", "my-mac.example.ts.net:8446", "my-mac/x", "", "a..b", "-a.test"]) expect(() => allowHosts([bad]), bad).toThrowError(/--allow-host takes a host name/);
    expect(hubPlan("/opt/youi", { project: "/src/acme-app", allowHosts: ["a.test", "b.test"] }).env).toEqual({ YOUI_HUB_SNAPSHOT: "/opt/youi/apps/web/.hub", YOUI_ALLOW_HOSTS: "a.test,b.test" });
    expect(hubPlan("/opt/youi", {}).env).toEqual({});
  });

  test("ui runs the built hub when the tool's root has one, and removes the snapshot it made when the hub stops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-built-hub-"));
    try {
      await mkdir(join(dir, "hub"), { recursive: true });
      await writeFile(join(dir, "hub/index.html"), "<!doctype html>");
      // Stand-ins for the bundled scripts: the snapshot names its --out, the server exits at once.
      await writeFile(join(dir, "hub-snapshot.js"), 'import { writeFileSync } from "node:fs"; const out = process.argv[process.argv.indexOf("--out") + 1]; writeFileSync(process.env.YOUI_TEST_OUT, out); writeFileSync(out + "/made", "");');
      await writeFile(join(dir, "hub-server.js"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.YOUI_TEST_OUT, "\\n" + process.argv.slice(2).join(" "));');
      vi.stubEnv("YOUI_TEST_OUT", join(dir, "seen"));
      expect(await runHub(dir, { design: DEMO })).toBe(0);
      const [out, server] = (await readFile(join(dir, "seen"), "utf8")).split("\n");
      expect(server).toContain(`--snapshot ${out} --build-frame`);
      expect(existsSync(out!)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stopped built hub stops its server and still removes its snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-built-hub-"));
    try {
      await mkdir(join(dir, "hub"), { recursive: true });
      await writeFile(join(dir, "hub/index.html"), "<!doctype html>");
      await writeFile(join(dir, "hub-snapshot.js"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.YOUI_TEST_OUT, process.argv[process.argv.indexOf("--out") + 1]);');
      // A server that runs until it is stopped, and says when it is up.
      await writeFile(join(dir, "hub-server.js"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.YOUI_TEST_OUT + ".up", ""); setInterval(() => {}, 1000);');
      vi.stubEnv("YOUI_TEST_OUT", join(dir, "seen"));
      const hub = runHub(dir, { design: DEMO });
      await vi.waitFor(() => expect(existsSync(join(dir, "seen.up"))).toBe(true), { timeout: 10_000 });
      process.emit("SIGINT");
      expect(await hub).toBe(0);
      expect(existsSync(await readFile(join(dir, "seen"), "utf8"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detect on a repo writes youi.detect/v1 and lists declared-but-unused packages apart from the verdicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-detect-"));
    try {
      const repo = join(import.meta.dirname, "../../detect/test/fixtures/repos/shadcn-app");
      expect(await main(["detect", repo, "--out", dir, "--json"])).toBe(0);
      const report = JSON.parse(out) as { schema: string; libraries: Array<{ id: string }>; unused: Array<{ package: string }> };
      expect(report.schema).toBe("youi.detect/v1");
      expect(report.libraries.map((l) => l.id)).toEqual(["shadcn", "radix"]);
      expect(report.unused.map((u) => u.package).sort()).toEqual(["@mui/material", "styled-components"]);
      expect(JSON.parse(await readFile(join(dir, "detect.json"), "utf8"))).toEqual(report);
      out = "";
      expect(await main(["detect", repo, "--out", dir])).toBe(0);
      expect(out).toMatch(/shadcn\/ui\s+high/);
      expect(out).toMatch(/Declared, never imported · not counted\n {2}@mui\/material@\^6\.1\.0 in package\.json\n {2}styled-components@\^6\.1\.13 in package\.json/);
      expect(out).toContain("declared but never imported packages are listed apart");
      expect(out).toContain("youiyoux ui --detect");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detect refuses a repo mixed with URLs, and says when YOUI_CHROMIUM names no Chromium", async () => {
    expect(await main(["detect"])).toBe(2);
    expect(await main(["detect", ".", "https://example.com"])).toBe(2);
    expect(err).toContain("usage: youiyoux detect <repo-path>");
    const dir = await mkdtemp(join(tmpdir(), "youi-detect-"));
    vi.stubEnv("YOUI_CHROMIUM", join(dir, "no-such-chromium"));
    try {
      expect(await main(["detect", "http://127.0.0.1:9/", "--out", dir])).toBe(1);
      expect(err).toContain("no Chromium for website detection");
      expect(err).toContain("(YOUI_CHROMIUM)");
      expect(err).not.toContain("downloading");
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
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

describe("youiyoux migrate: renamed and removed exports", () => {
  const MIGRATION = ["schema: youi.migration/v1", "id: youi:demo/migration/card-2.0.0", "element: youi:demo/component/card", "from: 1.x", "to: 2.0.0", "changes:", "  - renameExport: { from: Card, to: Panel }", "  - removeExport: { name: CardTitle, replacement: CardHeading }", ""].join("\n");
  const CLASH = 'import { Card } from "@/components/ui";\n\nconst Panel = "panel";\nexport const Clash = () => <Card className={Panel} />;\n';
  let dir = "";
  let app = "";
  let migration = "";
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Copies of examples/demo-app and examples/demo-design; the design renames Card and CardTitle; `synced` vendors that into the app. */
  async function setup(synced: boolean): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "youi-migrate-cli-"));
    app = join(dir, "demo-app");
    const design = join(dir, "demo-design");
    await cp(join(DEMO, "../demo-app"), app, { recursive: true });
    await cp(DEMO, design, { recursive: true });
    const card = (await readFile(join(design, "components/card/card.tsx"), "utf8")).replace("export function Card(", "export function Panel(").replace("export function CardTitle(", "export function CardHeading(");
    await writeFile(join(design, "components/card/card.tsx"), card);
    const contractFile = join(design, "components/card/card.contract.json");
    const contract = (await readFile(contractFile, "utf8")).replace('"export": "Card"', '"export": "Panel"').replace('"CardTitle"', '"CardHeading"');
    await writeFile(contractFile, contract);
    if (synced) await writeFile(join(app, "components/ui/card.tsx"), card);
    await writeFile(join(app, "components/clash.tsx"), CLASH);
    migration = join(dir, "card.migration.yaml");
    await writeFile(migration, MIGRATION);
  }

  const files = async (): Promise<string[]> => Promise.all(["app/index.tsx", "app/settings/index.tsx", "components/invite-form.tsx", "components/clash.tsx"].map((f) => readFile(join(app, f), "utf8")));
  const treeHash = async (): Promise<string> => {
    const paths = (await readdir(app, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
    const hash = createHash("sha256");
    for (const path of paths) hash.update(relative(app, path)).update("\0").update(await readFile(path)).update("\0");
    return hash.digest("hex");
  };

  test("without --write it previews: the diff, the residual sites with file:line and why, and nothing written", async () => {
    await setup(true);
    await writeFile(join(app, "components/cards.ts"), 'export { Card } from "./ui/card";\n');
    await writeFile(join(app, "components/dynamic.ts"), 'import * as ui from "./ui";\nconst { Card } = ui;\n');
    const before = await files();
    const hash = await treeHash();
    expect(await main(["migrate", migration, "--project", app])).toBe(0);
    expect(out).toContain("dry run: nothing written");
    expect(out).toContain("✓ exports");
    expect(out).toContain("✓ imports-resolve");
    expect(out).toContain("Barrel public names kept:\n  components/cards.ts:1  Card");
    expect(out).toContain("components/dynamic.ts:2  not rewritten: namespace ui is used dynamically");
    expect(out).toContain("--- a/app/index.tsx");
    expect(out).toContain('+import { Button, Panel, CardContent, CardHeader, CardHeading } from "@/components/ui";');
    expect(out).toContain("+          <CardHeading>Project</CardHeading>");
    expect(out).toContain("components/clash.tsx:1  not rewritten: Panel is already used at line 3");
    expect(out).toContain("run again with --write to apply");
    expect(await files()).toEqual(before);
    expect(await treeHash()).toBe(hash);
  });

  test("--write applies it, keeps the ambiguous file as it was, and a second run changes nothing", async () => {
    await setup(true);
    expect(await main(["migrate", migration, "--project", app, "--write"])).toBe(0);
    expect(out).toContain("applied");
    expect(out).not.toContain("--- a/app/index.tsx");
    const [home, , invite, clash] = await files();
    expect(home).toContain("<Panel key={project.name}>");
    expect(home).toContain("<CardHeading>{project.name}</CardHeading>");
    expect(invite).toContain('import { Button, Panel, CardContent, CardHeader, CardHeading, Input } from "@/components/ui";');
    expect(clash).toBe(CLASH);
    out = "";
    expect(await main(["migrate", migration, "--project", app, "--write"])).toBe(0);
    expect(out).toContain("nothing to change");
    expect(out).toContain("components/clash.tsx:1  not rewritten");
    expect(await files()).toEqual([home, expect.any(String), invite, CLASH]);
  });


  test("qualified external members survive preview and --write beside a renamed local", async () => {
    await setup(true);
    const source = 'import type * as R from "react";\ntype X = R.Card;\ntype Y = MyGlobal.Card;\ntype Z = R.Panel;\n';
    const local = 'import { Card } from "./ui/card";\nexport const card = Card;\n';
    await writeFile(join(app, "components/qualified.ts"), source);
    await writeFile(join(app, "components/qualified-mixed.ts"), local + source);
    const before = await treeHash();
    expect(await main(["migrate", migration, "--project", app])).toBe(0);
    expect(out).toContain("dry run: nothing written");
    expect(await treeHash()).toBe(before);
    expect(await main(["migrate", migration, "--project", app, "--write"])).toBe(0);
    expect(await readFile(join(app, "components/qualified.ts"), "utf8")).toBe(source);
    expect(await readFile(join(app, "components/qualified-mixed.ts"), "utf8")).toBe(local.replaceAll("Card", "Panel") + source);
  });

  test("before youiyoux sync the exports gate rejects it and nothing is written", async () => {
    await setup(false);
    const before = await files();
    expect(await main(["migrate", migration, "--project", app, "--write"])).toBe(1);
    expect(out).toContain("rejected: nothing written");
    expect(out).toContain("✖ exports       components/ui/card.tsx does not export Panel, CardHeading yet: run youiyoux sync, then migrate");
    expect(await files()).toEqual(before);
  });

  test("--write refuses unresolved imports through an owned barrel, including type-only imports", async () => {
    await setup(true);
    // This owned barrel has not been updated by sync; migrate must neither edit it nor trust it.
    await writeFile(join(app, "components/ui/index.ts"), 'export * from "./button";\nexport { Card, CardContent, CardHeader, CardTitle } from "./card";\nexport * from "./input";\n');
    await writeFile(join(app, "components/typed.ts"), 'import type { Card } from "./ui";\nexport type T = typeof Card;\n');
    const hash = await treeHash();
    expect(await main(["migrate", migration, "--project", app, "--write"])).toBe(1);
    expect(out).toContain("rejected: nothing written");
    expect(out).toContain("✖ imports-resolve");
    expect(await treeHash()).toBe(hash);
  });
});
