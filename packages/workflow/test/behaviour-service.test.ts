/**
 * Behaviour probes from the hub (slice 4): the run, read and consent routes. A sandboxed product
 * with a behaviour rule (behaviour-sandbox.ts); the probe is a stand-in (no browser) except in the
 * last block, which runs real Chromium against a fixture app.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BehaviourRouteRun } from "@youiyoux/core";
import { launchBrowser } from "@youiyoux/detect";
import { loadProject } from "@youiyoux/scanner";
import { behaviourFile, behaviourStanding, runBehaviour, type BehaviourSetup } from "../src/index.ts";
import { BASE, behaviourSandbox, control, HOSTILE, KEY, RULE_ID, tick, TOOL, UNSAFE } from "./behaviour-sandbox.ts";

const s = behaviourSandbox();

describe("the run route", () => {
  test("needs the session key and a loopback origin, takes a route and a target identity only (never a URL, path or file), and refuses without consent before any browser opens", async () => {
    control.probes = 0;
    expect((await s.call("POST", "/api/behaviour/run", {}, { route: "/x" })).status).toBe(401);
    expect((await s.call("POST", "/api/behaviour/run", { "x-youi-session": "guess" }, { route: "/x" })).status).toBe(401);
    expect((await s.call("POST", "/api/behaviour/run", { "x-youi-session": KEY, origin: "https://evil.example" }, { route: "/x" })).status).toBe(403);
    for (const body of [{ route: "/x", url: "http://127.0.0.1:9/x" }, { route: "/x", path: "/x" }, { route: "/x", file: "app/x.tsx" }, { url: "http://127.0.0.1:9/x" }, { route: "//evil.example/x" }, { route: "http://127.0.0.1:9/x" }, { route: "/x", target: { component: "UserMenu", file: "components/user-menu.tsx" } }, { route: "/x", target: { selector: "button" } }]) {
      const refused = await s.write("/api/behaviour/run", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    s.screens(null);
    const off = await s.write("/api/behaviour/run", { route: "/x" });
    expect(off.status).toBe(403);
    expect(off.json.error).toMatch(/^Probes click buttons that open menus and dialogs in your running app\. Use a dev app with test data\. Probing isn't switched on for this app\. Next: switch probing on in the hub/);
    // Consent for another origin than base's is none.
    s.screens({ allowedOrigin: "http://127.0.0.1:8", generation: 2 });
    expect((await s.write("/api/behaviour/run", { route: "/x" })).status).toBe(403);
    s.consentOn();
    expect((await s.write("/api/behaviour/run", { route: "/elsewhere" })).status).toBe(404);
    expect(control.probes).toBe(0);
    expect(readFileSync(s.screensFile(), "utf8")).not.toContain("http://127.0.0.1:9/x");
  });

  test("one run at a time: a second is told one is already going; the hub polls how it goes", async () => {
    let release!: () => void;
    control.gate = new Promise((done) => (release = done));
    control.probes = 0;
    try {
      const first = await s.write("/api/behaviour/run", { route: "/x" });
      expect(first.status).toBe(202);
      expect(first.json.running).toMatchObject({ route: "/x", target: null, by: "person" });
      for (let i = 0; i < 100 && control.probes === 0; i++) await tick();
      const second = await s.write("/api/behaviour/run", { route: "/y" });
      expect(second.status).toBe(409);
      expect(second.json.error).toMatch(/^a behaviour run is already going for this app \(\/x, started /);
      expect((await s.call("GET", "/api/behaviour/run")).json.running).toMatchObject({ route: "/x", popups: 2 });
    } finally {
      release();
      control.gate = null;
    }
    for (let i = 0; i < 400 && (await s.call("GET", "/api/behaviour/run")).json.running !== null; i++) await tick();
    expect((await s.call("GET", "/api/behaviour/run")).json).toMatchObject({ running: null, last: { route: "/x", problem: null, runId: expect.any(String) } });
  });
});

describe("reading results", () => {
  test("GET /api/behaviour gives the stored run held to now, page text never raw even when the file was edited by hand, and a stale result never counts", async () => {
    control.verdict = "failed";
    await s.runFromHub();
    const file = join(s.box.project, behaviourFile("/x"));
    const stored = JSON.parse(readFileSync(file, "utf8")) as BehaviourRouteRun;
    // A hand-edited (or older youiyoux's) file: raw page text in its display strings.
    stored.coverage = `covered ${HOSTILE}`;
    for (const r of stored.results) Object.assign(r, { why: `why ${HOSTILE}`, fix: `fix ${HOSTILE}`, info: [`info ${HOSTILE}`] });
    writeFileSync(file, JSON.stringify(stored));
    const view = await s.call("GET", "/api/behaviour?route=/x");
    expect(view.status).toBe(200);
    const text = JSON.stringify(view.json);
    expect(text).not.toMatch(/\\u001b|\\u202e|\\n/);
    const results = view.json.results as Array<Record<string, unknown>>;
    expect(UNSAFE.test(String(results[0]!.why))).toBe(false);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ index: 0, state: "failed", stale: [], counts: true, check: "dismiss-escape" });
    expect(view.json).toMatchObject({ route: "/x", rules: [{ id: RULE_ID, check: "dismiss-escape", severity: "error" }], consent: { on: true }, running: null });
    // The code changes: every result is stale and none counts.
    const app = join(s.box.project, "app/broken.tsx");
    const was = readFileSync(app, "utf8");
    writeFileSync(app, `${was}\n// changed\n`);
    try {
      const stale = (await s.call("GET", "/api/behaviour?route=/x")).json.results as Array<{ stale: string[]; counts: boolean }>;
      expect(stale.every((r) => r.stale.includes("the code changed") && r.counts === false)).toBe(true);
    } finally {
      writeFileSync(app, was);
    }
    expect((await s.call("GET", "/api/behaviour?route=//x")).status).toBe(400);
    expect((await s.call("GET", "/api/behaviour?route=/nowhere")).status).toBe(404);
  });

  test("GET /api/screens/behaviour says whether probing is on, for which origin, and whether base still matches it", async () => {
    s.screens(null);
    expect((await s.call("GET", "/api/screens/behaviour")).json).toMatchObject({ screens: true, on: false, origin: BASE, allowedOrigin: null, matches: false, why: expect.stringMatching(/^Probes click buttons/), words: "Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data." });
    expect((await s.write("/api/screens/behaviour", { allow: true })).json).toEqual({ allowedOrigin: BASE });
    expect((await s.call("GET", "/api/screens/behaviour")).json).toMatchObject({ on: true, origin: BASE, allowedOrigin: BASE, matches: true, why: null });
    // A capture moved base: consent was for the old origin, and the tab asks again.
    const doc = JSON.parse(readFileSync(s.screensFile(), "utf8")) as Record<string, unknown>;
    writeFileSync(s.screensFile(), JSON.stringify({ ...doc, base: "http://127.0.0.1:7" }));
    expect((await s.call("GET", "/api/screens/behaviour")).json).toMatchObject({ on: false, origin: "http://127.0.0.1:7", allowedOrigin: BASE, matches: false });
    s.consentOn();
  });

  test("a component's run tests only its popups, and lists the others as not tested, so the screen doesn't read as checked", async () => {
    control.verdict = "passed";
    await s.runFromHub("/x", { component: "Toolbar" });
    const results = (await s.call("GET", "/api/behaviour?route=/x")).json.results as Array<{ target: { component: string }; state: string; why: string }>;
    expect(results.find((r) => r.target.component === "Toolbar")).toMatchObject({ state: "passed" });
    expect(results.find((r) => r.target.component === "UserMenu")).toMatchObject({ state: "incomplete", why: "not tested in this run: it probed only the popups of 'Toolbar'" });
    const project = await loadProject(s.box.project, { designRoot: s.box.design });
    const standing = await behaviourStanding(project, project.system.rules.filter((r) => r.check.engine === "behaviour"), TOOL);
    expect(standing.runs[0]).toMatchObject({ state: "incomplete" });
  });
});

// The scanner's own filter, with real Chromium: only the picked popup is clicked.
const MISSING = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false }).then(
  async (browser) => {
    await browser.close();
    return null;
  },
  (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
);
if (MISSING) console.warn(`behaviour service browser test skipped: ${MISSING}`);
describe.skipIf(MISSING !== null)("a component's run in a real browser", () => {
  let app: Server;
  let base = "";
  const opened: string[] = [];
  const MENU = (name: string, id: string) =>
    `<button aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" onclick="new Image().src='/opened-${id}';const m=document.getElementById('${id}');m.hidden=false;m.querySelector('li').focus()">${name}</button><ul role="menu" id="${id}" hidden onkeydown="if (event.key === 'Escape') this.hidden = true"><li role="menuitem" tabindex="-1">Item</li></ul>`;
  beforeAll(async () => {
    app = createServer((req, res) => {
      if (req.url?.startsWith("/opened-")) {
        opened.push(req.url.slice("/opened-".length));
        return void res.writeHead(200, { "content-type": "image/gif" }).end();
      }
      if (req.url !== "/x") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><body>${MENU("Open", "a")}${MENU("Stuck", "b")}</body>`);
    });
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });
  afterAll(() => app?.close());

  test("only the chosen popup is opened; the other is listed as not tested in this run", async () => {
    s.screens({ allowedOrigin: base, generation: 1 }, base);
    try {
      const project = await loadProject(s.box.project, { designRoot: s.box.design });
      const real: BehaviourSetup = { tool: TOOL, browser: () => launchBrowser(process.env.YOUI_CHROMIUM, { download: false }) };
      const { run } = await (await runBehaviour(project, real, { route: "/x", target: { component: null, accessibleName: "Open" }, by: "person" })).done;
      expect(new Set(opened)).toEqual(new Set(["a"]));
      expect(run.results.find((r) => r.target.accessibleName === "Open")).toMatchObject({ state: "passed" });
      expect(run.results.find((r) => r.target.accessibleName === "Stuck")).toMatchObject({ state: "incomplete", why: "not tested in this run: it probed only the popup 'Open' in plain markup (no component)" });
      expect(run.coverage).toMatch(/this run tested only the popup 'Open' in plain markup \(no component\) \(1\)/);
    } finally {
      s.consentOn();
    }
  }, 120_000);
});
