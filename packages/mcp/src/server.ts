/**
 * The YouIyouX MCP server (stdio). Two families of read tools, named for the
 * side of the tool they read:
 *   system_*   approved elements: build with these (contracts, tokens, rules,
 *              where-used, check) and plan a change to them.
 *   library_*  ingested references: browse and draft an adoption request only.
 *   discover_* candidates from the local Discover index (`youi discover sync` builds it):
 *              search by need and show one; read-only, they never fetch.
 * There is no publish, approve, merge or install tool, so an agent can look things up,
 * plan a change and draft a request, but never ship one.
 *
 * Responses are compact JSON (no pretty-printing) and bounded: lists paginate
 * and site lists default to 10, which keeps a typical lookup near 2 KB.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { isLibraryId, loadLibrary, MigrationSpec, normalizeRelPath, type Library, type McpTool } from "@youiyoux/core";
import { DiscoverConstraints, discoverCacheDir, loadIndex, MissingIndexError, searchIndex, showCandidate } from "@youiyoux/discover";
import { adoptionRequest, findLibraryEntry, componentCard, describeIdentity, failedChecks, findContract, formatProps, loadProject, planChange, ruleRows, ScanCache, scanProject, screenBom, searchElements, searchLibrary, tokenRows, whereUsed, type PlanInput, type Project, type ScanResult } from "@youiyoux/scanner";
import { z } from "zod";

export interface ServerOptions {
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly designRoot?: string;
  readonly productRoot?: string;
  /** How long a scan stays fresh before a query rescans (ms). */
  readonly scanTtlMs?: number;
  /** The Discover index directory (default: YOUI_DISCOVER_CACHE, else ~/.cache/youiyoux/discover). */
  readonly discoverCache?: string;
}

const VERSION = "0.1.0";
const DEFAULT_TTL = 5_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true });

/**
 * The project and its scan, both refreshed after the TTL. The project is reloaded through
 * the normal loader, so an edited rule, contract or token is picked up; the shared scan
 * cache keys everything by content and drops derived state when the definitions change.
 */
class State {
  private project: { at: number; value: Promise<Project> } | null = null;
  private library: { project: Promise<Project>; value: Promise<Library> } | null = null;
  private scan: { at: number; project: Promise<Project>; result: Promise<ScanResult> } | null = null;
  private readonly cache = new ScanCache();
  private readonly options: ServerOptions;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  private get ttl(): number {
    return this.options.scanTtlMs ?? DEFAULT_TTL;
  }

  /** The definitions, re-read once they are older than the TTL: an approved, merged rule reaches a running agent without a restart. */
  loadProject(): Promise<Project> {
    if (!this.project || Date.now() - this.project.at > this.ttl) {
      const value = loadProject(this.options.projectRoot, { ...(this.options.configPath ? { configPath: this.options.configPath } : {}), ...(this.options.designRoot ? { designRoot: this.options.designRoot } : {}), ...(this.options.productRoot ? { productRoot: this.options.productRoot } : {}) });
      // A failed load (a half-written definition) is retried on the next call, not cached.
      value.catch(() => {
        if (this.project?.value === value) this.project = null;
      });
      this.project = { at: Date.now(), value };
    }
    return this.project.value;
  }

  /** The Library, reloaded with the project after the TTL. */
  loadLibrary(): Promise<Library> {
    const current = this.loadProject();
    if (!this.library || this.library.project !== current) this.library = { project: current, value: current.then((project) => loadLibrary(project.repo.root)) };
    return this.library.value;
  }

  async scanned(): Promise<{ project: Project; scan: ScanResult }> {
    const current = this.loadProject();
    if (!this.scan || this.scan.project !== current || Date.now() - this.scan.at > this.ttl) {
      this.scan = { at: Date.now(), project: current, result: current.then((project) => scanProject(project, { cache: this.cache })) };
    }
    return { project: await current, scan: await this.scan.result };
  }

