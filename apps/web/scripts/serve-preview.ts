/**
 * Serves the preview build (dist/) on $PORT: the start command of the preview deploy.
 *
 *   node scripts/build-preview.ts && PORT=8080 node scripts/serve-preview.ts
 */
import { join, resolve } from "node:path";
import { createPreviewServer, HEALTH_PATH } from "./preview/server.ts";

const DEFAULT_PORT = 8080;
const port = Number(process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a port number, not "${process.env.PORT}"`);

const server = createPreviewServer(join(resolve(import.meta.dirname, ".."), "dist"));
server.listen(port, () => process.stdout.write(`preview: serving dist/ on port ${port} (health: ${HEALTH_PATH})\n`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
