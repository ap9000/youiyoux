/** A local server for the fixture pages, so site tests never touch the network. */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize } from "node:path";

export const SITES = join(import.meta.dirname, "fixtures/sites");

export async function serveFixtures(dir = SITES): Promise<{ url: (page: string) => string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    readFile(join(dir, path)).then(
      (body) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
      },
      () => {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      },
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: (page) => `http://127.0.0.1:${port}/${page}`, close: () => new Promise((done) => server.close(() => done())) };
}
