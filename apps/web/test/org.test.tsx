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
  test("signed out, it asks for the view key in a modal, never a box on the page; a wrong one says so; the right one shows the organisation", async () => {
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
    const open = await screen.findByRole("button", { name: "Sign in with the view key" });
    expect(document.querySelector("input")).toBeNull();
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Sign in with the view key" });
    const field = within(dialog).getByLabelText("View key");
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with the view key" })).toBeTruthy());
  });

  test("a hub that cannot read its store says so, never an empty organisation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "the hub could not read its store; its log says why" }, 500)));
    render(<OrgApp api="/api/org" />);
    expect((await screen.findByRole("alert")).textContent).toBe("the hub could not read its store; its log says why");
  });
});

describe("the hosted hub with workspaces", () => {
  const empty: OrgView = { ...view, repos: [], systems: [], totals: { repos: 0, products: 0, unreadable: 0, behind: 0, failing: 0 } };
  const me = { user: { login: "peter", name: "Peter" }, workspaces: [{ id: "acme", name: "Acme", role: "member" }, { id: "globex", name: "Globex", role: "admin" }] };
  afterEach(() => window.history.replaceState(null, "", "/"));

  test("signed out, it offers GitHub, and says what happened when GitHub sent someone back without signing them in", async () => {
    window.history.replaceState(null, "", "/?signin=denied&w=acme");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "sign in with GitHub" }, 401)));
    render(<OrgApp api="/api/me" mode="workspaces" />);
    const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(link.getAttribute("href")).toBe("/auth/github");
    expect(screen.getByRole("alert").textContent).toContain("You declined on GitHub");
    // The outcome is read once: the address keeps only the workspace.
    expect(window.location.search).toBe("?w=acme");
    expect(screen.queryByRole("button", { name: "Sign in with the view key" })).toBeNull();
  });

  test("the workspace in the address, or the first; switching reads the other one and puts it in the address", async () => {
    window.history.replaceState(null, "", "/?w=globex");
    const fetch = vi.fn(async (url: string) => (url === "/api/me" ? json(me) : url === "/api/w/globex/org" ? json(empty) : json(view)));
    vi.stubGlobal("fetch", fetch);
    render(<OrgApp api="/api/me" mode="workspaces" />);
    expect(await screen.findByText("No records in Globex yet")).toBeTruthy();
    expect(screen.getByText("youiyoux hub owner add")).toBeTruthy();
    expect(screen.getByText("peter")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "acme" } });
    expect(await screen.findByText("Adoption by version")).toBeTruthy();
    expect(window.location.search).toBe("?w=acme");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/me", "/api/w/globex/org", "/api/w/acme/org"]);
    // peter is only a member of acme: no Manage page there.
    expect(screen.queryByRole("radio", { name: "Manage" })).toBeNull();
  });

  test("signed in with no workspace, it says who can add them and why an organisation might not let them in; sign out offers GitHub again", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => (url === "/api/session" && init?.method === "DELETE" ? json({ ok: true }) : json({ ...me, workspaces: [] })));
    vi.stubGlobal("fetch", fetch);
    render(<OrgApp api="/api/me" mode="workspaces" />);
    expect(await screen.findByText("You are not in a workspace here yet")).toBeTruthy();
    expect(screen.getByText("youiyoux hub member add <workspace> peter")).toBeTruthy();
    expect(screen.getByText(/third-party access settings/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  });
});

