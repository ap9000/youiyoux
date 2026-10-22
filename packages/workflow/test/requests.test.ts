/** Requests on captured screens: one file each in the product, a thread, and who may move them on. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RequestDoc } from "@youiyoux/core";
import { MemoryStore, REQUESTS_DIR, RequestStore, RuleWorkflow, serveWorkflow, WorkflowError, type RunningService } from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

const PERSON = { kind: "person", name: "captain" } as const;
const AGENT = { kind: "agent", name: "claude" } as const;
const TARGET = { route: "/settings", scope: "here", name: "Button", element: "youi:demo/component/button", file: "app/settings/index.tsx", line: 12, box: { x: 10, y: 20, width: 80, height: 32 }, page: { width: 1440, height: 900 } } as const;

describe("the request store", () => {
  const root = mkdtempSync(join(tmpdir(), "youi-requests-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-22T12:00:00Z");
  let n = 0;
  const store = new RequestStore(root, "demo-app", { now: () => new Date((clock += 60_000)), newId: () => `r-${String(++n).padStart(10, "0")}` });

  test("a request is a youi.request/v1 file in the product's .youi/requests, listed newest first", async () => {
    const first = await store.create(PERSON, { kind: "change", body: "  Make this the primary button  ", target: TARGET });
    const second = await store.create(AGENT, { kind: "comment", body: "Is this the right label?", target: { ...TARGET, scope: "element" } });
    expect(first).toMatchObject({ id: "r-0000000001", project: "demo-app", status: "open", body: "Make this the primary button", author: PERSON, thread: [] });
    const onDisk = JSON.parse(await readFile(join(root, REQUESTS_DIR, "r-0000000001.json"), "utf8")) as unknown;
    expect(RequestDoc.parse(onDisk)).toEqual(first);
    expect((await store.list()).requests.map((r) => r.id)).toEqual([second.id, first.id]);
    await expect(store.create(PERSON, { kind: "comment", body: "   ", target: TARGET })).rejects.toThrow(/needs words/);
  });

  test("anyone replies; an agent marks a request addressed but never closes or reopens it; a person does", async () => {
    const id = "r-0000000001";
    await store.reply(AGENT, id, "Which variant: primary or default?");
    await store.reply(PERSON, id, "primary");
    const addressed = await store.setStatus(AGENT, id, "addressed", "Changed to variant=\"primary\" in app/settings/index.tsx:12");
    expect(addressed.status).toBe("addressed");
    expect(addressed.thread.map((e) => [e.author.kind, e.status ?? null, e.body])).toEqual([
      ["agent", null, "Which variant: primary or default?"],
      ["person", null, "primary"],
      ["agent", "addressed", "Changed to variant=\"primary\" in app/settings/index.tsx:12"],
    ]);
    await expect(store.setStatus(AGENT, id, "closed")).rejects.toThrow(/cannot close or reopen a request: mark it addressed, and a person closes it/);
    await expect(store.setStatus(AGENT, id, "open")).rejects.toThrow(/cannot close or reopen/);
    expect((await store.setStatus(PERSON, id, "closed", "Looks right")).status).toBe("closed");
    await expect(store.setStatus(AGENT, id, "addressed")).rejects.toThrow(/is closed: a person reopens it first/);
    await expect(store.setStatus(PERSON, id, "closed")).rejects.toThrow(/already closed/);
    expect((await store.setStatus(PERSON, id, "open", "The dark one is still grey")).status).toBe("open");
  });

  test("an id that is not one never reaches a path; a bad file is listed as unreadable, never dropped or rewritten", async () => {
    for (const bad of ["../escape", "r-zz", "r-0000000001/../../x"]) await expect(store.get(bad)).rejects.toBeInstanceOf(WorkflowError);
    await expect(store.get("r-ffffffffff")).rejects.toThrow(/no request r-ffffffffff/);
    const dir = join(root, REQUESTS_DIR);
    await writeFile(join(dir, "r-aaaaaaaaaa.json"), "{ not json");
    await writeFile(join(dir, "r-bbbbbbbbbb.json"), JSON.stringify({ schema: "youi.request/v1", id: "r-bbbbbbbbbb" }));
    await writeFile(join(dir, "r-cccccccccc.json"), JSON.stringify({ ...(await store.get("r-0000000002")), id: "r-dddddddddd" }));
    await writeFile(join(dir, "notes.txt"), "ignored");
    const { requests, unreadable } = await store.list();
    expect(requests).toHaveLength(2);
    expect(unreadable.map((u) => u.file)).toEqual([".youi/requests/r-aaaaaaaaaa.json", ".youi/requests/r-bbbbbbbbbb.json", ".youi/requests/r-cccccccccc.json"]);
    expect(unreadable[2]!.reason).toBe("its id is not its file name");
    expect(await readFile(join(dir, "r-aaaaaaaaaa.json"), "utf8")).toBe("{ not json");
  });
});

describe("requests through the loopback service", () => {
  const KEY = "test-session-key";
  let box: Sandbox;
  let service: RunningService;
  beforeAll(async () => {
    box = await sandbox();
    service = await serveWorkflow({ workflow: new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new MemoryStore() }), actor: PERSON, sessionKey: KEY, port: 0 });
  });
  afterAll(async () => {
    await service.close();
    await box.dispose();
  });

  function call(method: string, path: string, body?: unknown, key: string | null = KEY): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, service.url), { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "x-youi-session": key } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  test("the hub files a request, replies and closes it, each write with the session key; the file lands in the product", async () => {
    expect((await call("POST", "/api/requests", { kind: "change", body: "Bigger", target: TARGET }, null)).status).toBe(401);
    expect((await call("POST", "/api/requests", { kind: "change", body: "Bigger", target: { route: "/x" } })).status).toBe(400);
    const created = await call("POST", "/api/requests", { kind: "change", body: "Bigger", target: TARGET });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(await readdir(join(box.project, REQUESTS_DIR))).toEqual([`${id}.json`]);
    expect((await call("POST", `/api/requests/${id}/replies`, { body: "How much bigger?" })).json.thread).toHaveLength(1);
    expect((await call("POST", `/api/requests/${id}/status`, { status: "closed", body: "Done" })).json.status).toBe("closed");
    const listed = await call("GET", "/api/requests", undefined, null);
    expect(listed.json).toMatchObject({ requests: [{ id, status: "closed" }], unreadable: [] });
    expect((await call("GET", "/api/requests/r-0000000000", undefined, null)).status).toBe(404);
    expect((await call("GET", "/api/requests/..%2Fescape", undefined, null)).status).toBe(404);
    // Before and after by this service's URL, never a path on disk; no picture is a 404.
    const compare = await call("GET", `/api/requests/${id}/compare`, undefined, null);
    expect(compare.json).toEqual({ before: null, after: null });
    expect((await call("GET", `/api/requests/${id}/after.webp`, undefined, null)).status).toBe(404);

    mkdirSync(join(box.project, ".youi/screens"), { recursive: true });
    writeFileSync(join(box.project, ".youi/screens/settings.light.webp"), "PICTURE");
    const pictured = (await call("POST", "/api/requests", { kind: "comment", body: "Spacing", target: TARGET })).json.id as string;
    const urls = (await call("GET", `/api/requests/${pictured}/compare`, undefined, null)).json as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(urls.before).toMatchObject({ url: `/api/requests/${pictured}/before.webp`, box: TARGET.box });
    expect(urls.after).toMatchObject({ url: `/api/requests/${pictured}/after.webp`, found: false });
    expect(JSON.stringify(urls)).not.toContain(box.project);
    const picture = await new Promise<{ status: number; type: string | undefined; body: string }>((done, fail) => {
      request(new URL(`/api/requests/${pictured}/before.webp`, service.url), (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => done({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }));
      }).on("error", fail).end();
    });
    expect(picture).toEqual({ status: 200, type: "image/webp", body: "PICTURE" });
  });
});

describe("before and after", () => {
  const root = mkdtempSync(join(tmpdir(), "youi-requests-compare-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const screens = join(root, ".youi/screens");
  let clock = Date.parse("2026-10-22T12:00:00Z");
  const store = new RequestStore(root, "acme", { now: () => new Date((clock += 60_000)) });
  const places = (box: { x: number; y: number; width: number; height: number }) => JSON.stringify({ schema: "youiyoux.places/v1", size: { width: 1440, height: 1800 }, places: [{ name: "Button", file: "app/settings/index.tsx", line: 12, box }] });

  test("filing keeps the screen as it was; after a capture the component is found again by its line, and the picture says if it came after the work", async () => {
    mkdirSync(screens, { recursive: true });
    writeFileSync(join(screens, "settings.light.webp"), "BEFORE");
    writeFileSync(join(screens, "settings.places.json"), places({ x: 10, y: 20, width: 80, height: 32 }));
    const filed = await store.create(PERSON, { kind: "change", body: "Bigger", target: TARGET });
    expect(filed.before).toBe(`${filed.id}.before.webp`);
    expect(readFileSync(join(root, REQUESTS_DIR, filed.before!), "utf8")).toBe("BEFORE");

    // Not captured since it was filed: after is the same picture, and says it is no newer.
    const older = new Date(Date.parse(filed.createdAt) - 5_000);
    utimesSync(join(screens, "settings.light.webp"), older, older);
    let compared = await store.compare(filed.id);
    expect(compared.before).toMatchObject({ box: TARGET.box, page: TARGET.page, at: filed.createdAt });
    expect(compared.after).toMatchObject({ found: true, sinceFiled: false });

    // The agent made the change and captured the route again (before marking it addressed): a new picture, the button moved and grew.
    writeFileSync(join(screens, "settings.light.webp"), "AFTER");
    writeFileSync(join(screens, "settings.places.json"), places({ x: 10, y: 40, width: 120, height: 44 }));
    const captured = new Date(Date.parse(filed.createdAt) + 30_000);
    utimesSync(join(screens, "settings.light.webp"), captured, captured);
    const addressed = await store.setStatus(AGENT, filed.id, "addressed", "Bigger at app/settings/index.tsx:12");
    expect(Date.parse(addressed.updatedAt)).toBeGreaterThan(captured.getTime());
    compared = await store.compare(filed.id);
    expect(compared.after).toMatchObject({ file: join(screens, "settings.light.webp"), box: { x: 10, y: 40, width: 120, height: 44 }, page: { width: 1440, height: 1800 }, found: true, sinceFiled: true });

    // Reopened: the same picture predates the reopening, so it no longer shows new work.
    await store.setStatus(PERSON, filed.id, "open", "Not quite");
    expect((await store.compare(filed.id)).after!.sinceFiled).toBe(false);
    await store.setStatus(AGENT, filed.id, "addressed", "Again");
    expect(readFileSync(compared.before!.file, "utf8")).toBe("BEFORE");

    // Its line gone from the new places: shown where it was, and said so.
    writeFileSync(join(screens, "settings.places.json"), places({ x: 0, y: 0, width: 1, height: 1 }).replace('"line":12', '"line":99'));
    expect((await store.compare(filed.id)).after).toMatchObject({ box: TARGET.box, found: false });
  });

  test("with no captured screen there is nothing to compare, and a before that is not the request's own is ignored", async () => {
    const elsewhere = await store.create(PERSON, { kind: "comment", body: "Hm", target: { ...TARGET, route: "/never" } });
    expect(elsewhere.before).toBeUndefined();
    expect(await store.compare(elsewhere.id)).toEqual({ before: null, after: null });
    const file = join(root, REQUESTS_DIR, `${elsewhere.id}.json`);
    const other = (await store.list()).requests.find((r) => r.before)!;
    writeFileSync(file, JSON.stringify({ ...elsewhere, before: other.before }));
    expect((await store.compare(elsewhere.id)).before).toBeNull();
  });
});
