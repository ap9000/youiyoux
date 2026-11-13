// @vitest-environment jsdom
/**
 * The Behaviour tab (a picked component's popups) and a screen's Behaviour section (all of them):
 * without consent only the words and the switch; Run on this component or this screen; "Testing 2
 * popups on /flows…" while it runs; one row per check with its result as text and a sage or clay dot,
 * why and fix on a failure, can't tell with its why, stale never counted, data blocked as a note,
 * evidence behind a keyboard-reachable button; a failed row filed by naming the stored result only.
 */
import { BEHAVIOUR_NOT_RUN } from "@youiyoux/core/rules";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BehaviourCheckId, BehaviourResult } from "@youiyoux/core";
import type { BehaviourResultView, BehaviourView } from "../src/data/behaviour.ts";
import type { Model } from "../src/data/model.ts";
import { buildScreens } from "../src/data/screens.ts";
import type { CatalogRule, Manifest, ScanReport } from "../src/data/types.ts";
import { indexUsage } from "../src/data/usage.ts";
import { BehaviourPanel } from "../src/screens/screens/Behaviour.tsx";
import { IssueGroups, ScreenDetail } from "../src/screens/screens/ScreenDetail.tsx";

const RULE = "youi:demo/rule/popup.escape";
const AT = "2026-11-12T10:00:00.000Z";
const WHY = "Esc didn't close the menu within 1.5 s, while a run without Esc showed it stays open by itself; a very long sentence that goes on to say exactly which element had focus when the key was sent and what the page did next, so it has to wrap on a phone.";
const freshness = { rule: "0123456789ab", tool: "youiyoux test", origin: "http://127.0.0.1:5173", config: "0123456789ab", app: "0123456789ab", bindings: "0123456789ab" };

function result(index: number, check: BehaviourCheckId, state: BehaviourResult["state"], over: Partial<BehaviourResultView> = {}, component = "UserMenu", name = "More"): BehaviourResultView {
  return {
    runId: "run1",
    at: AT,
    viewport: { width: 1280, height: 800 },
    route: "/flows",
    rule: RULE,
    target: { route: "/flows", pattern: "menu-button", component, accessibleName: name, file: "src/user-menu.tsx", line: 12 },
    pattern: "menu-button",
    check,
    state,
    why: state === "passed" ? "Esc closed it" : WHY,
    fix: "When the menu is open, close it on Esc and put focus back on its button.",
    info: [],
    dataBlocked: false,
    evidence: [],
    freshness,
    index,
    stale: [],
    counts: true,
    ...over,
  };
}

const RESULTS: BehaviourResultView[] = [
  result(0, "dismiss-escape", "failed", { info: ["a control run without Esc saw the menu stay open for 1.5 s"] }),
  result(1, "trigger-state", "passed"),
  result(2, "focus-into", "incomplete", { why: "clicking the button didn't open anything we could identify", fix: "Next: check the menu opens on click." }),
  result(3, "focus-return", "failed", { stale: ["the code changed"], counts: false }),
  result(4, "arrow-keys", "passed", { dataBlocked: true }),
  result(5, "focus-trap", "not-applicable"),
  result(6, "dismiss-escape", "passed", {}, "Toolbar", "Sort"),
];

function view(over: Partial<BehaviourView> = {}): BehaviourView {
  return {
    route: "/flows",
    rules: [{ id: RULE, title: "Esc closes popups", severity: "error", check: "dismiss-escape" }],
    run: { schema: "youiyoux.behaviour/v1", route: "/flows", runId: "run1", at: AT, origin: "http://127.0.0.1:5173", viewport: { width: 1280, height: 800 }, state: "probed", why: null, fix: null, coverage: "2 popup triggers found by ARIA markers.", notes: [], rules: [], targets: [] },
    results: RESULTS,
    problem: null,
    consent: { screens: true, on: true, origin: "http://127.0.0.1:5173", allowedOrigin: "http://127.0.0.1:5173", matches: true, why: null, words: "Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data." },
    running: null,
    last: null,
    ...over,
  };
}

