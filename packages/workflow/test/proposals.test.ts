/** Options requests and the proposals that answer them: the task a runner's agent needs, one proposal per request, and every proposal read held to its contract and its request. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ComponentContract, ProposalDoc } from "@youiyoux/core";
import { decisionsKey, proposalDigest, ProposalStore, RequestStore, type ProposalCheck } from "../src/index.ts";

const BUTTON = { id: "youi:demo/component/button", name: "Button", props: { variant: { type: "enum", values: ["default", "outline", "ghost"], default: "default", required: false }, onClick: { type: "function", required: false }, old: { type: "string", deprecated: "use label", required: false }, label: { type: "string", required: false } } } as unknown as ComponentContract;
const TARGET = { route: "/flows", scope: "here", name: "Button", element: "youi:demo/component/button", file: "src/app.tsx", line: 12, box: { x: 10, y: 20, width: 80, height: 32 }, page: { width: 1440, height: 900 } } as const;
const PERSON = { kind: "person", name: "captain" } as const;
const AGENT = { kind: "agent", name: "builder" } as const;

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "youi-proposals-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("an options request", () => {
  test("asks for one proposal file, named for it, with everything an agent without youiyoux tools needs: the contract's choices and the file's shape", async () => {
    const requests = new RequestStore(root, "acme", { newId: () => "r-00000000aa" });
    const request = await requests.create(PERSON, { kind: "options", body: "Make the main action clearer", target: TARGET }, BUTTON);
    const task = request.task!;
    expect(task.offer).toEqual({ proposal: "p-00000000aa", file: ".youi/proposals/p-00000000aa.json", choices: { variant: { type: "enum", values: ["default", "outline", "ghost"], default: "default" }, label: { type: "string" } }, text: true });
    expect([task.touches, task.touchesKnown]).toEqual([[".youi/proposals/p-00000000aa.json"], true]);
    expect(task.goal).toContain("- variant: one of default, outline, ghost (default \"default\")");
    expect(task.goal).toContain('"id":"p-00000000aa","for":"r-00000000aa"');
    expect(task.not[0]).toMatch(/^Changing any file other than \.youi\/proposals\/p-00000000aa\.json/);
    // On every use of an element, HTML a server writes, or no place on the screen, there is nothing to pin options at.
    for (const target of [{ ...TARGET, scope: "element" as const }, { ...TARGET, html: "button" }, { ...TARGET, box: undefined }]) {
      await expect(requests.create(PERSON, { kind: "options", body: "x", target }, BUTTON)).rejects.toThrow(/options are for one component React renders on the screen/);
    }
  });
});

describe("proposals read from disk", () => {
  const proposal = (patch: Partial<ProposalDoc> = {}): ProposalDoc => ({
    schema: "youi.proposal/v1", id: "p-00000000aa", for: "r-00000000aa", project: "acme", route: "/flows", ask: "Make the main action clearer", author: AGENT, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", status: "open",
    target: { name: "Button", element: "youi:demo/component/button", file: "src/app.tsx", line: 12, box: TARGET.box },
    options: [{ id: "a", label: "Primary", why: "x", set: [{ prop: "variant", value: "default" }], text: null }, { id: "b", label: "Quieter", why: "x", set: [{ prop: "variant", value: "outline" }], text: "Start" }],
    ...patch,
  });
  const write = (doc: ProposalDoc) => {
    mkdirSync(join(root, ".youi/proposals"), { recursive: true });
    writeFileSync(join(root, ".youi/proposals", `${doc.id}.json`), JSON.stringify(doc));
  };

  test("a runner's agent's file is shown only when every option is the contract's own and its component is the one its request asked about", async () => {
    const requests = new RequestStore(root, "acme", { newId: () => "r-00000000aa" });
    await requests.create(PERSON, { kind: "options", body: "Make the main action clearer", target: TARGET }, BUTTON);
    const check: ProposalCheck = { contractOf: (id) => (id === BUTTON.id ? BUTTON : null), request: (id) => requests.get(id).catch(() => null), sealKey: null };
    const store = new ProposalStore(root, "acme");
    write(proposal());
    expect((await store.list(check)).proposals.map((p) => p.id)).toEqual(["p-00000000aa"]);
    write(proposal({ options: [{ id: "a", label: "Loud", why: "x", set: [{ prop: "variant", value: "neon" }], text: null }, { id: "b", label: "B", why: "x", set: [], text: "B" }] }));
    expect((await store.list(check)).unreadable).toEqual([{ file: ".youi/proposals/p-00000000aa.json", reason: 'option a: Button\'s variant is one of default, outline, ghost, not "neon"' }]);
    write(proposal({ target: { ...proposal().target, line: 40 } }));
    expect((await store.list(check)).unreadable[0]!.reason).toBe("its component isn't the one r-00000000aa asked about (Button at src/app.tsx:12 on /flows)");
    write(proposal({ id: "p-00000000bb", for: "r-00000000bb" }));
    expect((await store.list(check)).unreadable.map((u) => u.reason)).toContain("it answers r-00000000bb, which isn't an options request here");
    // Without a check (an agent's own view), it is only read as a youi.proposal/v1.
    expect((await store.list()).proposals).toHaveLength(2);
  });

  test("a decision is shown only as your hub sealed it: one written into the file, or made with another key, never is; options are an agent's", async () => {
    const requests = new RequestStore(root, "acme", { newId: () => "r-00000000aa" });
    await requests.create(PERSON, { kind: "options", body: "Make the main action clearer", target: TARGET }, BUTTON);
    const keyFile = join(root, "config", "decisions.key");
    const store = new ProposalStore(root, "acme", { sealKey: () => decisionsKey(keyFile, true) });
    const check = async (): Promise<ProposalCheck> => ({ contractOf: (id) => (id === BUTTON.id ? BUTTON : null), request: (id) => requests.get(id).catch(() => null), sealKey: await decisionsKey(keyFile, false) });
    // Forged: decided by a "person" in the file itself.
    write(proposal({ status: "chosen", choice: "b", decidedBy: PERSON, decidedAt: "2026-11-01T11:00:00Z", request: "r-0123456789" }));
    expect((await store.list(await check())).unreadable).toEqual([{ file: ".youi/proposals/p-00000000aa.json", reason: "its decision wasn't made in your hub: its seal doesn't match" }]);
    write(proposal({ decidedBy: PERSON }));
    expect((await store.list(await check())).unreadable[0]!.reason).toBe("it is open but carries a decision");
    write(proposal({ author: PERSON }));
    expect((await store.list(await check())).unreadable[0]!.reason).toBe("its author isn't an agent: options are offered by agents");
    // Decided in the hub on what the person saw: sealed, and shown.
    write(proposal());
    const seen = proposalDigest(proposal());
    // The file changed after they saw it: nothing is decided.
    write(proposal({ ask: "Something else" }));
    await expect(store.decide(PERSON, "p-00000000aa", { choice: "b", seen }, await check())).rejects.toThrow(/options changed since you saw them/);
    // A proposal that fails its checks is never sealed, whoever saw it.
    const bad = proposal({ options: [{ id: "a", label: "Loud", why: "x", set: [{ prop: "variant", value: "neon" }], text: null }, { id: "b", label: "B", why: "x", set: [], text: "B" }] });
    write(bad);
    await expect(store.decide(PERSON, "p-00000000aa", { choice: "b", seen: proposalDigest(bad) }, await check())).rejects.toThrow(/can't be decided: option a/);
    write(proposal());
    const decided = await store.decide(PERSON, "p-00000000aa", { choice: "b", seen }, await check());
    expect(decided.seal).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.list(await check())).proposals.map((p) => [p.id, p.status])).toEqual([["p-00000000aa", "chosen"]]);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    // A seal made with another key, or a decision changed after it was sealed, isn't yours.
    expect((await store.list({ ...(await check()), sealKey: "0".repeat(64) })).unreadable).toHaveLength(1);
    write({ ...decided, choice: "a" });
    expect((await store.list(await check())).unreadable[0]!.reason).toBe("its decision wasn't made in your hub: its seal doesn't match");
    // The seal covers the whole document: moving it to another component, or rewording why, breaks it.
    write({ ...decided, target: { ...decided.target, box: { x: 1, y: 1, width: 1, height: 1 } } });
    expect((await store.list(await check())).unreadable[0]!.reason).toBe("its decision wasn't made in your hub: its seal doesn't match");
    write({ ...decided, options: decided.options.map((o) => ({ ...o, why: "Reworded" })) });
    expect((await store.list(await check())).unreadable).toHaveLength(1);
    // Without the key, nothing can be decided.
    write(proposal());
    await expect(new ProposalStore(root, "acme").decide(PERSON, "p-00000000aa", { dismiss: true, seen }, await check())).rejects.toThrow(/deciding needs youiyoux's key/);
  });

  test("one proposal answers a request: its id is the request's hex, and a second is refused", async () => {
    const store = new ProposalStore(root, "acme");
    const input = { route: "/flows", target: { name: "Button", element: "youi:demo/component/button", file: "src/app.tsx", line: 12, box: TARGET.box }, ask: "x", options: [{ label: "A", why: "x", set: [{ prop: "variant", value: "ghost" }], text: null }, { label: "B", why: "x", set: [], text: "B" }], for: "r-00000000aa" };
    expect((await store.create(AGENT, input, BUTTON)).id).toBe("p-00000000aa");
    await expect(store.create(AGENT, input, BUTTON)).rejects.toThrow(/options for r-00000000aa are already on the canvas \(p-00000000aa\)/);
  });
});
