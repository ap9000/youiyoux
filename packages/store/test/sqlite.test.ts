import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openSqlite } from "../src/index.ts";
import { storeContract } from "./store.contract.ts";

let dir = "";
storeContract({
  name: "sqlite",
  open: async () => {
    dir = await mkdtemp(join(tmpdir(), "youi-store-sqlite-"));
    return openSqlite(join(dir, "index.db"));
  },
  reopen: () => openSqlite(join(dir, "index.db")),
  readOnly: () => openSqlite(join(dir, "index.db"), { readOnly: true }),
  cleanup: () => rm(dir, { recursive: true, force: true }),
});

test("sqlite: the file is in WAL mode with FTS5, and opening it again migrates nothing", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "youi-store-wal-"));
  try {
    const store = await openSqlite(join(scratch, "nested", "index.db"));
    expect(await store.migrate()).toEqual([]);
    await store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(scratch, "nested", "index.db"));
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'discover_fts'").get()?.sql).toMatch(/fts5.*porter unicode61/);
    db.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});


test("records CI sent before workspaces move to the default workspace, and nowhere else", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "youi-store-records-"));
  const path = join(scratch, "index.db");
  const { sqliteAdapter, MIGRATIONS } = await import("../src/index.ts");
  try {
    const db = sqliteAdapter(path);
    await db.exec("CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((m) => m.id < 5)) {
      for (const sql of migration.statements(db)) await db.exec(sql);
      await db.run("INSERT INTO migrations VALUES (?, ?, ?)", [migration.id, migration.name, new Date().toISOString()]);
    }
    const record = { schema: "youi.record/v1", repo: "acme/web", commit: "a".repeat(40), ref: "main", generatedAt: "2026-10-20T12:00:00.000Z", tool: "0.1.27", products: [] };
    await db.run("INSERT INTO ci_records (id, repo, commit_sha, ref, generated_at, received_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)", [`acme/web@${record.commit}`, record.repo, record.commit, record.ref, record.generatedAt, "2026-10-20T12:00:01.000Z", JSON.stringify(record)]);
    await db.close();
    const store = await openSqlite(path);
    expect((await store.latestRecords()).map((l) => [l.record.repo, l.receivedAt])).toEqual([["acme/web", "2026-10-20T12:00:01.000Z"]]);
    expect(await store.latestRecords("acme")).toEqual([]);
    await store.close();
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("read-only old schemas ask for rebuild; writable opens migrate", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "youi-store-old-"));
  const path = join(scratch, "index.db");
  const { sqliteAdapter, MIGRATIONS, SCHEMA_VERSION } = await import("../src/index.ts");
  try {
    const db = sqliteAdapter(path);
    await db.exec("CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((m) => m.id < 3)) {
      for (const sql of migration.statements(db)) await db.exec(sql);
      await db.run("INSERT INTO migrations VALUES (?, ?, ?)", [migration.id, migration.name, new Date().toISOString()]);
    }
    await db.close();
    await expect(openSqlite(path, { readOnly: true })).rejects.toThrow("run youiyoux index rebuild");
    const writer = await openSqlite(path);
    expect((await writer.stats()).schema).toBe(SCHEMA_VERSION);
    await writer.close();
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