  /** A fresh, focused check through the shared cache (only changed files are re-analysed). */
  async check(project: Project, options: { overrides?: Record<string, string>; focus: readonly string[] }): Promise<ScanResult> {
    return scanProject(project, { ...options, cache: this.cache });
  }
}

function guard<A>(handler: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return ok(await handler(args));
    } catch (error: unknown) {
      return fail(error);
    }
  };
}

export function createServer(options: ServerOptions): McpServer {
  const state = new State(options);
  const discoverDir = discoverCacheDir(options.discoverCache);
  /** Read the index; a missing one is an error that says how to build it, never a fetch. */
  const discoverIndex = () => loadIndex(discoverDir);

  /** A Discover candidate can be requested by its lib: id, as if it were in the Library; the Library's own entry wins. */
  async function withCandidate(library: Library, item: string): Promise<Library> {
    if (findLibraryEntry(library, item) || !isLibraryId(item)) return library;
    try {
      const candidate = (await discoverIndex()).entries.find((e) => e.id === item.trim());
      return candidate ? { entries: [...library.entries, candidate] } : library;
    } catch (error: unknown) {
      if (error instanceof MissingIndexError) return library;
      throw error;
    }
  }
  const server = new McpServer(
    { name: "youiyoux", version: VERSION },
    {
      instructions:
        "YouIyouX design-language lookups for this project. Build only with System elements: call system_get_component before using a component's props, system_get_tokens instead of writing colours or sizes, and system_check on code before finishing. system_plan shows the impact of a change to the System. The Library (library_* tools, lib: ids) holds ingested references that are not approved: browse them with library_search, never import, copy or build with them, and use library_request to draft an adoption request for a person to approve. discover_search and discover_show find outside candidates by need (shadcn registries, npm) with licence, signals and install command: they are references, never install or copy one; propose one with library_request. There are no tools to publish, approve or install anything.",
    },
  );

  server.registerTool(
    "system_search" satisfies McpTool,
    { title: "Search the System", description: "Find approved components, tokens and rules by words (e.g. \"destructive button\", \"hairline\"). These are what you build with.", inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }, annotations: READ_ONLY },
    guard(async ({ query, limit }) => {
      const { project, scan } = await state.scanned();
      return { hits: searchElements(project, scan.tokens, query, limit ?? 12) };
    }),
  );

  server.registerTool(
    "system_get_component" satisfies McpTool,
    { title: "Get a System component contract", description: "The contract for one System component: import line, legal prop values, do/don't, a11y notes, examples, stage (adopted or in-use) and usage counts. Call this before using its props.", inputSchema: { name: z.string().min(1).describe("Component name or id, e.g. Button or youi:demo/component/button") }, annotations: READ_ONLY },
    guard(async ({ name }) => {
      const { project, scan } = await state.scanned();
      const contract = findContract(project, name);
      if (!contract) throw new Error(`no component "${name}"; known: ${project.system.components.map((c) => c.contract.name).join(", ")}`);
      return componentCard(project, contract, scan.report);
    }),
  );

  server.registerTool(
    "system_get_tokens" satisfies McpTool,
    { title: "Get System tokens", description: "Tokens with their CSS variable, light and dark values, alias and Tailwind utility. Filter by group (color, typography, radius, space, shadow, font, easing) or a full id.", inputSchema: { group: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: READ_ONLY },
    guard(async ({ group, limit }) => {
      const { project, scan } = await state.scanned();
      return tokenRows(project, scan.tokens, group, limit ?? 40);
    }),
  );

  server.registerTool(
    "system_get_rules" satisfies McpTool,
    { title: "Get System rules", description: "Every System rule that is on: severity, whether `youi check` enforces it (execution: enforced, advisory or unsupported), the instruction to follow, and a bad/good example. Follow advisory and unsupported rules yourself: nothing checks them.", inputSchema: {}, annotations: READ_ONLY },
    guard(async () => ({ rules: ruleRows(await state.loadProject()) })),
  );

  server.registerTool(
    "system_where_used" satisfies McpTool,
    { title: "Where a System component is used", description: "Usage sites by screen (file:line, design props), prop-value counts, unresolved sites that may be it (never counted) and same-named lookalikes. Paginate with offset.", inputSchema: { element: z.string().min(1), route: z.string().optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).optional() }, annotations: READ_ONLY },
    guard(async ({ element, route, limit, offset }) => {
      const { project, scan } = await state.scanned();
      return whereUsed(project, scan.report, element, { ...(route ? { route } : {}), limit: limit ?? 10, offset: offset ?? 0 });
    }),
  );

  server.registerTool(
    "system_screen_bom" satisfies McpTool,
    { title: "Everything on one screen", description: "The System elements, lookalikes and rule violations on a route.", inputSchema: { route: z.string().min(1) }, annotations: READ_ONLY },
    guard(async ({ route }) => {
      const { project, scan } = await state.scanned();
      return screenBom(project, scan.report, route);
    }),
  );

  server.registerTool(
    "system_check" satisfies McpTool,
    {
      title: "Check code against the System rules",
      description: "Run the design rules on code you are about to write (pass `code` and the `path` it will live at, so imports resolve) or on existing project files (pass `files`). Returns violations with suggestions, lookalikes and unresolved components.",
      inputSchema: { code: z.string().optional(), path: z.string().optional(), files: z.array(z.string()).max(50).optional() },
      annotations: READ_ONLY,
    },
    guard(async ({ code, path, files }) => {
      const project = await state.loadProject();
      if (code === undefined && !files?.length) throw new Error("pass `code` (with `path`) or `files`");
      const target = normalizeRelPath(path ?? "__youi_check__.tsx");
      if (target.startsWith("..") || isAbsolute(path ?? "")) throw new Error("`path` must be relative to the project root and inside it");
      // Always a fresh scan of the asked-about files: a check right after an edit must not read a cached result.
      const wanted = new Set(code !== undefined ? [target] : files!.map(normalizeRelPath));
      const result = await state.check(project, { ...(code !== undefined ? { overrides: { [target]: code } } : {}), focus: [...wanted] });
      const checked = new Set(result.modules.keys());
      const unchecked = [...wanted].filter((f) => !checked.has(f));
      const violations = result.report.violations.filter((v) => wanted.has(v.file)).map(({ rule, severity, line, column, message, suggestion, file }) => ({ at: `${file}:${line}:${column}`, rule: rule.split("/rule/")[1], severity, message, ...(suggestion ? { suggestion } : {}) }));
      const usages = result.report.usages.filter((u) => wanted.has(u.file)).map((u) => `${u.file}:${u.line} ${u.export} ${formatProps(u.props, u.spread)}`.trim());
      const failed = result.report.coverage.failed.filter((f) => wanted.has(f.file)).map((f) => `${f.file}: ${f.reason}`);
      // A rule that should have run and did not leaves its findings unknown, never zero.
      const notRun = failedChecks(result.report.checks).map((c) => `${c.rule.split("/rule/")[1]}: ${c.reason ?? c.state}`);
      return {
        errors: violations.filter((v) => v.severity === "error").length,
        ...(unchecked.length || failed.length || notRun.length ? { incomplete: true, unchecked, failed, notRun } : {}),
        violations,
        lookalikes: result.report.lookalikes.filter((l) => wanted.has(l.file)).map((l) => `${l.file}:${l.line} ${l.local} → ${l.resolved}`),
        unknown: result.report.unknowns.filter((u) => wanted.has(u.file)).map((u) => `${u.file}:${u.line} ${u.name} (${u.reason})`),
        usages: usages.slice(0, 30),
        rules: describeIdentity(result.identity),
      };
    }),
  );

  server.registerTool(
    "system_plan" satisfies McpTool,
    {
      title: "Plan a System change",
      description: "Read-only impact plan. Give {element, patch} (partial contract, e.g. {\"status\":\"deprecated\"} or new props), {token, value}, or {migration} (a youi.migration/v1 spec). Returns the computed change class, semver bump, affected screens, automatic versus by-hand call sites, sites to review, and `completeness`: when `exact` is false the counts are a lower bound and `limits` says what is missing, so zero affected is not proof of no effect. It never applies or publishes anything.",
      inputSchema: { element: z.string().optional(), patch: z.record(z.string(), z.unknown()).optional(), token: z.string().optional(), value: z.string().optional(), migration: z.record(z.string(), z.unknown()).optional() },
      annotations: READ_ONLY,
    },
    guard(async ({ element, patch, token, value, migration }) => {
      const { project, scan } = await state.scanned();
      let input: PlanInput;
      if (token) input = { token, ...(value ? { value } : {}) };
      else if (migration) input = { migration: MigrationSpec.parse(migration) };
      else if (element && patch) input = { element, patch };
      else throw new Error("pass {element, patch}, {token, value} or {migration}");
      return planChange(project, scan, input);
    }),
  );

  server.registerTool(
    "library_search" satisfies McpTool,
    { title: "Browse the Library", description: "Search ingested Library items (lib: ids) by words, with their source, categories and the System elements each could swap in for. Browse only: never import, copy or build with a Library item.", inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }, annotations: READ_ONLY },
    guard(async ({ query, limit }) => searchLibrary(await state.loadLibrary(), query, limit ?? 12)),
  );

  server.registerTool(
    "library_request" satisfies McpTool,
    { title: "Draft a Library adoption request", description: "Draft a request to adopt a Library item, or a Discover candidate by its lib: id, into the System (library → candidate), with the live usage of the System elements it would swap in for. Nothing is filed, installed or changed: put the draft in your summary or PR for a person to approve.", inputSchema: { item: z.string().min(1).describe("Library or Discover id (lib:<source>/<kind>/<name>), or a Library item's name"), reason: z.string().min(1).describe("Why the System needs it") }, annotations: READ_ONLY },
    guard(async ({ item, reason }) => {
      const { project, scan } = await state.scanned();
      return adoptionRequest(project, await withCandidate(await state.loadLibrary(), item), item, reason, scan);
    }),
  );

  server.registerTool(
    "discover_search" satisfies McpTool,
    {
      title: "Discover candidates by need",
      description: "Find outside UI components for a need (e.g. \"command menu\", \"toast\", \"date picker\") across the official shadcn registry, community registries and npm, from the local index. Ranked by match (names and aliases) plus signals; each hit has its licence (an SPDX id or \"unknown\"), weekly downloads, stars, last push and install command. Candidates are references: never install, import or copy one; propose one with library_request.",
      inputSchema: {
        need: z.string().min(1),
        role: z.string().optional().describe("Only candidates that play this role, e.g. button, dialog, toast"),
        constraints: DiscoverConstraints.optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: READ_ONLY,
    },
    guard(async ({ need, role, constraints, limit }) => searchIndex(await discoverIndex(), need, { ...(role ? { role } : {}), ...(constraints ? { constraints } : {}), limit: limit ?? 8 })),
  );

  server.registerTool(
    "discover_show" satisfies McpTool,
    { title: "Show one Discover candidate", description: "One candidate in full: source, provenance (fetch time, sha256 of the item and its files, registry health), licence evidence, signals and install dependencies (npm, registry, and implicit ones its code imports without declaring).", inputSchema: { id: z.string().min(1).describe("A lib: id or ref from discover_search, e.g. @coss/command") }, annotations: READ_ONLY },
    guard(async ({ id }) => showCandidate(await discoverIndex(), id)),
  );

  return server;
}


export async function startStdioServer(options: ServerOptions): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
