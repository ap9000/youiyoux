/**
 * Where behaviour rules stand from stored runs (what `youiyoux check` reads): fresh and complete on
 * every route, or incomplete naming the routes and why; stale results never count. The runs are
 * made by the real probe (real headless Chromium, a fixture app on a loopback port), then the
 * project, the rule, screens.json and the stored files are changed underneath them.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RuleSpec } from "@youiyoux/core";
import { launchBrowser } from "@youiyoux/detect";
import { appFingerprint, ruleDigest, type Project } from "@youiyoux/scanner";
import { behaviourFile, behaviourStanding, probeBehaviour, setBehaviourConsent } from "../src/index.ts";

const MISSING = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false }).then(
  async (browser) => {
    await browser.close();
    return null;
  },
  (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
);
const HAVE_CHROMIUM = MISSING === null;
const GATE = process.env.YOUI_SECURITY_GATE === "1";
if (!HAVE_CHROMIUM) console.warn(`behaviour standing tests ${GATE ? "FAIL" : "skipped"}: ${MISSING}`);
test.runIf(GATE && !HAVE_CHROMIUM)("security gate: behaviour standing's browser tests need Chromium", () => {
  throw new Error(`YOUI_SECURITY_GATE is set and Chromium couldn't be launched (${MISSING}): nothing was tested`);
});

const TOOL = "youiyoux test";
const rule = (id: string, check: string, severity = "error") =>
  RuleSpec.parse({ schema: "youi.rule/v1", id: `youi:demo/rule/${id}`, title: id, severity, statement: `${id}.`, agent: `Do ${id}.`, check: { engine: "behaviour", id: check } });
const ESCAPE = rule("popup.escape", "dismiss-escape");
const RETURN = rule("popup.return", "focus-return");

describe("no screens", () => {
  test("without screens.json, a behaviour rule is incomplete and says how to start", async () => {
    const root = mkdtempSync(join(tmpdir(), "youi-standing-none-"));
    try {
      const standing = await behaviourStanding({ root, config: { include: ["src/**/*.tsx"], exclude: [] }, system: { components: [], rules: [] } } as unknown as Project, [ESCAPE], TOOL);
      expect(standing.runs).toEqual([{ rule: ESCAPE.id, state: "incomplete", reason: expect.stringMatching(/^no screens are captured yet .*youiyoux screens capture --base <url>.*youiyoux behave$/) }]);
      expect(standing.failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAVE_CHROMIUM)("standing from stored runs", () => {
  let browser: Browser;
  let server: Server;
  let base = "";
  const scratch = mkdtempSync(join(tmpdir(), "youi-standing-"));
  const MENU = (id: string, closes: boolean) =>
    `<button aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" onclick="const m=document.getElementById('${id}');m.hidden=false;m.querySelector('li').focus()">Actions</button><ul role="menu" id="${id}" hidden onkeydown="${closes ? "if (event.key === 'Escape') this.hidden = true" : ""}"><li role="menuitem" tabindex="-1">Rename</li></ul>`;
  const PAGES: Record<string, string> = { "/esc": MENU("m1", true), "/esc-ignored": MENU("m2", false), "/plain": "<p>No popups here.</p>" };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = PAGES[req.url ?? ""];
      if (body === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A product: its sources, package.json and lockfile, and screens.json with consent. */
  function product(name: string, routes: readonly string[]): { root: string; project: Project; screens: string; doc: Record<string, unknown> } {
    const root = join(scratch, name);
    mkdirSync(join(root, ".youi/screens"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.tsx"), "export const App = () => <main />;\n");
    writeFileSync(join(root, "src/app.css"), "main { color: black; }\n");
    writeFileSync(join(root, "vite.config.ts"), "export default {};\n");
    mkdirSync(join(root, "node_modules/react"), { recursive: true });
    writeFileSync(join(root, "node_modules/react/package.json"), JSON.stringify({ name: "react", version: "19.0.0" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, dependencies: { react: "19.0.0" } }));
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const doc = { schema: "youiyoux.screens/v1", project: name, source: "a test app", capturedAt: "", viewport: { width: 800, height: 600 }, base, behaviour: { allowedOrigin: base, generation: 1 }, screens: routes.map((r) => ({ route: r, path: r })) };
    const screens = join(root, ".youi/screens/screens.json");
    writeFileSync(screens, JSON.stringify(doc, null, 2));
    return { root, project: { root, config: { include: ["src/**/*.{ts,tsx,css}"], exclude: [] }, system: { components: [], rules: [] } } as unknown as Project, screens, doc };
  }
  /** `youiyoux behave` for one route, as the CLI runs it: digests and the fingerprint computed now. */
  const behave = async (p: { root: string; project: Project }, route: string, rules: readonly RuleSpec[]) =>
    probeBehaviour({ root: p.root, route, browser, checks: rules.map((r) => ({ rule: r.id, check: (r.check as { id: "dismiss-escape" }).id, digest: ruleDigest(r) })), fingerprint: { app: await appFingerprint(p.project, { inputs: (JSON.parse(readFileSync(join(p.root, ".youi/screens/screens.json"), "utf8")) as { behaviour?: { inputs?: string[] } }).behaviour?.inputs ?? [] }), tool: TOOL } });

  test("ran only when every route has fresh, complete results; a route never probed keeps the rule incomplete, naming it", async () => {
    const p = product("all-routes", ["/esc", "/plain"]);
    await behave(p, "/esc", [ESCAPE]);
    const one = await behaviourStanding(p.project, [ESCAPE], TOOL);
    expect(one.runs).toEqual([{ rule: ESCAPE.id, state: "incomplete", reason: "no fresh, complete probe results on 1 of 2 routes: /plain was never probed. Run youiyoux behave --route /plain (for popup.escape), then youiyoux check again" }]);
    // A screen with no popups is probed too: it says so, and counts as checked.
    const plain = await behave(p, "/plain", [ESCAPE]);
    expect(plain.run.coverage).toBe("No declared popups found; popups without these markers were not assessed.");
    expect((await behaviourStanding(p.project, [ESCAPE], TOOL)).runs).toEqual([{ rule: ESCAPE.id, state: "ran", findings: 0 }]);
    // Probed, but for another rule: not this one's result.
    expect((await behaviourStanding(p.project, [rule("popup.other", "dismiss-escape")], TOOL)).runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/\/esc was probed, but not for this rule/) });
  }, 60_000);

  test("any change to a scanned file, CSS, package.json, the rule, the viewport or screens.json's behaviour config makes it stale; put back, it is fresh again", async () => {
    const p = product("stale", ["/esc"]);
    await behave(p, "/esc", [ESCAPE]);
    const standing = async (rules = [ESCAPE]) => (await behaviourStanding(p.project, rules, TOOL)).runs[0]!;
    expect(await standing()).toEqual({ rule: ESCAPE.id, state: "ran", findings: 0 });
    const staleBy = (why: string) => ({ state: "incomplete", reason: `no fresh, complete probe results on 1 of 1 route: /esc is stale (${why} since its run). Run youiyoux behave --route /esc (for popup.escape), then youiyoux check again` });
    for (const [file, change] of [["src/app.tsx", "export const App = () => <main>changed</main>;\n"], ["src/app.css", "main { color: red; }\n"], ["package.json", "{}"], ["pnpm-lock.yaml", "lockfileVersion: '9.1'\n"]] as const) {
      const was = readFileSync(join(p.root, file), "utf8");
      writeFileSync(join(p.root, file), change);
      expect(await standing(), file).toMatchObject(staleBy("the code changed"));
      writeFileSync(join(p.root, file), was);
      expect(await standing(), file).toMatchObject({ state: "ran" });
    }
    // Installed packages, build output and youiyoux's own files aren't the app's source.
    for (const file of ["node_modules/left-pad/index.js", "dist/app.js", ".youi/notes.txt"]) {
      mkdirSync(join(p.root, file, ".."), { recursive: true });
      writeFileSync(join(p.root, file), "changed\n");
    }
    expect(await standing()).toMatchObject({ state: "ran" });
    // The rule (its severity here): stale until probed again with it.
    expect(await standing([rule("popup.escape", "dismiss-escape", "warn")])).toMatchObject(staleBy("the rule changed"));
    expect((await behaviourStanding(p.project, [ESCAPE], "youiyoux next")).runs[0]).toMatchObject(staleBy("youiyoux changed"));
    writeFileSync(p.screens, JSON.stringify({ ...p.doc, viewport: { width: 390, height: 844 } }));
    expect(await standing()).toMatchObject(staleBy("the viewport changed"));
    writeFileSync(p.screens, JSON.stringify({ ...p.doc, behaviour: { ...(p.doc.behaviour as object), routes: ["/esc"] } }));
    expect(await standing()).toMatchObject(staleBy("screens.json's behaviour settings or the screen's path changed"));
    writeFileSync(p.screens, JSON.stringify({ ...p.doc, screens: [{ route: "/esc", path: "/esc?v=2" }] }));
    expect(await standing()).toMatchObject(staleBy("screens.json's behaviour settings or the screen's path changed"));
    writeFileSync(p.screens, JSON.stringify(p.doc));
    expect(await standing()).toMatchObject({ state: "ran" });
    // Probing switched off: no result made under the old consent counts.
    await setBehaviourConsent(p.root, false);
    expect(await standing()).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/\/esc is stale \(probing isn't switched on now, screens\.json's behaviour settings/) });
  }, 60_000);

  test("the fingerprint reaches what the running app reads beyond the scan: other project files, every lockfile up to the repo top, installed dependencies, behaviour.inputs; the bindings are part of the key", async () => {
    // A product inside a git repository (its top holds the workspace lockfile); .env files are ignored by git.
    const top = join(scratch, "mono");
    mkdirSync(top, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: top });
    writeFileSync(join(top, ".gitignore"), ".env*\n");
    writeFileSync(join(top, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const p = product("mono/apps/web", ["/esc"]);
    writeFileSync(join(p.root, ".env.development"), "VITE_FLAG=on\n");
    const withInputs = { ...p.doc, behaviour: { ...(p.doc.behaviour as object), inputs: [".env.development"] } };
    writeFileSync(p.screens, JSON.stringify(withInputs));
    await behave(p, "/esc", [ESCAPE]);
    const standing = async (project: Project = p.project) => (await behaviourStanding(project, [ESCAPE], TOOL)).runs[0]!;
    expect(await standing()).toMatchObject({ state: "ran" });
    const stale = (why: string) => ({ state: "incomplete", reason: expect.stringContaining(`/esc is stale (${why} since its run)`) });
    const changed = async (file: string, content: string) => {
      const was = readFileSync(file, "utf8");
      writeFileSync(file, content);
      const now = await standing();
      writeFileSync(file, was);
      expect(await standing(), file).toMatchObject({ state: "ran" });
      return now;
    };
    // A config file the scan's include globs don't cover.
    expect(await changed(join(p.root, "vite.config.ts"), "export default { base: '/x' };\n")).toMatchObject(stale("the code changed"));
    // The workspace lockfile at the repository's top.
    expect(await changed(join(top, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n")).toMatchObject(stale("the code changed"));
    // A dependency installed at another version, the lockfile unchanged.
    expect(await changed(join(p.root, "node_modules/react/package.json"), JSON.stringify({ name: "react", version: "19.1.0" }))).toMatchObject(stale("the code changed"));
    // A file named in behaviour.inputs (git ignores it, so only that names it); its content is hashed, never stored.
    expect(await changed(join(p.root, ".env.development"), "VITE_FLAG=off\n")).toMatchObject(stale("the code changed"));
    expect(readFileSync(join(p.root, behaviourFile("/esc")), "utf8")).not.toContain("VITE_FLAG");
    // The components' behaviour bindings: a binding added is a new key.
    const bound = { ...p.project, system: { components: [{ contract: { name: "Menu", a11y: { behaviour: { pattern: "menu-button" } } } }], rules: [] } } as unknown as Project;
    expect(await standing(bound)).toMatchObject(stale("the components' behaviour bindings changed"));
  }, 60_000);

  test("a fresh failure counts by its rule's severity; once stale it counts as nothing, and the rule is incomplete", async () => {
    const p = product("failing", ["/esc-ignored"]);
    await behave(p, "/esc-ignored", [ESCAPE]);
    const fresh = await behaviourStanding(p.project, [ESCAPE], TOOL);
    expect(fresh.runs).toEqual([{ rule: ESCAPE.id, state: "ran", findings: 1 }]);
    expect(fresh.failures).toEqual([{ rule: ESCAPE.id, severity: "error", result: expect.objectContaining({ state: "failed", route: "/esc-ignored", why: "Esc did nothing: the menu was still open after 1.5 s" }) }]);
    writeFileSync(join(p.root, "src/app.tsx"), "export const App = () => <main>fixed?</main>;\n");
    const stale = await behaviourStanding(p.project, [ESCAPE], TOOL);
    expect(stale.failures).toEqual([]);
    expect(stale.runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/stale \(the code changed/) });
  }, 60_000);

  test("a stored run must hold one result per popup it found, and not-applicable only where the check doesn't apply: a deleted or relabelled failure isn't clean", async () => {
    const p = product("integrity", ["/esc-ignored"]);
    await behave(p, "/esc-ignored", [ESCAPE]);
    const file = join(p.root, behaviourFile("/esc-ignored"));
    const run = JSON.parse(readFileSync(file, "utf8")) as { targets: unknown[]; results: Array<{ state: string; target: Record<string, unknown> }> };
    expect(run.targets).toEqual([{ route: "/esc-ignored", pattern: "menu-button", component: null, accessibleName: "Actions" }]);
    expect((await behaviourStanding(p.project, [ESCAPE], TOOL)).failures).toHaveLength(1);
    // The failure taken out, the rule's entry kept.
    writeFileSync(file, JSON.stringify({ ...run, results: [] }));
    const deleted = await behaviourStanding(p.project, [ESCAPE], TOOL);
    expect(deleted.failures).toEqual([]);
    expect(deleted.runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/\/esc-ignored has a stored run whose results don't match the popups it found \(1 missing, 0 extra or repeated\)/) });
    // dismiss-escape relabelled not-applicable: it applies to every pattern.
    writeFileSync(file, JSON.stringify({ ...run, results: run.results.map((r) => ({ ...r, state: "not-applicable" })) }));
    const relabelled = await behaviourStanding(p.project, [ESCAPE], TOOL);
    expect(relabelled.failures).toEqual([]);
    expect(relabelled.runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/says dismiss-escape doesn't apply to a menu-button, which it does/) });
    // Repeated: one target, two results.
    writeFileSync(file, JSON.stringify({ ...run, results: [...run.results, ...run.results] }));
    expect((await behaviourStanding(p.project, [ESCAPE], TOOL)).runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/0 missing, 1 extra or repeated/) });
  }, 60_000);

  test("a stored file can't decide for itself: an undecided check stays incomplete even if the file says passed, and a file that claims to be fresh isn't read", async () => {
    const p = product("hand-edited", ["/esc"]);
    await behave(p, "/esc", [ESCAPE, RETURN]);
    expect((await behaviourStanding(p.project, [RETURN], TOOL)).runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/\/esc has 1 popup that couldn't be decided \(the popup opened and was identified/) });
    const file = join(p.root, behaviourFile("/esc"));
    const run = JSON.parse(readFileSync(file, "utf8")) as { results: Array<{ check: string; state: string }> };
    for (const r of run.results) if (r.check === "focus-return") r.state = "passed";
    writeFileSync(file, JSON.stringify(run));
    expect((await behaviourStanding(p.project, [RETURN], TOOL)).runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/couldn't be decided/) });
    // dismiss-escape's own result in the same file still counts.
    expect((await behaviourStanding(p.project, [ESCAPE], TOOL)).runs[0]).toMatchObject({ state: "ran" });
    writeFileSync(file, JSON.stringify({ ...run, fresh: true }));
    expect((await behaviourStanding(p.project, [ESCAPE], TOOL)).runs[0]).toMatchObject({ state: "incomplete", reason: expect.stringMatching(/\/esc has a stored run that couldn't be used/) });
  }, 60_000);
});
