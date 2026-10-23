/**
 * The workspace hub's service: `youiyoux ui` in a workspace shows one product at a time and
 * switches between them. The hub's servers proxy /api here (as they do the rule editor's).
 *
 *   GET  /api/workspace          every product's status (youi.status/v1) and which one is shown
 *   POST /api/workspace/open     { index }: snapshot that product; the open hub then loads it
 *   POST /api/workspace/refresh  read every product's status again
 *
 * Only products the workspace lists can be opened, by their place in the list; never a path the
 * request names. Changes need this run's key (`x-youi-session`, from the link `youiyoux ui`
 * prints), so another page in the browser cannot switch the hub. It listens on 127.0.0.1 only.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { StatusReport } from "@youiyoux/core";

export interface WorkspaceHubOptions {
  /** The products' roots, in the workspace's order. */
  readonly roots: readonly string[];
  readonly status: () => Promise<StatusReport>;
  /** Snapshot one product for the open hub; 0 when it worked. */
  readonly open: (root: string) => Promise<number>;
  /** The product shown first. */
  readonly current: number;
}

export interface WorkspaceHub {
  readonly url: string;
  readonly key: string;
  close(): Promise<void>;
}

const KEY_HEADER = "x-youi-session";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 4096) throw new Error("request too large");
  }
  return text ? JSON.parse(text) : {};
}

export async function startWorkspaceHub(options: WorkspaceHubOptions): Promise<WorkspaceHub> {
  const key = randomBytes(18).toString("base64url");
  let report = await options.status();
  let current = options.current;
  let busy = false;
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/api/workspace") return send(res, 200, { report, current });
      if (req.method !== "POST" || (path !== "/api/workspace/open" && path !== "/api/workspace/refresh")) {
        return send(res, 404, { error: "Not in a workspace hub: Rules and Changes are read-only here; youiyoux ui --project <dir> opens the rule editor on one product" });
      }
      if (req.headers[KEY_HEADER] !== key) return send(res, 401, { error: "this tab does not carry this run's key" });
      if (busy) return send(res, 409, { error: "another product is opening; try again in a moment" });
      busy = true;
      try {
        if (path === "/api/workspace/refresh") {
          report = await options.status();
          return send(res, 200, { report, current });
        }
        const { index } = (await readBody(req)) as { index?: unknown };
        const entry = typeof index === "number" && Number.isInteger(index) ? report.projects[index] : undefined;
        if (entry === undefined || options.roots[index as number] === undefined) return send(res, 400, { error: `no product ${JSON.stringify(index)} in this workspace` });
        if ("error" in entry) return send(res, 400, { error: `${entry.root} cannot be opened: ${entry.error}`, problems: [entry.next] });
        const code = await options.open(options.roots[index as number]!);
        if (code !== 0) return send(res, 500, { error: `the snapshot of ${entry.root} failed (exit ${code}); the hub still shows the product it showed` });
        current = index as number;
        return send(res, 200, { report, current });
      } catch (error: unknown) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        busy = false;
      }
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    key,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
