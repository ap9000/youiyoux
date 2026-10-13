/**
 * The YouIyouX MCP server (stdio). Read tools, named for the side of the tool
 * they read:
 *   system_*   approved elements: build with these (contracts, tokens, rules,
 *              where-used, check) and plan a change to them.
 *   library_*  ingested references: browse and draft an adoption request only.
 *   discover_* candidates from the local Discover index (`youi discover sync` builds it):
 *              search by need and show one; read-only, they never fetch.
 *   index_*    the local index's graph (`youi inventory`, `youi scan`, `youi index rebuild`
 *              fill it): where an inventory family is used, what swapping a candidate in
 *              for one would touch, what a rule covers. A few plain lines each.
 *   ui_find_component  call before writing UI: the project's own components that fit a need
 *              (import, props, a real usage, where used, library), read live from the code with
 *              or without a youi.project.json, or "nothing fits" and where to start. Plain lines.
 *   ui_render  see a component after changing it: screenshots (light and dark, desktop and
 *              phone), accessibility issues and a diff against the base commit, as image
 *              paths and plain lines. It writes images to the specimen cache only, never
 *              into the project.
 * There is no publish, approve, merge or install tool, so an agent can look things up,
 * plan a change and draft a request, but never ship one.
 *
 * Responses are compact JSON (no pretty-printing) and bounded: lists paginate
 * and site lists default to 10, which keeps a typical lookup near 2 KB.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isLibraryId, loadLibrary, MigrationSpec, normalizeRelPath, type Library, type McpTool } from "@youiyoux/core";
import { DISCOVER_RULE, DiscoverConstraints, discoverCacheDir, discoverIndexPath, MissingIndexError, readCatalog, searchCatalog, sharedStore, showFromCatalog, type DiscoverHit } from "@youiyoux/discover";
import { storeLocation, type Store } from "@youiyoux/store";
import { adoptionRequest, collectComponents, findLibraryEntry, renderShots, type ShotsOptions, componentCard, describeIdentity, failedChecks, findContract, formatProps, loadProject, planChange, PROJECT_FILE, ruleRows, ScanCache, scanProject, screenBom, searchElements, searchLibrary, tokenRows, whereUsed, type PlanInput, type Project, type ProjectComponents, type ScanResult } from "@youiyoux/scanner";
import { z } from "zod";
import { findComponents, matchesText, noneFitsText } from "./find-component.ts";
import { renderText, ruleCoversText, swapImpactText, whereUsedText } from "./index-tools.ts";

export interface ServerOptions {
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly designRoot?: string;
  readonly productRoot?: string;
  /** How long a scan stays fresh before a query rescans (ms). */
  readonly scanTtlMs?: number;
  /** The Discover index directory (default: YOUI_DISCOVER_CACHE, else ~/.cache/youiyoux/discover). */
  readonly discoverCache?: string;
  /** The store (index.db); default beside an explicit discoverCache, else YOUI_INDEX, else ~/.cache/youiyoux/index.db. DATABASE_URL wins. */
  readonly index?: string;
  /** ui_render: tests count renders, choose the cache and never download Chromium. */
  readonly render?: Pick<ShotsOptions, "stats" | "download" | "cache">;
}