let posts: Array<{ path: string; body: Record<string, unknown> }>;
let answer: { view: BehaviourView; status: { running: unknown; last: unknown }; live: Record<string, unknown> };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  answer = { view: view(), status: { running: null, last: null }, live: { project: "app", base: "http://127.0.0.1:5173", viewport: { width: 1280, height: 800 }, screens: [{ route: "/flows", path: "/flows" }] } };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost/");
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/screens/behaviour") {
        answer.view = view();
        return json({ allowedOrigin: "http://127.0.0.1:5173" });
      }
      if (url.pathname === "/api/behaviour/run") {
        const running = { route: "/flows", target: body.target ?? null, startedAt: AT, popups: 2, by: "person" };
        answer.status = { running, last: null };
        return json({ running }, 202);
      }
      if (url.pathname === "/api/requests") return json({ id: "r-0123456789", kind: "change", status: "open", ...body }, 201);
    }
    if (url.pathname === "/api/behaviour") return json(answer.view);
    if (url.pathname === "/api/behaviour/run") return json(answer.status);
    if (url.pathname === "/api/live") return json(answer.live);
    if (url.pathname === "/api/requests") return json({ requests: [], unreadable: [] });
    return json({ error: "not here", code: "not-found" }, 404);
  }));
  sessionStorage.setItem("youiyoux.editor-key", "k-test");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("without consent", () => {
  test("only the words and the switch; the switch asks the service, then the tab can run", async () => {
    answer.view = view({ consent: { screens: true, on: false, origin: "http://127.0.0.1:5173", allowedOrigin: null, matches: false, why: "Probing isn't switched on.", words: "Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data." } });
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    await screen.findByText("Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data.");
    expect(screen.queryByRole("button", { name: "Run on this component" })).toBeNull();
    expect(container.querySelector("[data-behaviour-row]")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Switch probing on for http://127.0.0.1:5173" }));
    await screen.findByRole("button", { name: "Run on this component" });
    // Consent carries no origin: the service binds it to base's.
    expect(posts).toEqual([{ path: "/api/screens/behaviour", body: { allow: true } }]);
  });

  test("a base that moved since consent says so, and asks again", async () => {
    answer.view = view({ consent: { screens: true, on: false, origin: "http://127.0.0.1:5174", allowedOrigin: "http://127.0.0.1:5173", matches: false, why: "moved", words: "Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data." } });
    render(<BehaviourPanel route="/flows" />);
    expect((await screen.findByText(/Probing was switched on for/)).textContent).toBe("Probing was switched on for http://127.0.0.1:5173, but the app now runs at http://127.0.0.1:5174.");
    expect(screen.getByRole("button", { name: "Switch probing on for http://127.0.0.1:5174" })).toBeTruthy();
  });
});

describe("a component's popups", () => {
  test("rows per check: result as text and a dot, why and fix on a failure, can't tell with why, stale not counted, data blocked as a note; another component's popups aren't shown", async () => {
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    await screen.findByText(/Results from/);
    expect(container.textContent).toContain("Checks how UserMenu’s popups behave on /flows.");
    const rows = [...container.querySelectorAll<HTMLElement>("[data-behaviour-row]")];
    // Not-applicable checks aren't rows; Toolbar's popup is another component's.
    expect(rows.map((r) => `${r.dataset.behaviourRow} ${r.dataset.state}`)).toEqual(["dismiss-escape failed", "trigger-state passed", "focus-into incomplete", "focus-return stale", "arrow-keys passed"]);
    expect(container.textContent).not.toContain("Sort");
    const [failed, passed, cantTell, stale, blocked] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(failed.textContent).toContain("Failed");
    expect(failed.textContent).toContain(WHY);
    expect(failed.textContent).toContain("When the menu is open, close it on Esc and put focus back on its button.");
    expect(failed.querySelector(".bg-danger")).not.toBeNull();
    expect(passed.textContent).toContain("Passed");
    expect(passed.querySelector(".bg-success")).not.toBeNull();
    expect(passed.textContent).not.toContain("Esc closed it");
    expect(cantTell.textContent).toContain("Can't tell");
    expect(cantTell.textContent).toContain("clicking the button didn't open anything we could identify");
    expect(cantTell.querySelector(".rounded-full")).toBeNull();
    expect(stale.textContent).toContain("Stale");
    expect(stale.textContent).toContain("The code or rule changed since this run (the code changed), so it isn’t counted.");
    expect(stale.querySelector(".rounded-full")).toBeNull();
    expect(stale.textContent).not.toContain("File as change request");
    expect(blocked.textContent).toContain("Tested with its data blocked");
    // Status is never a filled background behind the words.
    expect(container.innerHTML).not.toMatch(/bg-(success|danger)-soft/);
    // Only a fresh, counted failure can be filed.
    expect(screen.getAllByRole("button", { name: "File as change request" })).toHaveLength(1);
  });

  test("evidence is behind a real button: in the tab order, says whether it is open, and opens on activation", async () => {
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    const show = await screen.findByRole("button", { name: "Show evidence" });
    expect(show.tagName).toBe("BUTTON");
    expect(show.getAttribute("tabindex")).not.toBe("-1");
    show.focus();
    expect(document.activeElement).toBe(show);
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-behaviour-evidence]")).toBeNull();
    fireEvent.click(show);
    expect(container.querySelector("[data-behaviour-evidence]")?.textContent).toBe("a control run without Esc saw the menu stay open for 1.5 s");
    expect(screen.getByRole("button", { name: "Hide evidence" }).getAttribute("aria-expanded")).toBe("true");
  });

  test("Run on this component sends the component, says what it is testing while it runs, then shows the new results", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer.view = view({ run: null, results: [] });
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    await screen.findByText("Nothing has been probed on /flows yet.");
    fireEvent.click(screen.getByRole("button", { name: "Run on this component" }));
    expect((await screen.findByRole("status")).textContent).toBe("Testing 2 popups on /flows…");
    expect(posts).toEqual([{ path: "/api/behaviour/run", body: { route: "/flows", target: { component: "UserMenu" } } }]);
    expect((screen.getByRole("button", { name: "Run on this component" }) as HTMLButtonElement).disabled).toBe(true);
    answer.view = view();
    answer.status = { running: null, last: { route: "/flows", target: { component: "UserMenu" }, at: AT, runId: "run1", problem: null } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitFor(() => expect(container.querySelectorAll("[data-behaviour-row]").length).toBe(5));
    expect(container.querySelector("[data-behaviour-running]")).toBeNull();
  });

  test("a failed row is filed by naming the stored result only; the service builds the request", async () => {
    const onFiled = vi.fn();
    render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} onFiled={onFiled} />);
    fireEvent.click(await screen.findByRole("button", { name: "File as change request" }));
    expect((await screen.findByText(/^Filed as/)).textContent).toBe("Filed as r-0123456789: it is addressed once this check passes in a newer run.");
    expect(posts).toEqual([{ path: "/api/requests", body: { kind: "change", behaviour: { route: "/flows", runId: "run1", index: 0 } } }]);
    expect(onFiled).toHaveBeenCalledWith(expect.objectContaining({ id: "r-0123456789" }));
  });

  test("a component with no probed popups says how popups are matched", async () => {
    render(<BehaviourPanel route="/flows" component={{ name: "Card" }} />);
    expect((await screen.findByText(/^No popups of Card/)).textContent).toBe("No popups of Card were found in the last run. A popup belongs to the component that renders its button: pick that one, or run the whole screen from its page.");
  });
});

