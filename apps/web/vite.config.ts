import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { discoverPreviewMiddleware } from "./scripts/discover-preview-server.ts";
import { discoverThumbsMiddleware } from "./scripts/discover-thumbs.ts";
import { allowedHosts, queryMiddleware } from "./scripts/query-server.ts";
import { tryIndexDeny, tryMiddleware } from "./scripts/try-server.ts";

const root = import.meta.dirname;
/**
 * The design system the hub shows: a snapshot directory written by scripts/snapshot.ts.
 * The committed default is the demo system; `youiyoux ui` points this at apps/web/.hub instead.
 */
const snapshot = resolve(root, process.env.YOUI_HUB_SNAPSHOT ?? "snapshot");
const snapshotPublic = join(snapshot, "public");
const TYPES: Record<string, string> = { ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".css": "text/css" };

/** Serves the snapshot's public files (data/, previews/) beside public/, and copies them into the build. */
function snapshotFiles(): Plugin {
  let outDir = "dist";
  return {
    name: "youiyoux-snapshot",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      // `youiyoux ui --watch` rewrites the manifest (atomically) after every re-scan: tell the open hub to load it.
      const manifest = join(snapshotPublic, "data/manifest.json");
      server.watcher.add(manifest);
      const announce = (file: string): void => {
        if (file === manifest) server.ws.send({ type: "custom", event: "youi:snapshot" });
      };
      server.watcher.on("add", announce);
      server.watcher.on("change", announce);
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

/**
 * Try it (scripts/try-server.ts): bundles one look for the browser on request, on the dev server
 * and on `vite preview`. A static host has no such endpoint; the hub then keeps the static specimen.
 */
function tryIt(): Plugin {
  return {
    name: "youiyoux-try",
    configureServer(server) {
      server.middlewares.use(tryMiddleware(snapshot, server.config.base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(tryMiddleware(snapshot, server.config.base));
    },
  };
}

/**
 * Paged queries over the local index (scripts/query-server.ts), beside Try it on the dev and
 * preview servers; localhost only. A static host has no such endpoint and the hub never needs it
 * to paint: its pages read the snapshot's JSON chunks.
 */
function query(): Plugin {
  return {
    name: "youiyoux-query",
    configureServer(server) {
      server.middlewares.use(queryMiddleware({}, server.config.base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(queryMiddleware({}, server.config.base));
    },
  };
}

/**
 * Discover previews (scripts/discover-preview-server.ts): one opened candidate fetched, bundled and
 * drawn in the project's theme, on request; localhost only. A static host has none: Discover then
 * lists candidates from the snapshot's JSON without drawing them.
 */
function discoverPreview(): Plugin {
  return {
    name: "youiyoux-discover-preview",
    configureServer(server) {
      server.middlewares.use(discoverPreviewMiddleware(snapshot, server.config.base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(discoverPreviewMiddleware(snapshot, server.config.base));
    },
  };
}

/**
 * Discover thumbnails (scripts/discover-thumbs.ts): the pictures `youiyoux discover previews`
 * took, for the gallery; localhost only. A static host has none, and Discover lists without them.
 */
function discoverThumbs(): Plugin {
  return {
    name: "youiyoux-discover-thumbs",
    configureServer(server) {
      server.middlewares.use(discoverThumbsMiddleware(snapshot, server.config.base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(discoverThumbsMiddleware(snapshot, server.config.base));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), snapshotFiles(), tryIt(), query(), discoverPreview(), discoverThumbs()],
  resolve: { alias: { "@snapshot": snapshot } },
  // A system's demos may use any of the hub's UI packages. Pre-bundled up front, so the preview
  // frame's first visit to such a demo never makes the dev server re-optimize and reload mid-render.
  optimizeDeps: { entries: ["index.html", "preview.html"], include: ["@radix-ui/react-label", "@radix-ui/react-separator", "@radix-ui/react-slot", "@radix-ui/react-switch", "@radix-ui/react-tabs", "class-variance-authority", "clsx", "tailwind-merge", "lucide-react"] },
  // The rule editor's live API: `youiyoux ui --project` starts the service and sets YOUI_API to it.
  // try.json is for the Try it handler only, never served (scripts/try-server.ts).
  // Vite answers this machine's names only, plus those given to `youiyoux ui --allow-host`.
  server: { allowedHosts: allowedHosts(), proxy: { "/api": { target: process.env.YOUI_API ?? "http://127.0.0.1:4417", changeOrigin: true } }, fs: { deny: tryIndexDeny(snapshot) } },
  preview: { allowedHosts: allowedHosts() },
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
