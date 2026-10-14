import { mkdtemp, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeSharedStores, openCatalog, syncIndex } from "@youiyoux/discover";
import { fixtureFetcher } from "../../discover/test/fixture-fetcher.ts";
import { createServer } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
let cache: string;
let empty: string;
const clients: Client[] = [];

async function connect(discoverCache: string): Promise<Client> {
  const server = createServer({ projectRoot: FIXTURE, discoverCache });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; bytes: number; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { data: JSON.parse(text) as Record<string, unknown>, bytes: Buffer.byteLength(text), isError: Boolean(result.isError) };
}

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "youi-mcp-discover-"));
  empty = await mkdtemp(join(tmpdir(), "youi-mcp-discover-empty-"));
  await syncIndex({ sleep: async () => {}, cacheDir: cache, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  await openCatalog(cache, join(cache, "index.db"));
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await closeSharedStores();
  await rm(cache, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

describe("discover MCP tools", () => {
  test("discover_search and discover_show are listed, read-only and closed-world", async () => {
    const client = await connect(cache);
    const { tools } = await client.listTools();
    for (const name of ["discover_search", "discover_show"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(tools.find((t) => t.name === "discover_search")!.inputSchema.properties).toHaveProperty("constraints");
  });

  test("discover_search ranks command and cmdk-based candidates first, each with licence, signals and install command", async () => {
    const client = await connect(cache);
    const fetch = vi.spyOn(globalThis, "fetch");
    const { data, bytes, isError } = await call(client, "discover_search", { need: "command menu" });
    expect(isError).toBe(false);
    const hits = data.hits as Array<{ id: string; license: string; signals: Record<string, unknown>; install: { command: string } }>;
    expect(hits.slice(0, 2).map((h) => h.id)).toEqual(["lib:shadcn/component/command", "lib:coss/component/command"]);
    expect(hits[0]).toMatchObject({ license: "MIT", install: { command: "npx shadcn add command" }, signals: { weeklyDownloads: null, via: { package: "cmdk", weeklyDownloads: 41566267 } } });
    expect(hits[1]).toMatchObject({ license: "unknown" });
    expect(String(data.note)).toMatch(/never install.*library_request/i);
    expect(bytes).toBeLessThan(8000);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  test("discover_search takes a role and constraints", async () => {
    const client = await connect(cache);
    const { data } = await call(client, "discover_search", { need: "command menu", constraints: { licenses: ["MIT"], sources: ["shadcn-registry"] } });
    const hits = data.hits as Array<{ id: string; license: string; source: { kind: string } }>;
    expect(hits[0]!.id).toBe("lib:shadcn/component/command");
    expect(hits.every((h) => h.license === "MIT" && h.source.kind === "shadcn-registry")).toBe(true);
    expect(hits.some((h) => h.id === "lib:coss/component/command")).toBe(false);
    const role = await call(client, "discover_search", { need: "dialog", role: "command palette" });
    expect((role.data.hits as Array<{ id: string }>).map((h) => h.id)).toEqual(["lib:coss/pattern/p-command-1", "lib:coss/pattern/p-command-2"]);
    // Input outside the schema is refused before the tool runs.
    const bad = (await client.callTool({ name: "discover_search", arguments: { need: "toast", constraints: { sources: ["website"] } } })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/sources/);
  });

  test("discover_show returns one candidate in full, by id or ref", async () => {
    const client = await connect(cache);
    const { data } = await call(client, "discover_show", { id: "@coss/command" });
    expect(data.entry).toMatchObject({
      id: "lib:coss/component/command",
      source: { kind: "shadcn-registry", ref: "@coss/command" },
      license: "unknown",
      install: { command: "npx shadcn add @coss/command", registryDeps: ["@coss/autocomplete"] },
      provenance: { url: "https://coss.com/ui/r/registry.json", registryHealth: { status: "healthy" } },
    });
    const missing = await call(client, "discover_show", { id: "@nowhere/thing" });
    expect(missing.isError).toBe(true);
  });

  test("without an index the tools say to run youiyoux discover sync, and write nothing", async () => {
    const client = await connect(empty);
    const { data, isError } = await call(client, "discover_search", { need: "toast" });
    expect(isError).toBe(true);
    expect(String(data.error)).toContain("youiyoux discover sync");
    expect(await readdir(empty)).toEqual([]);
  });

  test("the tools only read: the index is unchanged after searching and showing", async () => {
    await closeSharedStores();
    const beforeDb = await readFile(join(cache, "index.db"));
    const before = (await stat(join(cache, "index.json"))).mtimeMs;
    const client = await connect(cache);
    await call(client, "discover_search", { need: "toast" });
    await call(client, "discover_show", { id: "lib:npm/component/sonner" });
    expect((await stat(join(cache, "index.json"))).mtimeMs).toBe(before);
    expect(await readFile(join(cache, "index.db"))).toEqual(beforeDb);
  });

  test("adoption stays library_request: a Discover candidate can be drafted by its lib: id, nothing filed", async () => {
    const client = await connect(cache);
    const { data, isError } = await call(client, "library_request", { item: "lib:shadcn/component/command", reason: "a command menu for search" });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ request: "adopt", status: "draft", item: { id: "lib:shadcn/component/command", source: "shadcn/ui" }, move: { from: "library", to: "candidate" } });
  });
});

test("old indexes are cleaned for read-only search and show, with framework constraints", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "youi-mcp-escape-"));
  try {
    const raw = JSON.parse(await readFile(join(cache, "index.json"), "utf8"));
    delete raw.format;
    const command = raw.entries.find((entry: { source: { ref: string } }) => entry.source.ref === "@shadcn/command");
    command.title = "\x1b]0;pwned\x07Command";
    command.summary = "\x1b[2JCommand menu";
    command.categories.push("\x90payload\x9ccommand");
    await writeFile(join(isolated, "index.json"), JSON.stringify(raw));
    await openCatalog(isolated, join(isolated, "index.db"));
    const client = await connect(isolated);
    const result = await call(client, "discover_search", { need: "\x1b[2Jcommand menu", constraints: { framework: "react" } });
    expect(result.isError).toBe(false);
    const hits = result.data.hits as Array<{ source: { ref: string } }>;
    expect(hits.slice(0, 3).map((hit) => hit.source.ref)).toContain("@shadcn/command");
    const shown = await call(client, "discover_show", { id: "@shadcn/command" });
    expect(shown.data.entry).toMatchObject({ title: "Command", summary: "Command menu", categories: expect.arrayContaining(["command"]) });
    for (const data of [result.data, shown.data]) {
      const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : [];
      for (const value of strings(data)) expect(value).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    }
  } finally { await rm(isolated, { recursive: true, force: true }); }
});
