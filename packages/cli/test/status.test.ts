/**
 * `youiyoux status`: where a product stands, and the one next step; one block per product in a
 * workspace. It reads, and writes nothing.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { StatusReport, type ProjectStatus } from "@youiyoux/core";
import { RequestStore } from "@youiyoux/workflow";
import { main } from "../src/index.ts";
import { workspaceStatus } from "../src/status.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");

let dir: string;
let out = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-status-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});
const quiet = (): void => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
};

/** The demo app with its own copy of the demo design repo, so the design can move on. */
async function product(name: string): Promise<{ root: string; design: string }> {
  const root = join(dir, name);
  const design = join(dir, `${name}-design`);
  await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), design, { recursive: true });
  await mkdir(join(root, ".git"));
  const config = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: design } }));
  return { root, design };
}

/** Every file under a folder, with its content: to show status changed nothing. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = await readFile(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const one = async (root: string): Promise<ProjectStatus> => {
  const report = await workspaceStatus(dir, root);
  expect(StatusReport.safeParse(report).success).toBe(true);
  return report.projects[0] as ProjectStatus;
};

describe("youiyoux status on one product", () => {
  test("from never synced, to up to date, to behind its System, to drifting: each says what it is and the one thing to do, and status writes nothing", async () => {
    const { root, design } = await product("app");
    expect(await one(root)).toMatchObject({ id: "demo-app", system: { name: "Demo", version: "1.0.0", source: `path ${design}`, linked: false }, lock: null, sync: { state: "never" }, next: "youiyoux sync: this product has never been synced with its System" });

    quiet();
    expect(await main(["sync", "--project", root])).toBe(0);
    let status = await one(root);
    expect(status.sync).toEqual({ state: "current", changes: [] });
    expect(status.lock?.systemVersion).toBe("1.0.0");
    // The demo app has deliberate violations; nothing is drifting.
    expect(status.check.errors).toBeGreaterThan(0);
    expect(status.drift).toEqual([]);
    expect(status.components).toMatchObject({ system: 3, used: 3 });
    expect(status.next).toBe(`youiyoux check: fix ${status.check.errors === 1 ? "1 error" : `${status.check.errors} errors`}`);

    // The design moves on: a sync would bring one file.
    const button = join(design, "components/button/button.tsx");
    await writeFile(button, `${await readFile(button, "utf8")}\n// v1.1\n`);
    status = await one(root);
    expect(status.sync).toEqual({ state: "behind", changes: [{ file: "components/ui/button.tsx", action: "updated" }] });
    expect(status.next).toBe("youiyoux sync: 1 file would change");

    // A local edit to an owned component is drift, merged on the next sync.
    await writeFile(join(root, "components/ui/card.tsx"), `${await readFile(join(root, "components/ui/card.tsx"), "utf8")}\n// ours\n`);
    status = await one(root);
    expect(status.drift).toEqual([expect.objectContaining({ file: "components/ui/card.tsx", severity: "warn" })]);

    const before = await snapshot(root);
    quiet();
    await main(["status", "--project", root]);
    expect(out).toContain("behind: 1 file would change");
    expect(out).toContain("1 owned file edited locally, merged on sync (card.tsx)");
    expect(out).toContain("Next: youiyoux sync: 1 file would change");
    expect(await snapshot(root)).toEqual(before);
  }, 60_000);

  test("with a baseline, only what is beyond it counts; open requests are the next step once the check passes", async () => {
    const { root } = await product("baselined");
    quiet();
    expect(await main(["sync", "--project", root])).toBe(0);
    expect(await main(["baseline", "--project", root])).toBe(0);
    const store = new RequestStore(root, "demo-app");
    await store.create({ kind: "person", name: "Sam" }, { kind: "change", body: "Use the primary button here", target: { route: "/", scope: "here", name: "Button", element: "youi:demo/component/button", lookalike: false, file: "app/(tabs)/index.tsx", line: 7 } });
    const status = await one(root);
    expect(status.check).toMatchObject({ errors: 0, warnings: 0, incomplete: false });
    expect(status.check.baseline?.known).toBeGreaterThan(0);
    expect(status.requests).toEqual({ open: 1, addressed: 0, unreadable: 0 });
    expect(status.next).toBe("youiyoux requests: answer 1 open request");
  }, 60_000);
});

describe("youiyoux status in a workspace", () => {
  test("youi.workspace.json lists products, across repositories; one that cannot be read says why and what to do, never zeros", async () => {
    // A workspace file is found as a project is, inside a git repository (a shared folder's never counts).
    const ws = join(dir, "ws");
    await mkdir(join(ws, ".git"), { recursive: true });
    const { root } = await product("ws-web");
    await mkdir(join(dir, "ws-bare"), { recursive: true });
    await writeFile(join(ws, "youi.workspace.json"), JSON.stringify({ schema: "youi.workspace/v1", projects: ["../ws-web", "../ws-bare"] }));
    const report = await workspaceStatus(ws);
    expect(StatusReport.safeParse(report).success).toBe(true);
    expect(report.workspace).toBe("youi.workspace.json");
    expect(report.projects).toEqual([expect.objectContaining({ id: "demo-app", root: "../ws-web" }), { root: "../ws-bare", error: expect.stringContaining("youi.project.json"), next: "youiyoux adopt or youiyoux init --design <dir> in ../ws-bare" }]);
    quiet();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(ws);
    expect(await main(["status"])).toBe(1);
    cwd.mockRestore();
    expect(out).toContain("workspace · 2 products from youi.workspace.json");
    expect(out).toContain("../ws-bare ✖");
    expect(root).toBeTruthy();
  }, 60_000);

  test("in a monorepo with no workspace file, its products are found below, never another repository's or node_modules'", async () => {
    const mono = join(dir, "mono");
    await mkdir(join(mono, ".git"), { recursive: true });
    for (const app of ["apps/web", "apps/admin", "node_modules/pkg", "vendor/other"]) await cp(join(EXAMPLES, "demo-app"), join(mono, app), { recursive: true });
    await mkdir(join(mono, "vendor/other/.git"));
    for (const app of ["apps/web", "apps/admin"]) {
      const file = join(mono, app, "youi.project.json");
      const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...config, $schema: undefined, id: app.split("/")[1], source: { path: join(EXAMPLES, "demo-design") } }));
    }
    const report = await workspaceStatus(mono);
    expect(report.workspace).toBeNull();
    expect(report.projects.map((p) => p.root).sort()).toEqual(["apps/admin", "apps/web"]);
    expect(report.projects.map((p) => ("id" in p ? p.id : null)).sort()).toEqual(["admin", "web"]);
  }, 60_000);
});
