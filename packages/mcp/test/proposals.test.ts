/** Options an agent puts on the Screens canvas: what it reads first, every option held to the component's contract, and what a person picked. */
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { screenSlug } from "@youiyoux/scanner";
import { decisionsKey, ProposalStore, RequestStore } from "@youiyoux/workflow";
import { createServer } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const NEW_PROJECT = { name: "Button", file: "app/index.tsx", line: 13, column: 8, box: { x: 24, y: 80, width: 120, height: 36 }, depth: 4, owner: "Home", frames: [] };
let dir: string;
let app: string;
let client: Client;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-mcp-proposals-"));
  app = join(dir, "demo-app");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  const screens = join(app, ".youi/screens");
  await mkdir(screens, { recursive: true });
  await writeFile(join(screens, "screens.json"), JSON.stringify({ schema: "youiyoux.screens/v1", project: "demo-app", source: "a test", capturedAt: "", viewport: { width: 1440, height: 900 }, screens: [{ route: "/", path: "/" }] }));
  const row = { name: "Button", file: "app/index.tsx", line: 19, column: 12, box: { x: 600, y: 200, width: 60, height: 32 }, depth: 6, owner: "Home", frames: [] };
  await writeFile(join(screens, `${screenSlug("/")}.places.json`), JSON.stringify({
    schema: "youiyoux.places/v1", route: "/", path: "/", viewport: { width: 1440, height: 900 }, size: { width: 1440, height: 1200 }, dev: true, capped: false,
    places: [
      { name: "Home", file: "app/index.tsx", line: 4, column: 2, box: { x: 0, y: 0, width: 1440, height: 1200 }, depth: 1, owner: null, frames: [] },
      NEW_PROJECT,
      // A wrapper the same line places is not the Button.
      { ...NEW_PROJECT, name: "Slot", depth: 5 },
      row,
      { ...row, box: { ...row.box, y: 240 } },
      { name: 'button "Preview"', html: "button", owner: "Served", file: "app/index.tsx", line: 30, column: 4, box: { x: 0, y: 900, width: 80, height: 30 }, depth: 9, frames: [] },
    ],
  }));
  const server = createServer({ projectRoot: app, render: { download: false }, decisionsKey: join(dir, "decisions.key") });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
});
afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { data: (text.startsWith("{") ? JSON.parse(text) : { refused: text }) as Record<string, unknown>, isError: Boolean(result.isError) };
}

