/**
 * `youiyoux upgrade`: a System release in one step. The sync and each component's migrations are
 * worked out in memory first; nothing is written unless all of them hold, and a step that fails
 * while writing puts every file back. The git repositories are local (file://).
 */
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { main } from "../src/index.ts";
import { workspaceStatus } from "../src/status.ts";
import { admits, compareVersions, pendingMigrations } from "../src/upgrade.ts";
import { readLock } from "../src/sync.ts";
import type { ProjectStatus } from "@youiyoux/core";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd });

let dir: string;
let out = "";
let err = "";
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-upgrade-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  env = { ...process.env };
  process.env.YOUI_SYSTEMS_CACHE = join(dir, `cache-${Math.random().toString(36).slice(2)}`);
  process.env.YOUI_LINKS = join(dir, `links-${Math.random().toString(36).slice(2)}.json`);
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => {
  process.env = env;
  vi.restoreAllMocks();
});

const edit = async (file: string, ...pairs: Array<[string | RegExp, string]>): Promise<void> => {
  let text = await readFile(file, "utf8");
  for (const [from, to] of pairs) text = text.replaceAll(from, to);
  await writeFile(file, text);
};

/**
 * Demo 2.0.0: Button's `danger` variant is now `destructive`, and CardContent is now CardBody,
 * each with the migration that moves a product across. `card` is the Card migration's YAML.
 */
async function release(design: string, card = "renameExport: { from: CardContent, to: CardBody }"): Promise<void> {
  await edit(join(design, "youi.config.json"), ['"version": "1.0.0"', '"version": "2.0.0"']);
  const button = join(design, "components/button");
  await edit(join(button, "button.tsx"), ["danger:", "destructive:"]);
  await edit(join(button, "button.contract.json"), ['"version": "1.0.0"', '"version": "2.0.0"'], ['"danger", "link"', '"destructive", "link"'], ['variant=\\"danger\\"', 'variant=\\"destructive\\"']);
  await edit(join(button, "button.demo.tsx"), ['variant="danger"', 'variant="destructive"']);
  await mkdir(join(button, "migrations"));
  await writeFile(join(button, "migrations/button-2.0.0.yaml"), ["schema: youi.migration/v1", "id: youi:demo/migration/button-2.0.0", "element: youi:demo/component/button", "from: 1.x", "to: 2.0.0", "changes:", "  - mapValues: { prop: variant, map: { danger: destructive } }", ""].join("\n"));
  const cardDir = join(design, "components/card");
  for (const file of ["card.tsx", "card.contract.json", "card.demo.tsx"]) await edit(join(cardDir, file), ["CardContent", "CardBody"], ['"version": "1.0.0"', '"version": "2.0.0"']);
  await mkdir(join(cardDir, "migrations"));
  await writeFile(join(cardDir, "migrations/card-2.0.0.yaml"), ["schema: youi.migration/v1", "id: youi:demo/migration/card-2.0.0", "element: youi:demo/component/card", "from: 1.x", "to: 2.0.0", "changes:", `  - ${card}`, ""].join("\n"));
}

/** The demo app, synced with its own copy of the demo design at 1.0.0. */
async function product(name: string): Promise<{ root: string; design: string }> {
  const root = join(dir, name);
  const design = join(dir, `${name}-design`);
  await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), design, { recursive: true });
  await mkdir(join(root, ".git"));
  const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: design } }));
  expect(await main(["sync", "--project", root])).toBe(0);
  return { root, design };
}

