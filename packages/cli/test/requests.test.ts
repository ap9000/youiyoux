/** `youiyoux requests`: an agent without MCP reads the requests on the screens, replies and marks them addressed. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { RequestStore } from "@youiyoux/workflow";
import { main } from "../src/index.ts";

let dir: string;
let id: string;
let out = "";
let err = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-cli-requests-"));
  id = (await new RequestStore(dir, "acme").create({ kind: "person", name: "captain" }, { kind: "change", body: "Make it primary", target: { route: "/settings", scope: "here", name: "Button", file: "app/settings.tsx", line: 12 } })).id;
});
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => vi.restoreAllMocks());

test("lists open requests with the line, the ask and the command that answers each", async () => {
  expect(await main(["requests", "--project", dir])).toBe(0);
  expect(out).toContain(id);
  expect(out).toContain("app/settings.tsx:12");
  expect(out).toContain("“Make it primary”");
  expect(out).toContain(`then run youiyoux requests addressed ${id} --message "<what you changed, with file:line>"`);
  out = "";
  expect(await main(["requests", "--project", dir, "--status", "closed"])).toBe(0);
  expect(out).toContain("No closed requests on the screens.");
  expect(await main(["requests", "--project", dir, "--status", "done"])).toBe(2);
});

test("marks one addressed as an agent with what changed; without a message it says what to pass", async () => {
  expect(await main(["requests", "addressed", id, "--project", dir])).toBe(2);
  expect(err).toContain(`youiyoux requests addressed ${id} --message <what you changed, with file:line>`);
  expect(await main(["requests", "addressed", id, "--project", dir, "--message", "variant=\"primary\" at app/settings.tsx:12", "--json"])).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ id, status: "addressed" });
  const file = JSON.parse(await readFile(join(dir, `.youi/requests/${id}.json`), "utf8")) as { thread: Array<{ author: { kind: string; name: string }; status?: string }> };
  expect(file.thread.at(-1)).toMatchObject({ author: { kind: "agent", name: "youiyoux CLI" }, status: "addressed" });
  expect(await main(["requests", "close", id, "--project", dir])).toBe(2);
});

test("screens capture looks in the product a config names, not beside the config", async () => {
  const tool = join(import.meta.dirname, "../../..");
  const pilot = await mkdtemp(join(tmpdir(), "youi-pilot-"));
  const config = JSON.parse(await readFile(join(tool, "examples/demo-app/youi.project.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(pilot, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, root: join(tool, "examples/demo-app"), source: { path: join(tool, "examples/demo-design") } }));
  expect(await main(["screens", "capture", "--base", "http://127.0.0.1:5173", "--project", pilot])).toBe(1);
  expect(err).toContain(`no screens.json in ${join(tool, "examples/demo-app/.youi/screens")}`);
  await rm(pilot, { recursive: true, force: true });
});
