/**
 * Change requests from a failed behaviour result (slice 4): the service builds the request's
 * target, behaviour link and acceptance from the stored result, and refuses a body carrying any of
 * them; addressed needs a stored, fresh pass for the same check and popup from a newer run, for
 * HTTP, MCP and the store alike. A person may still close one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BehaviourRouteRun } from "@youiyoux/core";
import { createServer as createMcp } from "@youiyoux/mcp";
import { loadProject } from "@youiyoux/scanner";
import { behaviourEvidence, behaviourFile, RequestStore, runBehaviour, WorkflowError } from "../src/index.ts";
import { behaviourSandbox, control, escape, NAME, RULE_ID, setup, tick, TOOL, UNSAFE } from "./behaviour-sandbox.ts";

const s = behaviourSandbox();
let mcp: Client;
beforeAll(async () => {
  const server = createMcp({ projectRoot: s.box.project, designRoot: s.box.design, behaviourTool: TOOL, render: { download: false } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(b), mcp.connect(a)]);
});
afterAll(async () => {
  await mcp?.close();
});
async function tool(name: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const result = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { data: (text.startsWith("{") ? JSON.parse(text) : { refused: text }) as Record<string, unknown>, isError: Boolean(result.isError) };
}

const userMenu = (results: ReadonlyArray<{ target: { component: string | null } }>) => results.findIndex((r) => r.target.component === "UserMenu");
/** A run that fails, through the hub: the reference a request is filed from. */
async function failing(): Promise<{ runId: string; index: number }> {
  control.verdict = "failed";
  await s.runFromHub();
  const view = (await s.call("GET", "/api/behaviour?route=/x")).json as { run: { runId: string }; results: Array<{ target: { component: string } }> };
  return { runId: view.run.runId, index: userMenu(view.results) };
}

describe("filing", () => {
  test("the service builds the request from the stored result: its target, its behaviour link and its acceptance; a body carrying any of them is refused", async () => {
    const { runId, index } = await failing();
    const filed = await s.write("/api/requests", { kind: "change", behaviour: { route: "/x", runId, index } });
    expect(filed.status, JSON.stringify(filed.json)).toBe(201);
    expect(filed.json).toMatchObject({
      kind: "change",
      status: "open",
      target: { route: "/x", scope: "here", name: "UserMenu" },
      behaviour: { rule: RULE_ID, check: "dismiss-escape", target: { route: "/x", pattern: "menu-button", component: "UserMenu", accessibleName: NAME }, runId },
      task: { touchesKnown: false, acceptance: [{ statement: `dismiss-escape passes for the menu '${NAME}' (UserMenu) on /x in a run newer than this request`, evidence: ["check"] }] },
    });
    expect(UNSAFE.test(JSON.stringify(filed.json.task).replace(/\\n/g, " "))).toBe(false);
    const ref = { route: "/x", runId, index };
    // What only the service may set is refused, never used.
    for (const body of [
      { kind: "change", body: "x", target: { route: "/x", scope: "here", name: "UserMenu" }, task: { acceptance: [{ statement: "anything", evidence: ["manual-review"] }] } },
      { kind: "change", body: "x", target: { route: "/x", scope: "here", name: "UserMenu" }, behaviour: { rule: RULE_ID, check: "dismiss-escape", target: { route: "/x", pattern: "menu-button", component: "UserMenu", accessibleName: "More" }, runId, failedAt: new Date().toISOString() } },
      { kind: "change", behaviour: ref, acceptance: [{ statement: "anything", evidence: ["manual-review"] }] },
      { kind: "change", behaviour: ref, target: { route: "/x", scope: "here", name: "Other" } },
      { kind: "change", behaviour: { ...ref, rule: RULE_ID } },
      { kind: "comment", behaviour: ref },
    ]) expect((await s.write("/api/requests", body)).status, JSON.stringify(body)).toBe(400);
  });

  test("refused unless the result exists, is failed and fresh, and is still the route's run", async () => {
    const { runId, index } = await failing();
    expect((await s.write("/api/requests", { kind: "change", behaviour: { route: "/x", runId, index: 99 } })).status).toBe(404);
    expect((await s.write("/api/requests", { kind: "change", behaviour: { route: "/x", runId: "0000000000000000", index } })).json.error).toMatch(/^that result is gone/);
    const app = join(s.box.project, "app/broken.tsx");
    const was = readFileSync(app, "utf8");
    writeFileSync(app, `${was}\n// changed\n`);
    try {
      const stale = await s.write("/api/requests", { kind: "change", behaviour: { route: "/x", runId, index } });
      expect(stale.status).toBe(409);
      expect(stale.json.error).toMatch(/^that result is stale \(the code changed since its run\)/);
    } finally {
      writeFileSync(app, was);
    }
    control.verdict = "passed";
    await s.runFromHub();
    const view = (await s.call("GET", "/api/behaviour?route=/x")).json as { run: { runId: string }; results: Array<{ target: { component: string } }> };
    const passed = await s.write("/api/requests", { kind: "change", behaviour: { route: "/x", runId: view.run.runId, index: userMenu(view.results) } });
    expect(passed.status).toBe(409);
    expect(passed.json.error).toMatch(/^that result is passed, not failed/);
  });
});

