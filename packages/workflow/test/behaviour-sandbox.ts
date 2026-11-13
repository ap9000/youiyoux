/**
 * A product for the behaviour service tests (slice 4): the expo fixture and the demo design in temp
 * git repos, a behaviour rule (Esc closes popups), screens.json with consent for a loopback origin,
 * and the hub's service with a stand-in probe (no browser) whose verdict each test sets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { MemoryStore, RuleWorkflow, serveWorkflow, type RunningService } from "../src/index.ts";
import { BASE, ESCAPE, setup, tick } from "./behaviour-stand-in.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

export * from "./behaviour-stand-in.ts";
export const KEY = "test-session-key";

export interface BehaviourSandbox {
  box: Sandbox;
  service: RunningService;
  screensFile(): string;
  /** screens.json with these screens (/x and /y), this base and this behaviour block (none: no consent). */
  screens(behaviour: Record<string, unknown> | null, base?: string): void;
  consentOn(): void;
  call(method: string, path: string, headers?: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /** A write as the hub makes it: the session key and a loopback origin. */
  write(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /** A run through the hub's route, waited for. */
  runFromHub(route?: string, target?: Record<string, unknown>): Promise<void>;
}

/** The sandbox for one test file: made before its tests, removed after. */
export function behaviourSandbox(): BehaviourSandbox {
  const self = {} as BehaviourSandbox;
  self.screensFile = () => join(self.box.project, ".youi/screens/screens.json");
  self.screens = (behaviour, base = BASE) => {
    mkdirSync(join(self.box.project, ".youi/screens"), { recursive: true });
    writeFileSync(self.screensFile(), JSON.stringify({ schema: "youiyoux.screens/v1", project: "expo-fixture", source: "a test app", capturedAt: "", base, viewport: { width: 800, height: 600 }, screens: [{ route: "/x", path: "/x" }, { route: "/y", path: "/y" }], ...(behaviour ? { behaviour } : {}) }, null, 2));
  };
  self.consentOn = () => self.screens({ allowedOrigin: BASE, generation: 1 });
  self.call = (method, path, headers = {}, body) =>
    new Promise((resolve, reject) => {
      const req = request(new URL(path, self.service.url), { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  self.write = (path, body) => self.call("POST", path, { "x-youi-session": KEY, origin: "http://localhost:5173" }, body);
  self.runFromHub = async (route = "/x", target) => {
    const started = await self.write("/api/behaviour/run", { route, ...(target ? { target } : {}) });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    for (let i = 0; i < 400; i++) {
      const { json } = await self.call("GET", "/api/behaviour/run");
      if (json.running === null) {
        expect((json.last as { problem: string | null }).problem).toBeNull();
        return;
      }
      await tick();
    }
    throw new Error("the run never finished");
  };
  beforeAll(async () => {
    self.box = await sandbox();
    await self.box.commitDesign("rules/popup.escape.rule.yaml", ESCAPE, "a behaviour rule");
    self.consentOn();
    const workflow = new RuleWorkflow({ projectRoot: self.box.project, designRoot: self.box.design, store: new MemoryStore(), decisionsKey: join(self.box.dir, "decisions.key"), behaviour: setup });
    self.service = await serveWorkflow({ workflow, actor: { kind: "person", name: "captain" }, sessionKey: KEY, port: 0 });
  }, 60_000);
  afterAll(async () => {
    await self.service?.close();
    await self.box?.dispose();
  });
  return self;
}
