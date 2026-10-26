/**
 * The store over any adapter. Every statement here is portable SQL (text ids, `?` params,
 * `INSERT … ON CONFLICT DO UPDATE`, `WITH RECURSIVE … UNION` with a depth guard); the
 * adapter only supplies the JSON column type and the full-text match.
 */
import type { CiRecord } from "@youiyoux/core";
import { pageInteger, Lock, type Adapter, type Param, type Row } from "./driver.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";
import { DEFAULT_WORKSPACE } from "./types.ts";
import type { Ambiguous, GithubAccount, HubUser, MemberVia, SessionUser, Membership, Workspace, WorkspaceMember, WorkspaceRole, ProjectScope, DiscoverFilter, DiscoverItem, DiscoverSort, DiscoverMatchQuery, DiscoverPage, DiscoverRow, DiscoverScope, EdgeKind, Facets, FamilyRecord, Graph, GraphNode, InventoryRun, Licence, LookRecord, NodeKind, Page, Reached, RuleCovers, ScanRecord, Signal, SourceClass, Store, StoreStats, SwapImpact, WhereUsed } from "./types.ts";

/** The tables a rebuild empties: everything derived from git. ci_records is what CI sent, kept across rebuilds. */
const TABLES = ["meta", "discover_items", "discover_roles", "signals", "licences", "scans", "families", "looks", "nodes", "edges"] as const;
/** SQLite allows 32,766 parameters a statement and Postgres 65,535: batches stay well under both. */
const MAX_PARAMS = 30_000;
const MAX_DEPTH = 6;
const RECORDS_KEPT = 100;
const SOURCE_CLASSES: readonly SourceClass[] = ["official", "community", "npm", "other"];
/** Each browse order as SQL; the id last, so a page boundary never moves. */
const DISCOVER_ORDER: Readonly<Record<DiscoverSort, string>> = {
  recommended: "CASE d.source_class WHEN 'official' THEN 0 ELSE 1 END, COALESCE(d.downloads, -1) DESC, d.id",
  name: "LOWER(COALESCE(d.title, d.name)), d.id",
  registry: "LOWER(COALESCE(d.registry, '')), LOWER(COALESCE(d.title, d.name)), d.id",
  downloads: "COALESCE(d.downloads, -1) DESC, LOWER(COALESCE(d.title, d.name)), d.id",
};

const json = (value: unknown): string => JSON.stringify(value);
/** JSON comes back as text from SQLite and parsed from Postgres. */
const parse = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const int = (value: unknown): number => Number(value ?? 0);
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
/** Ids in slices small enough for one `IN (…)` each. */
const batches = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / MAX_PARAMS) }, (_, i) => items.slice(i * MAX_PARAMS, (i + 1) * MAX_PARAMS));

export class SqlStore implements Store {
  private readonly db: Adapter;
  private readonly lock = new Lock();

  constructor(adapter: Adapter) {
    this.db = adapter;
  }

  get engine() {
    return this.db.engine;
  }
  get location() {
    return this.db.location;
  }

  async checkSchema(): Promise<void> {
    try {
      const rows = await this.db.all<{ id: unknown }>(`SELECT MAX(id) AS id FROM migrations`);
      if (int(rows[0]?.id) !== SCHEMA_VERSION) throw new Error("schema mismatch");
    } catch {
      throw new Error("Index schema is outdated: run youiyoux index rebuild");
    }
  }

  /** Apply pending migrations, each in its own transaction. Safe to run on every open. */
  async migrate(): Promise<number[]> {
    return this.lock.run(async () => {
      await this.db.exec(`CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
      const done = new Set((await this.db.all<{ id: unknown }>(`SELECT id FROM migrations`)).map((r) => int(r.id)));
      const applied: number[] = [];
      for (const migration of MIGRATIONS) {
        if (done.has(migration.id)) continue;
        await this.db.exec(this.db.begin);
        try {
          for (const statement of migration.statements(this.db)) await this.db.exec(statement);
          await this.db.run(`INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)`, [migration.id, migration.name, new Date().toISOString()]);
          await this.db.exec("COMMIT");
        } catch (error) {
          await this.db.exec("ROLLBACK");
          throw error;
        }
        applied.push(migration.id);
      }
      for (const statement of this.db.optional ?? []) await this.db.exec(statement).catch(() => {});
      return applied;
    });
  }

  private write<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      await this.db.exec(this.db.begin);
      try {
        const result = await fn();
        await this.db.exec("COMMIT");
        return result;
      } catch (error) {
        await this.db.exec("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }

  /** Rows in batches of one multi-row INSERT each. `columns` are SQL names (quote reserved ones). */
  private async insert(table: string, columns: readonly string[], rows: readonly Param[][], conflict: string): Promise<void> {
    const size = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
    for (let i = 0; i < rows.length; i += size) {
      const batch = rows.slice(i, i + size);
      const values = batch.map(() => `(${marks(columns.length)})`).join(", ");
      await this.db.run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ${conflict}`, batch.flat());
    }
  }

