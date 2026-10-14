import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadIndex, MissingIndexError, readNeed, searchIndex, showCandidate, signalBoost, syncIndex, type DiscoverIndex } from "../src/index.ts";
import { fixtureFetcher } from "./fixture-fetcher.ts";

let dir: string;
let index: DiscoverIndex;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youi-discover-search-"));
  await syncIndex({ sleep: async () => {}, cacheDir: dir, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
  index = await loadIndex(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const refs = (need: string, options?: Parameters<typeof searchIndex>[2]) => searchIndex(index, need, options).hits.map((h) => h.source.ref);

describe("reading a need", () => {
  test("aliases name one concept: command menu = command palette = cmdk; toast = notification = snackbar; date picker = calendar", () => {
    for (const need of ["command menu", "command palette", "cmdk"]) expect(readNeed(need).concepts.map((c) => c.id)).toEqual(["command"]);
    for (const need of ["toast", "notification", "snackbar"]) expect(readNeed(need).concepts.map((c) => c.id)).toEqual(["toast"]);
    for (const need of ["date picker", "calendar"]) expect(readNeed(need).concepts.map((c) => c.id)).toEqual(["date-picker"]);
    expect(readNeed("dropdown menu").concepts.map((c) => c.id)).toEqual(["menu"]);
    expect(readNeed("animated marquee for logos")).toMatchObject({ words: ["animated", "logos"] });
  });
});

describe("youiyoux discover \"command menu\"", () => {
  test("ranks command and cmdk-based items first", () => {
    const result = searchIndex(index, "command menu");
    expect(result.concepts).toEqual(["command"]);
    expect(result.hits.slice(0, 2).map((h) => h.source.ref)).toEqual(["@shadcn/command", "@coss/command"]);
    // Everything ranked above the first non-command hit is a command menu by name, category, description or its cmdk dependency.
    const commandLike = (h: (typeof result.hits)[number]) => h.why.some((w) => /command|cmdk/.test(w));
    expect(result.hits.slice(0, 6).every(commandLike)).toBe(true);
    expect(result.hits[0]!.why).toContain("depends on cmdk");
  });

  test("each hit carries its licence (or unknown), signals and the install command", () => {
    const [shadcn, coss] = searchIndex(index, "command menu").hits;
    expect(shadcn).toMatchObject({ license: "MIT", signals: { weeklyDownloads: null, via: { package: "cmdk", weeklyDownloads: 41566267 }, stars: 125435, archived: false }, install: { command: "npx shadcn add command", npm: ["cn", "cmdk"], registryDeps: ["dialog"] } });
    expect(coss).toMatchObject({ license: "unknown", signals: { weeklyDownloads: null, stars: null }, install: { command: "npx shadcn add @coss/command" } });
    for (const hit of searchIndex(index, "command menu").hits) {
      expect(hit.license === "unknown" || /^[A-Za-z0-9.+()-]/.test(hit.license)).toBe(true);
      expect(hit.signals).toHaveProperty("weeklyDownloads");
      expect(hit.install?.command).toMatch(/^(npx shadcn add|npm install) /);
    }
  });

  test("aliases find the same things: command palette and cmdk lead with the same items", () => {
    expect(refs("command palette").slice(0, 2)).toEqual(["@shadcn/command", "@coss/command"]);
    expect(refs("cmdk").slice(0, 2)).toEqual(["@shadcn/command", "@coss/command"]);
  });

  test("toast = notification = snackbar; date picker = calendar", () => {
    for (const need of ["toast", "notification", "snackbar"]) {
      const top = refs(need).slice(0, 4);
      expect(top).toEqual(expect.arrayContaining(["@shadcn/sonner", "@coss/toast", "sonner"]));
    }
    expect(refs("date picker")[0]).toBe("@shadcn/calendar");
  });

  test("signals lift ties but never outrank a better match", () => {
    const hits = searchIndex(index, "command menu").hits;
    const cmdkPackage = hits.find((h) => h.source.ref === "react-cmdk")!;
    expect(hits.findIndex((h) => h.source.ref === "@coss/command")).toBeLessThan(hits.indexOf(cmdkPackage));
    for (const entry of index.entries) expect(signalBoost(entry)).toBeLessThanOrEqual(3);
    expect(signalBoost({ ...index.entries[0]!, signals: { weeklyDownloads: null, stars: null, pushedAt: null, archived: true, package: null, repo: null }, license: "unknown", provenance: undefined })).toBe(-2);
  });

  test("role and constraints filter", () => {
    // Dialogs that are command palettes, and only those.
    expect(refs("dialog", { role: "command palette" })).toEqual(["@coss/p-command-1", "@coss/p-command-2"]);
    expect(refs("dialog", { role: "dialog" })).toEqual(expect.arrayContaining(["@shadcn/dialog", "@coss/dialog"]));
    expect(refs("command menu", { constraints: { licenses: ["MIT"] } })).not.toContain("@coss/command");
    expect(refs("command menu", { constraints: { licenses: ["MIT"], allowUnknownLicense: true } })).toContain("@coss/command");
    expect(refs("command menu", { constraints: { sources: ["npm"] } }).every((r) => !r?.startsWith("@"))).toBe(true);
    expect(refs("command menu", { constraints: { registries: ["@coss"] } }).every((r) => r?.startsWith("@coss/"))).toBe(true);
    expect(refs("command menu", { constraints: { kinds: ["pattern"] } })).toEqual(["@coss/p-command-1", "@coss/p-command-2"]);
    expect(refs("command menu", { constraints: { minStars: 100_000 } })).toEqual(["@shadcn/command"]);
  });

  test("nothing matched is an empty answer, not a guess", () => {
    expect(searchIndex(index, "quaternion visualiser").hits).toEqual([]);
  });
});

describe("show", () => {
  test("finds a candidate by lib: id or ref, with provenance", () => {
    expect(showCandidate(index, "lib:coss/component/command").entry.source.ref).toBe("@coss/command");
    expect(showCandidate(index, "@coss/command").entry.id).toBe("lib:coss/component/command");
    expect(showCandidate(index, "command").entry.id).toBe("lib:shadcn/component/command");
    expect(showCandidate(index, "react-cmdk").entry.source.kind).toBe("npm");
    expect(() => showCandidate(index, "@nowhere/thing")).toThrow(/no Discover candidate/);
  });

  test("a missing index is an error that says to sync, never a fetch", async () => {
    const empty = await mkdtemp(join(tmpdir(), "youi-discover-empty-"));
    await expect(loadIndex(empty)).rejects.toBeInstanceOf(MissingIndexError);
    await expect(loadIndex(empty)).rejects.toThrow(/youiyoux discover sync/);
    await rm(empty, { recursive: true, force: true });
  });
});
