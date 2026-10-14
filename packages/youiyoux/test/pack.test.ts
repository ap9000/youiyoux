/**
 * The published package, as a person meets it (c1): `pnpm pack` (which builds the bundle), then
 * `npx --package <tarball> youiyoux` in a fresh temp directory holding a fixture repo with no youiyoux setup. Its
 * dependencies come from a registry on 127.0.0.1 (local-registry.ts); nothing goes to the network.
 * No Chromium is offered, so nothing is drawn or downloaded. Also: the `youi` bin's help, and a
 * bundle that Node 20 can load (no node:sqlite, fs.glob, path.matchesGlob or util.styleText import).
 */
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixtureRepo, singleFiles, type FixtureRepo } from "../../cli/test/report-fixtures.ts";
import { startRegistry, type LocalRegistry } from "./local-registry.ts";

const PACKAGE = join(import.meta.dirname, "..");
const LONG = 300_000;
const NPX = join(dirname(process.execPath), "npx");

let work = "";
let tarball = "";
let registry: LocalRegistry;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "youiyoux-pack-"));
  execFileSync("pnpm", ["pack", "--pack-destination", work], { cwd: PACKAGE, stdio: "ignore" });
  tarball = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })) as { name: string; version: string; dependencies: Record<string, string> };
  registry = await startRegistry(manifest.dependencies, PACKAGE, { manifest, tarball });
  const userconfig = join(work, "npmrc");
  writeFileSync(userconfig, "");
  const browsers = join(work, "no-browsers");
  mkdirSync(browsers);
  env = { ...process.env, npm_config_registry: registry.url, npm_config_cache: join(work, "npm-cache"), npm_config_userconfig: userconfig, npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false", npm_config_yes: "true", PLAYWRIGHT_BROWSERS_PATH: browsers, NO_COLOR: "1" };
  delete env.YOUI_CHROMIUM;
  for (const key of Object.keys(env)) if (key.startsWith("npm_package_") || key === "npm_lifecycle_event" || key === "npm_lifecycle_script") delete env[key];
}, LONG);

afterAll(async () => {
  await registry?.close();
  rmSync(work, { recursive: true, force: true });
});

/** Async: this process serves the registry npx installs from, so it must not block while npx runs. */
const npx = (cwd: string, args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(NPX, ["--yes", ...args], { cwd, env, encoding: "utf8", timeout: LONG, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ status: error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0, stdout, stderr }));
  });

