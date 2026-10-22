// @vitest-environment jsdom
/** Requests on a screen in the hub: filing one on what is picked out, and a thread a person replies to, closes and reopens. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RequestDoc } from "@youiyoux/core";
import { cropOf } from "../src/screens/screens/BeforeAfter.tsx";
import { RequestComposer, RequestThread } from "../src/screens/screens/Requests.tsx";

const TARGET = { route: "/settings", scope: "here", name: "Button", element: "youi:demo/component/button", file: "app/settings.tsx", line: 12, box: { x: 1, y: 2, width: 3, height: 4 } } as const;
const AT = "2026-10-22T12:00:00.000Z";
const request = (patch: Partial<RequestDoc> = {}): RequestDoc => ({ schema: "youi.request/v1", id: "r-0123456789", project: "acme", kind: "change", status: "open", body: "Make it primary", author: { kind: "person", name: "you" }, createdAt: AT, updatedAt: AT, target: { ...TARGET }, thread: [], ...patch });

let posts: Array<{ path: string; body: unknown; key: string | null }>;
let answer: (path: string, body: unknown) => Response;

beforeEach(() => {
  posts = [];
  answer = (path, body) => new Response(JSON.stringify(path === "/api/requests" ? request({ ...(body as object) }) : request({ status: (body as { status?: RequestDoc["status"] }).status ?? "open" })), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    posts.push({ path, body, key: new Headers(init?.headers).get("x-youi-session") });
    return answer(path, body);
  }));
  sessionStorage.setItem("youiyoux.editor-key", "k-test");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("filing a request", () => {
  test("a change request on this one, or on every use of the element, is filed with the pick's target and the session key", async () => {
    const onFiled = vi.fn();
    render(<RequestComposer target={TARGET} elementName="Button" onFiled={onFiled} onCancel={() => undefined} />);
    const file = screen.getByRole("button", { name: "File change request" });
    expect(file.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Applies to" })).getByRole("radio", { name: "Every Button" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What should change" }), { target: { value: "  Use the primary variant  " } });
    fireEvent.click(file);
    await waitFor(() => expect(onFiled).toHaveBeenCalled());
    expect(posts).toEqual([{ path: "/api/requests", body: { kind: "change", body: "Use the primary variant", target: { ...TARGET, scope: "element" } }, key: "k-test" }]);
  });

  test("a comment needs no element; without the service it says how to start it", async () => {
    answer = () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    render(<RequestComposer target={{ ...TARGET, element: undefined }} elementName={null} onFiled={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByRole("radiogroup", { name: "Applies to" })).toBeNull();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Kind" })).getByRole("radio", { name: "Comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your comment" }), { target: { value: "Odd spacing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/start the hub on your project/);
    expect(alert.textContent).toContain("youiyoux ui --project");
  });
});

describe("a request's thread", () => {
  test("shows who said what, an agent's addressed note, and offers the person Looks right: close", () => {
    render(<ol><RequestThread request={request({ status: "addressed", thread: [{ author: { kind: "agent", name: "claude" }, at: AT, body: "Changed app/settings.tsx:12", status: "addressed" }] })} number={2} active onChange={() => undefined} onPick={() => undefined} /></ol>);
    const item = document.querySelector<HTMLElement>("[data-request]")!;
    expect(item.dataset.status).toBe("addressed");
    expect(item.querySelector('[data-entry="agent"]')!.textContent).toMatch(/claude.*marked it addressed.*Changed app\/settings\.tsx:12/);
    expect(within(item).getByRole("button", { name: "Looks right: close" })).toBeTruthy();
    expect(within(item).getByText("app/settings.tsx:12")).toBeTruthy();
  });

  test("a reply, a close and a reopen each go to the service and hand back the request", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ol><RequestThread request={request()} number={1} active={false} onChange={onChange} onPick={() => undefined} /></ol>);
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to request 1" }), { target: { value: "Primary, please" } });
    fireEvent.click(screen.getByRole("button", { name: /Reply$/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    rerender(<ol><RequestThread request={request({ status: "closed" })} number={1} active={false} onChange={onChange} onPick={() => undefined} /></ol>);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
    // A closed request also asks for its before and after (a read).
    expect(posts.filter((p) => p.body !== undefined).map((p) => [p.path, p.body])).toEqual([
      ["/api/requests/r-0123456789/replies", { body: "Primary, please" }],
      ["/api/requests/r-0123456789/status", { status: "closed", body: "" }],
      ["/api/requests/r-0123456789/status", { status: "open", body: "" }],
    ]);
  });
});

describe("before and after", () => {
  const view = (patch: Record<string, unknown> = {}) => ({ url: "/api/requests/r-0123456789/before.webp", box: { x: 1100, y: 40, width: 160, height: 30 }, page: { width: 1440, height: 900 }, at: AT, ...patch });

  test("the crop keeps room around the component and stays inside the page", () => {
    expect(cropOf({ x: 1100, y: 40, width: 160, height: 30 }, { width: 1440, height: 900 })).toEqual({ x: 1020, y: 0, width: 320, height: 180 });
    expect(cropOf({ x: 0, y: 0, width: 1440, height: 900 }, { width: 1440, height: 900 })).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  test("an addressed request shows both pictures cropped to the component; one not captured since it was filed says how to capture it", async () => {
    answer = () => new Response(JSON.stringify({ before: view(), after: { ...view({ url: "/api/requests/r-0123456789/after.webp" }), sinceFiled: false, found: true } }), { status: 200, headers: { "content-type": "application/json" } });
    render(<ol><RequestThread request={request({ status: "addressed", before: "r-0123456789.before.webp" })} number={1} active onChange={() => undefined} onPick={() => undefined} /></ol>);
    await waitFor(() => expect(document.querySelector("[data-before-after]")).not.toBeNull());
    const figure = document.querySelector<HTMLElement>("[data-before-after]")!;
    expect([...figure.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["/api/requests/r-0123456789/before.webp", "/api/requests/r-0123456789/after.webp"]);
    const img = figure.querySelector<HTMLImageElement>("[data-crop] img")!;
    expect([img.style.width, img.style.left, img.style.top]).toEqual(["450%", "-318.75%", "0%"]);
    expect(figure.querySelector("[data-stale]")!.textContent).toContain("youiyoux screens capture --base <the app in development> --route /settings");
  });

  test("a picture taken since shows the work without a warning; an open request with no before asks for nothing", async () => {
    answer = () => new Response(JSON.stringify({ before: view(), after: { ...view(), sinceFiled: true, found: true } }), { status: 200, headers: { "content-type": "application/json" } });
    render(<ol><RequestThread request={request({ status: "closed", before: "r-0123456789.before.webp" })} number={1} active={false} onChange={() => undefined} onPick={() => undefined} /></ol>);
    await waitFor(() => expect(document.querySelectorAll("[data-crop]")).toHaveLength(2));
    expect(document.querySelector("[data-stale]")).toBeNull();
    cleanup();
    posts = [];
    render(<ol><RequestThread request={request()} number={1} active={false} onChange={() => undefined} onPick={() => undefined} /></ol>);
    expect(posts).toEqual([]);
  });
});