const VERSION = "0.1.0";
const DEFAULT_TTL = 5_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
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
  private inventory: { at: number; root: string; value: Promise<ProjectComponents> } | null = null;
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

  /**
   * The project's own components (inventory pass, no design system needed), re-read after the
   * TTL. With a youi.project.json, the System and its scan come too.
   */
  async components(): Promise<{ components: ProjectComponents; system: { project: Project; scan: ScanResult } | null }> {
    // No youi.project.json is the common case: the project's own components still answer.
    const system = existsSync(resolve(this.options.configPath ?? join(this.options.projectRoot, PROJECT_FILE))) ? await this.scanned() : null;
    const root = system?.project.root ?? resolve(this.options.productRoot ?? this.options.projectRoot);
    if (!this.inventory || this.inventory.root !== root || Date.now() - this.inventory.at > this.ttl) {
      const value = collectComponents(root);
      value.catch(() => {
        if (this.inventory?.value === value) this.inventory = null;
      });
      this.inventory = { at: Date.now(), root, value };
    }
    return { components: await this.inventory.value, system };
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
  const indexPath = options.index ?? discoverIndexPath(options.discoverCache);
  /** The store with the catalog in it; no index is an error that says how to build it, never a fetch. */
  const catalog = () => readCatalog(discoverDir, indexPath);
  /** The store for the index_* tools. A store that does not exist yet is not created here: it says what fills it. */
  async function graph(): Promise<Store> {
    if (!process.env.DATABASE_URL && !existsSync(indexPath)) throw new Error(`no local index at ${storeLocation({ path: indexPath })}: run youi inventory (families), youi scan (rules and usage) or youi index rebuild`);
    return sharedStore(indexPath, process.env, { readOnly: true });
  }

  /** A Discover candidate can be requested by its lib: id, as if it were in the Library; the Library's own entry wins. */
  async function withCandidate(library: Library, item: string): Promise<Library> {
    if (findLibraryEntry(library, item) || !isLibraryId(item)) return library;
    try {
      const candidate = await (await catalog()).getDiscoverItem(item.trim(), ["chosen"]);
      return candidate ? { entries: [...library.entries, candidate.entry as Library["entries"][number]] } : library;
    } catch (error: unknown) {
      if (error instanceof MissingIndexError) return library;
      throw error;
    }
  }
  const server = new McpServer(
    { name: "youiyoux", version: VERSION },
    {
      instructions:
        "YouIyouX: the UI context and verification layer for this project. Before creating any UI component, call ui_find_component with the need in words: reuse the existing component it names, or start where it says when nothing fits. Build only with System elements: call system_get_component before using a component's props, system_get_tokens instead of writing colours or sizes, and system_check on code before finishing. system_plan shows the impact of a change to the System. The Library (library_* tools, lib: ids) holds ingested references that are not approved: browse them with library_search, never import, copy or build with them, and use library_request to draft an adoption request for a person to approve. discover_search and discover_show find outside candidates by need (shadcn registries, npm) with licence, signals and install command: they are references, never install or copy one; propose one with library_request. index_where_used, index_swap_impact and index_rule_covers answer from the local index in a few lines: where an inventory family (button-2) is used, what swapping a candidate in for it would touch, and what a rule covers. After changing a component, call ui_render with its file and look at the images it names: light and dark at desktop and phone width, accessibility issues, and a diff against the base commit. There are no tools to publish, approve or install anything.",
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
    guard(async ({ need, role, constraints, limit }) => searchCatalog(await catalog(), need, { ...(role ? { role } : {}), ...(constraints ? { constraints } : {}), limit: limit ?? 8 })),
  );

  server.registerTool(
    "discover_show" satisfies McpTool,
    { title: "Show one Discover candidate", description: "One candidate in full: source, provenance (fetch time, sha256 of the item and its files, registry health), licence evidence, signals and install dependencies (npm, registry, and implicit ones its code imports without declaring).", inputSchema: { id: z.string().min(1).describe("A lib: id or ref from discover_search, e.g. @coss/command") }, annotations: READ_ONLY },
    guard(async ({ id }) => showFromCatalog(await catalog(), id, { all: false })),
  );

  /** A tool that answers in plain lines; a failure is an error result with the reason. */
  const lines = <A>(handler: (args: A) => Promise<string>) => async (args: A): Promise<ToolResult> => {
    try {
      return text(await handler(args));
    } catch (error: unknown) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  };
  /** The project an index tool answers for when none is named: the System project's id when this
   * root has a youi.project.json, else the scanned project whose root is (or holds) this server's
   * root. Undefined when neither fits; the store then answers with the choices instead of guessing. */
  const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  const defaultProject = async (store: Store): Promise<string | undefined> => {
    try { return (await state.loadProject()).config.id; } catch { /* no youi.project.json here: fall back to the scans */ }
    const here = real(options.projectRoot);
    const scans = await store.history({ limit: 100 });
    const exact = scans.find((s) => real(s.root) === here);
    const holding = scans.filter((s) => here.startsWith(real(s.root) + sep)).sort((a, b) => b.root.length - a.root.length)[0];
    return (exact ?? holding)?.project;
  };
  const knownFamilies = async (store: Store): Promise<string> => {
    const { rows, total } = await store.families({ limit: 12 });
    return total ? `known: ${rows.map((f) => f.id).join(", ")}${total > rows.length ? ", …" : ""}` : "no inventory recorded: run youi inventory";
  };

  server.registerTool(
    "index_where_used" satisfies McpTool,
    { title: "Where an inventory family is used", description: "Where one inventory family (a look the project builds, e.g. button-2 from youi inventory) is used: its files and routes, walked through the local index's graph, and the families it is a near-duplicate of. About ten plain lines.", inputSchema: { project: z.string().min(1).optional(), family: z.string().min(1).describe("An inventory family id, e.g. button-2") }, annotations: READ_ONLY },
    lines(async ({ family, project }) => {
      const store = await graph();
      const where = await store.whereUsed(family.trim(), { project: project ?? (await defaultProject(store)) });
      if (!where) throw new Error(`no family "${family}" in the index (${await knownFamilies(store)})`);
      if ("choices" in where) return ["Choose a project or full node id:", ...where.choices.slice(0, 8).map((n) => `${n.project ?? "unknown"} · ${n.id}`)].join("\n");
      return whereUsedText(where, (await store.latestRun(where.source))?.scannedAt ?? null);
    }),
  );

  server.registerTool(
    "index_swap_impact" satisfies McpTool,
    { title: "Impact of swapping a candidate in for a family", description: "What swapping a Discover or Library candidate (lib: id) in for an inventory family would touch: the family and its near-duplicates, their looks, files and routes, whether the candidate is a listed could-replace match, and the other candidates. Read-only: it changes nothing; propose a swap with library_request.", inputSchema: { project: z.string().min(1).optional(), candidate: z.string().min(1).describe("A lib: id, e.g. lib:shadcn/component/button"), family: z.string().min(1).describe("An inventory family id, e.g. button-2") }, annotations: READ_ONLY },
    lines(async ({ candidate, family, project }) => {
      const store = await graph();
      const swap = await store.swapImpact(candidate.trim(), family.trim(), { project: project ?? (await defaultProject(store)) });
      if (!swap) throw new Error(`no family "${family}" in the index (${await knownFamilies(store)})`);
      if ("choices" in swap) return ["Choose a project or full node id:", ...swap.choices.slice(0, 8).map((n) => `${n.project ?? "unknown"} · ${n.id}`)].join("\n");
      return swapImpactText(swap, DISCOVER_RULE);
    }),
  );

  server.registerTool(
    "index_rule_covers" satisfies McpTool,
    { title: "What a System rule covers", description: "The System components a rule governs, and the files and routes that use them, from the local index's graph (youi scan records the rules and the usage map). About ten plain lines.", inputSchema: { project: z.string().min(1).optional(), rule: z.string().min(1).describe("A rule id, full (youi:demo/rule/color.no-raw-color) or short (color.no-raw-color)") }, annotations: READ_ONLY },
    lines(async ({ rule, project }) => {
      const store = await graph();
      const covers = await store.ruleCovers(rule.trim(), { project: project ?? (await defaultProject(store)) });
      if (!covers) throw new Error(`no rule "${rule}" in the index: youi scan records the project's rules and usage`);
      if ("choices" in covers) return ["Choose a project or full node id:", ...covers.choices.slice(0, 8).map((n) => `${n.project ?? "unknown"} · ${n.id}`)].join("\n");
      const spec = await state.loadProject().then((p) => p.system.rules.find((r) => r.id === covers.rule), () => undefined);
      return ruleCoversText(covers, spec ? { title: spec.title, severity: spec.severity, files: spec.files } : {});
    }),
  );

  server.registerTool(
    "ui_find_component" satisfies McpTool,
    {
      title: "Find the project's existing component for a UI need",
      description: "Call this before creating any UI component. Given a need in words (\"dismissible alert\", \"primary button with icon\", \"toast\"), returns the project's existing components that fit, best first: import line, props, a real usage from the codebase, where it is used and its library (System, shadcn, Radix, hand-rolled…). Names and aliases count (toast = snackbar, dialog = modal). When nothing fits it says so plainly and names where to start: a library primitive the project already uses, or Discover candidates. Every answer ends with what to do next.",
      inputSchema: { need: z.string().min(1).describe("What the UI needs, in words, e.g. \"dismissible alert\""), limit: z.number().int().min(1).max(5).optional() },
      annotations: READ_ONLY,
    },
    lines(async ({ need, limit }) => {
      const { components, system } = await state.components();
      const result = findComponents(need.trim(), components, system ? { project: system.project, report: system.scan.report } : null, limit);
      if (result.kind === "matches") return matchesText(result, system !== null);
      let discover: DiscoverHit[] | null = null;
      try {
        discover = [...(await searchCatalog(await catalog(), need.trim(), { limit: 3 })).hits];
      } catch (error: unknown) {
        if (!(error instanceof MissingIndexError)) throw error;
      }
      return noneFitsText({ result, discover, componentsDir: system?.project.config.componentsDir ?? components.componentsDir, inSystem: system !== null });
    }),
  );

  server.registerTool(
    "ui_render" satisfies McpTool,
    {
      title: "See a component you changed",
      description: "Draw a component with the project's own code and CSS in headless Chromium: screenshots in light and dark at 1280 and 390 px, accessibility issues found by axe (WCAG 2.2 A and AA), and a pixel diff against the base commit (default: the merge base with origin/main, else main). Returns absolute image paths (open them) and a short summary ending in what to do next. With no target, only components whose files changed since the base are drawn; an unchanged component comes from the cache. Images go to the specimen cache, never into the project.",
      inputSchema: { target: z.string().min(1).optional().describe("The file you changed (project-relative or absolute), or an exported component name, e.g. src/components/ui/button.tsx or Button"), base: z.string().min(1).optional().describe("A git ref to compare with, e.g. main or HEAD~1") },
      annotations: READ_ONLY,
    },
    lines(async ({ target, base }) => {
      const root = resolve(options.productRoot ?? options.projectRoot);
      try {
        return renderText(await renderShots(root, target ? [target.trim()] : [], { ...(base ? { base } : {}), ...(process.env.YOUI_CHROMIUM ? { executablePath: process.env.YOUI_CHROMIUM } : {}), ...options.render }));
      } catch (error: unknown) {
        throw new Error(`ui_render could not run: ${error instanceof Error ? error.message : String(error)}. Nothing was checked; this is not a pass.`);
      }
    }),
  );

  return server;
}


export async function startStdioServer(options: ServerOptions): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
