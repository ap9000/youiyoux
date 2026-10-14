import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { guardProblems, manifests, nextVersion, parseArgs, setVersion, trailersFrom, type RepoState } from "../release.ts";

const root = join(import.meta.dirname, "../..");
const clean: RepoState = { branch: "main", status: "", ahead: 0, behind: 0, tagExists: false };

describe("pnpm release", () => {
  test("bumps patch, minor and major; takes an explicit greater version", () => {
    expect(nextVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.1", "0.3.0")).toBe("0.3.0");
    expect(nextVersion("0.1.1", "v1.0.0")).toBe("1.0.0");
  });

  test("refuses a version that is not greater, or not a version", () => {
    expect(() => nextVersion("0.2.0", "0.2.0")).toThrow(/not greater/);
    expect(() => nextVersion("0.2.0", "0.1.9")).toThrow(/not greater/);
    expect(() => nextVersion("1.0.0", "0.9.9")).toThrow(/not greater/);
    expect(() => nextVersion("0.2.0", "1.0")).toThrow(/is not patch, minor, major/);
    expect(() => nextVersion("0.2.0", "prerelease")).toThrow(/is not patch, minor, major/);
  });

  test("starts only from a clean main that matches origin/main, with a new tag", () => {
    expect(guardProblems(clean, "v1.0.0")).toEqual([]);
    expect(guardProblems({ ...clean, branch: "feature" }, "v1.0.0")).toEqual(["on branch feature, not main"]);
    expect(guardProblems({ ...clean, status: " M README.md\n" }, "v1.0.0")).toEqual(["the working tree has uncommitted changes"]);
    expect(guardProblems({ ...clean, behind: 2 }, "v1.0.0")[0]).toMatch(/2 commit\(s\) behind origin\/main/);
    expect(guardProblems({ ...clean, ahead: 1 }, "v1.0.0")[0]).toMatch(/1 commit\(s\) ahead of origin\/main/);
    expect(guardProblems({ ...clean, tagExists: true }, "v1.0.0")).toEqual(["the tag v1.0.0 already exists"]);
    expect(guardProblems({ branch: "x", status: "?? a", ahead: 1, behind: 1, tagExists: true }, "v1.0.0")).toHaveLength(5);
  });

  test("adds commit trailers only when given, and only well-formed ones", () => {
    expect(trailersFrom([], undefined)).toEqual([]);
    expect(trailersFrom(["Co-Authored-By: A <a@example.com>"], "Claude-Session: https://example.com/s\n")).toEqual(["Co-Authored-By: A <a@example.com>", "Claude-Session: https://example.com/s"]);
    expect(() => trailersFrom(["not a trailer"], undefined)).toThrow(/is not a trailer/);
  });

  test("parses the bump and its flags", () => {
    expect(parseArgs(["patch"])).toEqual({ bump: "patch", yes: false, dryRun: false, trailers: [] });
    expect(parseArgs(["1.2.3", "--dry-run", "--yes", "--trailer", "A: b", "--trailer=C: d"])).toEqual({ bump: "1.2.3", yes: true, dryRun: true, trailers: ["A: b", "C: d"] });
    expect(() => parseArgs([])).toThrow(/usage: pnpm release/);
    expect(() => parseArgs(["patch", "--force"])).toThrow(/unknown option --force/);
    expect(() => parseArgs(["patch", "minor"])).toThrow(/unexpected argument minor/);
  });

  test("sets the version in every workspace manifest, keeping each file's formatting", () => {
    const files = manifests(root);
    expect(files).toContain("package.json");
    expect(files).toContain("packages/youiyoux/package.json");
    expect(files).toContain("apps/web/package.json");
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      const next = setVersion(text, "9.9.9");
      expect(JSON.parse(next).version).toBe("9.9.9");
      expect(next.split("\n").filter((line, i) => line !== text.split("\n")[i])).toHaveLength(1);
    }
    // The workspace keeps one version.
    expect(new Set(files.map((f) => JSON.parse(readFileSync(join(root, f), "utf8")).version)).size).toBe(1);
  });
});
