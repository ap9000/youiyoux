import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MemoryStore, RuleWorkflow, serveWorkflow, type RunningService } from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

const KEY = "test-session-key";
let box: Sandbox;
let service: RunningService;

beforeAll(async () => {
  box = await sandbox();
  const workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new MemoryStore() });
  service = await serveWorkflow({ workflow, actor: { kind: "person", name: "captain" }, sessionKey: KEY, port: 0 });
});

afterAll(async () => {
  await service.close();
  await box.dispose();
});

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; headers: Record<string, unknown> }> {
  const url = new URL(path, service.url);
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
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

  test("writes need this run's session key, a loopback origin and a loopback host; nothing may frame it", async () => {
    expect((await call("POST", "/api/drafts", {}, { mode: "create" })).status).toBe(401);
    expect((await call("POST", "/api/drafts", { "x-youi-session": "guess" }, { mode: "create" })).status).toBe(401);
    expect((await call("POST", "/api/drafts", { "x-youi-session": KEY, origin: "https://evil.example" }, { mode: "create" })).status).toBe(403);
    expect((await call("GET", "/api/info", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call("GET", "/api/info", { host: "evil.example" })).status).toBe(421);
    expect((await call("GET", "/api/info")).headers).toMatchObject({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
    const created = await call("POST", "/api/drafts", { "x-youi-session": KEY, origin: "http://localhost:5173" }, { mode: "create" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ mode: "create", status: "draft" });
  });

  test("malformed bodies are refused with the reasons", async () => {
    const { status, json } = await call("POST", "/api/drafts", { "x-youi-session": KEY }, { mode: "rename" });
    expect(status).toBe(400);
    expect(json.code).toBe("bad-request");
    expect((await call("GET", "/api/drafts/d-0000000000")).status).toBe(404);
  });

  test("style drafts are created and saved over the same API", async () => {
    const headers = { "x-youi-session": KEY };
    const created = await call("POST", "/api/drafts", headers, { kind: "style" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ kind: "style", revision: 1 });
    const content = { title: "Rounder cards", tokens: [{ path: "radius.card", light: { value: 16, unit: "px" } }], states: [] };
    const saved = await call("PUT", `/api/drafts/${created.json.id as string}`, headers, { revision: 1, content });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ revision: 2, problems: [], content });
    expect((saved.json.content as { tokens: object[] }).tokens[0]).not.toHaveProperty("dark");
    const bad = await call("PUT", `/api/drafts/${created.json.id as string}`, headers, { revision: 2, content: { ...content, states: [{ component: "youi:demo/component/button", state: "pressed", role: "bg", token: "youi:demo/token/color.card" }] } });
    expect(bad.status).toBe(400);
    expect((await call("GET", "/api/info")).json).toMatchObject({ kinds: ["rule", "style", "library"] });
  });

  test("approving a style draft carries the contrast confirmation: refused (422, naming the pairs) without it, approved with it", async () => {
    const headers = { "x-youi-session": KEY };
    const id = (await call("POST", "/api/drafts", headers, { kind: "style" })).json.id as string;
    const muted = { colorSpace: "srgb", components: [0.7686, 0.7686, 0.8], hex: "#c4c4cc" };
    await call("PUT", `/api/drafts/${id}`, headers, { revision: 1, content: { title: "", tokens: [{ path: "color.muted", light: muted }], states: [] } });
    const previewed = (await call("POST", `/api/drafts/${id}/preview`, headers)).json as { revision: number; preview: { id: string; contrast: Array<{ key: string; change: string }> } };
    const keys = previewed.preview.contrast.filter((c) => c.change === "new").map((c) => c.key);
    expect(keys.length).toBeGreaterThan(0);
    const body = { revision: previewed.revision, previewId: previewed.preview.id };
    const refused = await call("POST", `/api/drafts/${id}/approve`, headers, body);
    expect(refused.status).toBe(422);
    expect(refused.json.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^color\.muted on color\.background, light: .*needs 4\.5:1 \(not confirmed\)$/)]));
    expect((await call("POST", `/api/drafts/${id}/approve`, headers, { ...body, acknowledgeContrast: "all" })).status).toBe(400);
    const approved = await call("POST", `/api/drafts/${id}/approve`, headers, { ...body, acknowledgeContrast: keys });
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ status: "approved", approval: { contrastAcknowledged: [...keys].sort() } });
  });
});
