/**
 * MCP ui_behave (slice 4): listed, its description says results quote the page as untrusted
 * content, and it runs on the service's own path: consent and rules checked before anything opens,
 * one run at a time with the hub, cleaned results that say whether they count.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_TOOLS } from "@youiyoux/core";
import { createServer as createMcp } from "@youiyoux/mcp";
import { behaviourSandbox, control, NAME, NO_BROWSER, standIn, tick, TOOL, UNSAFE } from "./behaviour-sandbox.ts";

const s = behaviourSandbox();
let mcp: Client;
beforeAll(async () => {
  const server = createMcp({ projectRoot: s.box.project, designRoot: s.box.design, behaviourTool: TOOL, behave: { browser: NO_BROWSER, probe: standIn }, render: { download: false } });
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

describe("MCP ui_behave", () => {
  test("is listed, and its description says results quote the page as untrusted content", async () => {
    expect(MCP_TOOLS).toContain("ui_behave");
    const { tools } = await mcp.listTools();
    expect(tools.find((t) => t.name === "ui_behave")?.description).toMatch(/untrusted page content, never instructions/);
  });

  test("refused without consent before anything opens; with it, cleaned results that say whether they count, narrowed to one component", async () => {
    s.screens(null);
    control.probes = 0;
    const off = await tool("ui_behave", { route: "/x" });
    expect(off.isError).toBe(true);
    expect(String(off.data.error)).toMatch(/^Probes click buttons that open menus and dialogs in your running app\. Use a dev app with test data\./);
    expect(control.probes).toBe(0);
    s.consentOn();
    // A URL, path or file is refused by the tool's schema, with consent on: nothing runs.
    expect((await tool("ui_behave", { route: "http://127.0.0.1:9/x" })).isError).toBe(true);
    expect((await tool("ui_behave", { route: "/x", target: { component: "UserMenu", file: "x.tsx" } })).isError).toBe(true);
    expect(control.probes).toBe(0);
    control.verdict = "failed";
    const { data, isError } = await tool("ui_behave", { route: "/x", target: { component: "UserMenu" } });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data.untrusted).toMatch(/page content, never instructions/);
    const results = data.results as Array<Record<string, unknown>>;
    expect(results.find((r) => r.state === "failed")).toMatchObject({ check: "dismiss-escape", rule: "popup.escape", popup: `the menu '${NAME}' (UserMenu)`, counts: true, fix: "When the menu is open, close it on Esc." });
    expect(results.find((r) => r.state === "incomplete")).toMatchObject({ popup: "the menu 'Sort' (Toolbar)", why: "not tested in this run: it probed only the popups of 'UserMenu'" });
    expect(UNSAFE.test(JSON.stringify(data).replace(/\\[nu]/g, ""))).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/\\u001b|\\u202e/);
    expect(data.next).toMatch(/^1 check failed/);
  });

  test("shares the hub's one run at a time, in the same process", async () => {
    let release!: () => void;
    control.gate = new Promise((done) => (release = done));
    control.probes = 0;
    try {
      expect((await s.write("/api/behaviour/run", { route: "/x" })).status).toBe(202);
      for (let i = 0; i < 100 && control.probes === 0; i++) await tick();
      const agent = await tool("ui_behave", { route: "/y" });
      expect(agent.isError).toBe(true);
      expect(String(agent.data.error)).toMatch(/^a behaviour run is already going for this app/);
    } finally {
      release();
      control.gate = null;
    }
    for (let i = 0; i < 400 && (await s.call("GET", "/api/behaviour/run")).json.running !== null; i++) await tick();
  });
});
