import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  test("exposes read tools and plan, and nothing that writes or approves", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["youi_check", "youi_get_component", "youi_get_rules", "youi_get_tokens", "youi_plan", "youi_screen_bom", "youi_search", "youi_where_used"]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tools.some((t) => /propose|publish|approve|merge|write|apply/.test(t.name))).toBe(false);
  });

  test("get_component returns the contract an agent needs in about 2 KB", async () => {
    const { data, bytes } = await call("youi_get_component", { name: "Button" });
    expect(data).toMatchObject({ name: "Button", import: "import { Button } from \"@/components/ui\";" });
    expect((data.props as Record<string, { values?: string[] }>).variant!.values).toContain("danger");
    expect(bytes).toBeLessThan(2600);
  });

  test("where_used pages sites and keeps unknowns and lookalikes visible", async () => {
    const { data, bytes } = await call("youi_where_used", { element: "button", limit: 3 });
    expect(data.total).toBe(7);
    expect((data.sites as unknown[]).length).toBe(3);
    expect(data.nextOffset).toBe(3);
    expect(data.lookalikes).toEqual([{ resolved: "components/legacy/button.tsx#Button", sites: 1 }]);
    expect(bytes).toBeLessThan(2048);
  });

  test("check finds violations in code an agent is about to write, with imports resolved", async () => {
    const code = `import { Button } from "@/components/ui";\nexport default function New() {\n  return <div className="bg-[#171717]"><Button variant="primary">Go</Button></div>;\n}\n`;
    const { data } = await call("youi_check", { code, path: "app/new/index.tsx" });
    expect(data.errors).toBe(2);
    expect((data.violations as Array<{ rule: string }>).map((v) => v.rule).sort()).toEqual(["color.no-raw-color", "props.contract-values"]);
    expect(data.usages).toEqual(["app/new/index.tsx:3 Button variant=primary"]);
  });

  test("clean code checks clean", async () => {
    const code = `import { Button } from "@/components/ui";\nexport default function New() {\n  return <Button variant="outline">Go</Button>;\n}\n`;
    const { data } = await call("youi_check", { code, path: "app/new/index.tsx" });
    expect(data).toMatchObject({ errors: 0, violations: [] });
  });

  test("plan classifies without applying anything", async () => {
    const { data } = await call("youi_plan", { element: "button", patch: { status: "deprecated" } });
    expect(data).toMatchObject({ class: "deprecation", semver: "minor" });
  });

  test("tokens, rules, search and screen BOM answer", async () => {
    const tokens = await call("youi_get_tokens", { group: "radius" });
    expect(tokens.data.columns).toEqual(["id", "cssVar", "light", "dark", "utility"]);
    expect((tokens.data.rows as string[][]).find((row) => row[0] === "radius.card")?.[4]).toBe("rounded-card");
    expect((tokens.data.rows as string[][]).map((row) => row[0])).toContain("radius.card");
    // Tailwind already owns spacing-md, so the token gets no utility rather than a colliding one.
    const space = await call("youi_get_tokens", { group: "space" });
    expect((space.data.rows as string[][]).find((row) => row[0] === "space.md")?.[4]).toBe("");
    const rules = await call("youi_get_rules");
    expect((rules.data.rules as Array<{ enforced: boolean }>).filter((r) => r.enforced)).toHaveLength(5);
    expect((rules.data.rules as Array<{ id: string; execution: string }>).find((r) => r.id.endsWith("components.one-primary-action"))?.execution).toBe("advisory");
    const search = await call("youi_search", { query: "destructive" });
    expect((search.data.hits as Array<{ name: string }>)[0]?.name).toBe("Button");
    const bom = await call("youi_screen_bom", { route: "/settings" });
    expect((bom.data.elements as Array<{ name: string }>).map((e) => e.name)).toEqual(["Button"]);
  });

  test("errors come back as tool errors, not crashes", async () => {
    const { isError, data } = await call("youi_get_component", { name: "Carousel" });
    expect(isError).toBe(true);
    expect(String(data.error)).toContain("no component");
  });
});
