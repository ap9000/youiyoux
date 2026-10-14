/** ui_find_component: the project's own components for a need, read live from the code; or "nothing fits" and where to start. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeSharedStores, openCatalog, syncIndex } from "@youiyoux/discover";
import { collectComponents } from "@youiyoux/scanner";
import { fixtureFetcher } from "../../discover/test/fixture-fetcher.ts";
import { findComponents, libraryOf, matchesText, noneFitsText } from "../src/find-component.ts";
import { createServer } from "../src/index.ts";

const FIND_APP = join(import.meta.dirname, "fixtures/find-app");
const EXPO_APP = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
let cache: string;
let empty: string;
const clients: Client[] = [];

async function connect(projectRoot: string, discoverCache: string): Promise<Client> {
  const server = createServer({ projectRoot, discoverCache });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

async function find(client: Client, need: string): Promise<{ text: string; lines: string[]; isError: boolean }> {
  const result = (await client.callTool({ name: "ui_find_component", arguments: { need } })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { text, lines: text.split("\n"), isError: Boolean(result.isError) };
}

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "youi-mcp-find-"));
  empty = await mkdtemp(join(tmpdir(), "youi-mcp-find-empty-"));
  await syncIndex({ sleep: async () => {}, cacheDir: cache, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  await openCatalog(cache, join(cache, "index.db"));
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await closeSharedStores();
  await rm(cache, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

describe("ui_find_component", () => {
  test("is listed, read-only and closed-world, and the server tells agents to call it before creating a component", async () => {
    const client = await connect(FIND_APP, empty);
    const tool = (await client.listTools()).tools.find((t) => t.name === "ui_find_component")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool.description).toMatch(/before creating any UI component/);
    expect(client.getInstructions()).toMatch(/Before creating any UI component, call ui_find_component/);
  });

  test("'dismissible alert' → the hand-rolled Alert: import, onDismiss, a real <Alert usage, its pages and routes", async () => {
    const client = await connect(FIND_APP, empty);
    const fetch = vi.spyOn(globalThis, "fetch");
    const { text, lines, isError } = await find(client, "dismissible alert");
    expect(isError).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
    expect(lines[1]).toBe('1. Use Alert (hand-rolled): import { Alert } from "@/components/alert";');
    expect(text).toContain("prop onDismiss (dismissible)");
    expect(text).toContain("Props: tone: info|warning|danger, title, children, onDismiss");
    // The example is the site that shows the trait, read from the codebase as written.
    expect(text).toContain('Example at app/page.tsx:8:\n     <Alert tone="warning" title="Your trial ends soon" onDismiss={() => {}}>');
    expect(text).toContain("Used in 2 places on 2 routes: app/billing/page.tsx:4 (/billing), app/page.tsx:8 (/)");
    expect(lines.at(-1)).toMatch(/^Next: import Alert as shown and reuse it .* open components\/alert\.tsx/);
    expect(text).not.toContain("Lacks: Alert");
  });

  test("'primary button with icon' → the shadcn Button, with its primary variant and the site that renders an icon", async () => {
    const { text, lines } = await find(await connect(FIND_APP, empty), "primary button with icon");
    expect(lines[1]).toBe('1. Use Button (shadcn (Radix)): import { Button } from "@/components/ui/button";');
    expect(text).toContain('variant="primary"');
    expect(text).toContain("variant: default|primary|outline");
    expect(text).toContain('Example at app/page.tsx:11:\n     <Button variant="primary">\n       <PlusIcon /> New project\n     </Button>');
    expect(text).toContain("Used in 3 places on 2 routes");
    expect(lines.at(-1)).toMatch(/^Next: /);
  });

  test("names and aliases: 'toast' leads with its call API and also finds Snackbar, 'dialog' the Radix-based Modal", async () => {
    const client = await connect(FIND_APP, empty);
    const toast = await find(client, "toast");
    expect(toast.lines[1]).toBe('1. Use toast (sonner): import { toast } from "@/components/ui/sonner";');
    expect(toast.text).toContain('toast.success("Saved")');
    expect(toast.text).toContain("<Toaster/> is already mounted at app/layout.tsx:7; don't mount another.");
    expect(toast.text).toContain("snackbar = toast");
    expect(toast.text).toContain('<Snackbar message="Settings saved" />');
    expect(toast.lines.at(-1)).toMatch(/^Next: /);
    const dialog = await find(client, "modal dialog");
    expect(dialog.lines[1]).toBe('1. Use Modal (Radix Primitives): import { Modal } from "@/components/modal";');
    expect((await find(client, "dialog")).text).toContain("modal = dialog");
    expect(dialog.text).toContain("app/settings/page.tsx:20 (/settings)");
  });

  test("'tooltip': nothing fits, so it starts from the Radix tooltip the project already renders", async () => {
    const { text, lines, isError } = await find(await connect(FIND_APP, empty), "tooltip");
    expect(isError).toBe(false);
    expect(lines[0]).toMatch(/^Nothing in this project fits "tooltip" \(looked at \d+ components/);
    expect(text).toContain("Start from: @radix-ui/react-tooltip (Radix Primitives), which this project already uses at app/settings/page.tsx:12");
    expect(lines.at(-1)).toBe("Next: build it from that primitive as a new component in components/, so the next agent finds it with ui_find_component.");
  });

  test("'date picker': Discover candidates from the local index, with licence and install command; without an index, how to build one", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const withIndex = await find(await connect(FIND_APP, cache), "date picker");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
    expect(withIndex.text).not.toMatch(/lucide|CalendarClock/);
    expect(withIndex.lines[0]).toMatch(/^Nothing in this project fits "date picker"/);
    expect(withIndex.lines[1]).toBe("Start from one of these Discover candidates (outside references, not installed here):");
    expect(withIndex.lines[2]).toMatch(/^- .+ \(lib:.+\): .+, licence [^,;]+.*; install: /);
    expect(withIndex.lines.at(-1)).toMatch(/^Next: show these to a person and install only the one they choose/);
    const without = await find(await connect(FIND_APP, empty), "date picker");
    expect(without.text).not.toMatch(/lucide|CalendarClock/);
    expect(without.text).toContain('No Discover index on this machine to suggest a starting point: run youiyoux discover sync, then youiyoux discover "date picker".');
    expect(without.lines.at(-1)).toMatch(/^Next: build it as a new component in components\//);
  });

  test("a System project ranks its System Button first, with the contract's import and system_get_component", async () => {
    const { text, lines } = await find(await connect(EXPO_APP, empty), "button");
    expect(lines[1]).toBe('1. Use Button (System): import { Button } from "@/components/ui";');
    expect(text).toMatch(/2\. Use Button \(hand-rolled\): import \{ Button \} from "@\/components\/legacy\/button";/);
    expect(text).toContain("variant: default|outline|ghost|danger|link");
    expect(lines.at(-1)).toBe('Next: import it as shown, check its props with system_get_component {"name": "Button"} and use only the listed values, then run system_check on your code before finishing.');
    const none = await find(await connect(EXPO_APP, empty), "tooltip");
    expect(none.lines.at(-1)).toMatch(/^Next: .*library_request/);
  });

  test("a weak or unrelated hit is 'nothing fits', never a guess; whole words only", async () => {
    const components = await collectComponents(FIND_APP);
    // "menu" is a concept: no component names it, and "Modal" containing nothing of it does not qualify.
    expect(findComponents("dropdown menu", components).kind).toBe("none");
    // Plain words match names only as whole words.
    expect(findComponents("snack", components).kind).toBe("none");
    expect(findComponents("snackbar", components)).toMatchObject({ kind: "matches", matches: expect.arrayContaining([expect.objectContaining({ name: "Snackbar" })]) });
  });

  test("library labels: shadcn by its data-slot names, Radix by its package, hand-rolled otherwise", async () => {
    const components = await collectComponents(FIND_APP);
    const label = (name: string): string => libraryOf(components.components.find((c) => c.definition.name === name)!, components);
    expect(label("Button")).toBe("shadcn (Radix)");
    expect(label("PlainAlert")).toBe("shadcn");
    expect(label("RadixDialog")).toBe("shadcn (Radix)");
    expect(label("Toaster")).toBe("sonner");
    expect(label("Modal")).toBe("Radix Primitives");
    expect(label("Alert")).toBe("hand-rolled");
    expect(libraryOf({ ...components.components.find((c) => c.definition.name === "Alert")!, ownSlots: [] }, { shadcnUi: "components" })).toBe("shadcn");
  });
});

test("class kits include real class usage and stylesheet guidance", async () => {
  const components = await collectComponents(FIND_APP);
  const kit = components.components.find((c) => c.definition.name === ".button")!;
  expect(kit.props).toEqual([{ name: "modifier", values: ["primary"] }]);
  expect(kit.sites[0]).toMatchObject({ file: "app/examples/page.tsx", line: 4 });
  const result = findComponents("primary button with icon", { ...components, components: components.components.filter((c) => c.definition.kind === "class") });
  expect(result.kind).toBe("matches");
  if (result.kind !== "matches") return;
  const text = matchesText(result, false);
  expect(text).toContain('Use .button class kit (class kit, styles/kit.css): className="button button--primary"');
  expect(text).toContain('<PlusIcon /> Save</button>');
  expect(text).toContain("Next: apply the .button classes");
  expect((await find(await connect(FIND_APP, empty), "primary button with icon")).text).toContain("Use .button class kit");
  // A class that only styles a component (<Modal className="card">) is not a kit to reuse.
  const card = components.components.find((c) => c.definition.name === ".card")!;
  expect(card.sites.map((site) => site.file)).toEqual(["app/direct/page.tsx"]);
  expect(findComponents("card", components).kind).toBe("none");
});

test("requested missing capabilities explain the edit", async () => {
  const { text } = await find(await connect(FIND_APP, empty), "dismissible snackbar");
  expect(text).toContain("Lacks: Snackbar has no dismiss prop (onDismiss/onClose)");
  expect(text).toContain("onDismiss?: () => void");
  expect(text).toContain("components/snackbar.tsx");
});

test("call sites resolve aliases, namespaces and local hooks", async () => {
  const hook = await find(await connect(FIND_APP, empty), "notice");
  expect(hook.lines[1]).toContain("Use useNotice");
  expect(hook.text).toContain("notices.useNotice()");
  expect(hook.lines.at(-1)).toContain("call it like the example");
  const components = await collectComponents(FIND_APP);
  const toaster = components.components.find((c) => c.definition.name === "Toaster")!;
  expect(toaster.calls.find((c) => c.name === "toast")!.sites.map((s) => s.snippet)).toEqual(expect.arrayContaining([
    'notify("Saved via alias")', 'messages.toast.success("Saved via namespace")', 'toast.success("Saved")',
    // Straight from the package the Toaster wraps, through a conditional callee.
    '(ok ? toast.success : toast.error)(alertTone("danger"))',
  ]));
  // A helper exported beside Alert has call sites but never stands in for it.
  expect(components.components.find((c) => c.definition.name === "Alert")!.calls.find((c) => c.name === "alertTone")!.sites).toHaveLength(1);
  expect((await find(await connect(FIND_APP, empty), "alert")).lines[1]).toBe('1. Use Alert (hand-rolled): import { Alert } from "@/components/alert";');
  const notice = components.components.find((c) => c.definition.name === "NoticeProvider")!;
  expect(notice.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "useNotice", sites: [expect.objectContaining({ snippet: "notices.useNotice()", file: "app/calls/page.tsx", line: 5 })] }),
    expect.objectContaining({ name: "showNotice", sites: [expect.objectContaining({ snippet: "notices.showNotice()" })] }),
  ]));
});

test("Astro class kits keep actual class:list usage and its location", async () => {
  const components = await collectComponents(FIND_APP);
  const site = components.components.find((c) => c.definition.name === ".button")!.sites.find((s) => s.file.endsWith("class-kit.astro"))!;
  expect(site).toMatchObject({ line: 4, column: 1 });
  expect(site.snippet).toContain('<button class:list={["button", "button--primary"]}>Save from Astro</button>');
});

test("Discover icon sets are never offered as component starting points", async () => {
  const components = await collectComponents(FIND_APP);
  const result = findComponents("date picker", components);
  expect(result.kind).toBe("none");
  if (result.kind !== "none") return;
  const text = noneFitsText({ result, componentsDir: components.componentsDir, inSystem: false, discover: [{
    id: "lib:icons/calendar", name: "CalendarClock", title: null, kind: "component", summary: "Calendar icon",
    source: { kind: null, name: "lucide-react", ref: "lucide-react", url: null }, license: "ISC",
    signals: { weeklyDownloads: null, stars: null, pushedAt: null, archived: null }, install: null, score: 10, why: ["icon set"],
  }] });
  expect(text).not.toMatch(/lucide|CalendarClock|Start from one/);
  expect(text).toContain("Next: build it");
});
