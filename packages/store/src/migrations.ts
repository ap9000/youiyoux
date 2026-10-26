/**
 * One schema for both engines, applied in order and recorded in `migrations`. Portable SQL
 * only: text ids, ISO-8601 times as text, 0/1 for booleans, INTEGER counts, and JSON in the
 * column type the adapter names (TEXT or JSONB). The full-text index is the one part each
 * engine writes its own way (Dialect.searchDdl).
 *
 * Everything here is derived and rebuildable (`youiyoux index rebuild`): decisions (tokens,
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
  // What CI sends a hosted hub (youi.record/v1, redacted, no code): not derived from git like the
  // rest, so a rebuild (reset) keeps it; each repository's last 100 are kept.
  { id: 4, name: "ci-records", statements: ({ json }) => [
    `CREATE TABLE IF NOT EXISTS ci_records (id TEXT PRIMARY KEY, repo TEXT NOT NULL, commit_sha TEXT, ref TEXT, generated_at TEXT NOT NULL, received_at TEXT NOT NULL, record ${json} NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ci_records_repo ON ci_records (repo, generated_at)`,
  ] },
  // A hosted hub's workspaces, kept apart from each other: the GitHub owners and CI tokens that feed
  // each, its members, and people's sessions. Like ci_records, none of it is derived from git, and
  // a rebuild keeps it. Owners and people by GitHub's numeric id, which a renamed account never
  // passes on; tokens and sessions by their SHA-256 only. Records sent before workspaces are the
  // `default` workspace's, and a commit is kept once per workspace.
  { id: 5, name: "workspaces", statements: ({ json }) => [
    `CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, github_org_id TEXT, github_org_login TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE workspace_owners (owner_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, login TEXT NOT NULL, added_at TEXT NOT NULL)`,
    `CREATE TABLE workspace_tokens (hash TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (workspace, name))`,
    `CREATE TABLE hub_users (github_id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, seen_at TEXT NOT NULL)`,
    `CREATE TABLE workspace_members (workspace TEXT NOT NULL, github_id TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL, via TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (workspace, github_id))`,
    `CREATE INDEX workspace_members_person ON workspace_members (github_id)`,
    `CREATE TABLE hub_sessions (hash TEXT PRIMARY KEY, github_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE TABLE ci_records_by_workspace (workspace TEXT NOT NULL, id TEXT NOT NULL, repo TEXT NOT NULL, commit_sha TEXT, ref TEXT, generated_at TEXT NOT NULL, received_at TEXT NOT NULL, record ${json} NOT NULL, PRIMARY KEY (workspace, id))`,
    `INSERT INTO ci_records_by_workspace (workspace, id, repo, commit_sha, ref, generated_at, received_at, record) SELECT 'default', id, repo, commit_sha, ref, generated_at, received_at, record FROM ci_records`,
    `DROP TABLE ci_records`,
    `ALTER TABLE ci_records_by_workspace RENAME TO ci_records`,
    `CREATE INDEX ci_records_workspace_repo ON ci_records (workspace, repo, generated_at)`,
  ] },
];

export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.id));
