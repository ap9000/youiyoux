/** Packages a preview needs: plain npm names only, fetched once into the cache with install scripts off, one install at a time. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fetchPreviewPackages, isPackageName, MAX_PREVIEW_PACKAGES, offRegistry, packageSpec, PREVIEW_PACKAGES_DIR, type NpmRunner } from "../src/index.ts";

let cache: string;
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "discover-preview-packages-"));
});
afterAll(async () => {
  await rm(cache, { recursive: true, force: true });
});

const REGISTRY = "https://registry.npmjs.org";
/** A resolved tree (package-lock.json v3) of these packages, each from the registry unless `from` names another source. */
function lockOf(names: readonly string[], from: Record<string, string> = {}): string {
  const packages: Record<string, { resolved?: string; link?: boolean }> = { "": {} };
  for (const name of names) packages[`node_modules/${name}`] = { resolved: from[name] ?? `${REGISTRY}/${name}/-/${name.split("/").at(-1)}-1.0.0.tgz` };
  return JSON.stringify({ lockfileVersion: 3, packages });
}

/** An npm that records each run and answers as told (a --package-lock-only run writes `lock`); never the network. */
function fakeNpm(answer: { code?: number; stderr?: string; delayMs?: number; fail?: NodeJS.ErrnoException; lock?: (args: readonly string[]) => string } = {}) {
  const runs: Array<{ args: readonly string[]; cwd: string }> = [];
  let inFlight = 0;
  let most = 0;
  const run: NpmRunner = async (args, cwd) => {
    runs.push({ args, cwd });
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((done) => setTimeout(done, answer.delayMs ?? 0));
    inFlight--;
    if (answer.fail) throw answer.fail;
    if (args.includes("--package-lock-only") && answer.code === undefined) {
      const names = args.filter((x) => !x.startsWith("-") && x !== "install").map((x) => x.replace(/(.)@.*$/, "$1"));
      await writeFile(join(cwd, "package-lock.json"), (answer.lock ?? (() => lockOf(names)))(args));
      // As npm does, the requested packages are saved to package.json too.
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      await writeFile(join(cwd, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, ...Object.fromEntries(names.map((n) => [n, "1.0.0"])) } }));
    }
    return { code: answer.code ?? 0, stderr: answer.stderr ?? "" };
  };
  return { run, runs, most: () => most };
}

test("only plain npm names, never a Node built-in's; a declared plain range is kept, anything else falls back to the name", () => {
  for (const name of ["motion", "@base-ui/react", "date-fns", "react-icons"]) expect(isPackageName(name), name).toBe(true);
  for (const name of ["fs", "child_process", "node:fs", "../evil", "/etc/passwd", "file:../x", "git+ssh://x/y.git", "https://evil.test/x.tgz", "-rf", "Motion", "@scope", "a b", ""]) expect(isPackageName(name), name).toBe(false);
  expect(packageSpec("motion", ["motion@^12.0.0", "clsx"])).toBe("motion@^12.0.0");
  expect(packageSpec("@base-ui/react", ["@base-ui/react@1.0.0-beta.2"])).toBe("@base-ui/react@1.0.0-beta.2");
  for (const declared of ["motion@file:../motion", "motion@github:evil/motion", "motion@https://evil.test/m.tgz", "motion@../m"]) expect(packageSpec("motion", [declared]), declared).toBe("motion");
  expect(packageSpec("fs", ["fs@1"])).toBeNull();
});

test("fetched into the cache's own folder with install scripts off and peers left to the project, the folder made once", async () => {
  const npm = fakeNpm();
  const result = await fetchPreviewPackages(cache, ["motion", "@base-ui/react", "motion"], { declared: ["motion@^12.0.0"], run: npm.run });
  const store = join(cache, PREVIEW_PACKAGES_DIR);
  expect(result).toEqual({ store, fetched: ["motion@^12.0.0", "@base-ui/react"] });
  const flags = ["--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--save-exact", "--loglevel=error"];
  // The tree resolved first, nothing downloaded; then the install.
  expect(npm.runs).toEqual([
    { cwd: store, args: ["install", "--package-lock-only", ...flags, "motion@^12.0.0", "@base-ui/react"] },
    { cwd: store, args: ["install", ...flags, "motion@^12.0.0", "@base-ui/react"] },
  ]);
  expect(JSON.parse(await readFile(join(store, "package.json"), "utf8"))).toMatchObject({ name: "youiyoux-preview-packages", private: true });
});

test("a refused name, too many packages, a failing npm or no npm at all: a sentence, and nothing run for a refusal", async () => {
  const npm = fakeNpm();
  await expect(fetchPreviewPackages(cache, ["motion", "child_process"], { run: npm.run })).rejects.toThrow(/refused to fetch "child_process": not a plain npm package name/);
  const many = Array.from({ length: MAX_PREVIEW_PACKAGES + 1 }, (_, i) => `pkg-${i}`);
  await expect(fetchPreviewPackages(cache, many, { run: npm.run })).rejects.toThrow(/a preview fetches at most 8/);
  expect(npm.runs).toEqual([]);
  const failing = fakeNpm({ code: 1, stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@repo%2fshadcn-ui - Not found\nnpm error A complete log of this run can be found in: /x.log\n" });
  await expect(fetchPreviewPackages(cache, ["@repo/shadcn-ui"], { run: failing.run })).rejects.toThrow("npm could not fetch @repo/shadcn-ui (404 Not Found - GET https://registry.npmjs.org/@repo%2fshadcn-ui - Not found)");
  const missing = fakeNpm({ fail: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) });
  await expect(fetchPreviewPackages(cache, ["motion"], { run: missing.run })).rejects.toThrow(/npm is not installed on this machine/);
});

test("a tree with anything not from the registry is refused before anything is downloaded, and the folder is left as it was", async () => {
  const store = join(cache, PREVIEW_PACKAGES_DIR);
  const before = await readFile(join(store, "package.json"), "utf8");
  for (const source of ["git+ssh://git@github.com/evil/payload.git#abc", "file:../payload", "https://evil.example/payload-1.0.0.tgz"]) {
    const npm = fakeNpm({ lock: () => lockOf(["fancy-text", "payload"], { payload: source }) });
    await expect(fetchPreviewPackages(cache, ["fancy-text"], { run: npm.run }), source).rejects.toThrow(/refused to fetch fancy-text: a package it depends on does not come from the npm registry: payload/);
    expect(npm.runs.map((r) => r.args.includes("--package-lock-only"))).toEqual([true]);
    expect(await readFile(join(store, "package.json"), "utf8")).toBe(before);
  }
  expect(offRegistry(JSON.parse(lockOf(["motion", "@base-ui/react"])), ["motion"])).toEqual([]);
  expect(offRegistry({ packages: { "": {}, "node_modules/motion": { resolved: `${REGISTRY}/motion/-/motion-1.0.0.tgz` }, "node_modules/local": { link: true } } }, ["motion"])).toEqual(["local (a link)"]);
});

test("one install at a time in the folder, however many previews ask", async () => {
  const npm = fakeNpm({ delayMs: 30 });
  await Promise.all([fetchPreviewPackages(cache, ["motion"], { run: npm.run }), fetchPreviewPackages(cache, ["date-fns"], { run: npm.run }), fetchPreviewPackages(cache, ["jotai"], { run: npm.run })]);
  expect(npm.runs).toHaveLength(6);
  expect(npm.most()).toBe(1);
});
