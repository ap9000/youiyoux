/**
 * dismiss-escape end to end in a real headless Chromium, against fixture apps served here on a
 * loopback port: effective focus placed inside the popup (or on the combobox), consent read again,
 * Escape pressed once by real keyboard input, then "closed" polled within the 1.5 s close budget.
 * Every page logs the clicks and keys it sees back to its server, so what was clicked and pressed
 * is what the app itself saw.
 */
import { createServer, type Server } from "node:http";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchBrowser } from "@youiyoux/detect";
import { assertSafeKey, probeRoute, SWITCHED_OFF, type ProbeRouteOptions, type RouteProbe, type TargetScenario } from "../src/index.ts";

const MISSING = await launchBrowser(process.env.YOUI_CHROMIUM, { download: false }).then(
  async (browser) => {
    await browser.close();
    return null;
  },
  (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
);
const HAVE_CHROMIUM = MISSING === null;
const GATE = process.env.YOUI_SECURITY_GATE === "1";
if (!HAVE_CHROMIUM) console.warn(`dismiss-escape probe tests ${GATE ? "FAIL" : "skipped"}: ${MISSING}`);
test.runIf(GATE && !HAVE_CHROMIUM)("security gate: dismiss-escape's browser tests need Chromium", () => {
  throw new Error(`YOUI_SECURITY_GATE is set and Chromium couldn't be launched (${MISSING}): nothing was tested`);
});

describe("safe keys", () => {
  test("only Escape may be sent: every other key is refused before anything is sent", () => {
    expect(() => assertSafeKey("Escape")).not.toThrow();
    for (const key of ["Enter", " ", "Space", "Tab", "ArrowDown", "a", "Shift+Tab", "escape"]) expect(() => assertSafeKey(key), key).toThrow(/sends only Escape/);
  });
});

describe.skipIf(!HAVE_CHROMIUM)("dismiss-escape in a real browser", () => {
  let browser: Browser;
  let server: Server;
  let origin = "";
  const requests: Array<{ method: string; path: string; query: string }> = [];

  const LOGGER = `<script>
    const report = (q) => { new Image().src = "/log?" + q; };
    document.addEventListener("click", (e) => report("click=" + encodeURIComponent(e.target.closest("[data-log]")?.dataset.log ?? e.target.localName)), true);
    document.addEventListener("keydown", (e) => report("key=" + encodeURIComponent(e.key)), true);
  </script>`;
  const page = (body: string, script = "") => `<!doctype html><meta charset="utf-8"><title>fixture</title><body>${LOGGER}${body}<script>${script}</script></body>`;
  /**
   * An APG-style menu button: items with tabindex=-1, focus to the first item on open. `onEscape`
   * is what the menu's keydown handler does with Esc (nothing, when it's empty); `before` runs first
   * in the click.
   */
  const menu = (name: string, id: string, onEscape: string, before = "", itemTabindex = true) =>
    `<button data-log="trigger-${id}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" onclick="${before.replace(/"/g, "&quot;")};const m=document.getElementById('${id}');m.hidden=false;this.setAttribute('aria-expanded','true');m.querySelector('[role=menuitem]').focus()">${name}</button>` +
    `<ul role="menu" id="${id}" hidden onkeydown="if (event.key === 'Escape') { ${onEscape.replace(/"/g, "&quot;")} }"><li role="menuitem" ${itemTabindex ? 'tabindex="-1"' : ""} data-log="item-${id}">Rename</li><li role="menuitem" ${itemTabindex ? 'tabindex="-1"' : ""} data-log="item2-${id}">Delete</li></ul>`;
  const CLOSE = (id: string) => `document.getElementById('${id}').hidden=true;document.querySelector('[aria-controls=${id}]').setAttribute('aria-expanded','false');document.querySelector('[aria-controls=${id}]').focus();`;

  const pages: Record<string, () => string> = {
    "/menu-esc": () => page(menu("Actions", "m1", CLOSE("m1"))),
    "/menu-ignores": () => page(menu("Actions", "m2", "")),
    // Esc starts a 400 ms exit animation; the menu is hidden at its end.
    "/menu-anim": () => page(menu("Actions", "m3", `const m=document.getElementById('m3'); m.style.opacity='0.5'; setTimeout(() => { ${CLOSE("m3")} }, 400);`)),
    // Esc closes it only after 2 s: past the 1.5 s close budget.
    "/menu-slow": () => page(menu("Actions", "m4", `setTimeout(() => { ${CLOSE("m4")} }, 2000);`)),
    // A combobox whose listbox is portalled to the end of the body; focus stays on the combobox.
    "/combobox": () =>
      page(
        `<label for="cb">Fruit</label><input id="cb" data-log="trigger-cb" role="combobox" aria-expanded="false" aria-controls="lb" aria-autocomplete="list" onclick="document.getElementById('lb').hidden=false;this.setAttribute('aria-expanded','true')" onkeydown="if (event.key === 'Escape') { document.getElementById('lb').hidden=true; this.setAttribute('aria-expanded','false'); }"><main><p>Other content</p></main>`,
        `const portal = document.createElement('div'); portal.innerHTML = '<ul role="listbox" id="lb" hidden><li role="option" id="o1">Apple</li><li role="option" id="o2">Pear</li></ul>'; document.body.append(portal);`,
      ),
    // A native <dialog> opened with showModal(): the browser closes it on Esc.
    "/native-dialog": () => page(`<button data-log="trigger-nd" aria-haspopup="dialog" onclick="document.getElementById('nd').showModal()">Settings</button><dialog id="nd"><p>Settings</p><button data-log="inside-nd">Close</button></dialog>`),
    // A native popover (popover="auto"): the browser closes it on Esc.
    "/native-popover": () => page(`<button data-log="trigger-np" popovertarget="np">Info</button><div popover id="np"><p>Help</p><button data-log="inside-np">Got it</button></div>`),
    // A hand-made modal dialog that ignores Esc (and swallows the key).
    "/modal-ignores": () =>
      page(
        `<button data-log="trigger-md" aria-haspopup="dialog" aria-controls="md" onclick="const d=document.getElementById('md');d.hidden=false;d.querySelector('button').focus()">Delete project</button>` +
          `<div role="dialog" aria-modal="true" id="md" hidden onkeydown="if (event.key === 'Escape') event.preventDefault()"><p>Sure?</p><button data-log="inside-md">Cancel</button></div>`,
      ),
    // Its click asks for data (blocked after the click), and the menu opens anyway.
    "/menu-data": () => page(menu("Inbox", "m5", CLOSE("m5"), "fetch('/api/items?page=1').catch(() => {})")),
    // Nothing inside the menu can take focus, and the menu itself can't either.
    "/menu-nofocus": () => page(menu("Actions", "m6", CLOSE("m6"), "", false).replace(";m.querySelector('[role=menuitem]').focus()", "")),
    // Esc closes it, and also tries to leave the page.
    "/esc-leaves": () => page(menu("Actions", "m7", `${CLOSE("m7")}location.href='/elsewhere?x=1';`)),
    // The app doesn't move focus on open; the first item's focus handler closes the menu.
    "/focus-closes": () => page(menu("Actions", "m9", CLOSE("m9")).replace(";m.querySelector('[role=menuitem]').focus()", "").replace('data-log="item-m9"', `data-log="item-m9" onfocus="setTimeout(() => { ${CLOSE("m9").replace(/'/g, "&#39;")} }, 10)"`)),
    // The app doesn't move focus on open; focusing an item reports it to the server.
    "/focus-reports": () => page(menu("Actions", "m10", CLOSE("m10")).replace(";m.querySelector('[role=menuitem]').focus()", "").replace('data-log="item-m10"', `data-log="item-m10" onfocus="report('focus=m10')"`)),
    // A custom popover whose Esc handler drops the trigger's aria-controls, and stays open.
    "/drops-relationship": () =>
      page(
        `<button data-log="trigger-cp" aria-expanded="false" aria-controls="cp" onclick="const p=document.getElementById('cp');p.hidden=false;this.setAttribute('aria-expanded','true');p.querySelector('button').focus()">Filters</button>` +
          `<div id="cp" hidden onkeydown="if (event.key === 'Escape') document.querySelector('[data-log=trigger-cp]').removeAttribute('aria-controls')"><button data-log="inside-cp">Apply</button></div>`,
      ),
    // A menu whose Esc handler renames it, and leaves it open.
    "/renames-popup": () => page(menu("Actions", "m11", "this.id = 'renamed'")),
    // A menu replaced on Esc by an identical one, still open.
    "/replaced-open": () => page(menu("Actions", "m12", "const c = this.cloneNode(true); this.replaceWith(c); c.querySelector('[role=menuitem]').focus();")),
    // Focus moving in closes the menu by itself, later than the probe's settle: at 180 ms, at 1.2 s. Esc does nothing.
    "/delayed-180": () => page(menu("Actions", "m14", "").replace(";m.querySelector('[role=menuitem]').focus()", "").replace('data-log="item-m14"', `data-log="item-m14" onfocus="setTimeout(() => { ${CLOSE("m14").replace(/'/g, "&#39;")} }, 180)"`)),
    "/delayed-1200": () => page(menu("Actions", "m15", "").replace(";m.querySelector('[role=menuitem]').focus()", "").replace('data-log="item-m15"', `data-log="item-m15" onfocus="setTimeout(() => { ${CLOSE("m15").replace(/'/g, "&#39;")} }, 1200)"`)),
    // Esc hides the menu and shows an identical one with the same id in its place.
    "/hides-and-replaces": () => page(menu("Actions", "m16", "const c = this.cloneNode(true); this.hidden = true; this.after(c); c.hidden = false; c.querySelector('[role=menuitem]').focus();")),
    // A menu removed from the page on Esc: closed.
    "/removed": () => page(menu("Actions", "m13", "document.querySelector('[aria-controls=m13]').focus(); this.remove();")),
    // Esc closes it, and also tries to send a POST.
    "/esc-posts": () => page(menu("Actions", "m8", `${CLOSE("m8")}fetch('/api/closed', { method: 'POST', body: 'x' }).catch(() => {});`)),
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

  const probe = (path: string, extra: Partial<ProbeRouteOptions> = {}): Promise<RouteProbe> =>
    probeRoute({ browser, origin, route: path, path, viewport: { width: 800, height: 600 }, checks: ["dismiss-escape"], ...extra });
  const only = (result: RouteProbe): TargetScenario => {
    expect(result.state).toBe("probed");
    expect(result.targets).toHaveLength(1);
    return result.targets[0]!.scenarios[0]!;
  };
  const logged = (key: string) => requests.filter((r) => r.path === "/log" && r.query.startsWith(`?${key}=`)).map((r) => decodeURIComponent(r.query.slice(key.length + 2)));
  const seen = (path: string) => requests.filter((r) => r.path === path);

  test("a menu that closes on Esc passes; one that ignores Esc fails with why and a menu fix", async () => {
    expect(only(await probe("/menu-esc"))).toMatchObject({ check: "dismiss-escape", state: "passed", why: "Esc closed the menu", keys: ["Escape"] });
    const ignored = only(await probe("/menu-ignores"));
    expect(ignored).toMatchObject({ state: "failed", why: "Esc did nothing: the menu was still open after 1.5 s", fix: expect.stringMatching(/^Close the menu when Esc is pressed while focus is in it/), keys: ["Escape"] });
  }, 60_000);

  test("the close budget allows a 400 ms exit animation, and not a menu that closes after 2 s", async () => {
    expect(only(await probe("/menu-anim"))).toMatchObject({ state: "passed" });
    const started = Date.now();
    expect(only(await probe("/menu-slow"))).toMatchObject({ state: "failed", why: "Esc did nothing: the menu was still open after 1.5 s" });
    // It waited out the whole budget before failing.
    expect(Date.now() - started).toBeGreaterThan(1_500);
  }, 60_000);

  test("a combobox with a portalled listbox: Esc on the combobox closes it", async () => {
    const result = await probe("/combobox");
    expect(result.targets[0]!.key).toMatchObject({ pattern: "combobox-listbox", accessibleName: "Fruit" });
    expect(only(result)).toMatchObject({ state: "passed", why: "Esc closed the listbox", popup: { how: "aria-controls", role: "listbox" } });
  }, 60_000);

  test("a native <dialog> opened with showModal() and a native popover pass by the browser's own Esc", async () => {
    const dialog = await probe("/native-dialog");
    expect(dialog.targets[0]!.key.pattern).toBe("modal-dialog");
    expect(only(dialog)).toMatchObject({ state: "passed", why: "Esc closed the dialog" });
    const popover = await probe("/native-popover");
    expect(popover.targets[0]!.key.pattern).toBe("popover");
    // Focus starts on its button; the probe moves it inside before pressing Esc, and says so.
    expect(only(popover)).toMatchObject({ state: "passed", why: "Esc closed the popover", info: expect.arrayContaining(["focus wasn't inside the popover after it opened; the probe moved it there before pressing Esc"]) });
  }, 60_000);

  test("a hand-made modal dialog that ignores Esc fails, with a dialog fix", async () => {
    expect(only(await probe("/modal-ignores"))).toMatchObject({ state: "failed", why: "Esc did nothing: the dialog was still open after 1.5 s", fix: expect.stringMatching(/^Close the dialog when Esc is pressed .*showModal\(\)/) });
  }, 60_000);

  test("a popup whose data is blocked but still opens is decided, and says it was tested with its data blocked", async () => {
    const result = only(await probe("/menu-data"));
    expect(result).toMatchObject({ state: "passed", dataBlocked: true, info: expect.arrayContaining(["the popup asked for data when it opened (GET /api/items); it was blocked, so this was tested with its data blocked"]) });
    expect(seen("/api/items")).toEqual([]);
  }, 60_000);

  test("when focus can't be placed inside the popup, Esc isn't pressed and the result is incomplete", async () => {
    const before = logged("key").length;
    expect(only(await probe("/menu-nofocus"))).toMatchObject({ state: "incomplete", why: "focus couldn't be placed inside the menu, so Esc wasn't pressed", fix: expect.stringMatching(/tabindex="-1"/), keys: [] });
    expect(logged("key").slice(before)).toEqual([]);
  }, 60_000);

  test("Esc that leaves the page or sends a POST is incomplete, never passed, and nothing leaves", async () => {
    expect(only(await probe("/esc-leaves"))).toMatchObject({ state: "incomplete", why: "the page tried to leave for /elsewhere; it was stopped before it left" });
    expect(seen("/elsewhere")).toEqual([]);
    expect(only(await probe("/esc-posts"))).toMatchObject({ state: "incomplete", why: "the page tried to send a POST to /api/closed; nothing was sent" });
    expect(seen("/api/closed")).toEqual([]);
  }, 60_000);

  test("the only key ever sent is one Escape per decided scenario, and only triggers are clicked", async () => {
    const keys = logged("key").length;
    const clicks = logged("click").length;
    const result = await probe("/menu-ignores", { checks: ["dismiss-escape", "focus-return", "focus-into", "arrow-keys", "trigger-state"] });
    // dismiss-escape and trigger-state (no key) are decided; the others open the menu and stop there.
    expect(result.targets[0]!.scenarios.map((s) => [s.check, s.state, s.keys])).toEqual([
      ["dismiss-escape", "failed", ["Escape"]],
      ["focus-return", "opened", []],
      ["focus-into", "opened", []],
      ["arrow-keys", "opened", []],
      ["trigger-state", "passed", []],
    ]);
    expect(logged("key").slice(keys)).toEqual(["Escape"]);
    expect(logged("click").slice(clicks)).toEqual(Array(5).fill("trigger-m2"));
    // Across every fixture so far: Escape is the only key the pages ever saw, and no item was clicked.
    expect(new Set(logged("key"))).toEqual(new Set(["Escape"]));
    expect(logged("click").filter((c) => !c.startsWith("trigger-"))).toEqual([]);
  }, 60_000);

  test("a popup that placing focus closes isn't tested: no key is sent, never passed", async () => {
    const keys = logged("key").length;
    expect(only(await probe("/focus-closes"))).toMatchObject({ state: "incomplete", why: "placing focus changed the menu (it closed, was replaced, or focus left it), so Esc wasn't pressed; not tested", keys: [] });
    expect(logged("key").slice(keys)).toEqual([]);
  }, 60_000);

  test("closed is judged on the popup itself: dropping the trigger's aria-controls or renaming the popup while it stays open fails; a replacement with its identity is still it; removed is closed", async () => {
    expect(only(await probe("/drops-relationship"))).toMatchObject({ state: "failed", why: "Esc did nothing: the popover was still open after 1.5 s" });
    expect(only(await probe("/renames-popup"))).toMatchObject({ state: "failed", why: "Esc did nothing: the menu was still open after 1.5 s" });
    expect(only(await probe("/replaced-open"))).toMatchObject({ state: "failed" });
    expect(only(await probe("/removed"))).toMatchObject({ state: "passed", why: "Esc closed the menu" });
  }, 60_000);

  test("a control run without Esc decides whether a closing is Esc's: a menu that closes itself after focus moves in (at 180 ms, at 1.2 s) is incomplete, never passed; a normal menu still passes", async () => {
    const keys = logged("key").length;
    for (const path of ["/delayed-180", "/delayed-1200"]) expect(only(await probe(path)), path).toMatchObject({ state: "incomplete", why: "the menu closes on its own after focus moves into it (a run without Esc saw it close), so Esc can't be judged", keys: ["Escape"] });
    // One Escape per test scenario; the control sends none.
    expect(logged("key").slice(keys)).toEqual(["Escape", "Escape"]);
    expect(only(await probe("/menu-esc"))).toMatchObject({ state: "passed", info: expect.arrayContaining(["a control run without Esc saw the menu stay open for 1.5 s"]) });
  }, 60_000);

  test("a hidden original with a showing replacement of the same id is still open: Esc that swaps the menu fails, never passes", async () => {
    expect(only(await probe("/hides-and-replaces"))).toMatchObject({ state: "failed", why: "Esc did nothing: the menu was still open after 1.5 s" });
  }, 60_000);

  test("consent is read after focus is placed, immediately before Esc: revoked while focus moved in, no key is sent", async () => {
    const keys = logged("key").length;
    let asked = 0;
    // Asked before the scenario (1), before the click (2) and before the key (3). At 3 it is
    // revoked once the page has seen focus move inside (it waits for that, up to 1.5 s): read
    // before focus, it would still be on and Esc would be sent.
    const stillAllowed = async () => {
      if (++asked !== 3) return null;
      for (const until = Date.now() + 1_500; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 20))) if (logged("focus").includes("m10")) return SWITCHED_OFF;
      return null;
    };
    const result = only(await probe("/focus-reports", { stillAllowed }));
    expect(logged("focus")).toContain("m10");
    expect(result).toMatchObject({ state: "incomplete", why: SWITCHED_OFF.why, keys: [] });
    expect(logged("key").slice(keys)).toEqual([]);
  }, 60_000);

  test("consent is read again immediately before Esc: switched off there, no key is sent", async () => {
    const keys = logged("key").length;
    let asked = 0;
    // Asked before the scenario (1), before the click (2) and before the key (3): off at 3.
    const stillAllowed = async () => (++asked === 3 ? SWITCHED_OFF : null);
    const result = only(await probe("/menu-esc", { stillAllowed }));
    expect(asked).toBe(3);
    expect(result).toMatchObject({ state: "incomplete", why: SWITCHED_OFF.why, keys: [] });
    expect(logged("key").slice(keys)).toEqual([]);
  }, 60_000);
});
