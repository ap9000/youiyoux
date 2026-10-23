/**
 * The one contract every engine meets. sqlite.test.ts runs it on a temp file, pglite.test.ts
 * on PGlite (Postgres in-process): the same calls, the same answers.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { inventoryRun, MIGRATIONS, nodeId, projectGraph, SCHEMA_VERSION, SqlStore, type Store } from "../src/index.ts";
import type { CiRecord } from "@youiyoux/core";
import { EXTRA_ALL, inventory, item, ITEMS, PROJECT } from "./fixtures.ts";

export interface Engine {
  readonly name: string;
  open(): Promise<Store>;
  /** The same store, opened again (SQLite: a new connection to the file). */
  reopen?(): Promise<Store>;
  cleanup?(): Promise<void>;
  readOnly(): Promise<Store>;
}

const SOURCE = "/work/.youi/inventory.json";
const FIRST = inventory("2026-10-10T09:00:00.000Z");
const SECOND = inventory("2026-10-12T09:00:00.000Z", 3);

/** Everything the store can be asked, in one value: a rebuild from the same inputs must give it back exactly. */
async function answers(store: Store) {
  return {
    match: (await store.matchDiscover({ scopes: ["chosen"], terms: ["command", "menu"], perClass: 10 })).map((r) => r.id).sort(),
    list: (await store.listDiscover({ scopes: ["chosen"] }, { limit: 50 })).rows.map((r) => r.id),
    facets: await store.discoverFacets({ scopes: ["chosen", "all"] }),
    history: (await store.history({ limit: 10 })).map((s) => [s.project, s.scannedAt, s.looks, s.families, s.commit]),
    families: (await store.families()).rows.map((f) => [f.id, f.looks]),
    looks: (await store.looks({ limit: 100 })).total,
    where: await store.whereUsed("button-1"),
    swap: await store.swapImpact("lib:shadcn/component/button", "button-1"),
    covers: await store.ruleCovers("components.no-native-controls"),
    signal: await store.signal("npm:cmdk"),
    licence: await store.licence("lib:npm/component/cmdk"),
  };
}

/** Fill a store from the fixtures, as `youiyoux index rebuild` does from files. */
async function fill(store: Store): Promise<void> {
  await store.replaceDiscoverItems("chosen", ITEMS);
  await store.replaceDiscoverItems("all", EXTRA_ALL);
  await store.replaceSignals([{ key: "npm:cmdk", kind: "npm", data: { weeklyDownloads: 41_000_000, license: "MIT" }, fetchedAt: "2026-10-12T12:00:00.000Z" }]);
  await store.replaceLicences([{ itemId: "lib:npm/component/cmdk", spdx: "MIT", evidenceUrl: "https://www.npmjs.com/package/cmdk", verifiedAt: "2026-10-12T12:00:00.000Z" }]);
  await store.recordInventory(inventoryRun(FIRST, SOURCE));
  await store.recordInventory(inventoryRun(SECOND, SOURCE));
  await store.replaceGraph("project:console", projectGraph(PROJECT));
  const families = await store.nodesOfKind("family");
  await store.replaceGraph("discover", {
    nodes: [{ id: nodeId.candidate("lib:shadcn/component/button"), kind: "candidate", ref: "lib:shadcn/component/button" }, { id: nodeId.candidate("lib:coss/component/button"), kind: "candidate", ref: "lib:coss/component/button" }, ...families],
    edges: families.filter((f) => f.ref.startsWith("button-")).flatMap((f) => [
      { from: nodeId.candidate("lib:shadcn/component/button"), to: f.id, kind: "could-replace" as const },
      { from: nodeId.candidate("lib:coss/component/button"), to: f.id, kind: "could-replace" as const },
    ]),
  });
}

