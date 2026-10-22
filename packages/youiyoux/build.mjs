// Bundle the youi CLI into dist/ as Node 20 ESM: youiyoux.js (report by default), youi.js (the full
// CLI) and the Tailwind worker specimens start. Pure-JS dependencies are bundled; native and
// file-loading ones (ast-grep, TypeScript, esbuild, playwright-core, axe-core) stay dependencies,
// and the Postgres drivers stay out (the local index is SQLite; DATABASE_URL needs them installed).
// The browser is never bundled: playwright-core downloads it on request.
// The hub goes in built (dist/hub, by apps/web's Vite), with its server, snapshot and Discover
// capture scripts bundled beside the CLI, the preview frame's kit (dist/hub/kit) and the demo
// system's snapshot with its frame (dist/hub-demo), so `youiyoux ui` needs no checkout.
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildFrame, buildFrameKit } from "../../apps/web/scripts/frame.ts";

const here = import.meta.dirname;
const dist = join(here, "dist");
const repo = join(here, "../..");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const external = [...Object.keys(pkg.dependencies), "pg", "pg-native", "@electric-sql/pglite"];
const web = join(repo, "apps/web");

/** dist layout: tool.ts → src/tool.js, and the worker's URL names the built worker. */
const layout = {
  name: "youiyoux-layout",
  setup(b) {
    b.onResolve({ filter: /\/tool\.ts$/ }, (args) => (args.importer.includes(join("packages", "cli", "src")) ? { path: join(here, "src/tool.js") } : undefined));
    b.onResolve({ filter: /\/packages\.ts$/ }, (args) => (args.importer.includes(join("apps", "web", "scripts")) ? { path: join(here, "src/hub-packages.js") } : undefined));
    b.onLoad({ filter: /specimens[\\/]css\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!source.includes('"./tailwind-worker.ts"')) throw new Error("css.ts no longer starts ./tailwind-worker.ts: update build.mjs");
      return { contents: source.replace('"./tailwind-worker.ts"', '"./tailwind-worker.js"'), loader: "ts" };
    });
  },
};

rmSync(dist, { recursive: true, force: true });
const result = await build({
  entryPoints: { youiyoux: join(here, "src/youiyoux.js"), youi: join(here, "src/youi.js"), "tailwind-worker": join(repo, "packages/scanner/src/specimens/tailwind-worker.ts"), "hub-server": join(here, "src/hub-server.js"), "hub-snapshot": join(here, "src/hub-snapshot.js"), "hub-previews": join(here, "src/hub-previews.js") },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external,
  plugins: [layout],
  chunkNames: "chunks/[name]-[hash]",
  // Bundled CommonJS (yaml's, the MCP SDK's dependencies) may call require.
  // import.meta.dirname is Node 20.11+: each output file works out its own.
  banner: { js: 'import { createRequire as __youiRequire } from "node:module"; import { dirname as __youiDir } from "node:path"; import { fileURLToPath as __youiPath } from "node:url"; const require = __youiRequire(import.meta.url); const __youiDirname = __youiDir(__youiPath(import.meta.url));' },
  // A script's own `if (import.meta.main)` never runs in the bundle: its entry (src/hub-*.js) calls main.
  define: { "import.meta.dirname": "__youiDirname", "import.meta.main": "false" },
  metafile: true,
  legalComments: "linked",
  logLevel: "warning",
});
// What went in, for the bundle test (never packed).
writeFileSync(join(here, "build-meta.json"), JSON.stringify(result.metafile));
// TOOL_ROOT is dist: the schemas youiyoux init and youiyoux schema read, and the CLI path hooks and MCP configs run.
cpSync(join(repo, "schema"), join(dist, "schema"), { recursive: true });
const bin = join(dist, "packages/cli/bin/youi.js");
mkdirSync(dirname(bin), { recursive: true });
writeFileSync(bin, '#!/usr/bin/env node\nimport "../../../youi.js";\n');

// The hub, built on the committed demo snapshot (never a snapshot of a real system); its data
// comes from the snapshot the server is given, so the build's own copy is dropped.
const hub = join(dist, "hub");
const { YOUI_HUB_SNAPSHOT: _dropped, ...env } = process.env;
const vite = spawnSync(process.execPath, [join(web, "node_modules/vite/bin/vite.js"), "build", "--outDir", hub, "--emptyOutDir", "--logLevel", "warn"], { cwd: web, env, stdio: "inherit" });
if (vite.status !== 0) throw new Error("the hub's build failed");
for (const path of ["data", "previews", "preview.html"]) rmSync(join(hub, path), { recursive: true, force: true });
await buildFrameKit(join(hub, "kit"), web);
const demo = join(dist, "hub-demo");
for (const part of ["public", "preview"]) cpSync(join(web, "snapshot", part), join(demo, part), { recursive: true });
const frame = await buildFrame(demo, join(hub, "kit"), join(demo, "frame"));
if (Object.keys(frame.errors).length > 0) throw new Error(`the demo's preview frame did not build: ${JSON.stringify(frame.errors)}`);
console.log(`youiyoux: built ${Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js")).length} files in dist/`);
