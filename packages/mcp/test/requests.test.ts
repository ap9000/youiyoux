/** The request tools: what an agent reads about a request, and that it can reply and mark addressed but never close. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RequestStore } from "@youiyoux/workflow";
import { createServer } from "../src/index.ts";

let root: string;
let client: Client;
let change: string;
let comment: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "youi-mcp-requests-"));
  await mkdir(join(root, ".youi/screens"), { recursive: true });
  await writeFile(join(root, ".youi/screens/settings.light.webp"), "RIFF");
  const store = new RequestStore(root, "acme");
  const person = { kind: "person", name: "captain" } as const;
  change = (await store.create(person, { kind: "change", body: "Use the primary button here", target: { route: "/settings", scope: "here", name: "Button", element: "youi:demo/component/button", lookalike: true, file: "app/settings.tsx", line: 12, box: { x: 10, y: 20, width: 80, height: 32 }, page: { width: 1440, height: 900 } } })).id;
  comment = (await store.create(person, { kind: "comment", body: "Is this label right everywhere?", target: { route: "/", scope: "element", name: "Card", element: "youi:demo/component/card" } })).id;
  const server = createServer({ projectRoot: root, render: { download: false } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
});
afterAll(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  // The SDK refuses input that does not match a tool's schema in words, not JSON.
  return { data: (text.startsWith("{") ? JSON.parse(text) : { refused: text }) as Record<string, unknown>, isError: Boolean(result.isError) };
}

describe("requests over MCP", () => {
  test("open requests say what is asked, where to look (the picture, the box at its pixels), the line, and what to do next", async () => {
    const { data } = await call("requests_list");
    const requests = data.requests as Array<Record<string, unknown>>;
    expect(requests.map((r) => r.id).sort()).toEqual([change, comment].sort());
    expect(requests.find((r) => r.id === change)).toMatchObject({
      kind: "change",
      ask: "Use the primary button here",
      from: "person captain",
      route: "/settings",
      at: "app/settings.tsx:12",
      lookalike: true,
      scope: "this one, on this screen",
      picture: join(root, ".youi/screens/settings.light.webp"),
      box: { x: 20, y: 40, width: 160, height: 64 },
      next: expect.stringMatching(/^Make the change at app\/settings\.tsx:12, using the System's youi:demo\/component\/button rather than the hand-built lookalike[\s\S]*request_addressed/),
    });
    expect(requests.find((r) => r.id === comment)).toMatchObject({ scope: "everywhere youi:demo/component/card is used", picture: null, at: null, next: expect.stringMatching(/^A comment on every use of youi:demo\/component\/card/) });
    expect((await call("requests_list", { route: "/" })).data.requests).toHaveLength(1);
    expect((await call("requests_list", { status: "closed" })).data).toEqual({ requests: [], next: "No closed requests." });
  });

  test("an agent replies and marks a request addressed, as an agent, in the request's file; it cannot close one", async () => {
    await call("request_reply", { id: change, message: "Primary or default?" });
    const { data } = await call("request_addressed", { id: change, message: "Swapped to <Button variant=\"primary\"> at app/settings.tsx:12" });
    // The picture is older than the request: the person would compare against the old screen, so the agent is told to capture it.
    expect(data).toMatchObject({ status: "addressed", recaptured: false, next: expect.stringMatching(/^Marked addressed, but \/settings has not been captured since this was filed[\s\S]*screens_capture with route \/settings/) });
    const file = JSON.parse(await readFile(join(root, `.youi/requests/${change}.json`), "utf8")) as { status: string; thread: Array<{ author: { kind: string }; status?: string }> };
    expect(file.status).toBe("addressed");
    expect(file.thread.map((e) => [e.author.kind, e.status ?? null])).toEqual([["agent", null], ["agent", "addressed"]]);
    expect((await call("request_addressed", { id: change, message: "again" })).data).toEqual({ error: `${change} is already addressed` });
    const escape = await call("request_reply", { id: "../escape", message: "x" });
    expect(escape.isError).toBe(true);
    expect(String(escape.data.refused)).toMatch(/r-\[0-9a-f\]\{10\}|Invalid/);
    expect((await call("requests_list", { status: "addressed" })).data.requests).toHaveLength(1);
  });
});

describe("screens_capture", () => {
  test("photographs only an app on this machine, and needs a base when no capture has recorded one", async () => {
    await writeFile(join(root, ".youi/screens/screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "acme", source: "a test app", capturedAt: "", viewport: { width: 400, height: 300 }, screens: [{ route: "/settings", path: "/settings" }] }));
    expect((await call("screens_capture", { route: "/settings" })).data.error).toMatch(/^no base: pass base/);
    expect((await call("screens_capture", { route: "/settings", base: "https://example.com" })).data.error).toMatch(/is not on this machine/);
    expect((await call("screens_capture", { route: "/settings", base: "http://169.254.169.254/" })).data.error).toMatch(/is not on this machine/);
  });

  test("captures one route again, records where the app ran, and the addressed request then reads as captured", async () => {
    const { createServer: createHttp } = await import("node:http");
    const app = createHttp((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><body style="margin:0"><button>Save</button></body>'));
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    try {
      const { data } = await call("screens_capture", { route: "/settings", base });
      expect(data).toMatchObject({ route: "/settings", base, picture: join(root, ".youi/screens/settings.light.webp") });
      expect(data.requests).toEqual([expect.objectContaining({ id: change, recaptured: true, next: expect.stringMatching(/^Marked addressed: a person checks it/) })]);
      expect(JSON.parse(await readFile(join(root, ".youi/screens/screens.json"), "utf8")).base).toBe(base);
      // The next capture finds the app where the last one did.
      expect((await call("screens_capture", { route: "/settings" })).data).toMatchObject({ base });
      expect((await call("screens_capture", { route: "/nope" })).data.error).toMatch(/has no route \/nope/);
    } finally {
      app.close();
    }
  }, 120_000);
});
