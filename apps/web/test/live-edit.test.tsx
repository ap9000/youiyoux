// @vitest-environment jsdom
/** Edit on a live screen: the contract's choices applied in the running app, then shown and written into the code, or filed as an exact change request. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentContract } from "@youiyoux/core";
import type { LiveHandle, LiveProps } from "../src/data/live.ts";
import { editWords, LiveEditor } from "../src/screens/screens/LiveEditor.tsx";

const CONTRACT = {
  name: "Button",
  props: {
    variant: { type: "enum", values: ["default", "outline", "ghost"], default: "default", required: false },
    disabled: { type: "boolean", default: false, required: false },
    onClick: { type: "function", required: false },
    children: { type: "node", required: false },
  },
} as unknown as ComponentContract;
const TARGET = { route: "/flows", scope: "here", name: "Button", element: "youi:signal/component/button", file: "src/browser/app.tsx", line: 624 } as const;
const HASH = "a".repeat(64);

let posts: Array<{ path: string; body: Record<string, unknown> }>;
let preview: Record<string, unknown>;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function handle(answer: Partial<LiveProps> = {}) {
  const live = {
    ask: vi.fn(async () => ({ editable: true, why: null, found: true, props: { variant: "outline", disabled: null }, text: "New flow", ...answer })),
    edit: vi.fn(async () => ({ ok: true, why: null })),
    reset: vi.fn(),
    forget: vi.fn(),
  } satisfies LiveHandle;
  return live;
}
const show = (live: LiveHandle) => render(<LiveEditor live={live} component="Button" column={12} name="Button" contract={CONTRACT} target={TARGET} onFiled={() => undefined} onDone={() => undefined} />);

beforeEach(() => {
  posts = [];
  preview = { file: TARGET.file, hash: HASH, ok: true, tag: "Button", line: 624, before: '<Button variant="outline">New flow</Button>', after: '<Button variant="ghost">Create flow</Button>', written: false };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/api/requests") return json({ id: "r-0123456789", ...body });
    return json(body.write ? { ...preview, written: true } : preview);
  }));
  sessionStorage.setItem("youiyoux.editor-key", "k-test");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("editing a component on a live screen", () => {
  test("the contract's value props are offered with the page's values; a change is applied in the app, shown in the code, then written", async () => {
    const live = handle();
    show(live);
    const variant = (await screen.findByRole("combobox", { name: "variant" })) as HTMLSelectElement;
    expect(live.ask).toHaveBeenCalledWith(["variant", "disabled"]);
    expect(variant.value).toBe("outline");
    expect([...variant.options].map((o) => o.textContent)).toEqual(["default (default)", "outline", "ghost"]);
    // A function or a node is not a choice.
    expect(screen.queryByRole("textbox", { name: "onClick" })).toBeNull();
    fireEvent.change(variant, { target: { value: "ghost" } });
    expect(live.edit).toHaveBeenLastCalledWith({ variant: "ghost" }, null);
    const text = screen.getByRole("textbox", { name: "text" });
    fireEvent.change(text, { target: { value: "Create flow" } });
    fireEvent.blur(text);
    expect(live.edit).toHaveBeenLastCalledWith({ variant: "ghost" }, "Create flow");
    fireEvent.click(screen.getByRole("button", { name: "Write to code" }));
    await waitFor(() => expect(document.querySelector('[data-live-edit="shown"]')).not.toBeNull());
    expect(posts.at(-1)).toEqual({ path: "/api/live/edit", body: { file: TARGET.file, line: 624, column: 12, component: "Button", set: [{ prop: "variant", value: "ghost", default: "default" }], text: "Create flow" } });
    fireEvent.click(screen.getByRole("button", { name: `Write to ${TARGET.file}` }));
    await waitFor(() => expect(document.querySelector('[data-live-edit="written"]')).not.toBeNull());
    expect(posts.at(-1)!.body.write).toEqual({ hash: HASH });
    // Written: the page keeps it (the code says the same now), even when the bubble closes.
    expect(live.forget).toHaveBeenCalled();
    cleanup();
    expect(live.reset).not.toHaveBeenCalled();
  });

  test("closed without writing, the page is put back; what can't be written says why and is filed as an exact change request", async () => {
    const live = handle();
    preview = { file: TARGET.file, hash: HASH, ok: false, why: "variant is computed in code (variant={tone})" };
    const filed = vi.fn();
    render(<LiveEditor live={live} component="Button" column={null} name="Button" contract={CONTRACT} target={TARGET} onFiled={filed} onDone={() => undefined} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "disabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Write to code" }));
    await waitFor(() => expect(document.querySelector('[data-live-edit="refused"]')).not.toBeNull());
    expect(document.querySelector('[data-live-edit="refused"]')!.textContent).toContain("variant is computed in code");
    expect(screen.queryByRole("button", { name: "Write to code" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "File as change request" }));
    await waitFor(() => expect(filed).toHaveBeenCalled());
    expect(posts.at(-1)).toEqual({ path: "/api/requests", body: { kind: "change", body: "Set disabled on Button at src/browser/app.tsx:624, as previewed live on /flows.", target: TARGET } });
    cleanup();
    expect(live.reset).toHaveBeenCalledTimes(1);
  });

  test("a page that can't edit in place says why; the request's words name every change", async () => {
    show(handle({ editable: false, why: "the bridge loaded after React: load it in the page's head, before the app's scripts" }));
    await waitFor(() => expect(document.querySelector('[data-live-edit="unavailable"]')).not.toBeNull());
    expect(document.querySelector('[data-live-edit="unavailable"]')!.textContent).toBe("Button can't be edited in place: the bridge loaded after React: load it in the page's head, before the app's scripts.");
    expect(editWords("Button", { ...TARGET, file: undefined, line: undefined }, { variant: "ghost", disabled: false }, "Go")).toBe('Set variant="ghost", disabled=false, its text to "Go" on Button, as previewed live on /flows.');
  });
});
