/** The workspace hub's service: every product's status, and opening one of the listed products, with this run's key only. */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { StatusReport } from "@youiyoux/core";
import { builtHubPlan } from "../src/hub.ts";
import { startWorkspaceHub, type WorkspaceHub } from "../src/workspace-hub.ts";

const product = (id: string, root: string) => ({
  id,
  root,
  system: { id: "demo", name: "Demo", version: "1.0.0", source: "path ../design", linked: false, commit: null },
  lock: null,
  sync: { state: "never" as const, changes: [] },
  drift: [],
  check: { errors: 0, warnings: 0, baseline: null, incomplete: false },
  components: { system: 3, used: 3, sites: 25 },
  requests: { open: 0, addressed: 0, unreadable: 0 },
  next: "youiyoux sync",
});
const report: StatusReport = { schema: "youi.status/v1", generatedAt: "2026-10-23T12:00:00.000Z", workspace: "youi.workspace.json", projects: [product("web", "apps/web"), { root: "../bare", error: "no youi.project.json", next: "youiyoux adopt" }, product("admin", "apps/admin")] };
const ROOTS = ["/ws/apps/web", "/ws/bare", "/ws/apps/admin"];

let hub: WorkspaceHub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

const post = (path: string, body: unknown, key?: string): Promise<Response> => fetch(`${hub!.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-youi-session": key } : {}) }, body: JSON.stringify(body) });

describe("the workspace hub's service", () => {
  test("it lists every product's status and which one is shown; it opens only a listed, readable product, by its place in the list, and only with this run's key", async () => {
    const open = vi.fn(async () => 0);
    const status = vi.fn(async () => report);
    hub = await startWorkspaceHub({ roots: ROOTS, current: 0, status, open });
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${hub.url}/api/workspace`)).json()).toEqual({ report, current: 0 });

    expect((await post("/api/workspace/open", { index: 2 })).status).toBe(401);
    expect((await post("/api/workspace/open", { index: 2 }, "not-the-key")).status).toBe(401);
    const missing = await post("/api/workspace/open", { index: "/etc" }, hub.key);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('no product "/etc" in this workspace');
    const unreadable = await post("/api/workspace/open", { index: 1 }, hub.key);
    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toEqual({ error: "../bare cannot be opened: no youi.project.json", problems: ["youiyoux adopt"] });
    expect(open).not.toHaveBeenCalled();

    const opened = await post("/api/workspace/open", { index: 2 }, hub.key);
    expect(opened.status).toBe(200);
    expect(open).toHaveBeenCalledWith("/ws/apps/admin");
    expect(((await opened.json()) as { current: number }).current).toBe(2);

    expect((await post("/api/workspace/refresh", {}, hub.key)).status).toBe(200);
    expect(status).toHaveBeenCalledTimes(2);
    const elsewhere = await fetch(`${hub.url}/api/drafts`);
    expect(elsewhere.status).toBe(404);
    expect(((await elsewhere.json()) as { error: string }).error).toContain("Rules and Changes are read-only here");
  });

  test("a snapshot that fails keeps the product that was shown, and says so", async () => {
    hub = await startWorkspaceHub({ roots: ROOTS, current: 0, status: async () => report, open: async () => 1 });
    const failed = await post("/api/workspace/open", { index: 2 }, hub.key);
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toBe("the snapshot of apps/admin failed (exit 1); the hub still shows the product it showed");
    expect(((await (await fetch(`${hub.url}/api/workspace`)).json()) as { current: number }).current).toBe(0);
  });

  test("the packaged hub stays live in a workspace, so an opened product reaches the open page", () => {
    const plan = builtHubPlan("/tool", { project: "/ws/apps/web", api: "http://127.0.0.1:1", workspace: () => undefined }, "/tmp/hub");
    expect(plan.server).toContain("--live");
    expect(builtHubPlan("/tool", { project: "/ws/apps/web" }, "/tmp/hub").server).not.toContain("--live");
  });
});
