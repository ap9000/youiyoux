/**
 * `youiyoux behave` end to end: the real CLI on a copy of the fixture app, probing a fixture
 * server on a loopback port in real headless Chromium, storing runs that `youiyoux check` then
 * reads. Without consent it refuses with the plan's words before any browser opens.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import { behaviourFile } from "@youiyoux/workflow";
import { main } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
const DEMO = join(import.meta.dirname, "../../../examples/demo-design");

const MISSING = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false }).then(
  async (browser) => {
    await browser.close();
    return null;
  },
  (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
);
const HAVE_CHROMIUM = MISSING === null;
const GATE = process.env.YOUI_SECURITY_GATE === "1";
if (!HAVE_CHROMIUM) console.warn(`youiyoux behave tests ${GATE ? "FAIL" : "skipped"}: ${MISSING}`);
test.runIf(GATE && !HAVE_CHROMIUM)("security gate: youiyoux behave's browser tests need Chromium", () => {
  throw new Error(`YOUI_SECURITY_GATE is set and Chromium couldn't be launched (${MISSING}): nothing was tested`);
});

let out = "";
let err = "";
let dir = "";
let app = "";
let design = "";
let server: Server;
let base = "";
const requests: string[] = [];
const MENU = (id: string, closes: boolean) =>
  `<button aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" onclick="const m=document.getElementById('${id}');m.hidden=false;m.querySelector('li').focus()">Actions</button><ul role="menu" id="${id}" hidden onkeydown="${closes ? "if (event.key === 'Escape') this.hidden = true" : ""}"><li role="menuitem" tabindex="-1">Rename</li></ul>`;
const PAGES: Record<string, string> = { "/": MENU("m1", true), "/settings": MENU("m2", false) };

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const body = PAGES[req.url ?? ""];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
  dir = await mkdtemp(join(tmpdir(), "youi-behave-cli-"));
  app = join(dir, "app");
  design = join(dir, "design");
  await cp(FIXTURE, app, { recursive: true });
  await rm(join(app, "app/broken.tsx"));
  await cp(DEMO, design, { recursive: true });
  await writeFile(join(design, "rules/popup.escape.rule.yaml"), ["schema: youi.rule/v1", "id: youi:demo/rule/popup.escape", "title: Esc closes popups", "severity: error", "statement: Esc closes every popup.", "agent: Close popups on Esc.", "check:", "  engine: behaviour", "  id: dismiss-escape", ""].join("\n"));
  await mkdir(join(app, ".youi/screens"), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const screens = (consent: boolean, list = [{ route: "/", path: "/" }, { route: "/settings", path: "/settings" }]) =>
  writeFile(join(app, ".youi/screens/screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "the fixture", capturedAt: "", viewport: { width: 800, height: 600 }, base, ...(consent ? { behaviour: { allowedOrigin: base } } : {}), screens: list }));
const run = async (...args: string[]): Promise<number> => {
  out = "";
  err = "";
  return main([...args, "--project", app, "--design", design]);
};
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("youiyoux behave without consent", () => {
  test("is refused with the plan's words, exit 1, before anything opens", async () => {
    await screens(false);
    const before = requests.length;
    expect(await run("behave")).toBe(1);
    expect(err).toContain("Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data. Probing isn't switched on for this app.");
    expect(err).toContain(`Next: add "behaviour": { "allowedOrigin": "${base}" } to .youi/screens/screens.json (by hand for now; a switch in the hub is coming).`);
    // Never pointing at a hub tab that doesn't exist yet.
    expect(err).not.toContain("Behaviour tab");
    expect(requests.length).toBe(before);
    expect(existsSync(join(app, ".youi/behaviour"))).toBe(false);
  });

  test("with no screens captured, or a route screens.json doesn't list, it says what to do", async () => {
    expect(await run("behave")).toBe(1);
    expect(err).toContain("no screens are captured yet");
    await screens(true);
    expect(await run("behave", "--route", "/nowhere")).toBe(1);
    expect(err).toContain("screens.json has no route /nowhere: it lists /, /settings");
  });

  test("with consent and rules but no screens listed, nothing is checked: refused, exit 1, never 0 checks passed", async () => {
    await screens(true, []);
    const before = requests.length;
    expect(await run("behave")).toBe(1);
    expect(err).toContain("screens.json lists no screens, so there is nothing to probe: add the app's screens to .youi/screens/screens.json");
    expect(out).not.toContain("passed");
    expect(requests.length).toBe(before);
  });

  test("with no behaviour rules on, there is nothing to probe: exit 0, no browser", async () => {
    await rm(join(design, "rules/popup.escape.rule.yaml"));
    await screens(true);
    const before = requests.length;
    expect(await run("behave")).toBe(0);
    expect(plain(out)).toContain("No behaviour rules are on in this System, so there is nothing to probe.");
    expect(requests.length).toBe(before);
  });
});

describe.skipIf(!HAVE_CHROMIUM)("youiyoux behave in a real browser", () => {
  test("probes, stores, prints; check then reads what it stored; exit codes follow the matrix", async () => {
    await screens(true);
    // One route that passes: stored, exit 0.
    expect(await run("behave", "--route", "/")).toBe(0);
    expect(plain(out)).toMatch(/\/\n  1 popup trigger found by ARIA markers\. .*\n  ✓ passed  menu 'Actions'  dismiss-escape \(popup\.escape\)  Esc closed the menu/);
    expect(plain(out)).toContain("✓ 1 check passed on 1 route");
    expect(existsSync(join(app, behaviourFile("/")))).toBe(true);
    // check: /settings has never been probed, so the rule is incomplete, naming it.
    expect(await run("check", "--rule", "popup.escape")).toBe(1);
    expect(plain(out)).toContain("! rule popup.escape did not run: no fresh, complete probe results on 1 of 2 routes: /settings was never probed. Run youiyoux behave --route /settings");
    // Every route: /settings' menu ignores Esc, an error-severity failure: exit 1.
    expect(await run("behave")).toBe(1);
    const text = plain(out);
    expect(text).toContain("✖ failed  menu 'Actions'  dismiss-escape (popup.escape)  Esc did nothing: the menu was still open after 1.5 s");
    expect(text).toContain("→ Close the menu when Esc is pressed while focus is in it");
    expect(text).toContain("✖ 1 error · 0 warnings: fix each (→), then run youiyoux behave again");
    const stored = JSON.parse(await readFile(join(app, behaviourFile("/settings")), "utf8")) as { results: Array<{ state: string }> };
    expect(stored.results.map((r) => r.state)).toEqual(["failed"]);
    // check now has fresh results on every route: the rule ran, with one error.
    expect(await run("check", "--rule", "popup.escape", "--json")).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ errors: 1, incomplete: false, behaviour: [{ rule: "youi:demo/rule/popup.escape", result: { route: "/settings", state: "failed" } }] });
    // JSON and GitHub formats of behave.
    expect(await run("behave", "--route", "/settings", "--json")).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ errors: 1, incomplete: false, rules: ["youi:demo/rule/popup.escape"], routes: [{ route: "/settings", problem: null, run: { state: "probed" } }] });
    expect(await run("behave", "--route", "/settings", "--format", "github")).toBe(1);
    expect(out).toMatch(/^::error title=youi popup\.escape::\/settings menu 'Actions' dismiss-escape: Esc did nothing/m);
    // A scanned file changes: what check read is stale now, so incomplete, not an error.
    await writeFile(join(app, "app/settings/index.tsx"), `${await readFile(join(app, "app/settings/index.tsx"), "utf8")}\n// edited\n`);
    expect(await run("check", "--rule", "popup.escape", "--json")).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ errors: 0, incomplete: true, behaviour: [] });
  }, 120_000);
});
