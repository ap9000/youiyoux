// @vitest-environment jsdom
/** The hosted hub's page: signing in with the view key, then every System's adoption by version and each repository's products. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OrgView, ProjectStatus } from "@youiyoux/core";
import { OrgApp } from "../src/org/OrgApp.tsx";

const status = (id: string, root: string, synced: string | null, extra: Partial<ProjectStatus> = {}): ProjectStatus => ({
  id,
  root,
  system: { id: "acme", name: "Acme", version: "2.0.0", source: "package @acme/design", linked: false, commit: null },
  lock: synced ? { systemVersion: synced, syncedAt: "2026-10-22T12:00:00.000Z" } : null,
  sync: { state: synced ? "current" : "never", changes: [] },
  drift: [],
  check: { errors: 0, warnings: 3, baseline: null, incomplete: false },
  components: { system: 12, used: 9, sites: 204 },
  requests: { open: 0, addressed: 0, unreadable: 0 },
  next: synced ? "nothing to do" : "youiyoux sync: this product has never been synced with its System",
  ...extra,
});

const view: OrgView = {
  schema: "youi.org/v1",
  generatedAt: "2026-10-23T13:00:00.000Z",
  repos: [
    { repo: "acme/billing", commit: "a".repeat(40), ref: "main", generatedAt: "2026-10-23T12:00:00.000Z", receivedAt: "2026-10-23T12:00:05.000Z", products: [status("billing", ".", "2.0.0"), status("admin", "apps/admin", "1.4.0", { check: { errors: 2, warnings: 0, baseline: null, incomplete: false } })] },
    { repo: "acme/site", commit: null, ref: null, generatedAt: "2026-10-23T11:00:00.000Z", receivedAt: "2026-10-23T11:00:05.000Z", products: [status("site", ".", null), { root: "packages/old", error: "no youi.project.json", next: "youiyoux adopt" }] },
  ],
  systems: [{ id: "acme", name: "Acme", latest: "2.0.0", versions: [{ version: "2.0.0", products: [{ repo: "acme/billing", id: "billing" }] }, { version: "1.4.0", products: [{ repo: "acme/billing", id: "admin" }] }, { version: null, products: [{ repo: "acme/site", id: "site" }] }] }],
  totals: { repos: 2, products: 4, unreadable: 1, behind: 2, failing: 1 },
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the hosted hub", () => {
  test("signed out, it asks for the view key; a wrong one says so; the right one shows the organisation", async () => {
    let signedIn = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/session") {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        if (key !== "the-view-key") return json({ error: "that is not this hub's view key" }, 401);
        signedIn = true;
        return json({ ok: true });
      }
      return signedIn ? json(view) : json({ error: "sign in with the hub's view key" }, 401);
    });
    vi.stubGlobal("fetch", fetch);
    render(<OrgApp api="/api/org" />);
    const field = await screen.findByLabelText("View key");
    expect(field.getAttribute("type")).toBe("password");
    fireEvent.change(field, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("that is not this hub's view key")).toBeTruthy();
    fireEvent.change(field, { target: { value: "the-view-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Adoption by version")).toBeTruthy();
    // The key goes to the server once, in the body; the page keeps no copy.
    expect(fetch.mock.calls.filter(([url]) => url === "/api/session").map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
    expect(JSON.stringify(localStorage)).not.toContain("the-view-key");
  });

  test("the headline with its numbers, each System's versions with who is on them, and each repository's products with what to do next", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(view)));
    render(<OrgApp api="/api/org" />);
    await screen.findByText("Adoption by version");
    const headline = document.querySelector(".text-title")!.textContent;
    expect(headline).toBe("4 products in 2 repositories follow 1 System. 2 are behind their System's newest release, and 1 fails its check. 1 product could not be read.");
    const adoption = screen.getByRole("region", { name: "Acme adoption" });
    expect(adoption.textContent).toContain("1 of 3 products on the newest, v2.0.0");
    expect(within(adoption).getByRole("img").getAttribute("aria-label")).toBe("v2.0.0: 1, v1.4.0: 1, never synced: 1");
    expect(within(adoption).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["v2.0.01acme/billing · billing", "v1.4.01acme/billing · admin", "never synced1acme/site · site"]);

    const billing = screen.getByRole("region", { name: "acme/billing" });
    expect(billing.textContent).toContain("aaaaaaa on main");
    const [current, admin] = within(billing).getAllByRole("listitem");
    expect(within(current!).queryByText(/is out$/)).toBeNull();
    expect(within(admin!).getByText("Synced v1.4.0; v2.0.0 is out")).toBeTruthy();
    expect(admin!.textContent).toContain("2 errors");
    const site = screen.getByRole("region", { name: "acme/site" });
    const [never, old] = within(site).getAllByRole("listitem");
    // Said once, by its sync state.
    expect(within(never!).getAllByText("Never synced").length).toBe(1);
    expect(within(old!).getByText("Could not be read")).toBeTruthy();
    expect(old!.textContent).toContain("Next: youiyoux adopt");
  });

  test("signed in with no records yet, it says how a repository sends one; sign out asks for the key again", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => (url === "/api/session" && init?.method === "DELETE" ? json({ ok: true }) : json({ ...view, repos: [], systems: [], totals: { repos: 0, products: 0, unreadable: 0, behind: 0, failing: 0 } })));
    vi.stubGlobal("fetch", fetch);
    render(<OrgApp api="/api/org" />);
    expect(await screen.findByText("No records yet")).toBeTruthy();
    expect(screen.getByText("youiyoux hooks install --record")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByLabelText("View key")).toBeTruthy());
  });

  test("a hub that cannot read its store says so, never an empty organisation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "the hub could not read its store; its log says why" }, 500)));
    render(<OrgApp api="/api/org" />);
    expect((await screen.findByRole("alert")).textContent).toBe("the hub could not read its store; its log says why");
  });
});
