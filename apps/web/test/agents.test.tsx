// @vitest-environment jsdom
/** Connect your agent: what is here, one button that connects the agents picked, the check each server answered, and the terminal command without the service. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectAgents } from "../src/shell/ConnectAgents.tsx";

const VIEW = {
  agents: [
    { kind: "claude", name: "Claude Code", found: true, connected: false, file: ".mcp.json" },
    { kind: "codex", name: "Codex", found: false, connected: false, file: ".codex/config.toml" },
    { kind: "cursor", name: "Cursor", found: true, connected: true, file: ".cursor/mcp.json" },
  ],
  command: "youiyoux agents install",
};

let posts: Array<{ body: unknown; key: string | null }>;
let answer: (method: string) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  answer = (method) => (method === "GET" ? json(VIEW) : json({
    results: [{ kind: "agent rule", file: "AGENTS.md", action: "updated", guarantee: "" }, { kind: "Claude Code MCP", file: ".mcp.json", action: "created", guarantee: "" }, { kind: "Codex MCP", file: ".codex/config.toml", action: "created", guarantee: "" }],
    checks: [{ kind: "claude", name: "Claude Code", ok: true, tools: 21, problem: null }, { kind: "codex", name: "Codex", ok: false, tools: 0, problem: "the server stopped (exit 1) before listing its tools: no design repo" }],
    view: { ...VIEW, agents: VIEW.agents.map((a) => ({ ...a, connected: true })) },
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(input), "http://localhost/").pathname).toBe("/api/agents");
    const method = init?.method ?? "GET";
    if (method === "POST") posts.push({ body: JSON.parse(String(init!.body)), key: new Headers(init!.headers).get("x-youi-session") });
    return answer(method);
  }));
  sessionStorage.setItem("youiyoux.editor-key", "k-test");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Connect your agent", () => {
  test("the agents here and not connected start picked; one connected says so; connecting sends the picks with the session key and shows each check", async () => {
    render(<ConnectAgents onClose={() => undefined} />);
    const claude = await screen.findByRole("checkbox", { name: "Connect Claude Code" });
    expect((claude as HTMLInputElement).checked).toBe(true);
    const codex = screen.getByRole("checkbox", { name: "Connect Codex" }) as HTMLInputElement;
    expect(codex.checked).toBe(false);
    expect(document.querySelector('[data-agent="codex"]')!.textContent).toContain("Not found on this machine");
    expect(screen.queryByRole("checkbox", { name: "Connect Cursor" })).toBeNull();
    expect(within(document.querySelector<HTMLElement>('[data-agent="cursor"]')!).getByText("Connected")).toBeTruthy();
    // One not on this machine can still be picked.
    fireEvent.click(codex);
    fireEvent.click(screen.getByRole("button", { name: "Connect 2 agents" }));
    await waitFor(() => expect(document.querySelector("[data-agents-done]")).not.toBeNull());
    expect(posts).toEqual([{ body: { agents: ["claude", "codex"] }, key: "k-test" }]);
    expect([...document.querySelectorAll("[data-check]")].map((li) => [li.getAttribute("data-check"), li.textContent])).toEqual([
      ["ok", "Claude Code: the server answers, with 21 tools."],
      ["failed", "Codex: the server stopped (exit 1) before listing its tools: no design repo"],
    ]);
    expect(document.querySelector("[data-agents-done]")!.textContent).toContain("Restart Claude Code and Codex so they load the server.");
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  test("nothing picked, nothing to send; without the service it gives the terminal command", async () => {
    answer = () => json({ ...VIEW, agents: VIEW.agents.map((a) => ({ ...a, found: false })) });
    render(<ConnectAgents onClose={() => undefined} />);
    await screen.findByRole("checkbox", { name: "Connect Claude Code" });
    expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    answer = () => json({ error: "connecting agents from the hub needs youiyoux ui --project", code: "not-found" }, 404);
    render(<ConnectAgents onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector("[data-agents-offline]")).not.toBeNull());
    expect(document.querySelector("[data-agents-offline]")!.textContent).toContain("youiyoux agents install");
    expect(posts).toEqual([]);
  });
});
