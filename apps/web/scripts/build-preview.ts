/**
 * The preview deploy's build: the hub on the committed demo snapshot, then the check that
 * nothing but that snapshot's design data made it into dist/.
 *
 *   node scripts/build-preview.ts
 *
 * YOUI_HUB_SNAPSHOT is dropped for the build, so a snapshot of a real system (`youi ui`
 * writes one to .hub/) can never be what a public preview URL serves.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { checkPreviewBuild } from "./preview/check.ts";

const APP = resolve(import.meta.dirname, "..");
const BIN = join(APP, "node_modules");
const STEPS: ReadonlyArray<readonly string[]> = [
  [join(BIN, "typescript/bin/tsc"), "-p", "tsconfig.json"],
  [join(BIN, "vite/bin/vite.js"), "build"],
];

function main(): number {
  const { YOUI_HUB_SNAPSHOT: _dropped, ...env } = process.env;
  for (const step of STEPS) {
    const run = spawnSync(process.execPath, step, { cwd: APP, env, stdio: "inherit" });
    if (run.error) throw run.error;
    if (run.status !== 0) return run.status ?? 1;
  }
  const problems = checkPreviewBuild(join(APP, "dist"), join(APP, "snapshot/public"));
  for (const problem of problems) process.stderr.write(`preview check: ${problem}\n`);
  if (problems.length > 0) return 1;
  process.stdout.write("preview check: dist/ serves only the committed demo snapshot\n");
  return 0;
}

process.exitCode = main();
