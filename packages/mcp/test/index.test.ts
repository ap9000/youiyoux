/** index_where_used, index_swap_impact and index_rule_covers: read-only answers of about ten lines from the store's graph. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeSharedStores } from "@youiyoux/discover";
import { inventoryRun, nodeId, openSqlite, projectGraph, type Store } from "@youiyoux/store";
import { inventory, PROJECT } from "../../store/test/fixtures.ts";
import { createServer } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
const INDEX_TOOLS = ["index_where_used", "index_swap_impact", "index_rule_covers"];
let dir: string;
let path: string;
const clients: Client[] = [];

async function connect(index: string, projectRoot = FIXTURE): Promise<Client> {
  const server = createServer({ projectRoot, index });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; lines: string[]; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { text, lines: text.split("\n"), isError: Boolean(result.isError) };
}

async function tables(store: Store): Promise<Record<string, number>> {
  return { ...(await store.stats()).tables };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-mcp-index-"));
  path = join(dir, "index.db");
  const store = await openSqlite(path);
  const source = join(dir, "inventory.json");
  const report = inventory("2026-10-12T09:00:00.000Z", 9);
  // Match the MCP server root, while retaining a second project with repeating ids.
  const renamed = JSON.parse(JSON.stringify(report).replaceAll("console", "expo-fixture"));
  await store.recordInventory(inventoryRun(renamed, source));
  const other = inventory("2026-10-13T09:00:00.000Z");
  await store.recordInventory(inventoryRun(other, `${source}.other`));
  await store.replaceGraph("project:console", projectGraph({ ...PROJECT, project: "expo-fixture" }));
  const buttons = (await store.nodesOfKind("family")).filter((f) => f.ref.startsWith("button-"));
  const candidates = ["lib:shadcn/component/button", "lib:coss/component/button"];
  await store.replaceGraph("discover", {
    nodes: candidates.map((id) => ({ id: nodeId.candidate(id), kind: "candidate" as const, ref: id })),
    edges: candidates.flatMap((id) => buttons.map((f) => ({ from: nodeId.candidate(id), to: f.id, kind: "could-replace" as const }))),
  });
  await store.close();
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await closeSharedStores();
  await rm(dir, { recursive: true, force: true });
});

describe("index MCP tools", () => {
  test("are listed, read-only, idempotent and closed-world", async () => {
    const { tools } = await (await connect(path)).listTools();
    for (const name of INDEX_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
  });

  test("index_where_used: a family's looks, files, routes and near-duplicates, in about ten lines", async () => {
    const { lines, isError, text } = await call(await connect(path), "index_where_used", { family: "button-1" });
    expect(isError).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toBe("button-1 (button): 11 looks in 11 files on 11 routes");
    expect(text).toMatch(/^files: expo-fixture:src\/app\/extra-0\.tsx, .*\(\+5 more\)$/m);
    expect(text).toMatch(/^near-duplicates: none$/m);
    expect(text).toMatch(/scanned 2026-10-12T09:00:00.000Z/);
  });

  test("index_swap_impact: the family and its near-duplicates, what they touch, and the other candidates", async () => {
    const { lines, isError, text } = await call(await connect(path), "index_swap_impact", { candidate: "lib:shadcn/component/button", family: "button-1" });
    expect(isError).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toMatch(/^Swapping lib:shadcn\/component\/button in for button-1: listed as a could-replace candidate/);
    expect(text).toContain("families: button-1 (11 looks)");
    expect(text).toContain("11 looks to change in 11 files on 11 routes");
    expect(text).toMatch(/^other candidates: lib:coss\/component\/button$/m);
    expect(text).toMatch(/never install/i);
    const unlisted = await call(await connect(path), "index_swap_impact", { candidate: "lib:shadcn/component/button", family: "dialog-1" });
    expect(unlisted.lines[0]).toMatch(/not a listed candidate/);
  });

  test("index_rule_covers: the components a rule governs and where they are used, with the rule's own title from the design repo", async () => {
    const { lines, isError, text } = await call(await connect(path), "index_rule_covers", { rule: "components.no-native-controls" });
    expect(isError).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toBe("youi:demo/rule/components.no-native-controls (Use the owned controls, not native elements, warn) governs Button, Input");
    expect(text).toContain("checks files matching **/*.tsx");
    expect(text).toContain("used in 3 files on 3 routes");
    expect(text).toMatch(/^routes: expo-fixture:\/, expo-fixture:\/login, expo-fixture:\/settings$/m);
  });

  test("an unknown family or rule is an error that says what is known; the store is unchanged by every call", async () => {
    const store = await openSqlite(path);
    const before = await tables(store);
    const client = await connect(path);
    const family = await call(client, "index_where_used", { family: "button-99" });
    expect(family.isError).toBe(true);
    expect(family.text).toMatch(/no family "button-99".*known: button-1, button-2, dialog-1/);
    expect((await call(client, "index_rule_covers", { rule: "nope" })).text).toMatch(/youiyoux scan/);
    for (const name of INDEX_TOOLS) await call(client, name, { family: "button-1", candidate: "lib:coss/component/button", rule: "color.no-raw-color" });
    expect(await tables(store)).toEqual(before);
    await store.close();
  });

  test("an explicit project overrides the server root without leaking another project's looks", async () => {
    const client = await connect(path);
    const own = await call(client, "index_where_used", { family: "button-1" });
    const other = await call(client, "index_where_used", { family: "button-1", project: "console" });
    expect(own.text).toContain("11 looks");
    expect(other.text).toContain("2 looks");
    expect(other.text).toContain("console:src/app/page.tsx");
    expect(other.text).not.toContain("expo-fixture:");
    const ambiguous = await call(client, "index_where_used", { family: "button-2", project: "site" });
    expect(ambiguous.text).toContain("Choose a project or full node id");
    expect(ambiguous.lines.length).toBeLessThanOrEqual(10);
  });

  test("button-2 in two projects defaults to the server root and honours an explicit project", async () => {
    const separate = join(dir, "two-projects.db");
    const writer = await openSqlite(separate);
    const report = inventory("2026-10-12T09:00:00.000Z");
    report.looks[0]!.family = "button-2";
    report.families.find((f) => f.id === "button-2")!.projects.push("console");
    await writer.recordInventory(inventoryRun(JSON.parse(JSON.stringify(report).replaceAll("console", "expo-fixture")), "two-projects"));
    await writer.close();
    const client = await connect(separate);
    const own = await call(client, "index_where_used", { family: "button-2" });
    expect(own.isError).toBe(false);
    expect(own.text).toContain("1 look in 1 file on 1 route");
    expect(own.text).toContain("expo-fixture:src/app/page.tsx");
    expect(own.text).not.toContain("site:");
    const other = await call(client, "index_swap_impact", { candidate: "lib:shadcn/component/button", family: "button-2", project: "site" });
    expect(other.isError).toBe(false);
    expect(other.text).toContain("site:src/pages/index.astro");
    expect(other.text).not.toContain("expo-fixture:");
  });

  test("a root with no youi.project.json answers for the scanned project at that root, and offers choices elsewhere", async () => {
    const consoleRoot = join(dir, "plain", "console");
    const siteRoot = join(dir, "plain", "site");
    const elsewhere = join(dir, "plain", "elsewhere");
    for (const root of [consoleRoot, siteRoot, elsewhere]) await mkdir(root, { recursive: true });
    const separate = join(dir, "plain-roots.db");
    const writer = await openSqlite(separate);
    const report = inventory("2026-10-12T09:00:00.000Z");
    report.looks[0]!.family = "button-2";
    report.families.find((f) => f.id === "button-2")!.projects.push("console");
    report.projects.find((p) => p.id === "console")!.root = consoleRoot;
    report.projects.find((p) => p.id === "site")!.root = siteRoot;
    await writer.recordInventory(inventoryRun(report, "plain-roots"));
    await writer.close();
    const fromConsole = await call(await connect(separate, consoleRoot), "index_where_used", { family: "button-2" });
    expect(fromConsole.isError).toBe(false);
    expect(fromConsole.text).toContain("console:");
    expect(fromConsole.text).not.toContain("site:");
    const fromSite = await call(await connect(separate, join(siteRoot)), "index_where_used", { family: "button-2" });
    expect(fromSite.isError).toBe(false);
    expect(fromSite.text).toContain("site:");
    expect(fromSite.text).not.toContain("console:");
    const unrelated = await call(await connect(separate, elsewhere), "index_where_used", { family: "button-2" });
    expect(unrelated.isError).toBe(false);
    expect(unrelated.text).toContain("Choose a project or full node id");
  });

  test("with no index yet they say what fills it, and create nothing", async () => {
    const missing = join(dir, "nowhere", "index.db");
    const { isError, text } = await call(await connect(missing), "index_where_used", { family: "button-1" });
    expect(isError).toBe(true);
    expect(text).toMatch(/no local index .*youiyoux inventory/);
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
  });
});
