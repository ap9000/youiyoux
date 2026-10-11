import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;
/**
 * The design system the hub shows: a snapshot directory written by scripts/snapshot.ts.
 * The committed default is the demo system; `youi ui` points this at apps/web/.hub instead.
 */
const snapshot = resolve(root, process.env.YOUI_HUB_SNAPSHOT ?? "snapshot");
const snapshotPublic = join(snapshot, "public");
const TYPES: Record<string, string> = { ".json": "application/json", ".webp": "image/webp" };

/** Serves the snapshot's public files (data/, previews/) beside public/, and copies them into the build. */
function snapshotFiles(): Plugin {
  let outDir = "dist";
  return {
    name: "youiyoux-snapshot",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(server.config.base, "/"));
        const file = join(snapshotPublic, path);
        if (!file.startsWith(`${snapshotPublic}/`) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (existsSync(snapshotPublic)) cpSync(snapshotPublic, outDir, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), snapshotFiles()],
  resolve: { alias: { "@snapshot": snapshot } },
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    // Two documents: the hub, and the isolated preview frame that renders a system's real components.
    rolldownOptions: { input: { main: resolve(root, "index.html"), preview: resolve(root, "preview.html") } },
  },
  worker: { format: "es" },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
