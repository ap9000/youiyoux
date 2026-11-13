/**
 * Behaviour probes, the service's side: consent read from screens.json at the moment of probing,
 * written only by the authenticated service write (its origin from base, never the request), the
 * run kept under the real .youi/, and evidence paths that never leave it. Real headless Chromium
 * against fixture apps on loopback ports.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BehaviourRouteRun } from "@youiyoux/core";
import { launchBrowser } from "@youiyoux/detect";
import { captureScreens } from "@youiyoux/scanner";
import { behaviourFile, LiveApp, MemoryStore, probeBehaviour, readBehaviourRun, readEvidence, readYouiFile, writeYouiFile, RuleWorkflow, serveWorkflow, setBehaviourConsent, WorkflowError, writeEvidence, type RunningService } from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

/**
 * Whether there is a Chromium, found exactly as these tests (and youiyoux) launch it:
 * launchBrowser(process.env.YOUI_CHROMIUM, { download: false }), i.e. YOUI_CHROMIUM when it is set,
 * else the headless shell of this playwright-core (what CI installs with `playwright-core install
 * chromium-headless-shell`), never downloading. Present when that launch works.
 */
const MISSING = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false }).then(
  async (browser) => {
    await browser.close();
    return null;
  },
  (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
);
const HAVE_CHROMIUM = MISSING === null;
/** YOUI_SECURITY_GATE=1 (CI): without Chromium the browser security tests fail rather than skip. */
const GATE = process.env.YOUI_SECURITY_GATE === "1";
if (!HAVE_CHROMIUM) console.warn(`behaviour probe tests ${GATE ? "FAIL" : "skipped"}: ${MISSING}`);
test.runIf(GATE && !HAVE_CHROMIUM)("security gate: probing's browser tests need Chromium", () => {
  throw new Error(`YOUI_SECURITY_GATE is set and Chromium couldn't be launched (${MISSING}): nothing was tested`);
});

// focus-return isn't decided yet: these runs stop once the popup is opened and identified (dismiss-escape, which decides, is tested below).
const CHECKS = [{ rule: "youi:demo/rule/menus-return", check: "focus-return" as const, digest: "0123456789ab" }];
const FINGERPRINT = { app: "abcdef012345", tool: "youiyoux@test" };
const scratch = mkdtempSync(join(tmpdir(), "youi-behaviour-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A product root with screens.json; `doc` overrides its fields. */
function product(name: string, doc: Record<string, unknown> = {}, screens = [{ route: "/menu", path: "/menu" }]): string {
  const root = join(scratch, name);
  mkdirSync(join(root, ".youi/screens"), { recursive: true });
  writeFileSync(join(root, ".youi/screens/screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "app", source: "a test app", capturedAt: "", viewport: { width: 800, height: 600 }, screens, ...doc }, null, 2));
  return root;
}
const screensOf = (root: string) => JSON.parse(readFileSync(join(root, ".youi/screens/screens.json"), "utf8")) as Record<string, unknown>;
/** A browser that must never be used: every refusal happens before anything opens. */
const NO_BROWSER = new Proxy({}, { get: () => { throw new Error("the browser was used"); } }) as unknown as Browser;
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(WorkflowError);
  return (error as WorkflowError).message;
};

describe("consent", () => {
  test("switching probing on binds it to the origin of base, keeps the rest of screens.json, and off takes it away; every switch is a new generation", async () => {
    const root = product("on-off", { base: "http://localhost:5173/app", note: "kept" });
    expect(await setBehaviourConsent(root, true)).toEqual({ allowedOrigin: "http://localhost:5173" });
    expect(screensOf(root)).toMatchObject({ base: "http://localhost:5173/app", note: "kept", behaviour: { allowedOrigin: "http://localhost:5173", generation: 1 } });
    expect(await setBehaviourConsent(root, false)).toEqual({ allowedOrigin: null });
    expect(screensOf(root).behaviour).toEqual({ generation: 2 });
    expect(screensOf(root).note).toBe("kept");
    // Back on is not the consent it was: a probe that began under generation 1 can tell.
    await setBehaviourConsent(root, true);
    expect(screensOf(root).behaviour).toEqual({ allowedOrigin: "http://localhost:5173", generation: 3 });
    // Never for an app that isn't on this machine, or with nowhere to point it.
    expect(await refusal(setBehaviourConsent(product("remote", { base: "http://example.com" }), true))).toMatch(/on this machine only/);
    expect(await refusal(setBehaviourConsent(product("nobase"), true))).toMatch(/does not say where the app runs/);
  });

  test("screens.json writers take turns under one lock; a dead holder's lock is broken", async () => {
    const root = product("locked", { base: "http://localhost:5173" });
    const lock = join(root, ".youi/screens/screens.json.lock");
    // A live holder (this process): the write waits until it lets go.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), id: "ab".repeat(8) }));
    let done = false;
    const waiting = setBehaviourConsent(root, true).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(screensOf(root)).not.toHaveProperty("behaviour");
    rmSync(lock);
    await waiting;
    expect(screensOf(root).behaviour).toEqual({ allowedOrigin: "http://localhost:5173", generation: 1 });
    // A holder that is gone: broken, and the write goes on. (A live one is never broken: scanner's screens-lock test.)
    const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    writeFileSync(lock, JSON.stringify({ pid: dead, host: hostname(), id: "cd".repeat(8) }));
    await setBehaviourConsent(root, false);
    expect(screensOf(root).behaviour).toEqual({ generation: 2 });
    expect(existsSync(lock)).toBe(false);
  });

  test("probing is refused, before any browser opens: no consent, consent for another origin, a base off this machine, a path off the app", async () => {
    const probe = (root: string) => probeBehaviour({ root, route: "/menu", browser: NO_BROWSER, checks: CHECKS, fingerprint: FINGERPRINT });
    expect(await refusal(probe(product("none", { base: "http://127.0.0.1:5173" })))).toMatch(/^Probes click buttons that open menus and dialogs in your running app\. Use a dev app with test data\. Probing isn't switched on/);
    expect(await refusal(probe(product("other", { base: "http://127.0.0.1:5173", behaviour: { allowedOrigin: "http://127.0.0.1:5174" } })))).toMatch(/switched on for http:\/\/127\.0\.0\.1:5174, but the app now runs at http:\/\/127\.0\.0\.1:5173/);
    expect(await refusal(probe(product("remote-base", { base: "http://10.1.2.3:5173", behaviour: { allowedOrigin: "http://10.1.2.3:5173" } })))).toMatch(/on this machine only/);
    expect(await refusal(probe(product("off-path", { base: "http://127.0.0.1:5173", behaviour: { allowedOrigin: "http://127.0.0.1:5173" } }, [{ route: "/menu", path: "//evil.example/menu" }])))).toMatch(/must start with a single \//);
    expect(existsSync(join(scratch, "none/.youi/behaviour"))).toBe(false);
  });
});

describe("only a decided check is stored passed or failed", () => {
  /** A probe that says it decided `check` (no browser): what the storage guards must refuse unless the check is decided. */
  const saying = (check: "dismiss-escape" | "focus-return", state: "passed" | "failed") =>
    (async ({ route }: { route: string }) => ({
      url: "http://127.0.0.1:9/x",
      state: "probed" as const,
      why: null,
      fix: null,
      coverage: "1 popup trigger found by ARIA markers.",
      targets: [{ key: { route, pattern: "menu-button" as const, component: null, accessibleName: "More" }, found: { pattern: "menu-button" as const, component: null, accessibleName: "More", via: "dom" as const, frames: [], domPath: "button", box: { x: 0, y: 0, width: 10, height: 10 } }, scenarios: [{ check, state, popup: { state: "open" as const, how: "aria-controls" as const, role: "menu", domPath: "ul" }, why: "decided", fix: "fix it", info: [], index: 0 }] }],
    })) as unknown as NonNullable<Parameters<typeof probeBehaviour>[0]["probe"]>;

  test("a pass or fail for a check this youiyoux doesn't decide is refused, and nothing is stored; dismiss-escape's is kept", async () => {
    const root = product("decided-guard", { base: "http://127.0.0.1:9", behaviour: { allowedOrigin: "http://127.0.0.1:9" } }, [{ route: "/x", path: "/x" }]);
    for (const state of ["passed", "failed"] as const) {
      expect(await refusal(probeBehaviour({ root, route: "/x", browser: NO_BROWSER, checks: CHECKS, fingerprint: FINGERPRINT, probe: saying("focus-return", state) }))).toMatch(/doesn't decide/);
      expect(existsSync(join(root, behaviourFile("/x")))).toBe(false);
    }
    const kept = await probeBehaviour({ root, route: "/x", browser: NO_BROWSER, checks: [{ rule: "youi:demo/rule/menus-close", check: "dismiss-escape", digest: "0123456789ab" }], fingerprint: FINGERPRINT, probe: saying("dismiss-escape", "failed") });
    expect(kept.run.results.map((r) => r.state)).toEqual(["failed"]);
  });
});

describe("the service write", () => {
  let box: Sandbox;
  let service: RunningService;
  const KEY = "test-session-key";
  beforeAll(async () => {
    box = await sandbox();
    const workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new MemoryStore(), decisionsKey: join(box.project, "..", "decisions.key") });
    service = await serveWorkflow({ workflow, actor: { kind: "person", name: "captain" }, sessionKey: KEY, port: 0 });
  });
  afterAll(async () => {
    await service.close();
    await box.dispose();
  });
  const call = (headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request(new URL("/api/screens/behaviour", service.url), { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || "{}") as Record<string, unknown> }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  test("POST /api/screens/behaviour needs the session key and a loopback origin, takes no origin, and binds consent to base", async () => {
    const file = join(box.project, ".youi/screens/screens.json");
    mkdirSync(join(box.project, ".youi/screens"), { recursive: true });
    writeFileSync(file, JSON.stringify({ schema: "youiyoux.screens/v1", project: "expo-fixture", source: "a test app", capturedAt: "", base: "http://localhost:5173", viewport: { width: 800, height: 600 }, screens: [{ route: "/", path: "/" }] }));
    expect((await call({}, { allow: true })).status).toBe(401);
    expect((await call({ "x-youi-session": "guess" }, { allow: true })).status).toBe(401);
    expect((await call({ "x-youi-session": KEY, origin: "https://evil.example" }, { allow: true })).status).toBe(403);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("behaviour");
    // An origin in the body is refused, not used.
    const named = await call({ "x-youi-session": KEY }, { allow: true, allowedOrigin: "http://localhost:9999" });
    expect(named.status).toBe(400);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("behaviour");
    const on = await call({ "x-youi-session": KEY, origin: "http://localhost:4000" }, { allow: true });
    expect(on).toEqual({ status: 200, json: { allowedOrigin: "http://localhost:5173" } });
    expect(JSON.parse(readFileSync(file, "utf8")).behaviour).toEqual({ allowedOrigin: "http://localhost:5173", generation: 1 });
    expect((await call({ "x-youi-session": KEY }, { allow: false })).json).toEqual({ allowedOrigin: null });
  });
});

describe("evidence and run files stay inside the real .youi/", () => {
  test("a path through a link, a linked file, a linked .youi or anything not under .youi/ is refused, for reading and writing", async () => {
    const root = product("evidence");
    const outside = mkdtempSync(join(tmpdir(), "youi-outside-"));
    try {
      await writeEvidence(root, ".youi/behaviour/shots/a.png", Buffer.from([1, 2, 3]));
      expect([...(await readEvidence(root, ".youi/behaviour/shots/a.png"))]).toEqual([1, 2, 3]);
      symlinkSync(outside, join(root, ".youi/behaviour/escape"));
      await expect(writeEvidence(root, ".youi/behaviour/escape/b.png", Buffer.from([1]))).rejects.toThrow(/goes through a link/);
      writeFileSync(join(outside, "secret.png"), "secret");
      await expect(readEvidence(root, ".youi/behaviour/escape/secret.png")).rejects.toThrow(/goes through a link/);
      symlinkSync(join(outside, "secret.png"), join(root, ".youi/behaviour/shots/linked.png"));
      await expect(readEvidence(root, ".youi/behaviour/shots/linked.png")).rejects.toThrow(/is a link/);
      await expect(writeEvidence(root, ".youi/behaviour/shots/linked.png", Buffer.from([9]))).rejects.toThrow(/is a link/);
      expect(readFileSync(join(outside, "secret.png"), "utf8")).toBe("secret");
      for (const path of ["../x.png", ".youi/../x.png", "/etc/passwd", ".youi/behaviour/../../x.png", "C:/x.png"]) await expect(writeEvidence(root, path, Buffer.from([1])), path).rejects.toThrow(/isn't a path under \.youi/);
      // A .youi that is itself a link holds nothing youiyoux writes.
      const linked = join(scratch, "linked-youi");
      mkdirSync(linked);
      symlinkSync(join(root, ".youi"), join(linked, ".youi"));
      await expect(writeEvidence(linked, ".youi/behaviour/c.png", Buffer.from([1]))).rejects.toThrow(/\.youi is a link/);
      // A stored run naming evidence through a link is refused when read.
      const run = { schema: "youiyoux.behaviour/v1", route: "/menu", runId: "r1", at: "2026-11-12T00:00:00.000Z", origin: "http://127.0.0.1:5173", viewport: { width: 800, height: 600 }, state: "probed", why: null, fix: null, coverage: "x", rules: [{ rule: "youi:demo/rule/menus-close", check: "dismiss-escape", freshness: { rule: "0123456789ab", tool: "t", origin: "http://127.0.0.1:5173", config: "0123456789ab", app: "0123456789ab" } }], results: [{ runId: "r1", at: "2026-11-12T00:00:00.000Z", viewport: { width: 800, height: 600 }, route: "/menu", rule: "youi:demo/rule/menus-close", target: { route: "/menu", pattern: "menu-button", component: null, accessibleName: "Actions" }, pattern: "menu-button", check: "dismiss-escape", state: "incomplete", why: "w", fix: "f", info: [], evidence: [".youi/behaviour/escape/secret.png"], freshness: { rule: "0123456789ab", tool: "t", origin: "http://127.0.0.1:5173", config: "0123456789ab", app: "0123456789ab" } }] };
      expect(BehaviourRouteRun.safeParse(run).success).toBe(true);
      // A result for a rule the run doesn't list, or with another freshness than its rule's, isn't a run.
      expect(BehaviourRouteRun.safeParse({ ...run, rules: [] }).success).toBe(false);
      expect(BehaviourRouteRun.safeParse({ ...run, rules: [{ ...run.rules[0]!, freshness: { ...run.rules[0]!.freshness, app: "fedcba987654" } }] }).success).toBe(false);
      writeFileSync(join(root, behaviourFile("/menu")), JSON.stringify(run));
      await expect(readBehaviourRun(root, "/menu")).rejects.toThrow(/goes through a link/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the check and the use of a .youi/ path are the same file", () => {
  const setup = (name: string) => {
    const root = product(name);
    const outside = mkdtempSync(join(tmpdir(), "youi-outside-"));
    writeFileSync(join(outside, "secret.png"), "secret");
    return { root, outside };
  };

  test("reading: a file swapped for a link after its check is refused by O_NOFOLLOW; one swapped for another file, by its device and inode", async () => {
    const { root, outside } = setup("swap-read");
    try {
      await writeEvidence(root, ".youi/behaviour/shots/a.png", Buffer.from("mine"));
      // After the check, the checked file becomes a link out of .youi/: the open refuses to follow it.
      const toLink = (file: string) => async () => {
        rmSync(file);
        symlinkSync(join(outside, "secret.png"), file);
      };
      const asLink = await readYouiFile(root, ".youi/behaviour/shots/a.png", { beforeOpen: (file) => toLink(file)() }).then((b) => b.toString(), (e: unknown) => e);
      expect(asLink).toBeInstanceOf(WorkflowError);
      expect((asLink as WorkflowError).message).toMatch(/is a link/);
      // Another regular file put in its place after the check: not the file that was checked.
      rmSync(join(root, ".youi/behaviour/shots/a.png"));
      await writeEvidence(root, ".youi/behaviour/shots/a.png", Buffer.from("mine"));
      const swapped = await readYouiFile(root, ".youi/behaviour/shots/a.png", {
        beforeOpen: async (file) => {
          writeFileSync(`${file}.other`, "planted");
          renameSync(`${file}.other`, file);
        },
      }).then((b) => b.toString(), (e: unknown) => e);
      expect(swapped).toBeInstanceOf(WorkflowError);
      expect((swapped as WorkflowError).message).toMatch(/changed between its check and its reading/);
      // Untouched, it reads.
      await writeEvidence(root, ".youi/behaviour/shots/b.png", Buffer.from("fine"));
      expect((await readEvidence(root, ".youi/behaviour/shots/b.png")).toString()).toBe("fine");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("writing: a link planted where the temp file goes, or swapped in after the rename, never writes outside; what was written is removed", async () => {
    const { root, outside } = setup("swap-write");
    try {
      const planted = await writeYouiFile(root, ".youi/behaviour/c.png", Buffer.from("x"), { beforeOpen: async (temp) => symlinkSync(join(outside, "secret.png"), temp) }).catch((e: unknown) => e);
      expect(planted).toBeInstanceOf(WorkflowError);
      expect(readFileSync(join(outside, "secret.png"), "utf8")).toBe("secret");
      const moved = await writeYouiFile(root, ".youi/behaviour/d.png", Buffer.from("written"), {
        afterRename: async (file) => {
          rmSync(file);
          symlinkSync(join(outside, "secret.png"), file);
        },
      }).catch((e: unknown) => e);
      expect(moved).toBeInstanceOf(WorkflowError);
      expect((moved as WorkflowError).message).toMatch(/didn't end up inside/);
      expect(existsSync(join(root, ".youi/behaviour/d.png"))).toBe(false);
      expect(readFileSync(join(outside, "secret.png"), "utf8")).toBe("secret");
      expect(readdirSync(outside)).toEqual(["secret.png"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAVE_CHROMIUM)("probing a running app", () => {
  let browser: Browser;
  let app: Server;
  let base: string;
  const requests: string[] = [];
  /** Set by a test: what the app does to screens.json when its menu is opened (as a person switching probing off mid-run). */
  let onOpen: (() => void) | null = null;
  let onSlowAsset: (() => void) | null = null;
  /** Loads of /revoke-on-second-load, and what the second one does. */
  let loads = 0;
  let onSecondLoad: (() => void) | null = null;
  /** Another server on this machine (B): nothing a probe does may reach it. */
  let elsewhere: { origin: string; requests: string[]; server: Server } | null = null;
  /** An APG menu button: focusable items, focus to the first on open; `closes`: Esc closes it. */
  const ESC_MENU = (name: string, id: string, closes: boolean) =>
    `<button aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" onclick="const m=document.getElementById('${id}');m.hidden=false;m.querySelector('li').focus()">${name}</button><ul role="menu" id="${id}" hidden onkeydown="${closes ? `if (event.key === 'Escape') this.hidden = true` : ""}"><li role="menuitem" tabindex="-1">Item</li></ul>`;
  const MENU = (name: string, id: string) =>
    `<button aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" onclick="new Image().src='/opened';document.getElementById('${id}').hidden=false">${name}</button><ul role="menu" id="${id}" hidden><li role="menuitem">Item</li></ul>`;

  beforeAll(async () => {
    app = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/slow-asset") {
        // The screen's load is under way (discovery): the person switches probing off now.
        onSlowAsset?.();
        return void setTimeout(() => res.writeHead(200, { "content-type": "image/gif" }).end(), 1_500);
      }
      if (req.url === "/opened") {
        onOpen?.();
        return void res.writeHead(200, { "content-type": "image/gif" }).end();
      }
      // /hostile: a page whose React-looking fiber names a module on another server (B), as a hostile or confused page can.
      const hostile = `${MENU("Actions", "h1")}<script>const b = document.querySelector("button"); b["__reactFiber$x"] = { tag: 5, type: "button", _debugStack: { stack: "Error\\n    at Menu (${elsewhere?.origin}/src/menu.js:1:1)" }, return: { tag: 0, type: function Menu() {}, return: null } };</script>`;
      if (req.url === "/revoke-on-second-load" && ++loads === 2) onSecondLoad?.();
      const body = req.url === "/revoke-on-second-load" ? MENU("Again", "r1") : req.url === "/never" ? `<button aria-haspopup="menu" aria-controls="nope" onclick="new Image().src='/opened'">Never</button>` : req.url === "/slow-discovery" ? `${MENU("Slow", "s1")}<img src="/slow-asset">` : req.url === "/menu" ? MENU("Actions", "m1") : req.url === "/fetches" ? MENU("Unread", "f1").replace("new Image().src='/opened';", "fetch('/api/read?id=7').catch(() => {});") : req.url === "/two" ? MENU("First", "a") + MENU("Second", "b") : req.url === "/hostile" ? hostile : req.url === "/esc" ? ESC_MENU("Actions", "e1", true) : req.url === "/esc-ignored" ? ESC_MENU("More", "e2", false) : req.url === "/" ? "<p>home</p>" : null;
      if (body === null) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
    });
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const requestsB: string[] = [];
    const serverB = createServer((req, res) => {
      requestsB.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/javascript" }).end(`x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ["src/Menu.tsx"], mappings: "AAAA" })).toString("base64")}`);
    });
    await new Promise<void>((done) => serverB.listen(0, "127.0.0.1", done));
    elsewhere = { origin: `http://127.0.0.1:${(serverB.address() as { port: number }).port}`, requests: requestsB, server: serverB };
    browser = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    app?.close();
    elsewhere?.server.close();
  });

  test("with consent, a route is probed and kept as .youi/behaviour/<route-hash>.json: an undecided check is incomplete or not-applicable, never passed, no invented line", async () => {
    const root = product("probed", { base, behaviour: { allowedOrigin: base } });
    const { run, file, probe } = await probeBehaviour({ root, route: "/menu", browser, checks: [...CHECKS, { rule: "youi:demo/rule/dialogs-trap", check: "focus-trap", digest: "0123456789ab" }], fingerprint: FINGERPRINT });
    expect(file).toBe(join(realpathSync(root), behaviourFile("/menu")));
    expect(behaviourFile("/menu")).toMatch(/^\.youi\/behaviour\/[0-9a-f]{16}\.json$/);
    expect(BehaviourRouteRun.parse(JSON.parse(readFileSync(file, "utf8")))).toEqual(run);
    expect(run).toMatchObject({ route: "/menu", origin: base, state: "probed" });
    expect(run.results.map((r) => [r.check, r.state])).toEqual([["focus-return", "incomplete"], ["focus-trap", "not-applicable"]]);
    expect(run.results[0]).toMatchObject({ target: { route: "/menu", pattern: "menu-button", component: null, accessibleName: "Actions" }, why: expect.stringMatching(/opened and was identified \(by aria-controls\), but this youiyoux doesn't decide focus-return yet/), freshness: { origin: base, app: FINGERPRINT.app, tool: FINGERPRINT.tool } });
    // Which rules the run was for, each with what it was made against.
    expect(run.rules.map((r) => [r.rule, r.check])).toEqual([["youi:demo/rule/menus-return", "focus-return"], ["youi:demo/rule/dialogs-trap", "focus-trap"]]);
    expect(run.results[0]!.target).not.toHaveProperty("file");
    // Its click only loads an image (a static file): nothing was blocked.
    expect(run.results.map((r) => r.dataBlocked)).toEqual([false, false]);
    expect(run.results.some((r) => r.state === "passed" || r.state === "failed")).toBe(false);
    // The opening itself is known to the caller, internally, not as a pass.
    expect(probe.targets[0]!.scenarios[0]).toMatchObject({ state: "opened" });
    expect(await readBehaviourRun(root, "/menu")).toEqual(run);
  }, 60_000);

  test("a popup that asks for data when it opens is tested with its data blocked, and every result of that scenario says so", async () => {
    const root = product("data-blocked", { base, behaviour: { allowedOrigin: base } }, [{ route: "/fetches", path: "/fetches" }]);
    const { run } = await probeBehaviour({ root, route: "/fetches", browser, checks: [...CHECKS, { rule: "youi:demo/rule/menus-close-too", check: "dismiss-escape", digest: "0123456789ab" }], fingerprint: FINGERPRINT });
    expect(run.results.map((r) => [r.state, r.dataBlocked])).toEqual([["incomplete", true], ["incomplete", true]]);
    expect(run.results[0]!.info).toContain("the popup asked for data when it opened (GET /api/read); it was blocked, so this was tested with its data blocked");
    expect(requests.filter((r) => r.startsWith("GET /api/read"))).toEqual([]);
  }, 60_000);

  test("consent is asked again before every scenario: switched off mid-run by another process, the rest stops", async () => {
    const root = product("mid-run", { base, behaviour: { allowedOrigin: base } }, [{ route: "/two", path: "/two" }]);
    // Another process's write: no in-process cancel, only what the file says.
    onOpen = () => writeFileSync(join(root, ".youi/screens/screens.json"), JSON.stringify({ ...screensOf(root), behaviour: { generation: 1 } }));
    try {
      const { run } = await probeBehaviour({ root, route: "/two", browser, checks: CHECKS, fingerprint: FINGERPRINT });
      expect(run.results.map((r) => r.why)).toEqual([expect.stringMatching(/opened and was identified/), "probing was switched off, or the app moved, during the run, so probing stopped"]);
    } finally {
      onOpen = null;
    }
  }, 60_000);

  test("consent is read again immediately before the click: switched off and on again during the load, nothing is clicked", async () => {
    const root = product("pre-click", { base, behaviour: { allowedOrigin: base, generation: 4 } }, [{ route: "/revoke-on-second-load", path: "/revoke-on-second-load" }]);
    loads = 0;
    // The scenario's own load (the second, after discovery's) switches consent off and on again, as another process could.
    onSecondLoad = () => writeFileSync(join(root, ".youi/screens/screens.json"), JSON.stringify({ ...screensOf(root), behaviour: { allowedOrigin: base, generation: 6 } }));
    const clicks = requests.filter((r) => r === "GET /opened").length;
    try {
      const { run } = await probeBehaviour({ root, route: "/revoke-on-second-load", browser, checks: CHECKS, fingerprint: FINGERPRINT });
      expect(run.results.map((r) => r.why)).toEqual(["probing was switched off, or the app moved, during the run, so probing stopped"]);
    } finally {
      onSecondLoad = null;
    }
    expect(loads).toBe(2);
    expect(requests.filter((r) => r === "GET /opened").length).toBe(clicks);
  }, 60_000);

  test("switching probing off during discovery stops the run there: nothing is clicked", async () => {
    const root = product("cancel-discovery", { base, behaviour: { allowedOrigin: base } }, [{ route: "/slow-discovery", path: "/slow-discovery" }]);
    onSlowAsset = () => void setBehaviourConsent(root, false);
    const clicks = requests.filter((r) => r === "GET /opened").length;
    try {
      const { run } = await probeBehaviour({ root, route: "/slow-discovery", browser, checks: CHECKS, fingerprint: FINGERPRINT });
      expect(run).toMatchObject({ state: "incomplete", why: "probing was switched off, or the app moved, during the run, so probing stopped", results: [] });
    } finally {
      onSlowAsset = null;
    }
    expect(requests.filter((r) => r === "GET /slow-discovery")).toHaveLength(1);
    expect(requests.filter((r) => r === "GET /opened").length).toBe(clicks);
  }, 60_000);

  test("switching probing off cancels a scenario that is running, at once", async () => {
    const root = product("cancel", { base, behaviour: { allowedOrigin: base } }, [{ route: "/never", path: "/never" }]);
    onOpen = () => void setBehaviourConsent(root, false);
    try {
      const started = Date.now();
      const { run } = await probeBehaviour({ root, route: "/never", browser, checks: CHECKS, fingerprint: FINGERPRINT });
      // Without the cancel it would wait out the 2 s open budget and say nothing opened.
      expect(run.results.map((r) => r.why)).toEqual(["probing was switched off, or the app moved, during the run, so probing stopped"]);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      onOpen = null;
    }
  }, 60_000);

  test("a capture never writes back an old snapshot: consent switched off while it runs stays off", async () => {
    const root = product("capture-race", { base, behaviour: { allowedOrigin: base, generation: 1 } }, [{ route: "/", path: "/" }]);
    // Between capture's read of screens.json and its write, the person switches probing off.
    await captureScreens(join(root, ".youi/screens"), { base, browser, beforeWrite: async () => void (await setBehaviourConsent(root, false)) });
    expect(screensOf(root).behaviour).toEqual({ generation: 2 });
    expect(screensOf(root).capturedAt).not.toBe("");
    expect(await refusal(probeBehaviour({ root, route: "/", browser: NO_BROWSER, checks: CHECKS, fingerprint: FINGERPRINT }))).toMatch(/Probing isn't switched on/);
    // Without a race, a capture on the same origin keeps consent as it is.
    await setBehaviourConsent(root, true);
    await captureScreens(join(root, ".youi/screens"), { base, browser });
    expect(screensOf(root).behaviour).toEqual({ allowedOrigin: base, generation: 3 });
  }, 60_000);

  test("file and line come only from the consented origin: a base moved to B mid-run, and frames naming B, fetch nothing from B", async () => {
    const root = product("resolve-pinned", { base, behaviour: { allowedOrigin: base } }, [{ route: "/hostile", path: "/hostile" }]);
    // When the menu opens, the app's base moves to B (a capture elsewhere, a hand edit).
    onOpen = () => {
      const doc = screensOf(root);
      writeFileSync(join(root, ".youi/screens/screens.json"), JSON.stringify({ ...doc, base: elsewhere!.origin, behaviour: { allowedOrigin: elsewhere!.origin } }));
    };
    try {
      const { probe } = await probeBehaviour({ root, route: "/hostile", browser, checks: CHECKS, fingerprint: FINGERPRINT });
      expect(probe.targets[0]!.found.frames.map((f) => new URL(f.url).origin)).toEqual([elsewhere!.origin]);
    } finally {
      onOpen = null;
    }
    expect(elsewhere!.requests).toEqual([]);
    // And the resolver itself, given the pinned origin, never fetches a frame on another origin, whatever base says.
    const live = new LiveApp(root, "app");
    const frame = (url: string) => ({ name: "Menu", owner: null, frames: [{ url, line: 1, column: 1 }], box: { x: 0, y: 0, width: 1, height: 1 }, depth: 0 });
    const placed = await live.resolve([frame(`${elsewhere!.origin}/src/menu.js`), frame(`${base}/nothing.js`)], { origin: base });
    expect(placed.map((p) => p.line)).toEqual([null, null]);
    expect(elsewhere!.requests).toEqual([]);
    // Without a pin it follows base (now B): what the pin is for.
    await live.resolve([frame(`${elsewhere!.origin}/src/menu.js`)]);
    expect(elsewhere!.requests).toEqual(["GET /src/menu.js"]);
  }, 60_000);

  test("a capture that moves base to another origin leaves no consent to probe with", async () => {
    const root = product("moved", { base: "http://127.0.0.1:1", behaviour: { allowedOrigin: "http://127.0.0.1:1" } }, [{ route: "/", path: "/" }]);
    await captureScreens(join(root, ".youi/screens"), { base, browser });
    expect(screensOf(root).base).toBe(base);
    expect(screensOf(root).behaviour).toEqual({ generation: 1 });
    expect(await refusal(probeBehaviour({ root, route: "/", browser: NO_BROWSER, checks: CHECKS, fingerprint: FINGERPRINT }))).toMatch(/Probing isn't switched on/);
  }, 60_000);

  test("dismiss-escape is decided and stored: passed when Esc closes the menu, failed when it doesn't; the other checks stay incomplete", async () => {
    const root = product("decided", { base, behaviour: { allowedOrigin: base } }, [{ route: "/esc", path: "/esc" }, { route: "/esc-ignored", path: "/esc-ignored" }]);
    const checks = [{ rule: "youi:demo/rule/menus-close", check: "dismiss-escape" as const, digest: "0123456789ab" }, ...CHECKS];
    const passed = await probeBehaviour({ root, route: "/esc", browser, checks, fingerprint: FINGERPRINT });
    expect(passed.run.results.map((r) => [r.check, r.state, r.why])).toEqual([
      ["dismiss-escape", "passed", "Esc closed the menu"],
      ["focus-return", "incomplete", expect.stringMatching(/doesn't decide focus-return yet/)],
    ]);
    const failed = await probeBehaviour({ root, route: "/esc-ignored", browser, checks, fingerprint: FINGERPRINT });
    expect(failed.run.results[0]).toMatchObject({ check: "dismiss-escape", state: "failed", why: "Esc did nothing: the menu was still open after 1.5 s", fix: expect.stringMatching(/^Close the menu when Esc is pressed/) });
    expect(await readBehaviourRun(root, "/esc-ignored")).toEqual(failed.run);
  }, 60_000);
});