export function storeContract(engine: Engine): void {
  describe(`store contract on ${engine.name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = await engine.open();
      await fill(store);
    });
    afterAll(async () => {
      await store.close();
      await engine.cleanup?.();
    });

    test(`${engine.name}: migrations are recorded once and re-running them changes nothing`, async () => {
      expect((await store.stats()).schema).toBe(SCHEMA_VERSION);
      expect(await (store as SqlStore).migrate()).toEqual([]);
      expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4]);
      expect((await store.stats()).engine).toBe(engine.name === "sqlite" ? "sqlite" : "postgres");
    });

    test(`${engine.name}: an upsert replaces a listing in place, and search sees the new words, not the old`, async () => {
      const before = await store.countDiscover({ scopes: ["chosen"] });
      await store.upsertDiscoverItems([item("lib:coss/component/dialog", { ref: "@coss/dialog", summary: "A lightbox overlay", searchText: "dialog a lightbox overlay", roles: ["dialog"], licence: "Apache-2.0" })]);
      expect(await store.countDiscover({ scopes: ["chosen"] })).toBe(before);
      expect((await store.matchDiscover({ scopes: ["chosen"], terms: ["lightbox"], perClass: 10 })).map((r) => r.id)).toEqual(["lib:coss/component/dialog"]);
      expect(await store.matchDiscover({ scopes: ["chosen"], terms: ["modal"], perClass: 10 })).toEqual([]);
      await store.upsertDiscoverItems([ITEMS[4]!]);
      expect((await store.matchDiscover({ scopes: ["chosen"], terms: ["modal"], perClass: 10 })).map((r) => r.id)).toEqual(["lib:coss/component/dialog"]);
    });

    test(`${engine.name}: search matches any term, stems, and keeps --all listings apart unless asked`, async () => {
      const ids = async (scopes: Array<"chosen" | "all">, terms: string[]) => (await store.matchDiscover({ scopes, terms, perClass: 10 })).map((r) => r.id).sort();
      expect(await ids(["chosen"], ["command"])).toEqual(["lib:coss/component/command", "lib:npm/component/cmdk", "lib:shadcn/component/command"]);
      expect(await ids(["chosen", "all"], ["command"])).toContain("lib:extra/component/command");
      expect(await ids(["chosen"], ["toast"])).toEqual(["lib:npm/component/sonner"]);
      expect(await ids(["chosen"], ["dialogs"])).toEqual(await ids(["chosen"], ["dialog"]));
      expect(await ids(["chosen"], ["nothingmatches"])).toEqual([]);
      const row = (await store.matchDiscover({ scopes: ["chosen"], terms: ["sonner"], perClass: 10 }))[0]!;
      expect(row.entry).toEqual({ id: "lib:npm/component/sonner", name: "sonner" });
    });

    test(`${engine.name}: filters narrow by role, source, licence, kind and style`, async () => {
      const ids = async (filter: Record<string, string[]>) => (await store.matchDiscover({ scopes: ["chosen"], terms: ["command", "dialog", "toast"], perClass: 10, ...filter })).map((r) => r.id).sort();
      expect(await ids({ roles: ["dialog"] })).toEqual(["lib:coss/component/dialog", "lib:kibo/component/dialog-stack"]);
      expect(await ids({ registries: ["NPM"] })).toEqual(["lib:npm/component/cmdk", "lib:npm/component/sonner"]);
      expect(await ids({ licences: ["unknown"] })).toEqual(["lib:coss/component/command"]);
      expect(await ids({ styles: ["headless"] })).toEqual(["lib:npm/component/cmdk"]);
      expect(await ids({ sourceKinds: ["npm"], roles: ["toast"] })).toEqual(["lib:npm/component/sonner"]);
    });

    test(`${engine.name}: the candidate cap is per source class, so community bulk never crowds out the official listing`, async () => {
      const bulk = Array.from({ length: 60 }, (_, i) => item(`lib:bulk/component/command-${String(i).padStart(2, "0")}`, { scope: "all", registry: "@bulk", summary: "command command command palette", searchText: "command command command command palette" }));
      await store.upsertDiscoverItems(bulk);
      const rows = await store.matchDiscover({ scopes: ["chosen", "all"], terms: ["command"], perClass: 5 });
      expect(rows.filter((r) => r.sourceClass === "community")).toHaveLength(5);
      expect(rows.map((r) => r.id)).toContain("lib:shadcn/component/command");
      expect(rows.map((r) => r.id)).toContain("lib:npm/component/cmdk");
      await store.replaceDiscoverItems("all", EXTRA_ALL);
    });

    test(`${engine.name}: pages are stable: walking them gives every listing once, in one order`, async () => {
      const whole = (await store.listDiscover({ scopes: ["chosen", "all"] }, { limit: 100 })).rows.map((r) => r.id);
      const walked: string[] = [];
      for (let offset = 0; offset < whole.length; offset += 2) {
        const page = await store.listDiscover({ scopes: ["chosen", "all"] }, { limit: 2, offset });
        expect(page.total).toBe(whole.length);
        walked.push(...page.rows.map((r) => r.id));
      }
      expect(walked).toEqual(whole);
      expect(new Set(walked).size).toBe(whole.length);
      // Official first, then the rest by downloads.
      expect(whole[0]).toBe("lib:shadcn/component/command");
      expect(whole[1]).toBe("lib:npm/component/cmdk");
    });

    test(`${engine.name}: facets count role, source, licence and style over the filtered listings`, async () => {
      expect(await store.discoverFacets({ scopes: ["chosen"] })).toEqual({
        role: { command: 3, dialog: 2, toast: 1 },
        source: { "@coss": 2, npm: 2, "@kibo": 1, "@shadcn": 1 },
        licence: { MIT: 4, "Apache-2.0": 1, unknown: 1 },
        style: { styled: 5, headless: 1 },
      });
      expect((await store.discoverFacets({ scopes: ["chosen", "all"], roles: ["command"] })).source).toEqual({ "@coss": 1, "@extra": 1, "@shadcn": 1, npm: 1 });
    });

    test(`${engine.name}: a listing is found by lib: id or by ref, in the scopes asked`, async () => {
      expect((await store.getDiscoverItem("@coss/command", ["chosen"]))?.id).toBe("lib:coss/component/command");
      expect((await store.getDiscoverItem("lib:npm/component/sonner", ["chosen"]))?.id).toBe("lib:npm/component/sonner");
      expect(await store.getDiscoverItem("@extra/command", ["chosen"])).toBeNull();
      expect((await store.getDiscoverItem("@extra/command", ["chosen", "all"]))?.id).toBe("lib:extra/component/command");
    });

    test(`${engine.name}: every scan is kept for trends, newest first; looks are the newest run's`, async () => {
      const history = await store.history();
      expect(history.map((s) => [s.project, s.scannedAt.slice(0, 10), s.looks])).toEqual([
        ["console", "2026-10-12", 6],
        ["site", "2026-10-12", 1],
        ["console", "2026-10-10", 3],
        ["site", "2026-10-10", 1],
      ]);
      expect(history[0]).toMatchObject({ commit: "a".repeat(40), roles: { button: 5, dialog: 1 }, families: 2, source: SOURCE });
      expect((await store.history({ project: "site" })).map((s) => s.scannedAt.slice(0, 10))).toEqual(["2026-10-12", "2026-10-10"]);
      expect((await store.history({ limit: 1, offset: 1 })).map((s) => s.project)).toEqual(["site"]);
      const latest = await store.latestRun();
      expect(latest?.scannedAt).toBe("2026-10-12T09:00:00.000Z");
      expect((await store.looks({ limit: 100 })).total).toBe(7);
      const older = history.at(-1)!.run;
      expect((await store.looks({ run: older })).total).toBe(0);
      expect((await store.families({ run: older })).rows.map((f) => [f.id, f.looks])).toEqual([["button-1", 2], ["button-2", 1], ["dialog-1", 1]]);
      expect((await store.looks({ family: "button-2" })).rows.map((l) => `${l.project}:${l.file}`)).toEqual(["site:src/pages/index.astro"]);
      // A replayed older run never overwrites the newer looks or graph.
      await store.recordInventory(inventoryRun(FIRST, SOURCE));
      expect((await store.looks({ limit: 100 })).total).toBe(7);
    });

    test(`${engine.name}: where_used walks family → file → route with a recursive CTE`, async () => {
      const where = await store.whereUsed("button-1");
      if (!where || "choices" in where) throw new Error("Expected unique family");
      expect(where).toMatchObject({ family: "button-1", role: "button", looks: 5, nearDuplicates: [] });
      expect(where!.files).toEqual(["console:src/app/extra-0.tsx", "console:src/app/extra-1.tsx", "console:src/app/extra-2.tsx", "console:src/app/page.tsx", "console:src/app/settings/page.tsx"]);
      expect(where!.routes).toEqual(["console:/", "console:/extra/0", "console:/extra/1", "console:/extra/2", "console:/settings"]);
      expect(await store.whereUsed("button-99")).toBeNull();
    });

    test(`${engine.name}: swap_impact follows near-duplicates transitively and lists the other candidates`, async () => {
      const swap = await store.swapImpact("lib:shadcn/component/button", "button-1");
      if (!swap || "choices" in swap) throw new Error("Expected unique family");
      expect(swap).toMatchObject({ listed: true, family: "button-1", looks: 5, otherCandidates: ["lib:coss/component/button"] });
      expect(swap!.families).toEqual([{ id: "button-1", looks: 5, depth: 0 }]);
      expect(swap!.files).not.toContain("site:src/pages/index.astro");
      expect(swap!.routes).not.toContain("site:/");
      expect(await store.swapImpact("lib:shadcn/component/button", "dialog-1")).toMatchObject({ listed: false });
      // Cycles end: near-duplicate edges run both ways.
      expect((await store.reach([nodeId.family(SOURCE, "button-1", "console")], ["near-duplicate-of"], { maxDepth: 6 })).map((n) => n.ref)).toEqual(["button-1"]);
    });

    test(`${engine.name}: rule_covers walks rule → component → file → route`, async () => {
      const covers = await store.ruleCovers("components.no-native-controls");
      expect(covers).toEqual({
        rule: "youi:demo/rule/components.no-native-controls",
        components: ["Button", "Input"],
        files: ["console:src/app/login/page.tsx", "console:src/app/page.tsx", "console:src/app/settings/page.tsx"],
        routes: ["console:/", "console:/login", "console:/settings"],
      });
      expect(await store.ruleCovers("youi:demo/rule/components.one-primary-action")).toMatchObject({ components: ["Button"] });
      expect(await store.ruleCovers("color.no-raw-color")).toMatchObject({ components: [] });
      expect(await store.ruleCovers("no-such-rule")).toBeNull();
    });

    test(`${engine.name}: signals and licences round-trip`, async () => {
      expect(await store.signal("npm:cmdk")).toEqual({ key: "npm:cmdk", kind: "npm", data: { weeklyDownloads: 41_000_000, license: "MIT" }, fetchedAt: "2026-10-12T12:00:00.000Z" });
      expect(await store.licence("lib:npm/component/cmdk")).toMatchObject({ spdx: "MIT" });
      expect(await store.signal("npm:absent")).toBeNull();
    });

    test(`${engine.name}: repeated family and rule ids resolve by project, never newest scan`, async () => {
      const report = inventory("2026-10-13T09:00:00.000Z");
      report.looks[0]!.family = "button-2";
      report.families.find((f) => f.id === "button-2")!.projects.push("console");
      await store.recordInventory(inventoryRun(report, SOURCE));
      const ambiguous = await store.whereUsed("button-2");
      expect(ambiguous).toHaveProperty("choices");
      if (!ambiguous || !("choices" in ambiguous)) throw new Error("Expected ambiguity");
      expect(ambiguous.choices.map((n) => n.project).sort()).toEqual(["console", "site"]);
      expect(await store.whereUsed("button-2", { project: "console" })).toMatchObject({ looks: 1, files: ["console:src/app/page.tsx"] });
      expect(await store.whereUsed("button-2", { project: "site" })).toMatchObject({ looks: 1, files: ["site:src/pages/index.astro"] });
      expect(await store.swapImpact("candidate", "button-2")).toHaveProperty("choices");
      expect(await store.swapImpact("candidate", "button-2", { project: "console" })).toMatchObject({ looks: 2, families: [{ id: "button-2", looks: 1, depth: 0 }, { id: "button-1", looks: 1, depth: 1 }] });
      expect(await store.swapImpact("candidate", "button-2", { project: "site" })).toMatchObject({ looks: 1, files: ["site:src/pages/index.astro"] });
      await store.replaceGraph("project:site", projectGraph({ ...PROJECT, project: "site" }));
      expect(await store.ruleCovers("COMPONENTS.NO-NATIVE-CONTROLS")).toHaveProperty("choices");
      const covers = await store.ruleCovers("COMPONENTS.NO-NATIVE-CONTROLS", { project: "site" });
      expect(covers).toMatchObject({ files: ["site:src/app/login/page.tsx", "site:src/app/page.tsx", "site:src/app/settings/page.tsx"] });
      await store.replaceGraph("literal-rules", { nodes: [
        { id: "literal-rule", kind: "rule", ref: "youi:test/rule/a_%!b", project: "literal" },
        { id: "other-rule", kind: "rule", ref: "youi:test/rule/axy!b", project: "literal" },
      ], edges: [] });
      expect(await store.ruleCovers("A_%!B")).toMatchObject({ rule: "youi:test/rule/a_%!b" });
      expect(await store.ruleCovers("%" )).toBeNull();
      await store.reset();
      await fill(store);
    });

    test(`${engine.name}: adapters sanitize hostile terms and preserve Unicode; paging stays bounded`, async () => {
      await store.upsertDiscoverItems([item("café", { searchText: "café résumé" })]);
      for (const terms of [["CAFÉ"], ['"café" | !:*'], ["cafe\u0301"]]) {
        expect((await store.matchDiscover({ scopes: ["chosen"], terms, perClass: 10 })).map((r) => r.id)).toContain("café");
      }
      for (const terms of [["' | !:*"], ["\" OR 1=1; --"]]) await store.matchDiscover({ scopes: ["chosen"], terms, roles: ["dialog"], perClass: 10 });
      for (const value of [NaN, Infinity, -Infinity, 1e100, -3, 1.5]) {
        await store.listDiscover({ scopes: ["chosen"] }, { limit: value, offset: value });
        await store.history({ limit: value, offset: value });
        await store.families({ limit: value, offset: value });
        await store.looks({ limit: value, offset: value });
        await store.matchDiscover({ scopes: ["chosen"], terms: ["command"], perClass: value });
      }
      await store.replaceDiscoverItems("chosen", ITEMS);
    });

    test(`${engine.name}: a read-only connection reads existing rows and rejects writes`, async () => {
      const before = await answers(store);
      await store.close();
      const reader = await engine.readOnly();
      expect(await answers(reader)).toEqual(before);
      await expect(reader.setMeta("not-allowed", "x")).rejects.toThrow();
      await expect(reader.reset()).rejects.toThrow();
      await reader.close();
      store = await engine.reopen!();
      expect(await store.meta("not-allowed")).toBeNull();
    });

    test(`${engine.name}: CI records: each repository's newest, the same commit sent again replaces it, a repository keeps its last 100, and a rebuild keeps them`, async () => {
      const record = (repo: string, n: number): CiRecord => ({ schema: "youi.record/v1", repo, commit: n.toString(16).padStart(40, "0"), ref: "main", generatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), tool: "0.1.10", products: [{ root: ".", error: `run ${n}`, next: "youiyoux adopt" }] });
      for (let n = 1; n <= 102; n++) await store.putRecord(record("acme/billing", n), new Date(Date.UTC(2026, 9, 2, 0, n)).toISOString());
      await store.putRecord(record("acme/admin", 5), "2026-10-03T00:00:00.000Z");
      // An older run arriving late never hides the newer one; a commit sent again replaces its row.
      await store.putRecord(record("acme/admin", 3), "2026-10-04T00:00:00.000Z");
      await store.putRecord({ ...record("acme/admin", 5), ref: "release" }, "2026-10-05T00:00:00.000Z");
      const latest = await store.latestRecords();
      expect(latest.map((l) => [l.record.repo, l.record.commit?.slice(-2), l.record.ref, l.receivedAt])).toEqual([
        ["acme/admin", "05", "release", "2026-10-05T00:00:00.000Z"],
        ["acme/billing", "66", "main", new Date(Date.UTC(2026, 9, 2, 0, 102)).toISOString()],
      ]);
      expect(latest[1]!.record.products).toEqual([{ root: ".", error: "run 102", next: "youiyoux adopt" }]);
      await store.reset();
      expect((await store.latestRecords()).length).toBe(2);
      await fill(store);
    });

    test(`${engine.name}: emptied and rebuilt from the same inputs, it answers exactly as before`, async () => {
      const before = await answers(store);
      await store.reset();
      expect(Object.values((await store.stats()).tables).every((n) => n === 0)).toBe(true);
      expect(await store.whereUsed("button-1")).toBeNull();
      await fill(store);
      expect(await answers(store)).toEqual(before);
      if (engine.reopen) {
        await store.close();
        store = await engine.reopen();
        expect(await answers(store)).toEqual(before);
      }
    });
  });
}
