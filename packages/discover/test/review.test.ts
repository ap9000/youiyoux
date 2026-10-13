import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { cleanText, cleanData, dedupe, registryEntry, parseRegistryItems, applySignals, searchIndex, keyPackage, type DiscoverIndex } from "../src/index.ts";

const source = (name: string) => ({ name, homepage: "https://example.com", url: "https://example.com/registry.json", fetchedAt: "2026-10-12T12:00:00Z", official: name === "@shadcn", health: null });
const recorded = JSON.parse(readFileSync(new URL("./fixtures/ranking.json", import.meta.url), "utf8")) as Array<{ registry: string; items: unknown[] }>;
const entries = recorded.flatMap((row) => parseRegistryItems(row.items).items.map((item) => registryEntry(source(row.registry), item, new Map())));
const signals = { npm: { "@radix-ui/react-dialog": { weeklyDownloads: 74000000, license: "MIT", repo: null, fetchedAt: source("").fetchedAt }, cmdk: { weeklyDownloads: 41566267, license: "MIT", repo: null, fetchedAt: source("").fetchedAt } }, github: {}, registryRepos: {} };
const index: DiscoverIndex = { schema: "youi.discover-index/v1", builtAt: source("").fetchedAt, sources: [], categories: {}, entries: dedupe(entries).entries.map((entry) => applySignals(entry, signals)) };

describe("live-shaped review regressions", () => {
  test("command menu leads with shadcn and a cmdk item among many community commands", () => {
    const hits = searchIndex(index, "command menu", { limit: 100 }).hits;
    expect(hits.slice(0, 3).map((hit) => hit.source.ref)).toContain("@shadcn/command");
    expect(hits.slice(0, 3).some((hit) => hit.install?.npm.includes("cmdk"))).toBe(true);
    expect(hits.find((hit) => hit.source.ref === "@glass-ui/command")?.signals.weeklyDownloads).toBeNull();
    expect(hits.some((hit) => hit.signals.weeklyDownloads === 74000000)).toBe(false);
    expect(keyPackage(entries.find((entry) => entry.source.ref === "@glass-ui/command")!)).toBeNull();
    expect(hits.some((hit) => hit.source.ref?.startsWith("@registrydirectory/"))).toBe(false);
    for (const ref of ["@vue/command", "@icons/command-icon"]) expect(hits.findIndex((hit) => hit.source.ref === ref)).toBeGreaterThan(hits.findIndex((hit) => hit.source.ref === "@coss/command"));
  });
  test.each(["date picker", "toast", "data table", "sidebar"])("%s leads with a matching React item", (need) => {
    const hit = searchIndex(index, need).hits[0]!;
    expect(hit.source.ref).toBe(`@shadcn/${need.replaceAll(" ", "-")}`);
  });
  test("framework constraint prefers Vue and mirror collapse preserves distinct originals", () => {
    expect(searchIndex(index, "command", { constraints: { framework: "vue" } }).hits[0]?.source.ref).toBe("@vue/command");
    expect(dedupe(entries).mirrorsCollapsed).toBe(1);
    expect(index.entries.filter((entry) => entry.name === "command").length).toBeGreaterThan(20);
  });
});

describe("untrusted text", () => {
  test.each(["\x1b[2J", "\x1b]0;title\x07", "\x1b]8;;https://evil.test\x1b\\", "\x1bPpayload\x1b\\", "\x1bXpayload\x1b\\", "\x1b^payload\x1b\\", "\x1b_payload\x1b\\", "\x1b(B", "\x9b2J", "\x9dtitle\x9c", "\x90payload\x9c"])("removes a whole terminal sequence %j", (sequence) => {
    expect(cleanText(`before${sequence}after`)).toBe("beforeafter");
  });
  test("strips every prohibited control and preserves tab and newline", () => {
    for (let n = 0; n <= 159; n++) if (n < 32 || n >= 127) {
      const char = String.fromCharCode(n);
      expect(cleanText(char)).toBe(n === 9 || n === 10 ? char : "");
    }
    expect(cleanData({ "title\x00": ["a\x1b]0;pwned\x07b"] })).toEqual({ title: ["ab"] });
  });
  test("rejects shell text in item names and cleans every entry field", () => {
    expect(parseRegistryItems([{ name: "command;touch pwned", type: "registry:ui" }]).invalid).toBe(1);
    const item = parseRegistryItems([{ name: "command", type: "registry:ui", title: "\x1b]0;pwned\x07Command", description: "\x1b[2JDescription", categories: ["\x00command"], files: [{ path: "\x7fcommand.tsx", content: "original" }] }]).items[0]!;
    const entry = registryEntry(source("@test"), item, new Map());
    expect(entry.title).toBe("Command");
    expect(entry.summary).toBe("Description");
    expect(entry.categories).toEqual(["command"]);
    expect(entry.provenance?.files[0]?.path).toBe("command.tsx");
  });
});

test("registry filters use the leading scope for registrydirectory nested refs", () => {
  const entry = { ...entries[0]!, source: { ...entries[0]!.source, ref: "@registrydirectory/coss/command", name: "mirror" } };
  expect(searchIndex({ ...index, entries: [entry] }, "command", { constraints: { registries: ["@registrydirectory"] } }).hits).toHaveLength(1);
});
