/**
 * One schema for both engines, applied in order and recorded in `migrations`. Portable SQL
 * only: text ids, ISO-8601 times as text, 0/1 for booleans, INTEGER counts, and JSON in the
 * column type the adapter names (TEXT or JSONB). The full-text index is the one part each
 * engine writes its own way (Dialect.searchDdl).
 *
 * Everything here is derived and rebuildable (`youi index rebuild`): decisions (tokens,
 * contracts, rules, adopted Library items, approvals) stay in git and are never stored.
 */
import type { Dialect } from "./driver.ts";

export interface Migration {
  readonly id: number;
  readonly name: string;
  statements(dialect: Dialect): readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "base",
    statements: ({ json }) => [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      // Discover listings: metadata only, never source. scope 'chosen' is the synced sources, 'all' what --all added.
      `CREATE TABLE IF NOT EXISTS discover_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        ref TEXT,
        name TEXT NOT NULL,
        title TEXT,
        summary TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_kind TEXT,
        source_class TEXT NOT NULL,
        registry TEXT,
        licence TEXT NOT NULL,
        style TEXT NOT NULL,
        downloads INTEGER,
        stars INTEGER,
        archived INTEGER NOT NULL,
        search_text TEXT NOT NULL,
        entry ${json} NOT NULL,
        built_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS discover_items_scope ON discover_items (scope, source_class)`,
      `CREATE INDEX IF NOT EXISTS discover_items_ref ON discover_items (ref)`,
      `CREATE TABLE IF NOT EXISTS discover_roles (item_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (item_id, role))`,
      `CREATE INDEX IF NOT EXISTS discover_roles_role ON discover_roles (role)`,
      `CREATE TABLE IF NOT EXISTS signals (key TEXT PRIMARY KEY, kind TEXT NOT NULL, data ${json} NOT NULL, fetched_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS licences (item_id TEXT PRIMARY KEY, spdx TEXT NOT NULL, evidence_url TEXT, verified_at TEXT)`,
      // Inventory history: one row per project per run.
      `CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        run TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT NOT NULL,
        root TEXT NOT NULL,
        commit_sha TEXT,
        scanned_at TEXT NOT NULL,
        status TEXT NOT NULL,
        files INTEGER NOT NULL,
        looks INTEGER NOT NULL,
        families INTEGER NOT NULL,
        near_duplicates INTEGER NOT NULL,
        roles ${json} NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS scans_project ON scans (project, scanned_at)`,
      `CREATE INDEX IF NOT EXISTS scans_run ON scans (run)`,
      `CREATE TABLE IF NOT EXISTS families (
        run TEXT NOT NULL,
        id TEXT NOT NULL,
        role TEXT NOT NULL,
        looks INTEGER NOT NULL,
        near_duplicate INTEGER NOT NULL,
        projects ${json} NOT NULL,
        kits ${json} NOT NULL,
        shape ${json} NOT NULL,
        PRIMARY KEY (run, id)
      )`,
      `CREATE TABLE IF NOT EXISTS looks (
        run TEXT NOT NULL,
        id TEXT NOT NULL,
        project TEXT NOT NULL,
        role TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        tag TEXT NOT NULL,
        kit TEXT,
        family TEXT,
        routes ${json} NOT NULL,
        shape ${json} NOT NULL,
        PRIMARY KEY (run, id)
      )`,
      `CREATE INDEX IF NOT EXISTS looks_family ON looks (run, family)`,
      // The graph: what uses what, read with recursive CTEs that are the same text on both engines.
      `CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, source TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS nodes_ref ON nodes (kind, ref)`,
      `CREATE TABLE IF NOT EXISTS edges ("from" TEXT NOT NULL, "to" TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY ("from", "to", kind))`,
      `CREATE INDEX IF NOT EXISTS edges_to ON edges ("to", kind)`,
      `CREATE INDEX IF NOT EXISTS edges_source ON edges (source)`,
    ],
  },
  { id: 2, name: "discover-search", statements: (dialect) => dialect.searchDdl },
  { id: 3, name: "project-graph", statements: () => [
    `ALTER TABLE nodes ADD COLUMN project TEXT`,
    `CREATE INDEX nodes_project ON nodes (project, kind, ref)`,
    `CREATE INDEX looks_project_family ON looks (run, project, family)`,
    // Old graph ids cannot be assigned safely to a project; rebuild restores this cache.
    `DELETE FROM edges`,
    `DELETE FROM nodes`,
  ] },
];

export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.id));