describe("route notes", () => {
  test("a socket the screen opened while it loaded is said once, as a note, not on each row", async () => {
    const note = "while the screen loaded, the page tried to open a WebSocket or tunnel to 127.0.0.1:5173; it was blocked (a dev server's reload socket, often); every popup here was tested without it";
    answer.view = view({ run: { ...view().run!, notes: [note] } });
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    expect((await screen.findByText(/^Note: while the screen loaded/)).textContent).toBe(`Note: ${note}`);
    expect(container.querySelectorAll("[data-behaviour-note]")).toHaveLength(1);
  });
});

describe("an open tab", () => {
  const states = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-behaviour-row]")].map((r) => r.dataset.state);
  const views = () => vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input), "http://localhost/").pathname === "/api/behaviour").length;
  const nowStale = () => view({ results: RESULTS.map((r) => ({ ...r, stale: ["the code changed"], counts: false })) });

  test("reads its results again every 30 s while visible, so a pass that went stale shows as stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    await screen.findByText(/Results from/);
    expect(states(container)).toContain("passed");
    answer.view = nowStale();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100);
    });
    await waitFor(() => expect(states(container).every((st) => st === "stale")).toBe(true));
    expect(screen.queryAllByText("Passed")).toHaveLength(0);
  });

  test("reads them again when the tab comes back into focus or view; not on a timer while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<BehaviourPanel route="/flows" component={{ name: "UserMenu" }} />);
    await screen.findByText(/Results from/);
    const before = views();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(views()).toBe(before);
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    }
    answer.view = nowStale();
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(states(container).every((st) => st === "stale")).toBe(true));
    answer.view = view();
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(states(container)).toContain("passed"));
  });
});