describe("a workspace's Manage page, for its admins", () => {
  const me = { user: { login: "milton", name: null }, workspaces: [{ id: "acme", name: "Acme", role: "admin" }] };
  type Admin = { workspace: { id: string; name: string; githubOrg: { id: string; login: string } | null }; you: string; members: Array<{ githubId: string; login: string; role: string; via: string; addedAt: string }>; owners: Array<{ id: string; login: string }>; tokens: string[] };
  let state: Admin;
  let calls: Array<[string, string, unknown]>;
  const at = "2026-10-24T09:00:00.000Z";
  /** The hub's admin API, kept in memory as the server keeps it. */
  function hub() {
    state = {
      workspace: { id: "acme", name: "Acme", githubOrg: { id: "1001", login: "acme" } },
      you: "12",
      members: [{ githubId: "12", login: "milton", role: "admin", via: "invite", addedAt: at }, { githubId: "11", login: "peter", role: "member", via: "org", addedAt: at }],
      owners: [{ id: "1001", login: "acme" }],
      tokens: [],
    };
    calls = [];
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : undefined;
      calls.push([method, url, body]);
      if (url === "/api/me") return json(me);
      if (url === "/api/w/acme/org") return json(view);
      if (url === "/api/w/acme/admin") return json(state);
      if (url === "/api/w/acme/admin/members" && method === "POST") {
        if (body!.account === "nobody") return json({ error: "GitHub has no account nobody" }, 422);
        const member = { githubId: "13", login: body!.account!, role: body!.role!, via: "invite", addedAt: at };
        state = { ...state, members: [...state.members, member] };
        return json({ member }, 201);
      }
      if (url === "/api/w/acme/admin/members/11" && method === "DELETE") {
        state = { ...state, members: state.members.filter((m) => m.githubId !== "11") };
        return json({ removed: "peter", returns: "they come back at their next sign-in while they are in acme" });
      }
      if (url === "/api/w/acme/admin/tokens" && method === "POST") {
        state = { ...state, tokens: [body!.name!] };
        return json({ name: body!.name, token: "yxh_shown-once-for-this-test" }, 201);
      }
      return json({ error: `unexpected ${method} ${url}` }, 500);
    });
  }
  afterEach(() => window.history.replaceState(null, "", "/"));

  test("an admin switches to Manage: the counts in a sentence, members with how they came in, and the only admin cannot be removed", async () => {
    vi.stubGlobal("fetch", hub());
    render(<OrgApp api="/api/me" mode="workspaces" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Manage" }));
    expect(window.location.search).toBe("?w=acme&page=manage");
    const members = await screen.findByRole("list", { name: "Members" });
    expect(document.querySelector(".text-title")!.textContent).toBe("2 members read Acme; CI from 1 GitHub owner and 0 tokens send it records.");
    const [milton, peter] = within(members).getAllByRole("listitem");
    expect(milton!.textContent).toContain("You");
    expect(peter!.textContent).toContain("From the acme organisation");
    expect((within(milton!).getByRole("button", { name: "Remove milton" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(milton!).getByRole("combobox", { name: "milton's role" }) as HTMLSelectElement).disabled).toBe(true);
    // No field waits on the page: every one is in a modal.
    expect(document.querySelector("input")).toBeNull();
  });

  test("inviting happens in a modal that says GitHub's refusal there; removing asks first and says what follows", async () => {
    window.history.replaceState(null, "", "/?w=acme&page=manage");
    vi.stubGlobal("fetch", hub());
    render(<OrgApp api="/api/me" mode="workspaces" />);
    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    let dialog = await screen.findByRole("dialog", { name: "Invite to Acme" });
    fireEvent.change(within(dialog).getByLabelText("GitHub login"), { target: { value: "nobody" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Invite" }));
    expect(await within(dialog).findByText("GitHub has no account nobody")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("GitHub login"), { target: { value: "samir" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Admin" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Invited samir as an admin");
    expect(calls.filter(([m]) => m === "POST").map(([, , b]) => b)).toEqual([{ account: "nobody", role: "member" }, { account: "samir", role: "admin" }]);

    fireEvent.click(await screen.findByRole("button", { name: "Remove peter" }));
    dialog = await screen.findByRole("dialog", { name: "Remove peter from Acme?" });
    expect(dialog.textContent).toContain("come back at their next sign-in while they are in acme");
    expect(calls.some(([m]) => m === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Removed peter. They come back at their next sign-in while they are in acme."));
    expect(within(screen.getByRole("list", { name: "Members" })).queryByText("peter")).toBeNull();
  });

  test("a new CI token is shown once, in its modal, and is gone from the page once it closes", async () => {
    window.history.replaceState(null, "", "/?w=acme&page=manage");
    vi.stubGlobal("fetch", hub());
    render(<OrgApp api="/api/me" mode="workspaces" />);
    fireEvent.click(await screen.findByRole("button", { name: "New token" }));
    const dialog = await screen.findByRole("dialog", { name: "New CI token" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "jenkins" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Make token" }));
    const reveal = await screen.findByRole("dialog", { name: "Copy the jenkins token now" });
    expect(within(reveal).getByLabelText("The jenkins token").textContent).toBe("yxh_shown-once-for-this-test");
    expect(within(reveal).getByRole("button", { name: "Copy the token" })).toBeTruthy();
    fireEvent.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(await screen.findByRole("list", { name: "CI tokens" })).getByText("jenkins")).toBeTruthy();
    expect(document.body.textContent).not.toContain("yxh_shown-once-for-this-test");
  });

  test("a member who is not an admin asking for Manage in the address sees the workspace instead", async () => {
    window.history.replaceState(null, "", "/?w=acme&page=manage");
    const fetch = vi.fn(async (url: string) => (url === "/api/me" ? json({ ...me, workspaces: [{ id: "acme", name: "Acme", role: "member" }] }) : json(view)));
    vi.stubGlobal("fetch", fetch);
    render(<OrgApp api="/api/me" mode="workspaces" />);
    expect(await screen.findByText("Adoption by version")).toBeTruthy();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/me", "/api/w/acme/org"]);
  });
});
