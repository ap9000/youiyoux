/** ui_render: the same render as `youiyoux render`, answered in plain lines with absolute image paths and a next step as a tool call. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newShotStats, SpecimenCache } from "@youiyoux/scanner";
import { eyesRepo, regressRadio, unlabelSearch, type EyesRepo } from "../../scanner/test/eyes-repo.ts";
import { createServer } from "../src/index.ts";

const SEARCH = "src/components/search-input.tsx";
let repo: EyesRepo;
let cache: SpecimenCache;
let client: Client;
const stats = newShotStats();

beforeAll(async () => {
  repo = eyesRepo();
  unlabelSearch(repo);
  cache = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-mcp-render-")));
  const server = createServer({ projectRoot: repo.dir, render: { cache, stats, download: false } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  repo.remove();
  rmSync(cache.dir, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name: "ui_render", arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0]!.text, isError: Boolean(result.isError) };
}

describe("ui_render", () => {
  test("a changed file: four screenshots, the accessibility issue, the diff against main, and the next step (c1)", async () => {
    const { text, isError } = await call({ target: SEARCH });
    expect(isError).toBe(false);
    const lines = text.split("\n");
    const shots = lines.map((l) => /^ {2}(light|dark) (1280|390): (.+\.png)$/.exec(l)).filter((m) => m !== null);
    expect(shots.map((m) => `${m[1]} ${m[2]}`)).toEqual(["light 1280", "light 390", "dark 1280", "dark 390"]);
    for (const m of shots) expect(isAbsolute(m[3]!) && existsSync(m[3]!)).toBe(true);
    const diffs = lines.map((l) => /^ {4}diff (light|dark) (1280|390): (.+\.png)$/.exec(l)).filter((m) => m !== null);
    expect(diffs).toHaveLength(4);
    for (const m of diffs) expect(existsSync(m[3]!)).toBe(true);
    expect(text).toMatch(/before\/after against main \([0-9a-f]{7}\): pixels changed/);
    expect(text).toMatch(/Form elements must have labels \(label, critical/);
    expect(lines.at(-1)).toBe(`next: fix the 1 accessibility issue (label), then call ui_render {"target":"${SEARCH}"} again`);
    expect(lines.length).toBeLessThan(25);
  }, 180_000);

  test("again, nothing changed: from the cache, nothing drawn (c2)", async () => {
    const before = { ...stats };
    const { text } = await call({ target: SEARCH });
    expect(text).toContain("from the cache: nothing it uses changed since it was last drawn");
    expect(stats.renders - before.renders).toBe(0);
    expect(stats.browsers - before.browsers).toBe(0);
    expect(stats.bundles - before.bundles).toBe(0);
    expect(stats.tailwindCompiles - before.tailwindCompiles).toBe(0);
  });

  test("no target: the changed components only, the others listed as unchanged", async () => {
    const { text } = await call({});
    expect(text.split("\n")[0]).toMatch(new RegExp(`^${SEARCH.replace(/[./]/g, "\\$&")}: 1 look`));
    expect(text).toMatch(/unchanged since main \([0-9a-f]{7}\), not re-rendered: 2 component files \(src\/components\/badge\.tsx, src\/components\/button\.tsx\)/);
  });

  test("an unknown base is said plainly", async () => {
    const { text } = await call({ target: SEARCH, base: "no-such-branch" });
    expect(text).toContain("no base: no-such-branch is not a commit in this repository");
  }, 180_000);
});


test("MCP explains omitted expression names without asking to fix correct components (c3)", async () => {
  const fixture = eyesRepo({ a11y: true });
  const server = createServer({ projectRoot: fixture.dir, render: { cache, download: false } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const local = new Client({ name: "a11y-test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(st), local.connect(ct)]);
    const result = await local.callTool({ name: "ui_render", arguments: { target: "LinkedButton" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("specimen-only: real usages pass aria-labelledby, which the specimen cannot supply");
    expect(text).toContain("pre-existing: already at main");
    expect(text.split("\n").at(-1)).not.toContain("fix the");
    regressRadio(fixture);
    const changed = await local.callTool({ name: "ui_render", arguments: { target: "RadioCard" } });
    const changedText = (changed.content as Array<{ text: string }>)[0]!.text;
    expect(changedText.split("\n").at(-1)).toContain("label");
    expect(changedText).not.toContain("specimen-only");
  } finally { await local.close(); fixture.remove(); }
}, 180_000);