describe("npx youiyoux from the packed tarball", () => {
  let repo: FixtureRepo;
  beforeAll(() => {
    repo = fixtureRepo("npx", singleFiles(), { parent: work });
  });
  afterAll(() => repo.remove());

  test("writes the report, the card and the summary, prints five lines and the paths, and writes nothing else (c1)", async () => {
    const before = repo.snapshot();
    // What `npx youiyoux` does once the package is on npm: install it, run its youiyoux bin.
    const run = await npx(repo.dir, ["--package", tarball, "youiyoux"]);
    expect(run.stderr).not.toMatch(/ERR!|Error:/);
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    // Five summary lines, a blank line, the three paths, a blank line, then what to do next.
    expect(lines).toHaveLength(11);
    expect(lines.slice(0, 5).every((l) => l.trim().length > 0)).toBe(true);
    expect(lines[0]).toMatch(/^acme-shop: 1 project, \d+ files scanned; UI libraries: /);
    expect(lines[5]).toBe("");
    expect(lines.slice(6, 9)).toEqual(["Report   youiyoux-report.html", "Card     youiyoux-card.png", "Summary  youiyoux-summary.md"]);
    expect(lines[10]).toMatch(/^Next: open youiyoux-report\.html .*npx youiyoux agents install; to add rendered looks, run npx youiyoux --render\.$/);

    const html = readFileSync(join(repo.dir, "youiyoux-report.html"), "utf8");
    expect(html).toContain('data-section="top-fixes"');
    const png = readFileSync(join(repo.dir, "youiyoux-card.png"));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(readFileSync(join(repo.dir, "youiyoux-summary.md"), "utf8")).toMatch(/^## youiyoux report: acme-shop/);

    const after = repo.snapshot();
    const added = [...after.keys()].filter((f) => !before.has(f)).sort();
    expect(added).toEqual(["youiyoux-card.png", "youiyoux-report.html", "youiyoux-summary.md"]);
    for (const [file, stamp] of before) expect(after.get(file)).toBe(stamp);
    expect(registry.served.has("@ast-grep/napi")).toBe(true);
  }, LONG);

  test("agents and hooks installed from npx register portable commands that actually run (c6)", async () => {
    const fixture = fixtureRepo("agents", singleFiles(), { parent: work });
    try {
      execFileSync("git", ["init", "-q"], { cwd: fixture.dir });
      const install = await npx(fixture.dir, ["youiyoux", "agents", "install"]);
      expect(install.status, install.stderr).toBe(0);
      const hooks = await npx(fixture.dir, ["youiyoux", "hooks", "install", "--claude", "--git"]);
      expect(hooks.status, hooks.stderr).toBe(0);
      const server = JSON.parse(readFileSync(join(fixture.dir, ".mcp.json"), "utf8")).mcpServers.youiyoux;
      expect(server.command).toBe("npx");
      expect(server.args.slice(0, 3)).toEqual(["-y", "youiyoux", "mcp"]);
      const settings = JSON.parse(readFileSync(join(fixture.dir, ".claude/settings.local.json"), "utf8"));
      const command = settings.hooks.PostToolUse[0].hooks[0].command as string;
      for (const file of [".mcp.json", ".codex/config.toml", ".claude/settings.local.json", ".git/hooks/pre-commit"]) {
        const text = readFileSync(join(fixture.dir, file), "utf8");
        expect(text).not.toMatch(/_npx|npm-cache|dist\/chunks|packages\/cli\/bin/);
      }
      expect(command).toContain("npx -y youiyoux hooks run claude");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(server.command, server.args, { cwd: fixture.dir, env, stdio: "pipe" });
        let output = "";
        const timeout = setTimeout(() => { child.kill(); reject(new Error("MCP initialize timed out")); }, 20_000);
        child.on("error", reject);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes('"id":1')) child.kill();
        });
        child.on("close", () => {
          clearTimeout(timeout);
          try { expect(output).toContain('"serverInfo"'); resolve(); } catch (e) { reject(e); }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pack-test", version: "1" } } }) + "\n");
      });
      const hook = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn("sh", ["-c", command], { cwd: fixture.dir, env, stdio: "pipe" });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("close", (code) => resolve({ code, stderr }));
        child.stdin.end(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "README.md" } }));
      });
      expect(hook.code, hook.stderr).toBe(0);
    } finally { fixture.remove(); }
  }, LONG);

  test("the package's youi bin runs the full CLI", async () => {
    const help = await npx(repo.dir, ["--package", tarball, "youi", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("agents install|remove");
    expect(help.stdout).toContain("report [path]");
    const agents = await npx(repo.dir, ["--package", tarball, "youiyoux", "agents"]);
    expect(agents.stderr).toContain("youiyoux agents install|remove");
  }, LONG);
});

describe("the bundle", () => {
  test("loads on Node 20: node:sqlite only on demand, and no import of an API Node 20 lacks", () => {
    const meta = JSON.parse(readFileSync(join(PACKAGE, "build-meta.json"), "utf8")) as { outputs: Record<string, { imports: Array<{ path: string; kind: string }> }> };
    const imports = Object.values(meta.outputs).flatMap((o) => o.imports);
    expect(imports.filter((i) => i.path === "node:sqlite")).toEqual([]);
    const code = Object.keys(meta.outputs).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(PACKAGE, f), "utf8")).join("\n");
    expect(code).not.toMatch(/import\s*\{[^}]*\bglob\b[^}]*\}\s*from\s*"node:fs\/promises"/);
    expect(code).not.toMatch(/import\s*\{[^}]*\bmatchesGlob\b[^}]*\}\s*from\s*"node:path"/);
    expect(code).not.toMatch(/import\s*\{[^}]*\bstyleText\b[^}]*\}\s*from\s*"node:util"/);
    expect(code).not.toMatch(/from\s*"node:sqlite"/);
  });

  test("runs the report with the Node 22+ APIs it can do without taken away, as on Node 20", () => {
    const repo = fixtureRepo("node20", singleFiles(), { parent: work });
    try {
      // fs.glob, path.matchesGlob, util.styleText and node:sqlite's absence, plus the ES2024 statics Node 20 lacks.
      const strip = 'import m from "node:module"; import fsp from "node:fs/promises"; import p from "node:path"; import u from "node:util"; delete fsp.glob; delete p.matchesGlob; delete u.styleText; delete Map.groupBy; delete Object.groupBy; delete Promise.withResolvers; m.syncBuiltinESMExports();';
      const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(strip)}`, join(PACKAGE, "dist/youiyoux.js"), "--json"], { cwd: repo.dir, env, encoding: "utf8", timeout: LONG });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const report = JSON.parse(run.stdout) as { totals: { nearDuplicates: number; hardcoded: number; offLibrary: number }; projects: Array<{ files: number }> };
      expect(report.projects[0]!.files).toBeGreaterThan(5);
      expect(report.totals).toMatchObject({ nearDuplicates: 1, hardcoded: 3, offLibrary: 1 });
    } finally {
      repo.remove();
    }
  }, LONG);
});
