import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_TOOLS } from "@youiyoux/core";
import { createServer } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
let client: Client;

beforeAll(async () => {
  const server = createServer({ projectRoot: FIXTURE });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ data: Record<string, unknown>; bytes: number; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { data: JSON.parse(text) as Record<string, unknown>, bytes: Buffer.byteLength(text), isError: Boolean(result.isError) };
}

describe("youiyoux MCP server", () => {
  test("exposes system_*, library_*, discover_*, index_* and ui_* read tools, and nothing that writes, approves or installs", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["discover_search", "discover_show", "index_rule_covers", "index_swap_impact", "index_where_used", "library_request", "library_search", "system_check", "system_get_component", "system_get_rules", "system_get_tokens", "system_plan", "system_screen_bom", "system_search", "system_where_used", "ui_find_component"]);
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tools.some((t) => /propose|publish|approve|merge|write|apply|install|sync/.test(t.name))).toBe(false);
    expect(tools.every((t) => /^(system|library|discover|index|ui)_/.test(t.name))).toBe(true);
  });

  test("component cards carry usage, and claim no stage from a partial scan", async () => {
    const { data } = await call("system_get_component", { name: "Button" });
    expect(data).toMatchObject({ usage: { sites: 7 } });
    expect(data).not.toHaveProperty("stage");
  });

  test("system lookups refuse Library ids and point at library_request", async () => {
    const { isError, data } = await call("system_get_component", { name: "lib:shadcn/component/date-picker" });
    expect(isError).toBe(true);
    expect(String(data.error)).toMatch(/Library item, not a System element.*library_request/);
  });

  test("the Library starts empty and says to build with the System", async () => {
    const { data } = await call("library_search", { query: "date picker" });
    expect(data).toMatchObject({ hits: [], total: 0 });
    expect(String(data.note)).toContain("system_search");
    const request = await call("library_request", { item: "date picker", reason: "booking flow" });
    expect(request.isError).toBe(true);
    expect(String(request.data.error)).toContain("Library is empty");
  });

  test("get_component returns the contract an agent needs in about 2 KB", async () => {
    const { data, bytes } = await call("system_get_component", { name: "Button" });
    expect(data).toMatchObject({ name: "Button", import: "import { Button } from \"@/components/ui\";" });
    expect((data.props as Record<string, { values?: string[] }>).variant!.values).toContain("danger");
    expect(bytes).toBeLessThan(2600);
  });

  test("where_used pages sites and keeps unknowns and lookalikes visible", async () => {
    const { data, bytes } = await call("system_where_used", { element: "button", limit: 3 });
    expect(data.total).toBe(7);
    expect((data.sites as unknown[]).length).toBe(3);
    expect(data.nextOffset).toBe(3);
    expect(data.lookalikes).toEqual([{ resolved: "components/legacy/button.tsx#Button", sites: 1 }]);
    expect(bytes).toBeLessThan(2048);
  });

  test("check finds violations in code an agent is about to write, with imports resolved", async () => {
    const code = `import { Button } from "@/components/ui";\nexport default function New() {\n  return <div className="bg-[#171717]"><Button variant="primary">Go</Button></div>;\n}\n`;
    const { data } = await call("system_check", { code, path: "app/new/index.tsx" });
    expect(data.errors).toBe(2);
    expect((data.violations as Array<{ rule: string }>).map((v) => v.rule).sort()).toEqual(["color.no-raw-color", "props.contract-values"]);
    expect(data.usages).toEqual(["app/new/index.tsx:3 Button variant=primary"]);
  });

  test("clean code checks clean", async () => {
    const code = `import { Button } from "@/components/ui";\nexport default function New() {\n  return <Button variant="outline">Go</Button>;\n}\n`;
    const { data } = await call("system_check", { code, path: "app/new/index.tsx" });
    expect(data).toMatchObject({ errors: 0, violations: [] });
  });

  test("plan classifies without applying anything", async () => {
    const { data } = await call("system_plan", { element: "button", patch: { status: "deprecated" } });
    expect(data).toMatchObject({ class: "deprecation", semver: "minor" });
  });

  test("tokens, rules, search and screen BOM answer", async () => {
    const tokens = await call("system_get_tokens", { group: "radius" });
    expect(tokens.data.columns).toEqual(["id", "cssVar", "light", "dark", "utility"]);
    expect((tokens.data.rows as string[][]).find((row) => row[0] === "radius.card")?.[4]).toBe("rounded-card");
    expect((tokens.data.rows as string[][]).map((row) => row[0])).toContain("radius.card");
    // Tailwind already owns spacing-md, so the token gets no utility rather than a colliding one.
    const space = await call("system_get_tokens", { group: "space" });
    expect((space.data.rows as string[][]).find((row) => row[0] === "space.md")?.[4]).toBe("");
    const rules = await call("system_get_rules");
    expect((rules.data.rules as Array<{ enforced: boolean }>).filter((r) => r.enforced)).toHaveLength(5);
    expect((rules.data.rules as Array<{ id: string; execution: string }>).find((r) => r.id.endsWith("components.one-primary-action"))?.execution).toBe("advisory");
    const search = await call("system_search", { query: "destructive" });
    expect((search.data.hits as Array<{ name: string }>)[0]?.name).toBe("Button");
    const bom = await call("system_screen_bom", { route: "/settings" });
    expect((bom.data.elements as Array<{ name: string }>).map((e) => e.name)).toEqual(["Button"]);
  });

  test("errors come back as tool errors, not crashes", async () => {
    const { isError, data } = await call("system_get_component", { name: "Carousel" });
    expect(isError).toBe(true);
    expect(String(data.error)).toContain("no component");
  });
});

describe("a config kept outside its product", () => {
  test("productRoot (--root) points the server's scans at the product", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-mcp-root-"));
    const config = JSON.parse(await readFile(join(FIXTURE, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(dir, "youi.project.json"), JSON.stringify({ ...config, source: { path: join(FIXTURE, "../../../../../examples/demo-design") } }));
    const server = createServer({ projectRoot: dir, productRoot: FIXTURE });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const outside = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), outside.connect(clientTransport)]);
    try {
      const result = (await outside.callTool({ name: "system_where_used", arguments: { element: "button" } })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ total: 7 });
    } finally {
      await outside.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
