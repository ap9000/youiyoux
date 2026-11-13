/**
 * Every change of one request runs under that request's lock, reading it again inside: a change
 * that awaits a behaviour check's evidence can't write back an old snapshot over a person's close
 * and reopen made meanwhile (review round 1, finding 1). A deterministic barrier holds the evidence.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { BehaviourResult } from "@youiyoux/core";
import { RequestStore, WorkflowError, type BehaviourEvidence } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "youi-request-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const target = { route: "/x", pattern: "menu-button" as const, component: "UserMenu", accessibleName: "More" };
const result = { runId: "run1", at: "2026-11-12T10:00:00.000Z", viewport: { width: 800, height: 600 }, route: "/x", rule: "youi:demo/rule/popup.escape", target, pattern: "menu-button", check: "dismiss-escape", state: "failed", why: "Esc did nothing", fix: "Close it on Esc.", info: [], dataBlocked: false, evidence: [], freshness: { rule: "0123456789ab", tool: "t", origin: "http://127.0.0.1:9", config: "0123456789ab", app: "0123456789ab", bindings: "0123456789ab" } } as BehaviourResult;

test("a person's close and reopen during an addressed check's evidence wait are kept, after it, in order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let entered!: () => void;
  const inside = new Promise<void>((done) => (entered = done));
  const evidence: BehaviourEvidence = {
    failure: async () => ({ result, link: { rule: result.rule, check: "dismiss-escape", target, runId: "run1", failedAt: result.at }, target: { route: "/x", scope: "here", name: "UserMenu" } }),
    passedSince: async () => {
      entered();
      await gate;
      return null;
    },
  };
  const store = new RequestStore(root, "app", { behaviour: evidence });
  const person = { kind: "person", name: "p" } as const;
  const { id } = await store.createFromBehaviour(person, { route: "/x", runId: "run1", index: 0 });
  const addressed = store.setStatus({ kind: "agent", name: "a" }, id, "addressed", "fixed");
  await inside;
  // While the evidence is awaited, a person closes it and reopens it.
  const reopened = store.setStatus(person, id, "closed", "no").then(() => store.setStatus(person, id, "open", "still broken"));
  await new Promise((done) => setTimeout(done, 100));
  release();
  await addressed;
  await reopened;
  const now = await store.get(id);
  expect(now.status).toBe("open");
  expect(now.thread.map((e) => e.status)).toEqual(["addressed", "closed", "open"]);
});

test("an unreadable lock (a folder in its place) is waited for until the deadline, then refused, naming it; never spun on", async () => {
  const store = new RequestStore(root, "app", { lockWaitMs: 300 });
  const person = { kind: "person", name: "p" } as const;
  const { id } = await store.create(person, { kind: "comment", body: "a note", target: { route: "/x", scope: "here", name: "Card" } });
  mkdirSync(join(root, ".youi/requests", `${id}.json.lock`));
  const started = Date.now();
  const refused = await store.reply(person, id, "hello").then(() => null, (e: unknown) => e);
  const ms = Date.now() - started;
  expect(refused).toBeInstanceOf(WorkflowError);
  expect((refused as WorkflowError).message).toBe(`${id} is being changed by a lock youiyoux can't read (EISDIR); nothing was written. Try again; if no youiyoux is running, delete .youi/requests/${id}.json.lock`);
  expect(ms).toBeGreaterThanOrEqual(300);
  expect(ms).toBeLessThan(3_000);
  expect((await store.get(id)).thread).toEqual([]);
}, 15_000);