describe("a screen's Behaviour section", () => {
  test("Run on this screen sends no target and shows every popup", async () => {
    const { container } = render(<BehaviourPanel route="/flows" />);
    await screen.findByText(/Results from/);
    expect(container.textContent).toContain("Checks how every popup on /flows behaves.");
    expect(container.querySelectorAll("[data-behaviour-popup]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Run on this screen" }));
    await screen.findByRole("status");
    expect(posts).toEqual([{ path: "/api/behaviour/run", body: { route: "/flows" } }]);
  });

  test("a refusal from the service is shown in its words", async () => {
    render(<BehaviourPanel route="/flows" />);
    await screen.findByText(/Results from/);
    vi.mocked(fetch).mockImplementationOnce(async () => json({ error: "a behaviour run is already going for this app (/other, started now): wait for it to finish, then run again", code: "conflict" }, 409));
    fireEvent.click(screen.getByRole("button", { name: "Run on this screen" }));
    expect((await screen.findByRole("alert")).textContent).toBe("a behaviour run is already going for this app (/other, started now): wait for it to finish, then run again");
  });

  test("ScreenDetail reads the stored results for the served product's screen, with Run on this screen, and its rule issues point there", async () => {
    const rule: CatalogRule = { schema: "youi.rule/v1", id: RULE, title: "Esc closes popups", severity: "error", statement: "Esc closes every popup.", rationale: "", agent: "Close popups on Esc.", check: { engine: "behaviour", id: "dismiss-escape", options: {} }, files: ["**/*.tsx"], examples: { bad: [], good: [] } };
    const report: ScanReport = {
      schema: "youi.usage/v1",
      project: "app",
      system: "demo",
      commit: null,
      scanner: "test",
      configDigest: "x",
      generatedAt: AT,
      durationMs: 1,
      status: "complete",
      coverage: { filesMatched: 1, filesScanned: 1, failed: [] },
      usages: [{ element: "youi:demo/component/button", kind: "render", export: "Button", local: "Button", props: {}, spread: false, file: "src/flows.tsx", line: 3, column: 1, routes: ["/flows"], routeSource: "route-file", fingerprint: "f" }],
      fileRoutes: { "src/flows.tsx": { routes: ["/flows"], routeSource: "route-file" } },
      unknowns: [],
      suppressed: 0,
      lookalikes: [],
      violations: [],
      checks: [{ rule: RULE, state: "incomplete", reason: BEHAVIOUR_NOT_RUN }],
    };
    const manifest: Manifest = { schema: "youiyoux.manifest/v1", source: { commit: null }, systems: [{ id: "demo", catalog: "demo.catalog.json", usage: [{ project: "app", file: "app.usage.json" }] }] };
    const model = { rules: new Map([[RULE, rule]]), byId: new Map(), components: new Map() } as unknown as Model;
    const screens = buildScreens(indexUsage([report]), manifest);
    const flows = screens.screens.find((s) => s.route === "/flows")!;
    const { container } = render(<ScreenDetail model={model} screens={screens} screen={flows} />);
    await screen.findByRole("button", { name: "Run on this screen" });
    expect(container.querySelectorAll("[data-behaviour-row]").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Behaviour not checked by the scan: Esc closes popups. A probe run in the running app checks these: the last run's results are under Behaviour on this page.");
    expect(container.textContent).not.toContain("none has run");
    cleanup();
    // Another product's screen (or no service): no Behaviour section, and the words say where results live.
    answer.live = { ...answer.live, project: "elsewhere" };
    const other = render(<ScreenDetail model={model} screens={screens} screen={flows} />);
    await waitFor(() => expect(other.container.textContent).toContain("this page can't read its results"));
    expect(screen.queryByRole("button", { name: "Run on this screen" })).toBeNull();
    cleanup();
    const plain = render(<IssueGroups model={model} screen={flows} />);
    expect(plain.container.textContent).toContain("youiyoux behave, or Run on this screen in the hub youiyoux ui starts");
  });
});
