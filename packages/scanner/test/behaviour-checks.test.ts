/**
 * The behaviour checks beyond dismiss-escape, end to end in a real headless Chromium against
 * fixture apps served here on a loopback port: good and bad versions per pattern. Every page logs
 * the clicks, keys and focus it sees back to its server, so what was clicked and pressed is what
 * the app itself saw, and each check's key log holds only its own keys.
 */
import { createServer, type Server } from "node:http";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import type { BehaviourCheckId } from "@youiyoux/core";
import { assertSafeKey, CHECK_KEYS, judgeTriggerState, probeRoute, type ProbeRouteOptions, type RouteProbe, type TargetScenario, type TriggerFacts } from "../src/index.ts";

const MISSING = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false }).then(
  async (browser) => {
    await browser.close();
    return null;
  },
  (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
);
const HAVE_CHROMIUM = MISSING === null;
const GATE = process.env.YOUI_SECURITY_GATE === "1";
if (!HAVE_CHROMIUM) console.warn(`behaviour check tests ${GATE ? "FAIL" : "skipped"}: ${MISSING}`);
test.runIf(GATE && !HAVE_CHROMIUM)("security gate: the behaviour checks' browser tests need Chromium", () => {
  throw new Error(`YOUI_SECURITY_GATE is set and Chromium couldn't be launched (${MISSING}): nothing was tested`);
});

describe("each check sends only its own keys", () => {
  test("a page refuses every key its check doesn't send, before anything is sent", () => {
    for (const check of ["trigger-state", "focus-into"] as const) expect(() => assertSafeKey("Escape", CHECK_KEYS[check]), check).toThrow(/this check sends no keys/);
    expect(() => assertSafeKey("Escape", CHECK_KEYS["dismiss-escape"])).not.toThrow();
  });
});

describe("trigger-state's verdict, from the button's state closed and open", () => {
  const facts = (over: Partial<TriggerFacts>): TriggerFacts => ({ connected: true, expanded: null, haspopup: null, controls: false, controlsPopup: null, popovertarget: false, popovertargetPopup: null, popupRole: null, ...over });
  test("a menu button: aria-expanded may be left off while closed; it must go to true, aria-haspopup must say menu, aria-controls (if there) must name the menu itself", () => {
    const closed = facts({ haspopup: "menu" });
    expect(judgeTriggerState("menu-button", closed, facts({ haspopup: "menu", expanded: "true" }))).toMatchObject({ ok: true, info: [expect.stringMatching(/left off while the menu is closed/)] });
    expect(judgeTriggerState("menu-button", facts({ haspopup: "true", expanded: "false" }), facts({ haspopup: "true", expanded: "true", controls: true, controlsPopup: true, popupRole: "menu" }))).toMatchObject({ ok: true, info: [] });
    expect(judgeTriggerState("menu-button", facts({ haspopup: "menu", expanded: "true" }), facts({ haspopup: "menu", expanded: "true" }))).toEqual({ ok: false, why: 'aria-expanded already said "true" before the menu opened' });
    expect(judgeTriggerState("menu-button", closed, facts({ haspopup: "menu", expanded: "true", controls: true, controlsPopup: false, popupRole: "menu" }))).toEqual({ ok: false, why: "aria-controls doesn't name the menu that opened" });
    expect(judgeTriggerState("menu-button", facts({ expanded: "false" }), facts({ expanded: "true" }))).toEqual({ ok: false, why: "aria-haspopup is missing while the menu is closed" });
    expect(judgeTriggerState("menu-button", facts({ haspopup: "listbox" }), facts({ haspopup: "listbox", expanded: "true" }))).toEqual({ ok: false, why: 'aria-haspopup is "listbox" while the menu is closed, not "menu"' });
  });
  test("a combobox must say false while closed; a popover through popovertarget passes unless a hand-set aria-expanded disagrees", () => {
    expect(judgeTriggerState("combobox-listbox", facts({}), facts({ expanded: "true", controls: true, controlsPopup: true, popupRole: "listbox" }))).toEqual({ ok: false, why: 'aria-expanded isn\'t set while the listbox is closed (a combobox says "false")' });
    expect(judgeTriggerState("combobox-listbox", facts({ expanded: "false" }), facts({ expanded: "true" }))).toEqual({ ok: false, why: "aria-controls is missing: the combobox doesn't name its listbox" });
    expect(judgeTriggerState("popover", facts({ popovertarget: true }), facts({ popovertarget: true, popovertargetPopup: true }))).toMatchObject({ ok: true });
    expect(judgeTriggerState("popover", facts({ popovertarget: true, expanded: "false" }), facts({ popovertarget: true, popovertargetPopup: true, expanded: "false" }))).toMatchObject({ ok: false });
    expect(judgeTriggerState("popover", facts({}), facts({ expanded: "true" }))).toEqual({ ok: false, why: "the button doesn't name its popover: it has neither popovertarget nor aria-controls" });
  });
});

describe.skipIf(!HAVE_CHROMIUM)("the behaviour checks in a real browser", () => {
  let browser: Browser;
  let server: Server;
  let origin = "";
  const requests: Array<{ method: string; path: string; query: string }> = [];

  const LOGGER = `<script>
    const report = (q) => { new Image().src = "/log?" + q; };
    document.addEventListener("click", (e) => report("click=" + encodeURIComponent(e.target.closest("[data-log]")?.dataset.log ?? e.target.localName)), true);
    document.addEventListener("keydown", (e) => report("key=" + encodeURIComponent((e.shiftKey && e.key !== "Shift" ? "Shift+" : "") + e.key)), true);
  </script>`;
  const page = (body: string, script = "") => `<!doctype html><meta charset="utf-8"><title>fixture</title><body>${LOGGER}<button data-log="before">Before</button>${body}<button data-log="after">After</button><script>${script}</script></body>`;
  const attr = (js: string) => js.replace(/"/g, "&quot;");
  /**
   * A menu button. `trigger` is extra markup on the button, `open` what its click does beyond
   * showing the menu, `items` the menu's items, `onKey` the menu's keydown handler.
   */
  const menu = (o: { name?: string; id: string; trigger?: string; open?: string; items?: string; onKey?: string; expanded?: boolean; wrap?: boolean }) => {
    const items = o.items ?? `<li role="menuitem" tabindex="-1">Rename</li><li role="menuitem" tabindex="-1">Delete</li>`;
    const menuEl = `<ul role="menu" id="${o.id}" ${o.wrap ? "" : "hidden"} onkeydown="${attr(o.onKey ?? "")}">${items}</ul>`;
    const show = o.wrap ? `document.getElementById('${o.id}-wrap').hidden=false` : `document.getElementById('${o.id}').hidden=false`;
    return (
      `<button data-log="trigger-${o.id}" ${o.trigger ?? `aria-haspopup="menu" aria-expanded="false" aria-controls="${o.id}"`} onclick="${attr(`${show};${o.expanded === false ? "" : "this.setAttribute('aria-expanded','true');"}${o.open ?? ""}`)}">${o.name ?? "Actions"}</button>` +
      (o.wrap ? `<div id="${o.id}-wrap" hidden>${menuEl}</div>` : menuEl)
    );
  };
  const combobox = (o: { id: string; input?: string; open?: string; options?: string; onKey?: string }) =>
    `<label for="${o.id}-cb">Fruit</label><input id="${o.id}-cb" data-log="trigger-${o.id}" ${o.input ?? `role="combobox" aria-expanded="false" aria-controls="${o.id}"`} onclick="${attr(`document.getElementById('${o.id}').hidden=false;this.setAttribute('aria-expanded','true');${o.open ?? ""}`)}" onkeydown="${attr(o.onKey ?? "")}">` +
    `<ul role="listbox" id="${o.id}" hidden>${o.options ?? `<li role="option" id="${o.id}-1">Apple</li><li role="option" id="${o.id}-2">Pear</li>`}</ul>`;

  const FIRST = (id: string) => `document.getElementById('${id}').querySelector('[role^=menuitem]').focus()`;
  const modal = (o: { id: string; open?: string; body?: string; attrs?: string; onKey?: string }) =>
    `<button data-log="trigger-${o.id}" aria-haspopup="dialog" aria-controls="${o.id}" onclick="${attr(`document.getElementById('${o.id}').hidden=false;${o.open ?? ""}`)}">Delete project</button>` +
    `<div role="dialog" aria-modal="true" aria-label="Delete project" id="${o.id}" hidden ${o.attrs ?? ""} onkeydown="${attr(o.onKey ?? "")}">${o.body ?? `<button>Cancel</button><button>Delete</button>`}</div>`;
  const pages: Record<string, () => string> = {
    // trigger-state
    "/ts-menu": () => page(menu({ id: "t1" })),
    "/ts-menu-apg": () => page(menu({ id: "t2", trigger: 'aria-haspopup="menu"' })),
    "/ts-menu-static": () => page(menu({ id: "t3", expanded: false })),
    "/ts-menu-no-expanded": () => page(menu({ id: "t4", trigger: 'aria-haspopup="menu" aria-controls="t4"', expanded: false })),
    "/ts-menu-wrapper": () => page(menu({ id: "t5", trigger: 'aria-haspopup="menu" aria-expanded="false" aria-controls="t5-wrap"', wrap: true })),
    "/ts-menu-drops-haspopup": () => page(menu({ id: "t6", open: "this.removeAttribute('aria-haspopup')" })),
    "/ts-menu-late": () => page(menu({ id: "t7", expanded: false, open: "setTimeout(() => this.setAttribute('aria-expanded','true'), 200)" })),
    "/ts-combobox": () => page(combobox({ id: "c1" })),
    "/ts-combobox-haspopup": () => page(combobox({ id: "c2", input: 'role="combobox" aria-haspopup="menu" aria-expanded="false" aria-controls="c2"' })),
    "/ts-combobox-closed": () => page(combobox({ id: "c3", input: 'role="combobox" aria-controls="c3"' })),
    "/ts-popover": () => page(`<button data-log="trigger-p1" popovertarget="p1">Info</button><div popover id="p1"><button>Got it</button></div>`),
    "/ts-popover-stale": () => page(`<button data-log="trigger-p2" popovertarget="p2" aria-expanded="false">Info</button><div popover id="p2"><button>Got it</button></div>`),
    "/ts-disclosure": () => page(`<button data-log="trigger-p3" aria-expanded="false" aria-controls="p3" onclick="document.getElementById('p3').hidden=false;this.setAttribute('aria-expanded','true')">Filters</button><div id="p3" hidden><button>Apply</button></div>`),
    "/ts-dialog": () => page(`<button data-log="trigger-d1" aria-haspopup="dialog" onclick="document.getElementById('d1').showModal()">Settings</button><dialog id="d1"><button>Close</button></dialog>`),
    "/ts-repeated": () => page(menu({ name: "More", id: "r1" }) + menu({ name: "More", id: "r2" })),
    // focus-into
    "/fi-menu": () => page(menu({ id: "f1", open: FIRST("f1") })),
    "/fi-menu-late": () => page(menu({ id: "f2", open: `setTimeout(() => ${FIRST("f2")}, 300)` })),
    "/fi-menu-container": () => page(menu({ id: "f3", open: "document.getElementById('f3').focus()" }).replace('<ul role="menu" id="f3"', '<ul role="menu" tabindex="-1" id="f3"')),
    "/fi-menu-none": () => page(menu({ id: "f4" })),
    "/fi-native-dialog": () => page(`<button data-log="trigger-n1" aria-haspopup="dialog" onclick="document.getElementById('n1').showModal()">Settings</button><dialog id="n1"><p>Settings</p><button>Close</button></dialog>`),
    "/fi-dialog-self": () => page(modal({ id: "m1", attrs: 'tabindex="-1"', open: "document.getElementById('m1').focus()" })),
    "/fi-dialog-none": () => page(modal({ id: "m2" })),
    "/fi-dialog-outside": () => page(modal({ id: "m3", open: "document.querySelector('[data-log=after]').focus()" })),
    "/ts-repeated-named": () => page(menu({ name: "More", id: "r3", trigger: 'aria-label="More for Alpha" aria-haspopup="menu" aria-expanded="false" aria-controls="r3"' }) + menu({ name: "More", id: "r4", trigger: 'aria-label="More for Beta" aria-haspopup="menu" aria-expanded="false" aria-controls="r4"' })),
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.search });
      if (url.pathname === "/log") return void res.writeHead(200, { "content-type": "image/gif" }).end();
      const body = pages[url.pathname];
      if (!body) return void res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": "text/html" }).end(body());
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const probe = (path: string, checks: readonly BehaviourCheckId[], extra: Partial<ProbeRouteOptions> = {}): Promise<RouteProbe> =>
    probeRoute({ browser, origin, route: path, path, viewport: { width: 800, height: 600 }, checks, ...extra });
  /** The one target's result for its one check. */
  const one = async (path: string, check: BehaviourCheckId, extra: Partial<ProbeRouteOptions> = {}): Promise<TargetScenario> => {
    const result = await probe(path, [check], extra);
    expect(result.state, result.why ?? "").toBe("probed");
    expect(result.targets).toHaveLength(1);
    return result.targets[0]!.scenarios[0]!;
  };
  const logged = (key: string) => requests.filter((r) => r.path === "/log" && r.query.startsWith(`?${key}=`)).map((r) => decodeURIComponent(r.query.slice(key.length + 2)));

  describe("focus-into", () => {
    test("a menu passes when the app moves focus to an item (at once or 300 ms later); container focus, or focus left on the button, fails, and the probe never places focus itself", async () => {
      expect(await one("/fi-menu", "focus-into")).toMatchObject({ state: "passed", why: "focus moved to the menu item 'Rename' inside the menu when it opened", keys: [] });
      expect(await one("/fi-menu-late", "focus-into")).toMatchObject({ state: "passed" });
      expect(await one("/fi-menu-container", "focus-into")).toMatchObject({ state: "failed", why: "focus went to the menu itself, not to one of its items (1 s after it opened)", fix: expect.stringMatching(/^When the menu opens, move focus to its first item/) });
      // Its items take focus (tabindex=-1): a probe that placed focus would have passed it.
      expect(await one("/fi-menu-none", "focus-into")).toMatchObject({ state: "failed", why: "focus stayed on the button that opened the menu (1 s after it opened)" });
    }, 60_000);

    test("a modal dialog passes with focus inside, the dialog itself included (a native showModal() does it by itself); focus left on the button or moved outside fails", async () => {
      expect(await one("/fi-native-dialog", "focus-into")).toMatchObject({ state: "passed", why: "focus moved to a button 'Close' inside the dialog when it opened" });
      expect(await one("/fi-dialog-self", "focus-into")).toMatchObject({ state: "passed", why: "focus moved to the dialog itself when it opened" });
      expect(await one("/fi-dialog-none", "focus-into")).toMatchObject({ state: "failed", why: "focus stayed on the button that opened the dialog (1 s after it opened)", fix: expect.stringMatching(/^When the dialog opens, move focus inside it/) });
      expect(await one("/fi-dialog-outside", "focus-into")).toMatchObject({ state: "failed", why: "focus went to a button 'After' outside the dialog, not inside the dialog (1 s after it opened)" });
    }, 60_000);

    test("a combobox and a popover aren't checked (not-applicable); no key is ever sent", async () => {
      const keys = logged("key").length;
      expect(await one("/ts-combobox", "focus-into")).toMatchObject({ state: "not-applicable" });
      expect(await one("/ts-popover", "focus-into")).toMatchObject({ state: "not-applicable" });
      await probe("/fi-menu", ["focus-into"]);
      expect(logged("key").slice(keys)).toEqual([]);
    }, 60_000);
  });

  describe("trigger-state", () => {
    test("a menu button passes with aria-expanded false → true and aria-controls on the menu, or APG's way (left off while closed, no aria-controls), saying so", async () => {
      expect(await one("/ts-menu", "trigger-state")).toMatchObject({ state: "passed", why: 'aria-expanded went to "true" when the menu opened, aria-haspopup says it opens a menu, and aria-controls names the menu', keys: [] });
      expect(await one("/ts-menu-apg", "trigger-state")).toMatchObject({ state: "passed", info: expect.arrayContaining([expect.stringMatching(/aria-expanded is left off while the menu is closed/)]) });
      // Set 200 ms after the menu shows: within the moment the state is given to follow.
      expect(await one("/ts-menu-late", "trigger-state")).toMatchObject({ state: "passed" });
    }, 60_000);

    test("a menu button fails when aria-expanded never changes or is missing, when aria-controls names a wrapper instead of the menu, or when aria-haspopup goes away; the fix names what to set", async () => {
      expect(await one("/ts-menu-static", "trigger-state")).toMatchObject({ state: "failed", why: 'aria-expanded stayed "false" while the menu was open', fix: expect.stringMatching(/^Give the menu button aria-haspopup="menu" and aria-expanded/) });
      expect(await one("/ts-menu-no-expanded", "trigger-state")).toMatchObject({ state: "failed", why: "aria-expanded isn't set while the menu is open" });
      expect(await one("/ts-menu-wrapper", "trigger-state")).toMatchObject({ state: "failed", why: 'aria-controls names a div element, not the menu itself (role="menu")' });
      expect(await one("/ts-menu-drops-haspopup", "trigger-state")).toMatchObject({ state: "failed", why: "aria-haspopup is missing while the menu is open" });
    }, 60_000);

    test("a combobox passes with aria-expanded false → true and aria-controls on its listbox; a wrong aria-haspopup, or no aria-expanded while closed, fails", async () => {
      expect(await one("/ts-combobox", "trigger-state")).toMatchObject({ state: "passed", why: 'aria-expanded went to "true" when the listbox opened and aria-controls names the listbox' });
      expect(await one("/ts-combobox-haspopup", "trigger-state")).toMatchObject({ state: "failed", why: 'aria-haspopup is "menu" on a combobox whose popup is a listbox; leave it off or set it to "listbox"', fix: expect.stringMatching(/^Give the combobox aria-expanded/) });
      expect(await one("/ts-combobox-closed", "trigger-state")).toMatchObject({ state: "failed", why: 'aria-expanded isn\'t set while the listbox is closed (a combobox says "false")' });
    }, 60_000);

    test("a native popovertarget passes by itself; a hand-set aria-expanded that never changes fails; a disclosure-style popover passes; a dialog's button isn't checked", async () => {
      expect(await one("/ts-popover", "trigger-state")).toMatchObject({ state: "passed", why: "the button names its popover with popovertarget, so the browser says whether it is open" });
      expect(await one("/ts-popover-stale", "trigger-state")).toMatchObject({ state: "failed", why: expect.stringMatching(/^aria-expanded is set by hand and says "false" while the popover is open/) });
      expect(await one("/ts-disclosure", "trigger-state")).toMatchObject({ state: "passed" });
      const clicks = logged("click").length;
      expect(await one("/ts-dialog", "trigger-state")).toMatchObject({ state: "not-applicable" });
      // Not applicable: nothing was clicked.
      expect(logged("click").slice(clicks)).toEqual([]);
    }, 60_000);

    test("repeated identical menus are never told apart by position (incomplete, none clicked); named apart, each is checked", async () => {
      const clicks = logged("click").length;
      const repeated = await probe("/ts-repeated", ["trigger-state"]);
      expect(repeated.targets.map((t) => t.scenarios[0]!.state)).toEqual(["incomplete", "incomplete"]);
      expect(logged("click").slice(clicks)).toEqual([]);
      const named = await probe("/ts-repeated-named", ["trigger-state"]);
      expect(named.targets.map((t) => [t.key.accessibleName, t.scenarios[0]!.state])).toEqual([["More for Alpha", "passed"], ["More for Beta", "passed"]]);
    }, 60_000);

    test("it sends no key, and only triggers are clicked", async () => {
      const keys = logged("key").length;
      const clicks = logged("click").length;
      await probe("/ts-menu", ["trigger-state"]);
      await probe("/ts-combobox", ["trigger-state"]);
      expect(logged("key").slice(keys)).toEqual([]);
      expect(logged("click").slice(clicks)).toEqual(["trigger-t1", "trigger-c1"]);
    }, 60_000);
  });
});
