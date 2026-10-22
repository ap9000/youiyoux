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

test("screens login keeps the session outside the product, owner-only; capture then signs in with it", async () => {
  const { launchBrowser } = await import("@youiyoux/detect");
  const { sessionFile } = await import("@youiyoux/scanner");
  const { createServer } = await import("node:http");
  const { existsSync, statSync } = await import("node:fs");
  const { mkdir } = await import("node:fs/promises");
  const product = await mkdtemp(join(tmpdir(), "youi-login-"));
  const cache = await mkdtemp(join(tmpdir(), "youi-login-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  // The app: signing in sets a cookie; every request records whether it came signed in.
  const seen: string[] = [];
  const app = createServer((req, res) => {
    seen.push(`${req.url} ${/session=abc/.test(req.headers.cookie ?? "") ? "signed-in" : "signed-out"}`);
    res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><body style="margin:0"><p>app</p></body>');
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const browser = await launchBrowser(undefined, { download: false });
  try {
    // The person gives up: nothing is saved.
    expect(await main(["screens", "login", "--base", base, "--project", product], { login: { browser, signedIn: async () => false } })).toBe(1);
    const file = sessionFile(product);
    expect(existsSync(file)).toBe(false);
    // The person signs in (here, the app's cookie is set for them), then presses Enter.
    const signedIn = async (page: { context(): { addCookies(c: unknown[]): Promise<void> } }) => (await page.context().addCookies([{ name: "session", value: "abc", url: base }]), true);
    expect(await main(["screens", "login", "--base", base, "--project", product], { login: { browser, signedIn: signedIn as never } })).toBe(0);
    expect(file.startsWith(join(cache, "youiyoux", "sessions"))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).cookies).toEqual([expect.objectContaining({ name: "session", value: "abc" })]);
    expect(out).toContain(`Saved the session (1 cookies, storage for 0 sites) to ${file}, readable only by you`);

    await mkdir(join(product, ".youi/screens"), { recursive: true });
    await writeFile(join(product, ".youi/screens/screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "a test app", capturedAt: "", viewport: { width: 400, height: 300 }, screens: [{ route: "/", path: "/home" }] }));
    seen.length = 0;
    expect(await main(["screens", "capture", "--base", base, "--project", product])).toBe(0);
    expect(err).toContain(`signed in with the session youiyoux screens login saved (${file})`);
    expect(seen).toContain("/home signed-in");
  } finally {
    vi.unstubAllEnvs();
    await browser.close();
    app.close();
    await rm(product, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
}, 120_000);

test("screens login with no terminal to answer in says so instead of waiting", async () => {
  const tty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    expect(await main(["screens", "login", "--base", "http://127.0.0.1:9", "--project", dir])).toBe(1);
    expect(err).toContain("waits for you to sign in and press Enter: run it in a terminal");
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  }
});
