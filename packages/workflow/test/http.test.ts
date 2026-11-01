import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MemoryStore, ProposalStore, readyProof, RuleWorkflow, serveWorkflow, type RunningService } from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

const KEY = "test-session-key";
let box: Sandbox;
let service: RunningService;

beforeAll(async () => {
  box = await sandbox();
  // Decisions are sealed with a key in the sandbox, never the person's own config folder.
  const workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new MemoryStore(), decisionsKey: join(box.project, "..", "decisions.key") });
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

  test("the live bridge is the one file any page may load; finding a live component's line needs the session key", async () => {
    const bridge = await new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
      request(new URL("/api/live/bridge.js", service.url), { headers: { "sec-fetch-site": "cross-site" } }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), text }));
      }).on("error", reject).end();
    });
    expect(bridge).toMatchObject({ status: 200, type: "text/javascript; charset=utf-8" });
    expect(bridge.text).toMatch(/^\/\* youiyoux live bridge v1/);
    expect((await call("GET", "/api/live/bridge.js", { host: "evil.example" })).status).toBe(421);
    // Everything else stays this hub's own.
    expect((await call("GET", "/api/live", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call("GET", "/api/live")).json).toMatchObject({ project: "expo-fixture", base: null, why: expect.stringMatching(/screens capture/) });
    expect((await call("POST", "/api/live/resolve", {}, { places: [] })).status).toBe(401);
    expect((await call("POST", "/api/live/resolve", { "x-youi-session": KEY }, { places: [{ name: "x" }] })).status).toBe(400);
  });

  test("plain HTML under the pointer keeps its tag through the service; a tag that is not one is refused", async () => {
    const dir = join(box.project, ".youi/screens");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "expo-fixture", source: "a test app", capturedAt: "", base: "http://127.0.0.1:9", viewport: { width: 800, height: 600 }, screens: [{ route: "/", path: "/" }] }));
    try {
      const place = { name: 'button "Approve plan"', owner: "Served", frames: [], box: { x: 0, y: 0, width: 10, height: 10 }, depth: 3 };
      const resolved = await call("POST", "/api/live/resolve", { "x-youi-session": KEY }, { places: [{ ...place, html: "button" }] });
      expect(resolved.status).toBe(200);
      expect(resolved.json.places).toEqual([{ ...place, frames: undefined, html: "button", file: null, line: null, column: null }].map(({ frames: _, ...p }) => p));
      expect((await call("POST", "/api/live/resolve", { "x-youi-session": KEY }, { places: [{ ...place, html: "<script>" }] })).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("Connect your agent", () => {
  test("what is here reads freely; connecting needs the session key, names known agents only, and without the CLI's setup says how to do it from a terminal", async () => {
    const asked: string[][] = [];
    const view = { agents: [{ kind: "claude", name: "Claude Code", found: true, connected: false, file: ".mcp.json" }], command: "youiyoux agents install" } as const;
    const workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new MemoryStore() });
    const agents = { view: async () => view, connect: async (kinds: readonly string[]) => (asked.push([...kinds]), { results: [], checks: [], view }) };
    const withAgents = await serveWorkflow({ workflow, actor: { kind: "person", name: "captain" }, sessionKey: KEY, port: 0, agents });
    const at = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request(new URL(path, withAgents.url), { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    try {
      expect((await at("GET", "/api/agents")).json).toEqual(view);
      expect((await at("POST", "/api/agents", {}, { agents: ["claude"] })).status).toBe(401);
      expect((await at("POST", "/api/agents", { "x-youi-session": KEY }, { agents: ["claude", "vscode"] })).status).toBe(400);
      expect((await at("POST", "/api/agents", { "x-youi-session": KEY }, { agents: [] })).status).toBe(400);
      expect((await at("POST", "/api/agents", { "x-youi-session": KEY }, { agents: ["cursor", "claude", "cursor"] })).status).toBe(200);
      expect(asked).toEqual([["cursor", "claude"]]);
    } finally {
      await withAgents.close();
    }
    const without = await call("GET", "/api/agents");
    expect(without.status).toBe(404);
    expect(without.json.error).toContain("youiyoux agents install");
  });
});

describe("a live edit written into the product's code", () => {
  const SOURCE = 'export const Bar = () => (\n  <div>\n    <Button variant="outline">New flow</Button>\n    <Button variant={x}>Other</Button>\n  </div>\n);\n';
  const edit = { file: "src/live-edit-bar.tsx", line: 3, column: 4, component: "Button", set: [{ prop: "variant", value: "default" }], text: "Create flow" };
  const file = () => join(box.project, edit.file);
  const post = (body: unknown, key: string | null = KEY) => call("POST", "/api/live/edit", key ? { "x-youi-session": key } : {}, body);

  test("is shown first with the file's hash, and written only with that hash, while the file is still the one shown", async () => {
    mkdirSync(join(box.project, "src"), { recursive: true });
    writeFileSync(file(), SOURCE);
    try {
      expect((await post(edit, null)).status).toBe(401);
      const shown = await post(edit);
      expect(shown.status).toBe(200);
      expect(shown.json).toMatchObject({ ok: true, written: false, tag: "Button", line: 3, before: '    <Button variant="outline">New flow</Button>', after: '    <Button variant="default">Create flow</Button>' });
      expect(readFileSync(file(), "utf8")).toBe(SOURCE);
      // Someone changed the file since: nothing is written.
      writeFileSync(file(), `${SOURCE}// edited\n`);
      const stale = await post({ ...edit, write: { hash: shown.json.hash } });
      expect([stale.status, stale.json.code]).toEqual([409, "stale"]);
      expect(readFileSync(file(), "utf8")).toBe(`${SOURCE}// edited\n`);
      const again = await post(edit);
      const written = await post({ ...edit, write: { hash: again.json.hash } });
      expect(written.json).toMatchObject({ ok: true, written: true });
      expect(readFileSync(file(), "utf8").split("\n")[2]).toBe('    <Button variant="default">Create flow</Button>');
      // A value the code computes is not written: it says why.
      const computed = await post({ ...edit, line: 4, set: [{ prop: "variant", value: "ghost" }], text: null });
      expect(computed.json).toMatchObject({ ok: false, why: expect.stringMatching(/^variant is computed in code/) });
    } finally {
      rmSync(file(), { force: true });
    }
  });

  test("a file outside the product, a link, or one that isn't a script is refused", async () => {
    mkdirSync(join(box.project, "src"), { recursive: true });
    const outside = join(box.project, "..", "outside-live-edit.tsx");
    writeFileSync(outside, SOURCE);
    symlinkSync(outside, join(box.project, "src/linked.tsx"));
    writeFileSync(join(box.project, "src/notes.md"), SOURCE);
    try {
      for (const name of ["../outside-live-edit.tsx", outside, "src/linked.tsx", "src/notes.md"]) {
        const refused = await post({ ...edit, file: name });
        expect([name, refused.status]).toEqual([name, 400]);
      }
      expect(readFileSync(outside, "utf8")).toBe(SOURCE);
      expect((await post({ ...edit, file: "src/missing.tsx" })).status).toBe(404);
      expect((await post({ ...edit, set: [{ prop: "on click", value: "x" }] })).status).toBe(400);
    } finally {
      rmSync(outside, { force: true });
      rmSync(join(box.project, "src/linked.tsx"), { force: true });
      rmSync(join(box.project, "src/notes.md"), { force: true });
    }
  });
});

describe("options an agent put on the canvas", () => {
  test("are read freely; a person's pick or dismissal needs the session key, names an option the proposal has, and is made once", async () => {
    const agent = { kind: "agent", name: "agent (MCP)" } as const;
    const store = new ProposalStore(box.project, "expo-fixture");
    const proposal = await store.create(agent, { route: "/", target: { name: "Title", box: { x: 0, y: 0, width: 10, height: 10 } }, ask: "Warmer words", options: [{ label: "Hello", why: "Friendly.", set: [], text: "Hello" }, { label: "Welcome", why: "Warmer.", set: [], text: "Welcome back" }] }, null);
    try {
      const listed = await call("GET", "/api/proposals");
      expect((listed.json.proposals as Array<{ id: string }>).map((p) => p.id)).toEqual([proposal.id]);
      const decide = (body: unknown, key: string | null = KEY) => call("POST", `/api/proposals/${proposal.id}/decision`, key ? { "x-youi-session": key } : {}, body);
      expect((await decide({ choice: "a" }, null)).status).toBe(401);
      expect((await decide({ choice: "z" })).status).toBe(400);
      expect((await decide({ choice: "c" })).status).toBe(400);
      expect((await decide({ choice: "a", dismiss: true })).status).toBe(400);
      const chosen = await decide({ choice: "b", request: "r-0123456789" });
      expect(chosen.json).toMatchObject({ status: "chosen", choice: "b", request: "r-0123456789", decidedBy: { kind: "person", name: "captain" } });
      expect((await decide({ dismiss: true })).status).toBe(409);
    } finally {
      rmSync(join(box.project, ".youi/proposals"), { recursive: true, force: true });
    }
  });
});

describe("ready", () => {
  test("signs a fresh challenge with the session key, so --open can tell this service from one that took the port; nothing else", async () => {
    const challenge = "0123456789abcdef0123456789abcdef";
    const { status, json } = await call("GET", `/api/ready?c=${challenge}`);
    expect([status, json.proof]).toEqual([200, readyProof(KEY, challenge)]);
    expect(json.proof).not.toBe(readyProof("another-key", challenge));
    expect((await call("GET", "/api/ready?c=not-a-challenge")).status).toBe(400);
    expect(JSON.stringify(json)).not.toContain(KEY);
  });
});
