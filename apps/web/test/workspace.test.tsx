// @vitest-environment jsdom
/** Work > Workspace: every product's status, which one the hub shows, and opening another. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectStatus, StatusReport } from "@youiyoux/core";
import { WorkspaceScreen } from "../src/screens/workspace/WorkspaceScreen.tsx";

const status = (id: string, root: string, extra: Partial<ProjectStatus> = {}): ProjectStatus => ({
  id,
  root,
  system: { id: "acme", name: "Acme", version: "2.1.0", source: "package @acme/design", linked: false, commit: null },
  lock: { systemVersion: "2.1.0", syncedAt: "2026-10-22T12:00:00.000Z" },
  sync: { state: "current", changes: [] },
  drift: [],
  check: { errors: 0, warnings: 3, baseline: null, incomplete: false },
  components: { system: 12, used: 9, sites: 204 },
  requests: { open: 0, addressed: 0, unreadable: 0 },
  next: "nothing to do",
  ...extra,
});

const report: StatusReport = {
  schema: "youi.status/v1",
  generatedAt: "2026-10-23T12:00:00.000Z",
  workspace: "youi.workspace.json",
  projects: [
    status("web", "apps/web"),
    { root: "../billing", error: "no youi.project.json", next: "youiyoux adopt or youiyoux init --design <dir> in ../billing" },
    status("admin", "apps/admin", { sync: { state: "behind", changes: [{ file: "components/ui/button.tsx", action: "updated" }] }, check: { errors: 2, warnings: 0, baseline: null, incomplete: false }, next: "youiyoux sync: 1 file would change" }),
  ],
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/workspace#key=run-key");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workspace", () => {
  test("each product with where it stands and its next step; the one shown is marked, one that cannot be read says why, and Open asks the service with this run's key", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ report, current: 2 }) : json({ report, current: 0 })));
    vi.stubGlobal("fetch", fetch);
    render(<WorkspaceScreen />);
    const list = await screen.findByRole("list", { name: "Products" });
    const [web, billing, admin] = within(list).getAllByRole("listitem");
    expect(web?.getAttribute("aria-current")).toBe("true");
    expect(within(web!).getByText("Showing")).toBeTruthy();
    expect(web!.textContent).toContain("Acme v2.1.0 · package @acme/design");
    expect(web!.textContent).toContain("9 of 12 components used");
    expect(within(billing!).getByText("Cannot be read")).toBeTruthy();
    expect(billing!.textContent).toContain("Next: youiyoux adopt or youiyoux init --design <dir> in ../billing");
    // The command in mono, why in words.
    expect(admin!.querySelector(".font-mono.text-ink")?.textContent).toBe("youiyoux sync");
    expect(admin!.textContent).toContain("Next: youiyoux sync: 1 file would change");
    expect(within(admin!).getByText("Behind: 1 file")).toBeTruthy();
    expect(admin!.textContent).toContain("2 errors");

    fireEvent.click(within(admin!).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Products" })).getAllByRole("listitem")[2]?.getAttribute("aria-current")).toBe("true"));
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(url).toMatch(/\/api\/workspace\/open$/);
    expect(JSON.parse(String(init?.body))).toEqual({ index: 2 });
    expect((init?.headers as Record<string, string>)["x-youi-session"]).toBe("run-key");
  });

  test("without a workspace service it says how to open one; a refused open is said, and the list stays", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    render(<WorkspaceScreen />);
    expect(await screen.findByText("No workspace here")).toBeTruthy();
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ error: "this tab does not carry this run's key" }, 401) : json({ report, current: 0 }))));
    render(<WorkspaceScreen />);
    const list = await screen.findByRole("list", { name: "Products" });
    fireEvent.click(within(within(list).getAllByRole("listitem")[2]!).getByRole("button", { name: "Open" }));
    expect((await screen.findByRole("alert")).textContent).toContain("open the hub from the link `youiyoux ui` printed");
    expect(within(screen.getByRole("list", { name: "Products" })).getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBe("true");
  });
});