describe("addressed", () => {
  test("needs a stored, fresh pass for the same check and popup from a newer run: refused over HTTP, MCP and a store without results, then allowed; a person may still close one", async () => {
    const { runId, index } = await failing();
    const file = async () => ((await s.write("/api/requests", { kind: "change", behaviour: { route: "/x", runId, index } })).json as { id: string }).id;
    const viaHttp = await file();
    const viaMcp = await file();
    const closing = await file();
    const http = await s.write(`/api/requests/${viaHttp}/status`, { status: "addressed", body: "fixed" });
    expect(http.status).toBe(409);
    expect(http.json.error).toMatch(new RegExp(`^${escape(`${viaHttp} is held to dismiss-escape on the menu '${NAME}' (UserMenu) (/x): run \`youiyoux behave --route /x\` first; this request has no newer run`)}$`));
    // A store that can't read behaviour results (an old caller) refuses rather than lets it through.
    const refused = await new RequestStore(s.box.project, "expo-fixture").setStatus({ kind: "agent", name: "a" }, viaHttp, "addressed", "fixed").then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(WorkflowError);
    expect((refused as WorkflowError).code).toBe("conflict");
    // A newer run that still fails.
    await tick();
    control.verdict = "failed";
    await s.runFromHub();
    expect((await s.write(`/api/requests/${viaHttp}/status`, { status: "addressed", body: "fixed" })).json.error).toMatch(/: run `youiyoux behave --route \/x` first; the last run still fails$/);
    const agent = await tool("request_addressed", { id: viaMcp, message: "fixed in components/user-menu.tsx:12" });
    expect(agent.isError).toBe(true);
    expect(String(agent.data.error)).toMatch(/the last run still fails$/);
    // A person closing it is their call, pass or not.
    expect((await s.write(`/api/requests/${closing}/status`, { status: "closed", body: "won't fix" })).status).toBe(200);
    // The check passes in a newer run: now it may be marked addressed, by anyone.
    control.verdict = "passed";
    await s.runFromHub();
    expect((await s.write(`/api/requests/${viaHttp}/status`, { status: "addressed", body: "fixed" })).status).toBe(200);
    const ok = await tool("request_addressed", { id: viaMcp, message: "fixed in components/user-menu.tsx:12" });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
  });

  test("a run that started before the request was reopened doesn't address it, though it finished after", async () => {
    const project = await loadProject(s.box.project, { designRoot: s.box.design });
    const { runId, index } = await failing();
    const store = new RequestStore(s.box.project, "expo-fixture", { behaviour: behaviourEvidence(project, TOOL) });
    const person = { kind: "person", name: "p" } as const;
    const request = await store.createFromBehaviour(person, { route: "/x", runId, index });
    await store.setStatus(person, request.id, "closed", "fine for now");
    let release!: () => void;
    control.gate = new Promise((done) => (release = done));
    control.probes = 0;
    control.verdict = "passed";
    try {
      await tick();
      const run = runBehaviour(project, setup, { route: "/x", by: "agent" }).done;
      for (let i = 0; i < 100 && control.probes === 0; i++) await tick();
      // The run has started; now the person reopens it.
      await tick();
      await store.setStatus(person, request.id, "open", "still broken");
      await tick();
      release();
      const { run: finished } = await run;
      expect(finished.results.some((r) => r.state === "passed")).toBe(true);
      expect(Date.parse(finished.at)).toBeGreaterThan(Date.parse((await store.get(request.id)).updatedAt));
    } finally {
      release();
      control.gate = null;
    }
    await expect(store.setStatus({ kind: "agent", name: "a" }, request.id, "addressed", "done")).rejects.toThrow(/this request has no newer run$/);
  });

  test("the store holds every caller to it, with results read as this youiyoux makes them", async () => {
    const project = await loadProject(s.box.project, { designRoot: s.box.design });
    const { runId, index } = await failing();
    const store = new RequestStore(s.box.project, "expo-fixture", { behaviour: behaviourEvidence(project, TOOL) });
    const request = await store.createFromBehaviour({ kind: "person", name: "p" }, { route: "/x", runId, index });
    const agent = { kind: "agent", name: "a" } as const;
    await expect(store.setStatus(agent, request.id, "addressed", "done")).rejects.toThrow(/this request has no newer run$/);
    await tick();
    control.verdict = "passed";
    await runBehaviour(project, setup, { route: "/x", by: "agent" }).done;
    expect((await store.setStatus(agent, request.id, "addressed", "done")).status).toBe("addressed");
    // Reopened by a person: a pass from before the reopening no longer counts.
    await store.setStatus({ kind: "person", name: "p" }, request.id, "open", "still broken on Safari");
    await expect(store.setStatus(agent, request.id, "addressed", "done")).rejects.toThrow(/this request has no newer run$/);
    // Results made by another youiyoux are stale here: not a pass.
    control.verdict = "failed";
    await runBehaviour(project, setup, { route: "/x", by: "agent" }).done;
    const run = JSON.parse(readFileSync(join(s.box.project, behaviourFile("/x")), "utf8")) as BehaviourRouteRun;
    const again = await store.createFromBehaviour({ kind: "person", name: "p" }, { route: "/x", runId: run.runId, index: userMenu(run.results) });
    await tick();
    control.verdict = "passed";
    await runBehaviour(project, setup, { route: "/x", by: "agent" }).done;
    const other = new RequestStore(s.box.project, "expo-fixture", { behaviour: behaviourEvidence(project, "youiyoux other") });
    await expect(other.setStatus(agent, again.id, "addressed", "done")).rejects.toThrow(/the last run is stale \(youiyoux changed since it ran\)$/);
    expect((await store.setStatus(agent, again.id, "addressed", "done")).status).toBe("addressed");
  });
});
