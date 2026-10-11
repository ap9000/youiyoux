/**
 * The YouIyouX MCP server (stdio). Read tools plus `youi_plan`, and nothing
 * else: there is no propose, publish, approve or merge tool, so an agent can
 * look things up and plan a change but never ship one.
 *
 * Responses are compact JSON (no pretty-printing) and bounded: lists paginate
 * and site lists default to 10, which keeps a typical lookup near 2 KB.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { MigrationSpec, normalizeRelPath } from "@youiyoux/core";
import { componentCard, findContract, formatProps, loadProject, planChange, ruleRows, scanProject, screenBom, searchElements, tokenRows, whereUsed, type PlanInput, type Project, type ScanResult } from "@youiyoux/scanner";
import { z } from "zod";

export interface ServerOptions {
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly designRoot?: string;
  /** How long a scan stays fresh before a query rescans (ms). */
  readonly scanTtlMs?: number;
}

const VERSION = "0.1.0";
const DEFAULT_TTL = 5_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true });

class State {
  private project: { at: number; result: Promise<Project> } | null = null;
  private scan: { at: number; project: Project; result: Promise<ScanResult> } | null = null;
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
      const result = loadProject(this.options.projectRoot, { ...(this.options.configPath ? { configPath: this.options.configPath } : {}), ...(this.options.designRoot ? { designRoot: this.options.designRoot } : {}) });
      // A failed load (a half-written definition) is retried on the next call, not cached.
      result.catch(() => {
        if (this.project?.result === result) this.project = null;
      });
      this.project = { at: Date.now(), result };
    }
    return this.project.result;
  }

  async scanned(): Promise<{ project: Project; scan: ScanResult }> {
    const project = await this.loadProject();
    if (!this.scan || this.scan.project !== project || Date.now() - this.scan.at > this.ttl) this.scan = { at: Date.now(), project, result: scanProject(project) };
    return { project, scan: await this.scan.result };
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
  const server = new McpServer(
    { name: "youiyoux", version: VERSION },
    {
      instructions:
        "YouIyouX design-language lookups for this project. Call youi_get_component before using a component's props, youi_get_tokens instead of writing colours or sizes, and youi_check on code before finishing. youi_plan shows the impact of a change to the system; there are no tools to publish or approve one.",
    },
  );

  server.registerTool(
    "youi_search",
    { title: "Search the design language", description: "Find components, tokens and rules by words (e.g. \"destructive button\", \"hairline\").", inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }, annotations: READ_ONLY },
    guard(async ({ query, limit }) => {
      const { project, scan } = await state.scanned();
      return { hits: searchElements(project, scan.tokens, query, limit ?? 12) };
    }),
  );

  server.registerTool(
    "youi_get_component",
    { title: "Get a component contract", description: "The contract for one component: import line, legal prop values, do/don't, a11y notes, examples and usage counts. Call this before using its props.", inputSchema: { name: z.string().min(1).describe("Component name or id, e.g. Button or youi:demo/component/button") }, annotations: READ_ONLY },
    guard(async ({ name }) => {
      const { project, scan } = await state.scanned();
      const contract = findContract(project, name);
      if (!contract) throw new Error(`no component "${name}"; known: ${project.system.components.map((c) => c.contract.name).join(", ")}`);
      return componentCard(project, contract, scan.report);
    }),
  );

  server.registerTool(
    "youi_get_tokens",
    { title: "Get design tokens", description: "Tokens with their CSS variable, light and dark values, alias and Tailwind utility. Filter by group (color, typography, radius, space, shadow, font, easing) or a full id.", inputSchema: { group: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: READ_ONLY },
    guard(async ({ group, limit }) => {
      const { project, scan } = await state.scanned();
      return tokenRows(project, scan.tokens, group, limit ?? 40);
    }),
  );

  server.registerTool(
    "youi_get_rules",
    { title: "Get design rules", description: "Every rule: severity, whether `youi check` enforces it, the instruction to follow, and a bad/good example.", inputSchema: {}, annotations: READ_ONLY },
    guard(async () => ({ rules: ruleRows(await state.loadProject()) })),
  );

  server.registerTool(
    "youi_where_used",
    { title: "Where a component is used", description: "Usage sites by screen (file:line, design props), prop-value counts, unresolved sites that may be it (never counted) and same-named lookalikes. Paginate with offset.", inputSchema: { element: z.string().min(1), route: z.string().optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).optional() }, annotations: READ_ONLY },
    guard(async ({ element, route, limit, offset }) => {
      const { project, scan } = await state.scanned();
      return whereUsed(project, scan.report, element, { ...(route ? { route } : {}), limit: limit ?? 10, offset: offset ?? 0 });
    }),
  );

  server.registerTool(
    "youi_screen_bom",
    { title: "Everything on one screen", description: "The design-system elements, lookalikes and rule violations on a route.", inputSchema: { route: z.string().min(1) }, annotations: READ_ONLY },
    guard(async ({ route }) => {
      const { project, scan } = await state.scanned();
      return screenBom(project, scan.report, route);
    }),
  );

  server.registerTool(
    "youi_check",
    {
      title: "Check code against the rules",
      description: "Run the design rules on code you are about to write (pass `code` and the `path` it will live at, so imports resolve) or on existing project files (pass `files`). Returns violations with suggestions, lookalikes and unresolved components.",
      inputSchema: { code: z.string().optional(), path: z.string().optional(), files: z.array(z.string()).max(50).optional() },
      annotations: READ_ONLY,
    },
    guard(async ({ code, path, files }) => {
      const project = await state.loadProject();
      if (code === undefined && !files?.length) throw new Error("pass `code` (with `path`) or `files`");
      const target = normalizeRelPath(path ?? "__youi_check__.tsx");
      if (target.startsWith("..") || isAbsolute(path ?? "")) throw new Error("`path` must be relative to the project root and inside it");
      // Always a fresh scan: a check right after an edit must not read a cached result.
      const result = await scanProject(project, code !== undefined ? { overrides: { [target]: code } } : {});
      const wanted = new Set(code !== undefined ? [target] : files!.map(normalizeRelPath));
      const checked = new Set(result.modules.keys());
      const unchecked = [...wanted].filter((f) => !checked.has(f));
      const violations = result.report.violations.filter((v) => wanted.has(v.file)).map(({ rule, severity, line, column, message, suggestion, file }) => ({ at: `${file}:${line}:${column}`, rule: rule.split("/rule/")[1], severity, message, ...(suggestion ? { suggestion } : {}) }));
      const usages = result.report.usages.filter((u) => wanted.has(u.file)).map((u) => `${u.file}:${u.line} ${u.export} ${formatProps(u.props, u.spread)}`.trim());
      const failed = result.report.coverage.failed.filter((f) => wanted.has(f.file)).map((f) => `${f.file}: ${f.reason}`);
      return {
        errors: violations.filter((v) => v.severity === "error").length,
        ...(unchecked.length || failed.length ? { incomplete: true, unchecked, failed } : {}),
        violations,
        lookalikes: result.report.lookalikes.filter((l) => wanted.has(l.file)).map((l) => `${l.file}:${l.line} ${l.local} → ${l.resolved}`),
        unknown: result.report.unknowns.filter((u) => wanted.has(u.file)).map((u) => `${u.file}:${u.line} ${u.name} (${u.reason})`),
        usages: usages.slice(0, 30),
      };
    }),
  );

  server.registerTool(
    "youi_plan",
    {
      title: "Plan a design-system change",
      description: "Read-only impact plan. Give {element, patch} (partial contract, e.g. {\"status\":\"deprecated\"} or new props), {token, value}, or {migration} (a youi.migration/v1 spec). Returns the computed change class, semver bump, affected screens, and automatic versus by-hand call sites. It never applies or publishes anything.",
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

  return server;
}

export async function startStdioServer(options: ServerOptions): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
