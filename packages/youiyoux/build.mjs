// Bundle the youi CLI into dist/ as Node 20 ESM: youiyoux.js (report by default), youi.js (the full
// CLI) and the Tailwind worker specimens start. Pure-JS dependencies are bundled; native and
// file-loading ones (ast-grep, TypeScript, esbuild, playwright-core, axe-core) stay dependencies,
// and the Postgres drivers stay out (the local index is SQLite; DATABASE_URL needs them installed).
// The browser is never bundled: playwright-core downloads it on request.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const repo = join(here, "../..");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const external = [...Object.keys(pkg.dependencies), "pg", "pg-native", "@electric-sql/pglite"];

/** dist layout: tool.ts → src/tool.js, and the worker's URL names the built worker. */
const layout = {
  name: "youiyoux-layout",
  setup(b) {
    b.onResolve({ filter: /\/tool\.ts$/ }, (args) => (args.importer.includes(join("packages", "cli", "src")) ? { path: join(here, "src/tool.js") } : undefined));
    b.onLoad({ filter: /specimens[\\/]css\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!source.includes('"./tailwind-worker.ts"')) throw new Error("css.ts no longer starts ./tailwind-worker.ts: update build.mjs");
      return { contents: source.replace('"./tailwind-worker.ts"', '"./tailwind-worker.js"'), loader: "ts" };
    });
  },
};

rmSync(dist, { recursive: true, force: true });
const result = await build({
  entryPoints: { youiyoux: join(here, "src/youiyoux.js"), youi: join(here, "src/youi.js"), "tailwind-worker": join(repo, "packages/scanner/src/specimens/tailwind-worker.ts") },
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
  banner: { js: 'import { createRequire as __youiRequire } from "node:module"; const require = __youiRequire(import.meta.url);' },
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
console.log(`youiyoux: built ${Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js")).length} files in dist/`);