/** Every file under a folder, with its content: to show a step wrote nothing, or put everything back. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = await readFile(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const upgrade = async (...args: string[]): Promise<{ code: number; json: Record<string, unknown> }> => {
  out = "";
  const code = await main(["upgrade", ...args, "--json"]);
  if (!out) throw new Error(`upgrade printed nothing; stderr: ${err}`);
  return { code, json: JSON.parse(out) as Record<string, unknown> };
};

describe("youiyoux upgrade", () => {
  test("a preview shows the sync and each migration, run on the components the sync would bring, and writes nothing; --write does it all, and then there is nothing left to do", async () => {
    const { root, design } = await product("app");
    const { sites } = ((await workspaceStatus(dir, root)).projects[0] as ProjectStatus).components;
    await release(design);
    const status = (await workspaceStatus(dir, root)).projects[0] as ProjectStatus;
    expect(status.next).toBe("youiyoux upgrade: Demo v2.0.0 comes with 2 migrations for this product's code, which upgrade runs with the sync");

    const before = await snapshot(root);
    out = "";
    expect(await main(["upgrade", "--project", root])).toBe(0);
    expect(out).toContain("upgrade Demo v1.0.0 → v2.0.0  preview: nothing written");
    expect(out).toMatch(/updated\s+components\/ui\/button\.tsx {2}1\.0\.0 → 2\.0\.0/);
    expect(out).toMatch(/✓ youi:demo\/migration\/button-2\.0\.0 {2}1 site rewritten in 1 file/);
    expect(out).toMatch(/✓ youi:demo\/migration\/card-2\.0\.0 {2}\d+ sites rewritten in \d+ files/);
    // The diff of what it would write, and the command that writes it.
    expect(out).toMatch(/updated\s+8 generated files {2}src\/design\/tokens\.css, /);
    expect(out).toContain('+          <Button variant="destructive">Delete project</Button>');
    // Both migrations change the settings page: it has one diff, of the two together.
    expect(out.split("+++ b/app/settings/index.tsx").length).toBe(2);
    expect(out).toContain("Next: youiyoux upgrade --write");
    expect(await snapshot(root)).toEqual(before);

    const preview = await upgrade("--project", root);
    expect(preview.json).toMatchObject({ status: "preview", from: { version: "1.0.0" }, to: { version: "2.0.0" }, blocked: [] });
    expect((preview.json.migrations as Array<{ status: string }>).map((m) => m.status)).toEqual(["dry-run", "dry-run"]);

    const written = await upgrade("--project", root, "--write");
    expect(written.code).toBe(0);
    expect(written.json).toMatchObject({ status: "upgraded", next: "youiyoux check" });
    expect((written.json.migrations as Array<{ status: string }>).map((m) => m.status)).toEqual(["applied", "applied"]);
    const settings = await readFile(join(root, "app/settings/index.tsx"), "utf8");
    expect(settings).toContain('<Button variant="destructive">');
    expect(settings).toContain("CardBody");
    expect(settings).not.toContain("CardContent");
    expect(await readFile(join(root, "components/ui/card.tsx"), "utf8")).toContain("export function CardBody");
    expect((await readLock(root))?.systemVersion).toBe("2.0.0");
    // In step with the release: nothing left to sync, and every Card and Button site still resolves.
    const after = (await workspaceStatus(dir, root)).projects[0] as ProjectStatus;
    expect(after.sync.state).toBe("current");
    expect(after.components.sites).toBe(sites);

    const again = await upgrade("--project", root, "--write");
    expect(again.json).toMatchObject({ status: "current", next: "nothing to do" });
    expect((again.json.migrations as unknown[]).length).toBe(0);
  });

  test("a migration that would not hold blocks the whole upgrade, with --write too: not the sync, not the other migration, nothing is written", async () => {
    const { root, design } = await product("bad-migration");
    // The release's file exports CardBody, but the migration moves imports to a name it does not export.
    await release(design, "renameExport: { from: CardContent, to: CardContents }");
    const before = await snapshot(root);
    const result = await upgrade("--project", root, "--write");
    expect(result.code).toBe(1);
    expect(result.json.status).toBe("blocked");
    expect((result.json.blocked as string[])[0]).toMatch(/^youi:demo\/migration\/card-2\.0\.0 would not hold: exports: .*does not export CardContents/);
    expect(await snapshot(root)).toEqual(before);
  });

  test("a sync that would conflict blocks it, and says to settle the conflict first", async () => {
    const { root, design } = await product("conflict");
    await release(design);
    // The product changed the very line the release changes.
    await edit(join(root, "components/ui/button.tsx"), ["danger:", "dangerous:"]);
    const before = await snapshot(root);
    const result = await upgrade("--project", root, "--write");
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ status: "blocked", next: "youiyoux sync: resolve the conflicts it reports, then youiyoux sync --adopt records them, then youiyoux upgrade" });
    expect((result.json.blocked as string[])[0]).toMatch(/^components\/ui\/button\.tsx: 1 conflict/);
    expect(await snapshot(root)).toEqual(before);
  });

  test.skipIf(process.getuid?.() === 0)("a step that fails while writing puts back every file the upgrade wrote, the sync's included", async () => {
    const { root, design } = await product("rollback");
    await release(design);
    const before = await snapshot(root);
    // The sync can write components/ui; the migrations cannot write app/settings.
    await chmod(join(root, "app/settings"), 0o555);
    try {
      const result = await upgrade("--project", root, "--write");
      expect(result.code).toBe(1);
      expect((result.json.blocked as string[])[0]).toMatch(/did not hold on the written files: sources-unchanged: write failed.*; every file the upgrade wrote was put back$/);
    } finally {
      await chmod(join(root, "app/settings"), 0o755);
    }
    expect(await snapshot(root)).toEqual(before);
  });

  test("a product never synced has nothing to upgrade from", async () => {
    const root = join(dir, "never");
    await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
    const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: join(EXAMPLES, "demo-design") } }));
    const result = await upgrade("--project", root);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ status: "blocked", next: "youiyoux sync" });
  });

  test("--to moves a git source to another tag: the release is fetched, and --write records the ref in the config", async () => {
    const source = join(dir, "git-design");
    await cp(join(EXAMPLES, "demo-design"), source, { recursive: true });
    await git(source, "init", "--quiet", "--initial-branch=main");
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "v1");
    await git(source, "tag", "v1");
    await release(source);
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "v2");
    await git(source, "tag", "v2");
    const v2 = (await git(source, "rev-parse", "HEAD")).stdout.trim();

    const root = join(dir, "git-app");
    await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
    const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { git: `file://${source}`, ref: "v1" } }));
    expect(await main(["sync", "--project", root])).toBe(0);
    expect((await readLock(root))?.systemVersion).toBe("1.0.0");

    const preview = await upgrade("--project", root, "--to", "v2");
    expect(preview.json).toMatchObject({ status: "preview", to: { version: "2.0.0", commit: v2, ref: "v2" }, next: "youiyoux upgrade --to v2 --write" });
    expect(JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")).source.ref).toBe("v1");

    const written = await upgrade("--project", root, "--to", "v2", "--write");
    expect(written.json.status).toBe("upgraded");
    expect(JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")).source).toEqual({ git: `file://${source}`, ref: "v2" });
    expect(await readLock(root)).toMatchObject({ systemVersion: "2.0.0", sourceCommit: v2 });
    expect(await readFile(join(root, "app/index.tsx"), "utf8")).toContain("CardBody");
  });

  test("--to names a git ref: for a folder or a package it says how to get the release instead", async () => {
    const { root } = await product("to-path");
    expect(await main(["upgrade", "--project", root, "--to", "v2"])).toBe(1);
    expect(err).toContain("check out v2 there, then run this again without --to");
    expect(await main(["upgrade", "--project", root, "--to", "--bad"])).toBe(2);
  });
});

describe("which migrations an upgrade runs", () => {
  test("versions compare by number, and a pre-release comes before its release", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  });

  test("from: x-ranges, exact, caret, tilde and comparisons; anything else is not read as a yes or a no", () => {
    expect(admits("1.x", "1.4.0")).toBe(true);
    expect(admits("1.x", "2.0.0")).toBe(false);
    expect(admits("1.2.x", "1.3.0")).toBe(false);
    expect(admits("*", "9.0.0")).toBe(true);
    expect(admits("^1.2.0", "1.9.9")).toBe(true);
    expect(admits("^1.2.0", "1.1.0")).toBe(false);
    expect(admits("~1.2.0", "1.3.0")).toBe(false);
    expect(admits(">=1.0.0 <2.0.0", "1.5.0")).toBe(true);
    expect(admits(">=1.0.0 <2.0.0", "2.0.0")).toBe(false);
    expect(admits("1.0.0", "1.0.0")).toBe(true);
    expect(admits("latest", "1.0.0")).toBeNull();
  });

  test("past the locked version and up to the release, oldest first, each from the version the one before leaves; one whose from does not fit is flagged", async () => {
    const { root, design } = await product("selection");
    await release(design);
    const migrations = join(design, "components/button/migrations");
    const spec = (id: string, from: string, to: string): string => ["schema: youi.migration/v1", `id: youi:demo/migration/${id}`, "element: youi:demo/component/button", `from: "${from}"`, `to: ${to}`, "changes:", "  - renameProp: { from: tone, to: intent }", ""].join("\n");
    await writeFile(join(migrations, "button-1.0.0.yaml"), spec("button-1.0.0", "0.x", "1.0.0")); // already past
    await writeFile(join(migrations, "button-3.0.0.yaml"), spec("button-3.0.0", "2.x", "3.0.0")); // beyond this release
    await writeFile(join(migrations, "button-1.5.0.yaml"), spec("button-1.5.0", "1.x", "1.5.0"));
    await writeFile(join(migrations, "button-1.9.0.yaml"), spec("button-1.9.0", "1.6.x", "1.9.0")); // 1.5.0 is left before it
    const project = await loadProject(root);
    const planned = pendingMigrations(project, (await readLock(root))!);
    expect(planned.map((p) => [p.spec.id.split("/").at(-1), p.at, p.mismatch])).toEqual([
      ["button-1.5.0", "1.0.0", false],
      ["button-1.9.0", "1.5.0", true],
      ["button-2.0.0", "1.9.0", false],
      ["card-2.0.0", "1.0.0", false],
    ]);
    const result = await upgrade("--project", root);
    expect(result.json.status).toBe("blocked");
    expect(result.json.blocked).toEqual(["youi:demo/migration/button-1.9.0 migrates from 1.6.x, but youi:demo/component/button would be at 1.5.0 here: no migration takes it from 1.5.0 to 1.6.x"]);
  });
});