describe("options on the Screens canvas, over MCP", () => {
  test("an agent reads the screens, then one screen's components: System elements first, with the choices their contract gives; a server's HTML only counted", async () => {
    const list = (await call("screens_list")).data;
    expect(list.screens).toEqual([{ route: "/", picture: join(app, ".youi/screens", `${screenSlug("/")}.light.webp`), placed: 5, requests: 0, proposals: 0 }]);
    const { data } = await call("screens_show", { route: "/" });
    const components = data.components as Array<Record<string, unknown>>;
    expect(components.map((c) => [c.name, c.line, c.element, c.count])).toEqual([
      ["Button", 13, "youi:demo/component/button", 1],
      ["Button", 19, "youi:demo/component/button", 2],
      ["Home", 4, null, 1],
      ["Slot", 13, null, 1],
    ]);
    expect((components[0]!.choices as Record<string, unknown>).variant).toEqual({ type: "enum", values: ["default", "outline", "ghost", "danger", "link"], default: "default" });
    expect(components[2]!.choices).toBeUndefined();
    expect(data.html).toBe(1);
    expect((await call("screens_show", { route: "/nope" })).data.error).toMatch(/has no route \/nope/);
  });

  test("options held to the contract are pinned where the capture placed the component; anything else is refused, option by option, and nothing is written", async () => {
    const options = [
      { label: "One primary action", why: "New project is the view's main action.", set: [{ prop: "variant", value: "default" }] },
      { label: "Quieter", why: "Keep the page calm.", set: [{ prop: "variant", value: "outline" }, { prop: "size", value: "sm" }], text: "Start a project" },
    ];
    // Where the agent says it is doesn't matter: the capture's box is kept.
    const { data } = await call("screens_offer", { route: "/", component: { name: "Button", file: "app/index.tsx", line: 13, box: { x: 0, y: 0, width: 1, height: 1 } }, ask: "Make the main action clearer", options });
    expect(data).toMatchObject({ route: "/", component: "Button", at: "app/index.tsx:13", status: "open", choice: null, options: [{ id: "a", label: "One primary action", changes: 'variant="default"' }, { id: "b", label: "Quieter", changes: 'variant="outline", size="sm", text "Start a project"' }], next: expect.stringMatching(/^Waiting for a person to pick one on \/ in the hub's Screens canvas/) });
    const store = new ProposalStore(app, "demo-app");
    const [saved] = (await store.list()).proposals;
    expect(saved!.target).toEqual({ name: "Button", element: "youi:demo/component/button", file: "app/index.tsx", line: 13, column: 8, box: NEW_PROJECT.box, page: { width: 1440, height: 1200 } });

    const refused = await call("screens_offer", { route: "/", component: { name: "Button", file: "app/index.tsx", line: 13 }, ask: "Bolder", options: [
      { label: "Primary", why: "x", set: [{ prop: "variant", value: "primary" }] },
      { label: "Link out", why: "x", set: [{ prop: "href", value: "https://example.com" }] },
      { label: "Bigger", why: "x", set: [{ prop: "size", value: "lg" }, { prop: "tone", value: "loud" }] },
    ] });
    expect(refused.isError).toBe(true);
    expect(refused.data).toEqual({ error: "every option must be the design system's own", problems: [
      "option a (Primary): Button's variant is one of default, outline, ghost, danger, link, not \"primary\"",
      "option b (Link out): href is never proposed: it can carry a URL, HTML, a style or a handler",
      "option c (Bigger): Button's size is one of default, sm, icon, not \"lg\"",
    ] });
    const plain = await call("screens_offer", { route: "/", component: { name: "Home", file: "app/index.tsx", line: 4 }, ask: "x", options: [{ label: "A", why: "x", set: [{ prop: "gap", value: 4 }] }, { label: "B", why: "x", text: "Hello" }] });
    expect(plain.data.problems).toEqual(["option a (A): Home isn't a design-system component, so options for it can only change its text"]);
    expect((await call("screens_offer", { route: "/", component: { name: "Card" }, ask: "x", options: [{ label: "A", why: "x", text: "a" }, { label: "B", why: "x", text: "b" }] })).data.error).toMatch(/^no Card on \/: screens_show lists what is there/);
    expect((await readdir(join(app, ".youi/proposals"))).length).toBe(1);
  });

  test("a prop only an object inherits, or a script address however it is disguised, is never proposed; text with a colon is", async () => {
    const offer = (set: Array<{ prop: string; value: string }>) => call("screens_offer", { route: "/", component: { name: "Button", file: "app/index.tsx", line: 13 }, ask: "x", options: [{ label: "A", why: "x", set }, { label: "B", why: "x", text: "Note: two lines" }] });
    expect((await offer([{ prop: "constructor", value: "x" }])).data.problems).toEqual(["option a (A): constructor is never proposed: it can carry a URL, HTML, a style or a handler"]);
    expect((await offer([{ prop: "toString", value: "x" }])).data.problems).toEqual([expect.stringMatching(/^option a \(A\): Button has no prop toString: its contract offers /)]);
    for (const value of ["java\tscript:alert(1)", " \u0001javascript:alert(1)", "DATA:text/html,x"]) expect((await offer([{ prop: "variant", value }])).data.problems).toEqual(["option a (A): variant's value is a script address, which is never proposed"]);
    expect((await readdir(join(app, ".youi/proposals"))).length).toBe(1);
  });

  test("only a person picks; the agent reads what was picked, and what is left to do", async () => {
    const store = new ProposalStore(app, "demo-app", { sealKey: () => decisionsKey(join(dir, "decisions.key"), true) });
    const [open] = (await store.list()).proposals;
    await expect(store.decide({ kind: "agent", name: "agent (MCP)" }, open!.id, { choice: "a" })).rejects.toThrow(/a person picks one on the Screens canvas/);
    await store.decide({ kind: "person", name: "captain" }, open!.id, { choice: "b", request: "r-0123456789" });
    expect((await call("screens_offers")).data).toEqual({ proposals: [], next: "No open proposals." });
    const [chosen] = (await call("screens_offers", { status: "chosen" })).data.proposals as Array<Record<string, unknown>>;
    expect(chosen).toMatchObject({ choice: "b", request: "r-0123456789", next: "The person picked Quieter, filed as change request r-0123456789: do that request (requests_list)." });
    await expect(store.decide({ kind: "person", name: "captain" }, open!.id, { dismiss: true })).rejects.toThrow(/is already chosen/);
  });

  test("an options request a person filed is answered for its own component and ask, once; a change request isn't one", async () => {
    const requests = new RequestStore(app, "demo-app", { newId: () => "r-0000000abc" });
    const target = { route: "/", scope: "here", name: "Button", element: "youi:demo/component/button", file: "app/index.tsx", line: 19, box: { x: 600, y: 200, width: 60, height: 32 }, page: { width: 1440, height: 1200 } } as const;
    await requests.create({ kind: "person", name: "captain" }, { kind: "options", body: "Calmer row actions", target }, null);
    const listed = ((await call("requests_list")).data.requests as Array<Record<string, unknown>>).find((r) => r.id === "r-0000000abc")!;
    expect(listed.next).toMatch(/^Offer two to four options for Button at app\/index\.tsx:19: call screens_offer with request r-0000000abc/);
    const options = [{ label: "Ghost", why: "Row tools stay quiet.", set: [{ prop: "variant", value: "ghost" }] }, { label: "Link", why: "Reads as navigation.", set: [{ prop: "variant", value: "link" }] }];
    // What the agent names is ignored: the request's own component is used.
    const { data } = await call("screens_offer", { request: "r-0000000abc", route: "/elsewhere", component: { name: "Home" }, options });
    expect(data).toMatchObject({ id: "p-0000000abc", route: "/", component: "Button", at: "app/index.tsx:19", ask: "Calmer row actions" });
    const saved = await new ProposalStore(app, "demo-app").get("p-0000000abc");
    expect([saved.for, saved.target.box]).toEqual(["r-0000000abc", target.box]);
    expect((await call("screens_offer", { request: "r-0000000abc", options })).data.error).toBe("options for r-0000000abc are already on the canvas (p-0000000abc)");
    const change = (await new RequestStore(app, "demo-app").create({ kind: "person", name: "captain" }, { kind: "change", body: "x", target })).id;
    expect((await call("screens_offer", { request: change, options })).data.error).toBe(`${change} is a change request, not an options request`);
  });
});
