import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const TTL_MS = 50;
let dir = "";
let client: Client;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-mcp-"));
  await cp(join(EXAMPLES, "demo-app"), join(dir, "demo-app"), { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  const server = createServer({ projectRoot: join(dir, "demo-app"), scanTtlMs: TTL_MS });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

async function check(code: string): Promise<{ errors: number; rules: string }> {
  const result = (await client.callTool({ name: "system_check", arguments: { code, path: "components/x.tsx" } })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as { errors: number; rules: string };
}

test("an edited rule reaches the MCP tools after the TTL, with a new definitions digest", async () => {
  const code = `export const X = () => <p style={{ color: "#123456" }} />;\n`;
  const before = await check(code);
  expect(before.errors).toBe(1);
  const rule = join(dir, "demo-design/rules/color.no-raw-color.rule.yaml");
  await writeFile(rule, (await readFile(rule, "utf8")).replace(/^severity: error$/m, "severity: off"));
  await new Promise((done) => setTimeout(done, TTL_MS * 2));
  const after = await check(code);
  expect(after.errors).toBe(0);
  expect(after.rules).not.toBe(before.rules);
  expect(after.rules).toMatch(/^demo@\d+\.\d+\.\d+ · defs [0-9a-f]{12}/);
});
