/**
 * The loopback HTTP service: the workflow under /api, and (optionally) the built hub at /.
 *
 * It listens on 127.0.0.1 only. Requests must name a loopback Host (no DNS rebinding);
 * writes must carry `X-Youi-Client` and, when the browser sends an Origin, a loopback one,
 * so another website cannot drive it from a person's browser.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { DefinitionError, ElementId, RuleCheck, RuleRollout } from "@youiyoux/core";
import type { Actor, ApiError } from "./api.ts";
import { WorkflowError } from "./policy.ts";
import type { RuleWorkflow } from "./service.ts";

export const CLIENT_HEADER = "x-youi-client";
const MAX_BODY = 1024 * 1024;

const RuleFieldsInput = z.object({
  id: z.string().max(200),
  title: z.string().max(200),
  severity: z.enum(["error", "warn", "off"]),
  rollout: RuleRollout.nullable(),
  statement: z.string().max(4000),
  rationale: z.string().max(4000),
  agent: z.string().max(1000),
  check: RuleCheck,
  files: z.array(z.string().max(300)).max(50),
  examples: z.object({ bad: z.array(z.string().max(2000)).max(20), good: z.array(z.string().max(2000)).max(20) }),
});
const DraftContentInput = z.object({ rule: RuleFieldsInput, components: z.array(ElementId).max(200) });
const CreateInput = z.discriminatedUnion("mode", [z.object({ mode: z.literal("edit"), ruleId: ElementId }), z.object({ mode: z.literal("create") })]);
const SaveInput = z.object({ revision: z.number().int().positive(), content: DraftContentInput });
const ApproveInput = z.object({ revision: z.number().int().positive() });

const STATUS: Record<ApiError["code"], number> = { "bad-request": 400, forbidden: 403, "not-found": 404, conflict: 409, stale: 409, invalid: 422, internal: 500 };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

export interface HandlerOptions {
  readonly workflow: RuleWorkflow;
  readonly actor: Actor;
  /** The built hub (apps/web/dist) to serve at /, if any. */
  readonly webRoot?: string | null;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send JSON (content-type: application/json)");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkflowError("bad-request", "the request does not match what this endpoint takes", result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  return result.data;
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkflowError) return send(res, STATUS[error.code], { error: error.message, code: error.code, ...(error.problems.length ? { problems: error.problems } : {}) } satisfies ApiError);
  if (error instanceof HttpError) return send(res, error.status, { error: error.message, code: error.status === 403 ? "forbidden" : error.status === 404 ? "not-found" : "bad-request" } satisfies ApiError);
  if (error instanceof DefinitionError) return send(res, 422, { error: `invalid definition ${error.file}`, code: "invalid", problems: error.issues } satisfies ApiError);
  send(res, 500, { error: error instanceof Error ? error.message : String(error), code: "internal" } satisfies ApiError);
}

/** Reject requests a loopback service must never act on. */
function screen(req: IncomingMessage): void {
  if (!LOOPBACK_HOST.test(req.headers.host ?? "")) throw new HttpError(421, "this service answers loopback hosts only");
  if (req.method === "GET" || req.method === "HEAD") return;
  if (req.headers[CLIENT_HEADER] === undefined) throw new HttpError(403, `writes need the ${CLIENT_HEADER} header`);
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) throw new HttpError(403, "cross-site requests are refused");
}

async function api(req: IncomingMessage, res: ServerResponse, path: string, options: HandlerOptions): Promise<void> {
  const { workflow, actor } = options;
  const method = req.method ?? "GET";
  if (path === "/api/info" && method === "GET") return send(res, 200, await workflow.info(actor));
  if (path === "/api/rules" && method === "GET") return send(res, 200, { rules: await workflow.published(actor) });
  if (path === "/api/drafts" && method === "GET") return send(res, 200, await workflow.list(actor));
  if (path === "/api/drafts" && method === "POST") return send(res, 201, await workflow.create(actor, parse(CreateInput, await readJson(req))));
  const match = /^\/api\/drafts\/(d-[0-9a-f]{10})(?:\/(preview|approve|rebase|handoff))?$/.exec(path);
  if (match) {
    const id = match[1]!;
    const action = match[2];
    if (!action && method === "GET") return send(res, 200, await workflow.get(actor, id));
    if (!action && method === "PUT") return send(res, 200, await workflow.save(actor, id, parse(SaveInput, await readJson(req))));
    if (!action && method === "DELETE") return send(res, 200, await workflow.discard(actor, id));
    if (method === "POST" && action === "preview") return send(res, 200, await workflow.preview(actor, id));
    if (method === "POST" && action === "approve") return send(res, 200, await workflow.approve(actor, id, parse(ApproveInput, await readJson(req))));
    if (method === "POST" && action === "rebase") return send(res, 200, await workflow.rebase(actor, id));
    if (method === "POST" && action === "handoff") return send(res, 200, await workflow.handoff(actor, id));
  }
  throw new WorkflowError("not-found", `no endpoint ${method} ${path}`);
}

async function staticFile(res: ServerResponse, root: string, path: string): Promise<void> {
  const base = resolve(root);
  const wanted = resolve(base, `.${normalize(decodeURIComponent(path))}`);
  if (wanted !== base && !wanted.startsWith(`${base}${sep}`)) throw new HttpError(404, "not found");
  let file = wanted;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Client-side routes (no extension) get the app; a missing asset is a 404.
    if (extname(path)) throw new HttpError(404, "not found");
    file = join(base, "index.html");
  }
  const body = await readFile(file);
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" });
  res.end(body);
}

export function createHandler(options: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://loopback").pathname;
        screen(req);
        if (path === "/api" || path.startsWith("/api/")) return await api(req, res, path, options);
        if (!options.webRoot || (req.method !== "GET" && req.method !== "HEAD")) throw new HttpError(404, "not found");
        await staticFile(res, options.webRoot, path);
      } catch (error: unknown) {
        fail(res, error);
      }
    })();
  };
}

export interface RunningService {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function serveWorkflow(options: HandlerOptions & { readonly port: number }): Promise<RunningService> {
  const server = createServer(createHandler(options));
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { url: `http://127.0.0.1:${port}`, server, close: () => new Promise((done) => server.close(() => done())) };
}
