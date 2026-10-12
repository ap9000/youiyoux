import { configDefaults, defineConfig } from "vitest/config";
import { detectChanged, SITE_TEST } from "./packages/detect/test/gate.ts";

// The site tests launch Chromium: they run when detect changed, or when YOUI_DETECT_SITE says so (CI sets 1).
const site = detectChanged(import.meta.dirname);
if (!site) console.log(`${SITE_TEST} skipped: nothing in detect changed versus origin/main (YOUI_DETECT_SITE=1 runs it)`);

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(site ? [] : [SITE_TEST])],
    testTimeout: 30_000,
    pool: "threads",
  },
});
