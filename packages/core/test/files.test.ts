/**
 * The Node 20 stand-ins for path.matchesGlob and fs.glob agree with Node's own on the globs youi
 * uses; atomic writes give a file its permissions from the start when asked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { glob, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { globRegExp, matchesAny, walkGlob, writeFileAtomic } from "../src/files.ts";

const PATTERNS = ["**/*.{tsx,jsx,ts,js,mjs,astro,css}", "**/node_modules/**", "**/.git/**", "**/*.d.ts", "**/*.test.*", "package.json", "**/package.json", "components/ui/**", "**/*.config.*", "apps/*", "**/build/**", "src/**/*.tsx", "a/[bc].ts", "a/?.ts"];
const PATHS = ["a.tsx", "src/a.tsx", "src/x/y.css", "node_modules", "node_modules/", "node_modules/a/b.js", "x/node_modules/y.ts", ".git/HEAD", "a/b.d.ts", "a.test.tsx", "package.json", "apps/web/package.json", "components/ui/", "components/ui/button.tsx", "apps/web", "tailwind.config.ts", "src/build/a.js", ".hidden/a.tsx", "src/.hidden.tsx", "a/b.ts", "a/d.ts"];

test("globRegExp matches what path.matchesGlob matches", () => {
  for (const pattern of PATTERNS) for (const path of PATHS) expect([pattern, path, globRegExp(pattern).test(path)]).toEqual([pattern, path, matchesGlob(path, pattern)]);
});

const dir = mkdtempSync(join(tmpdir(), "youi-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("walkGlob finds the files fs.glob finds, never entering an excluded directory", async () => {
  for (const file of ["package.json", "src/app.tsx", "src/ui/button.tsx", "src/a.d.ts", "node_modules/x/index.js", "apps/web/package.json", "apps/web/src/page.tsx", ".next/x.tsx", "dist/y.js"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  const include = ["**/*.{tsx,ts}", "**/package.json"];
  const skip = ["**/node_modules/**", "**/dist/**", "**/*.d.ts"];
  const options = { cwd: dir, exclude: (p: string) => matchesAny(p, skip) };
  const native: string[] = [];
  for await (const path of glob(include, options)) if (!matchesAny(path, skip)) native.push(path);
  const walked: string[] = [];
  for await (const path of walkGlob(include, options)) walked.push(path);
  expect(walked.sort()).toEqual(native.sort());
  expect(walked).not.toContain("node_modules/x/index.js");
});

describe("writeFileAtomic", () => {
  test("with a mode, the file has it as written: renamed from a temporary file made with it, never narrowed after", async () => {
    const secret = join(dir, "writes", "secret.json");
    await writeFileAtomic(secret, "{}\n", { mode: 0o600 });
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    // Rewriting keeps it so, and leaves no temporary file behind.
    await writeFileAtomic(secret, '{"a":1}\n', { mode: 0o600 });
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    expect(await readFile(secret, "utf8")).toBe('{"a":1}\n');
    expect((await readdir(join(dir, "writes"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("without one, the usual permissions", async () => {
    const plain = join(dir, "writes", "plain.txt");
    await writeFileAtomic(plain, "x");
    expect((await stat(plain)).mode & 0o777).toBe(0o666 & ~process.umask());
  });
});
