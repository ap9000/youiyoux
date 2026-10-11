import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MemoryStore, RuleWorkflow, serveWorkflow, type RunningService } from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let box: Sandbox;
let service: RunningService;

beforeAll(async () => {
  box = await sandbox();
  const workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new MemoryStore() });
  service = await serveWorkflow({ workflow, actor: { kind: "person", name: "captain" }, port: 0 });
});

afterAll(async () => {
  await service.close();
  await box.dispose();
});

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(path, service.url);
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("loopback service", () => {
  test("reads work and describe what this editor can do", async () => {
    const { status, json } = await call("GET", "/api/info");
    expect(status).toBe(200);
    expect(json).toMatchObject({ schema: "youiyoux.workflow/v1", project: { id: "expo-fixture" }, design: { branch: "main" } });
  });

  test("writes need the client header, a loopback origin and a loopback host", async () => {
    expect((await call("POST", "/api/drafts", {}, { mode: "create" })).status).toBe(403);
    expect((await call("POST", "/api/drafts", { "x-youi-client": "hub", origin: "https://evil.example" }, { mode: "create" })).status).toBe(403);
    expect((await call("GET", "/api/info", { host: "evil.example" })).status).toBe(421);
    const created = await call("POST", "/api/drafts", { "x-youi-client": "hub", origin: "http://localhost:5173" }, { mode: "create" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ mode: "create", status: "draft" });
  });

  test("malformed bodies are refused with the reasons", async () => {
    const { status, json } = await call("POST", "/api/drafts", { "x-youi-client": "hub" }, { mode: "rename" });
    expect(status).toBe(400);
    expect(json.code).toBe("bad-request");
    expect((await call("GET", "/api/drafts/d-0000000000")).status).toBe(404);
  });
});