  async close(): Promise<void> {
    await this.lock.run(() => this.db.close());
  }

  async reset(): Promise<void> {
    await this.write(async () => {
      for (const table of TABLES) await this.db.run(`DELETE FROM ${table}`);
    });
  }

  async stats(): Promise<StoreStats> {
    const tables: Record<string, number> = {};
    for (const table of TABLES) tables[table] = int((await this.db.all<{ n: unknown }>(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${table}`))[0]?.n);
    const schema = int((await this.db.all<{ id: unknown }>(`SELECT MAX(id) AS id FROM migrations`))[0]?.id);
    return { engine: this.engine, location: this.location, schema: schema || SCHEMA_VERSION, generation: await this.meta("generation"), tables };
  }

  async meta(key: string): Promise<string | null> {
    const row = (await this.db.all<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]))[0];
    return row ? row.value : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.write(() => this.db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]));
  }

  /* ------------------------------------------------------------------ Discover */

  private async putItems(items: readonly DiscoverItem[]): Promise<void> {
    const columns = ["id", "scope", "ref", "name", "title", "summary", "kind", "source_kind", "source_class", "registry", "licence", "style", "downloads", "stars", "archived", "search_text", "entry", "built_at"];
    const update = columns.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
    await this.insert("discover_items", columns, items.map((i) => [i.id, i.scope, i.ref, i.name, i.title, i.summary, i.kind, i.sourceKind, i.sourceClass, i.registry, i.licence, i.style, i.downloads, i.stars, i.archived ? 1 : 0, i.searchText, json(i.entry), i.builtAt]), `ON CONFLICT (id) DO UPDATE SET ${update}`);
    const ids = items.map((i) => i.id);
    for (const batch of batches(ids)) await this.db.run(`DELETE FROM discover_roles WHERE item_id IN (${marks(batch.length)})`, batch);
    await this.insert("discover_roles", ["item_id", "role"], items.flatMap((i) => [...new Set(i.roles)].map((role) => [i.id, role])), "ON CONFLICT (item_id, role) DO NOTHING");
  }

  async replaceDiscoverItems(scope: DiscoverScope, items: readonly DiscoverItem[]): Promise<void> {
    await this.write(async () => {
      await this.db.run(`DELETE FROM discover_roles WHERE item_id IN (SELECT id FROM discover_items WHERE scope = ?)`, [scope]);
      await this.db.run(`DELETE FROM discover_items WHERE scope = ?`, [scope]);
      await this.putItems(items.map((i) => ({ ...i, scope })));
    });
  }

  async upsertDiscoverItems(items: readonly DiscoverItem[]): Promise<void> {
    await this.write(() => this.putItems(items));
  }

  /** WHERE conditions for a filter, on discover_items aliased `d`. */
  private filterSql(filter: DiscoverFilter): { sql: string; params: Param[] } {
    const parts: string[] = [];
    const params: Param[] = [];
    const any = (column: string, values: readonly string[] | undefined, lower = false): void => {
      if (!values?.length) return;
      parts.push(`${lower ? `LOWER(${column})` : column} IN (${marks(values.length)})`);
      params.push(...values.map((v) => (lower ? v.toLowerCase() : v)));
    };
    any("d.scope", filter.scopes.length ? filter.scopes : ["chosen"]);
    any("d.source_kind", filter.sourceKinds);
    any("d.source_class", filter.sourceClasses);
    any("d.registry", filter.registries, true);
    any("d.licence", filter.licences, true);
    any("d.kind", filter.kinds);
    any("d.style", filter.styles);
    if (filter.roles?.length) {
      parts.push(`d.id IN (SELECT item_id FROM discover_roles WHERE role IN (${marks(filter.roles.length)}))`);
      params.push(...filter.roles);
    }
    return { sql: parts.join(" AND "), params };
  }

  async matchDiscover(query: DiscoverMatchQuery): Promise<DiscoverRow[]> {
    if (query.terms.length === 0) return [];
    const filtered = [query.roles, query.sourceKinds, query.sourceClasses, query.registries, query.licences, query.kinds, query.styles].some((v) => v?.length);
    if (!filtered && this.db.top) {
      const rows = await this.db.top(query.terms, query.scopes.length ? query.scopes : ["chosen"], SOURCE_CLASSES, pageInteger(query.perClass, 400, 10_000));
      return rows.map((r) => ({ id: r.id, sourceClass: r.source_class as SourceClass, entry: parse(r.entry) }));
    }
    const match = this.db.match(query.terms);
    const filter = this.filterSql(query);
    // Rank every match once, keep the best perClass of each source class, then read only those listings.
    const ranked = await this.db.all<{ id: string; source_class: SourceClass; r: unknown }>(
      `SELECT id, source_class, r FROM (
         SELECT id, source_class, r, ROW_NUMBER() OVER (PARTITION BY source_class ORDER BY r, id) AS n
         FROM (SELECT d.id, d.source_class, ${match.rank} AS r FROM ${match.from} WHERE ${match.where} AND ${filter.sql}) matched
       ) best WHERE n <= CAST(? AS INTEGER) ORDER BY r, id`,
      [...match.rankParams, ...match.whereParams, ...filter.params, pageInteger(query.perClass, 400, 10_000)],
    );
    const entries = new Map<string, unknown>();
    const ids = ranked.map((r) => r.id);
    for (const batch of batches(ids)) {
      for (const row of await this.db.all<{ id: string; entry: unknown }>(`SELECT id, entry FROM discover_items WHERE id IN (${marks(batch.length)})`, batch)) entries.set(row.id, row.entry);
    }
    return ranked.map((r) => ({ id: r.id, sourceClass: r.source_class, entry: parse(entries.get(r.id)) }));
  }

  async listDiscover(filter: DiscoverFilter, page: Page & { readonly sort?: DiscoverSort } = {}): Promise<DiscoverPage> {
    const where = this.filterSql(filter);
    const limit = pageInteger(page.limit, 20);
    const offset = pageInteger(page.offset, 0, 2_147_483_647);
    const rows = await this.db.all<{ id: string; source_class: SourceClass; entry: unknown }>(
      `SELECT d.id, d.source_class, d.entry FROM discover_items d WHERE ${where.sql} ORDER BY ${DISCOVER_ORDER[page.sort ?? "recommended"] ?? DISCOVER_ORDER.recommended} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    );
    return { rows: rows.map((r) => ({ id: r.id, sourceClass: r.source_class, entry: parse(r.entry) })), total: await this.countDiscover(filter) };
  }

  async countDiscover(filter: DiscoverFilter): Promise<number> {
    const where = this.filterSql(filter);
    return int((await this.db.all<{ n: unknown }>(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM discover_items d WHERE ${where.sql}`, where.params))[0]?.n);
  }

  async discoverFacets(filter: DiscoverFilter): Promise<Facets> {
    const where = this.filterSql(filter);
    const group = async (column: string): Promise<Record<string, number>> => {
      const rows = await this.db.all<{ k: string | null; n: unknown }>(`SELECT ${column} AS k, CAST(COUNT(*) AS INTEGER) AS n FROM discover_items d WHERE ${where.sql} GROUP BY ${column} ORDER BY n DESC, k`, where.params);
      return Object.fromEntries(rows.map((r) => [r.k ?? "unknown", int(r.n)]));
    };
    const roles = await this.db.all<{ k: string; n: unknown }>(`SELECT r.role AS k, CAST(COUNT(*) AS INTEGER) AS n FROM discover_roles r JOIN discover_items d ON d.id = r.item_id WHERE ${where.sql} GROUP BY r.role ORDER BY n DESC, k`, where.params);
    return { role: Object.fromEntries(roles.map((r) => [r.k, int(r.n)])), source: await group("COALESCE(d.registry, d.source_kind)"), licence: await group("d.licence"), style: await group("d.style") };
  }

  async getDiscoverItem(idOrRef: string, scopes: readonly DiscoverScope[]): Promise<DiscoverRow | null> {
    const scoped = scopes.length ? scopes : ["chosen"];
    for (const column of ["id", "ref"]) {
      const row = (await this.db.all<{ id: string; source_class: SourceClass; entry: unknown }>(`SELECT id, source_class, entry FROM discover_items WHERE ${column} = ? AND scope IN (${marks(scoped.length)}) ORDER BY CASE scope WHEN 'chosen' THEN 0 ELSE 1 END, id LIMIT 1`, [idOrRef, ...scoped]))[0];
      if (row) return { id: row.id, sourceClass: row.source_class, entry: parse(row.entry) };
    }
    return null;
  }

  async discoverRoles(itemIds: readonly string[]): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const batch of batches(itemIds)) {
      for (const row of await this.db.all<{ item_id: string; role: string }>(`SELECT item_id, role FROM discover_roles WHERE item_id IN (${marks(batch.length)}) ORDER BY item_id, role`, batch)) (out[row.item_id] ??= []).push(row.role);
    }
    return out;
  }

  /* ------------------------------------------------------- signals and licences */

  async replaceSignals(signals: readonly Signal[]): Promise<void> {
    await this.write(async () => {
      await this.db.run(`DELETE FROM signals`);
      await this.insert("signals", ["key", "kind", "data", "fetched_at"], signals.map((s) => [s.key, s.kind, json(s.data), s.fetchedAt]), "ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, data = excluded.data, fetched_at = excluded.fetched_at");
    });
  }

  async signal(key: string): Promise<Signal | null> {
    const row = (await this.db.all<{ key: string; kind: string; data: unknown; fetched_at: string | null }>(`SELECT key, kind, data, fetched_at FROM signals WHERE key = ?`, [key]))[0];
    return row ? { key: row.key, kind: row.kind, data: parse(row.data), fetchedAt: row.fetched_at } : null;
  }

  async replaceLicences(licences: readonly Licence[]): Promise<void> {
    await this.write(async () => {
      await this.db.run(`DELETE FROM licences`);
      await this.insert("licences", ["item_id", "spdx", "evidence_url", "verified_at"], licences.map((l) => [l.itemId, l.spdx, l.evidenceUrl, l.verifiedAt]), "ON CONFLICT (item_id) DO UPDATE SET spdx = excluded.spdx, evidence_url = excluded.evidence_url, verified_at = excluded.verified_at");
    });
  }

  async licence(itemId: string): Promise<Licence | null> {
    const row = (await this.db.all<{ item_id: string; spdx: string; evidence_url: string | null; verified_at: string | null }>(`SELECT item_id, spdx, evidence_url, verified_at FROM licences WHERE item_id = ?`, [itemId]))[0];
    return row ? { itemId: row.item_id, spdx: row.spdx, evidenceUrl: row.evidence_url, verifiedAt: row.verified_at } : null;
  }

  /* ---------------------------------------------------------------- CI records */

  async putRecord(record: CiRecord, receivedAt: string, workspace: string = DEFAULT_WORKSPACE): Promise<void> {
    await this.write(async () => {
      const id = `${record.repo}@${record.commit ?? record.generatedAt}`;
      await this.insert("ci_records", ["workspace", "id", "repo", "commit_sha", "ref", "generated_at", "received_at", "record"], [[workspace, id, record.repo, record.commit, record.ref, record.generatedAt, receivedAt, json(record)]], "ON CONFLICT (workspace, id) DO UPDATE SET ref = excluded.ref, generated_at = excluded.generated_at, received_at = excluded.received_at, record = excluded.record");
      await this.db.run(`DELETE FROM ci_records WHERE workspace = ? AND repo = ? AND id NOT IN (SELECT id FROM ci_records WHERE workspace = ? AND repo = ? ORDER BY generated_at DESC, received_at DESC LIMIT ${RECORDS_KEPT})`, [workspace, record.repo, workspace, record.repo]);
    });
  }

  async latestRecords(workspace: string = DEFAULT_WORKSPACE): Promise<Array<{ record: CiRecord; receivedAt: string }>> {
    const rows = await this.db.all<{ record: unknown; received_at: string }>(`SELECT record, received_at FROM (SELECT record, received_at, repo, ROW_NUMBER() OVER (PARTITION BY repo ORDER BY generated_at DESC, received_at DESC) AS n FROM ci_records WHERE workspace = ?) ranked WHERE n = 1 ORDER BY repo`, [workspace]);
    return rows.map((r) => ({ record: parse<CiRecord>(r.record), receivedAt: String(r.received_at) }));
  }

  /* -------------------------------------------------------- hosted hub workspaces */

  async addWorkspace(workspace: { id: string; name: string; githubOrg: GithubAccount | null }, at: string): Promise<void> {
    await this.write(async () => {
      if ((await this.db.all(`SELECT id FROM workspaces WHERE id = ?`, [workspace.id])).length > 0) throw new Error(`there is a workspace ${workspace.id} already`);
      await this.db.run(`INSERT INTO workspaces (id, name, github_org_id, github_org_login, created_at) VALUES (?, ?, ?, ?, ?)`, [workspace.id, workspace.name, workspace.githubOrg?.id ?? null, workspace.githubOrg?.login ?? null, at]);
    });
  }

  async workspaces(): Promise<Workspace[]> {
    const rows = await this.db.all<{ id: string; name: string; github_org_id: string | null; github_org_login: string | null; created_at: string }>(`SELECT id, name, github_org_id, github_org_login, created_at FROM workspaces ORDER BY id`);
    const owners = await this.db.all<{ workspace: string; owner_id: string; login: string }>(`SELECT workspace, owner_id, login FROM workspace_owners ORDER BY LOWER(login), owner_id`);
    const tokens = await this.db.all<{ workspace: string; name: string }>(`SELECT workspace, name FROM workspace_tokens ORDER BY name`);
    const members = await this.db.all<{ workspace: string; n: unknown }>(`SELECT workspace, COUNT(*) AS n FROM workspace_members GROUP BY workspace`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      githubOrg: r.github_org_id ? { id: r.github_org_id, login: r.github_org_login ?? r.github_org_id } : null,
      createdAt: String(r.created_at),
      owners: owners.filter((o) => o.workspace === r.id).map((o) => ({ id: o.owner_id, login: o.login })),
      tokens: tokens.filter((t) => t.workspace === r.id).map((t) => t.name),
      members: int(members.find((m) => m.workspace === r.id)?.n),
    }));
  }

  async workspace(id: string): Promise<Workspace | null> {
    return (await this.workspaces()).find((w) => w.id === id) ?? null;
  }

  async removeWorkspace(id: string): Promise<boolean> {
    return this.write(async () => {
      if ((await this.db.all(`SELECT id FROM workspaces WHERE id = ?`, [id])).length === 0) return false;
      for (const table of ["workspace_owners", "workspace_tokens", "workspace_members", "ci_records"]) await this.db.run(`DELETE FROM ${table} WHERE workspace = ?`, [id]);
      await this.db.run(`DELETE FROM workspaces WHERE id = ?`, [id]);
      return true;
    });
  }

  private async needWorkspace(id: string): Promise<void> {
    if ((await this.db.all(`SELECT id FROM workspaces WHERE id = ?`, [id])).length === 0) throw new Error(`there is no workspace ${id}`);
  }

  async addOwner(workspace: string, owner: GithubAccount, at: string): Promise<void> {
    await this.write(async () => {
      await this.needWorkspace(workspace);
      const held = (await this.db.all<{ workspace: string }>(`SELECT workspace FROM workspace_owners WHERE owner_id = ?`, [owner.id]))[0];
      if (held && held.workspace !== workspace) throw new Error(`${owner.login}'s records go to the workspace ${held.workspace} already: an owner feeds one workspace`);
      await this.db.run(`INSERT INTO workspace_owners (owner_id, workspace, login, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET login = excluded.login`, [owner.id, workspace, owner.login, at]);
    });
  }

  /** Delete what matches, and say whether anything did (the adapters do not count changes). */
  private async deleted(table: string, where: string, params: readonly Param[]): Promise<boolean> {
    return this.write(async () => {
      const found = (await this.db.all(`SELECT 1 AS found FROM ${table} WHERE ${where}`, params)).length > 0;
      if (found) await this.db.run(`DELETE FROM ${table} WHERE ${where}`, params);
      return found;
    });
  }

  async removeOwner(workspace: string, ownerId: string): Promise<boolean> {
    return this.deleted("workspace_owners", "workspace = ? AND owner_id = ?", [workspace, ownerId]);
  }

  async workspaceForOwner(ownerId: string): Promise<string | null> {
    return (await this.db.all<{ workspace: string }>(`SELECT workspace FROM workspace_owners WHERE owner_id = ?`, [ownerId]))[0]?.workspace ?? null;
  }

  async addToken(workspace: string, name: string, hash: string, at: string): Promise<void> {
    await this.write(async () => {
      await this.needWorkspace(workspace);
      if ((await this.db.all(`SELECT name FROM workspace_tokens WHERE workspace = ? AND name = ?`, [workspace, name])).length > 0) throw new Error(`the workspace ${workspace} has a token named ${name} already`);
      await this.db.run(`INSERT INTO workspace_tokens (hash, workspace, name, created_at) VALUES (?, ?, ?, ?)`, [hash, workspace, name, at]);
    });
  }

  async removeToken(workspace: string, name: string): Promise<boolean> {
    return this.deleted("workspace_tokens", "workspace = ? AND name = ?", [workspace, name]);
  }

  async workspaceForToken(hash: string): Promise<string | null> {
    return (await this.db.all<{ workspace: string }>(`SELECT workspace FROM workspace_tokens WHERE hash = ?`, [hash]))[0]?.workspace ?? null;
  }

  async putUser(user: HubUser, at: string): Promise<void> {
    await this.write(async () => {
      await this.db.run(`INSERT INTO hub_users (github_id, login, name, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, name = excluded.name, seen_at = excluded.seen_at`, [user.githubId, user.login, user.name, at]);
      // A member's login follows their account's.
      await this.db.run(`UPDATE workspace_members SET login = ? WHERE github_id = ?`, [user.login, user.githubId]);
    });
  }

  async addMember(workspace: string, person: GithubAccount, role: WorkspaceRole, via: MemberVia, at: string): Promise<void> {
    await this.write(async () => {
      await this.needWorkspace(workspace);
      const conflict = via === "invite" ? "DO UPDATE SET login = excluded.login, role = excluded.role, via = excluded.via" : "DO NOTHING";
      await this.db.run(`INSERT INTO workspace_members (workspace, github_id, login, role, via, added_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace, github_id) ${conflict}`, [workspace, person.id, person.login, role, via, at]);
    });
  }

  async removeMember(workspace: string, githubId: string, via?: MemberVia): Promise<boolean> {
    return via ? this.deleted("workspace_members", "workspace = ? AND github_id = ? AND via = ?", [workspace, githubId, via]) : this.deleted("workspace_members", "workspace = ? AND github_id = ?", [workspace, githubId]);
  }

  async members(workspace: string): Promise<WorkspaceMember[]> {
    const rows = await this.db.all<{ github_id: string; login: string; role: WorkspaceRole; via: MemberVia; added_at: string }>(`SELECT github_id, login, role, via, added_at FROM workspace_members WHERE workspace = ? ORDER BY LOWER(login), github_id`, [workspace]);
    return rows.map((r) => ({ githubId: r.github_id, login: r.login, role: r.role, via: r.via, addedAt: String(r.added_at) }));
  }

  async memberships(githubId: string): Promise<Membership[]> {
    const rows = await this.db.all<{ workspace: string; name: string; role: WorkspaceRole; via: MemberVia }>(`SELECT m.workspace, w.name, m.role, m.via FROM workspace_members m JOIN workspaces w ON w.id = m.workspace WHERE m.github_id = ? ORDER BY LOWER(w.name), w.id`, [githubId]);
    return rows.map((r) => ({ workspace: r.workspace, name: r.name, role: r.role, via: r.via }));
  }

  async addSession(hash: string, githubId: string, at: string, expiresAt: string): Promise<void> {
    await this.write(async () => {
      // Expired sessions go as new ones come.
      await this.db.run(`DELETE FROM hub_sessions WHERE expires_at <= ?`, [at]);
      await this.db.run(`INSERT INTO hub_sessions (hash, github_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, [hash, githubId, at, expiresAt]);
    });
  }

  async sessionUser(hash: string, now: string): Promise<SessionUser | null> {
    const row = (await this.db.all<{ github_id: string; login: string; name: string | null; created_at: string }>(`SELECT u.github_id, u.login, u.name, s.created_at FROM hub_sessions s JOIN hub_users u ON u.github_id = s.github_id WHERE s.hash = ? AND s.expires_at > ?`, [hash, now]))[0];
    return row ? { githubId: row.github_id, login: row.login, name: row.name, signedInAt: String(row.created_at) } : null;
  }

  async removeSession(hash: string): Promise<void> {
    await this.write(() => this.db.run(`DELETE FROM hub_sessions WHERE hash = ?`, [hash]));
  }

  /* ----------------------------------------------------------------- inventory */

  async recordInventory(run: InventoryRun): Promise<void> {
    await this.write(async () => {
      await this.insert(
        "scans",
        ["id", "run", "source", "project", "root", "commit_sha", "scanned_at", "status", "files", "looks", "families", "near_duplicates", "roles"],
        run.projects.map((p) => [`${run.run}:${p.project}`, run.run, run.source, p.project, p.root, p.commit, run.scannedAt, p.status, p.files, p.looks, p.families, p.nearDuplicates, json(p.roles)]),
        "ON CONFLICT (id) DO UPDATE SET commit_sha = excluded.commit_sha, scanned_at = excluded.scanned_at, status = excluded.status, files = excluded.files, looks = excluded.looks, families = excluded.families, near_duplicates = excluded.near_duplicates, roles = excluded.roles",
      );
      await this.db.run(`DELETE FROM families WHERE run = ?`, [run.run]);
      await this.insert("families", ["run", "id", "role", "looks", "near_duplicate", "projects", "kits", "shape"], run.families.map((f) => [run.run, f.id, f.role, f.looks, f.nearDuplicate ? 1 : 0, json(f.projects), json(f.kits), json(f.shape)]), "ON CONFLICT (run, id) DO NOTHING");
      // Looks and the graph are the newest run's: a run older than one the source already has keeps only its counts and families.
      const newest = (await this.db.all<{ scanned_at: string }>(`SELECT MAX(scanned_at) AS scanned_at FROM scans WHERE source = ?`, [run.source]))[0]?.scanned_at;
      if (newest && newest > run.scannedAt) return;
      await this.db.run(`DELETE FROM looks WHERE run IN (SELECT DISTINCT run FROM scans WHERE source = ?)`, [run.source]);
      await this.insert("looks", ["run", "id", "project", "role", "file", "line", "col", "tag", "kit", "family", "routes", "shape"], run.looks.map((l) => [run.run, l.id, l.project, l.role, l.file, l.line, l.column, l.tag, l.kit, l.family, json(l.routes), json(l.shape)]), "ON CONFLICT (run, id) DO NOTHING");
      await this.putGraph(run.source, run.graph);
    });
  }

  async history(filter: { readonly project?: string } & Page = {}): Promise<ScanRecord[]> {
    const where = filter.project ? `WHERE project = ?` : "";
    const rows = await this.db.all<Row>(`SELECT * FROM scans ${where} ORDER BY scanned_at DESC, project LIMIT ? OFFSET ?`, [...(filter.project ? [filter.project] : []), pageInteger(filter.limit, 20), pageInteger(filter.offset, 0, 2_147_483_647)]);
    return rows.map((r) => ({ id: String(r.id), run: String(r.run), source: String(r.source), project: String(r.project), root: String(r.root), commit: (r.commit_sha as string | null) ?? null, scannedAt: String(r.scanned_at), status: String(r.status), files: int(r.files), looks: int(r.looks), families: int(r.families), nearDuplicates: int(r.near_duplicates), roles: parse(r.roles) }));
  }

  async latestRun(source?: string): Promise<{ run: string; source: string; scannedAt: string } | null> {
    const row = (await this.db.all<{ run: string; source: string; scanned_at: string }>(`SELECT run, source, scanned_at FROM scans ${source ? "WHERE source = ?" : ""} ORDER BY scanned_at DESC, run DESC LIMIT 1`, source ? [source] : []))[0];
    return row ? { run: row.run, source: row.source, scannedAt: row.scanned_at } : null;
  }

  async families(filter: { readonly run?: string; readonly role?: string } & Page = {}): Promise<{ run: string | null; total: number; rows: FamilyRecord[] }> {
    const run = filter.run ?? (await this.latestRun())?.run ?? null;
    if (!run) return { run: null, total: 0, rows: [] };
    const where = `run = ?${filter.role ? " AND role = ?" : ""}`;
    const params = [run, ...(filter.role ? [filter.role] : [])];
    const total = int((await this.db.all<{ n: unknown }>(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM families WHERE ${where}`, params))[0]?.n);
    const rows = await this.db.all<Row>(`SELECT * FROM families WHERE ${where} ORDER BY role, looks DESC, id LIMIT ? OFFSET ?`, [...params, pageInteger(filter.limit, 50), pageInteger(filter.offset, 0, 2_147_483_647)]);
    return { run, total, rows: rows.map((r) => ({ id: String(r.id), role: String(r.role), looks: int(r.looks), nearDuplicate: int(r.near_duplicate) === 1, projects: parse(r.projects), kits: parse(r.kits), shape: parse(r.shape) })) };
  }

  async looks(filter: { readonly run?: string; readonly family?: string; readonly role?: string } & Page): Promise<{ run: string | null; total: number; rows: LookRecord[] }> {
    const run = filter.run ?? (await this.latestRun())?.run ?? null;
    if (!run) return { run: null, total: 0, rows: [] };
    const where = `run = ?${filter.family ? " AND family = ?" : ""}${filter.role ? " AND role = ?" : ""}`;
    const params = [run, ...(filter.family ? [filter.family] : []), ...(filter.role ? [filter.role] : [])];
    const total = int((await this.db.all<{ n: unknown }>(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM looks WHERE ${where}`, params))[0]?.n);
    const rows = await this.db.all<Row>(`SELECT * FROM looks WHERE ${where} ORDER BY project, file, line, col, id LIMIT ? OFFSET ?`, [...params, pageInteger(filter.limit, 50), pageInteger(filter.offset, 0, 2_147_483_647)]);
    return { run, total, rows: rows.map((r) => ({ id: String(r.id), project: String(r.project), role: String(r.role), file: String(r.file), line: int(r.line), column: int(r.col), tag: String(r.tag), kit: (r.kit as string | null) ?? null, family: (r.family as string | null) ?? null, routes: parse(r.routes), shape: parse(r.shape) })) };
  }

  /* --------------------------------------------------------------------- graph */

  private async putGraph(source: string, graph: Graph): Promise<void> {
    await this.db.run(`DELETE FROM edges WHERE source = ?`, [source]);
    // A node another source still links to stays; this source's other nodes go.
    await this.db.run(`DELETE FROM nodes WHERE source = ? AND id NOT IN (SELECT "from" FROM edges) AND id NOT IN (SELECT "to" FROM edges)`, [source]);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    await this.insert("nodes", ["id", "kind", "ref", "source", "project"], [...nodes.values()].map((n) => [n.id, n.kind, n.ref, source, n.project ?? null]), "ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, ref = excluded.ref, project = excluded.project");
    const edges = new Map(graph.edges.map((e) => [`${e.from}\0${e.to}\0${e.kind}`, e]));
    await this.insert("edges", [`"from"`, `"to"`, "kind", "source"], [...edges.values()].map((e) => [e.from, e.to, e.kind, source]), `ON CONFLICT ("from", "to", kind) DO UPDATE SET source = excluded.source`);
  }

  async replaceGraph(source: string, graph: Graph): Promise<void> {
    await this.write(() => this.putGraph(source, graph));
  }

  async reach(start: readonly string[], kinds: readonly EdgeKind[], options: { readonly maxDepth?: number; readonly reverse?: boolean } = {}): Promise<Reached[]> {
    if (start.length === 0 || kinds.length === 0) return [];
    const [near, far] = options.reverse ? [`"to"`, `"from"`] : [`"from"`, `"to"`];
    const depth = Math.max(0, Math.min(MAX_DEPTH, options.maxDepth ?? 3));
    // The same text on both engines: UNION drops repeats, the depth guard ends cycles.
    const rows = await this.db.all<{ id: string; kind: NodeKind; ref: string; depth: unknown }>(
      `WITH RECURSIVE reach(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id IN (${marks(start.length)})
         UNION
         SELECT e.${far}, r.depth + 1 FROM edges e JOIN reach r ON e.${near} = r.id
         WHERE e.kind IN (${marks(kinds.length)}) AND r.depth < CAST(? AS INTEGER)
       )
       SELECT n.id, n.kind, n.ref, MIN(r.depth) AS depth FROM reach r JOIN nodes n ON n.id = r.id
       GROUP BY n.id, n.kind, n.ref ORDER BY MIN(r.depth), n.kind, n.ref`,
      [...start, ...kinds, depth],
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, depth: int(r.depth) }));
  }

  async findNodes(kind: NodeKind, ref: string): Promise<Array<GraphNode & { source: string }>> {
    return this.db.all(`SELECT id, kind, ref, source, project FROM nodes WHERE kind = ? AND (ref = ? OR id = ?) ORDER BY id`, [kind, ref, ref]);
  }

  async nodesOfKind(kind: NodeKind, source?: string): Promise<Array<GraphNode & { source: string }>> {
    return this.db.all(`SELECT id, kind, ref, source, project FROM nodes WHERE kind = ?${source ? " AND source = ?" : ""} ORDER BY id`, source ? [kind, source] : [kind]);
  }

  async resolveFamily(ref: string, project?: string): Promise<(GraphNode & { source: string }) | Ambiguous | null> {
    const found = (await this.findNodes("family", ref)).filter((n) => project === undefined || n.project === project);
    return found.length > 1 ? { choices: found } : found[0] ?? null;
  }

  async resolveRule(ref: string, project?: string): Promise<(GraphNode & { source: string }) | Ambiguous | null> {
    const escaped = ref.toLowerCase().replace(/[!%_]/g, "!$&");
    const found = await this.db.all<GraphNode & { source: string }>(
      `SELECT id, kind, ref, source, project FROM nodes WHERE kind = 'rule' AND (LOWER(ref) = ? OR LOWER(id) = ? OR LOWER(ref) LIKE ? ESCAPE '!')${project === undefined ? "" : " AND project = ?"} ORDER BY id`,
      [ref.toLowerCase(), ref.toLowerCase(), `%/rule/${escaped}`, ...(project === undefined ? [] : [project])]);
    return found.length > 1 ? { choices: found } : found[0] ?? null;
  }

  private async familyLooks(source: string, ids: readonly string[], project?: string | null): Promise<Map<string, { looks: number; role: string }>> {
    const run = (await this.latestRun(source))?.run;
    if (!run || ids.length === 0) return new Map();
    const rows = await this.db.all<{ id: string; looks: unknown; role: string }>(`SELECT family AS id, COUNT(*) AS looks, MIN(role) AS role FROM looks WHERE run = ? AND family IN (${marks(ids.length)})${project == null ? "" : " AND project = ?"} GROUP BY family`, [run, ...ids, ...(project == null ? [] : [project])]);
    return new Map(rows.map((r) => [r.id, { looks: int(r.looks), role: r.role }]));
  }

  async whereUsed(family: string, options: ProjectScope = {}): Promise<WhereUsed | Ambiguous | null> {
    const node = await this.resolveFamily(family, options.project);
    if (!node || "choices" in node) return node;
    const used = await this.reach([node.id], ["used-in"], { maxDepth: 2 });
    const near = await this.reach([node.id], ["near-duplicate-of"], { maxDepth: 1 });
    const info = (await this.familyLooks(node.source, [node.ref], node.project)).get(node.ref);
    return {
      family: node.ref,
      role: info?.role ?? null,
      looks: info?.looks ?? 0,
      files: used.filter((n) => n.kind === "file").map((n) => n.ref),
      routes: used.filter((n) => n.kind === "route").map((n) => n.ref),
      nearDuplicates: near.filter((n) => n.depth > 0 && n.kind === "family").map((n) => n.ref),
      source: node.source,
    };
  }

  async swapImpact(candidate: string, family: string, options: ProjectScope = {}): Promise<SwapImpact | Ambiguous | null> {
    const node = await this.resolveFamily(family, options.project);
    if (!node || "choices" in node) return node;
    const cand = (await this.findNodes("candidate", candidate))[0];
    const replaces = cand ? await this.reach([cand.id], ["could-replace"], { maxDepth: 1 }) : [];
    // The family and its near-duplicates, transitively: swapping one look in means swapping its twins too.
    const twins = (await this.reach([node.id], ["near-duplicate-of"], { maxDepth: 4 })).filter((n) => n.kind === "family");
    const used = await this.reach(twins.map((t) => t.id), ["used-in"], { maxDepth: 2 });
    const looks = await this.familyLooks(node.source, twins.map((t) => t.ref), node.project);
    const others = await this.reach([node.id], ["could-replace"], { maxDepth: 1, reverse: true });
    return {
      candidate,
      family: node.ref,
      listed: replaces.some((n) => n.id === node.id),
      families: twins.map((t) => ({ id: t.ref, looks: looks.get(t.ref)?.looks ?? 0, depth: t.depth })),
      looks: twins.reduce((n, t) => n + (looks.get(t.ref)?.looks ?? 0), 0),
      files: used.filter((n) => n.kind === "file").map((n) => n.ref),
      routes: used.filter((n) => n.kind === "route").map((n) => n.ref),
      otherCandidates: others.filter((n) => n.kind === "candidate" && n.ref !== candidate).map((n) => n.ref),
    };
  }

  async ruleCovers(rule: string, options: ProjectScope = {}): Promise<RuleCovers | Ambiguous | null> {
    const node = await this.resolveRule(rule, options.project);
    if (!node || "choices" in node) return node;
    const reached = await this.reach([node.id], ["governs", "used-in"], { maxDepth: 3 });
    return {
      rule: node.ref,
      components: reached.filter((n) => n.kind === "component").map((n) => n.ref),
      files: reached.filter((n) => n.kind === "file").map((n) => n.ref),
      routes: reached.filter((n) => n.kind === "route").map((n) => n.ref),
    };
  }
}
