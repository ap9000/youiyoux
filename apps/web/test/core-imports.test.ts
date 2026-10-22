/** The hub runs in a browser: from @youiyoux/core's main entry, which reaches node:fs and node:path, it may import types only. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SRC = join(import.meta.dirname, "../src");

test("hub code takes only types from @youiyoux/core; values come from its browser-safe entries", () => {
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file));
  const valueImports = files.flatMap((file) => [...readFileSync(join(SRC, file), "utf8").matchAll(/^import\s+(?!type\b)[^;]*?from\s+"@youiyoux\/core";/gm)].map((m) => `${file}: ${m[0]}`));
  expect(valueImports).toEqual([]);
});
