import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const tracked = (path: string): string[] | null => {
  try {
    return execFileSync("git", ["ls-files", path], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return null; // not a git checkout (an exported copy): nothing is tracked
  }
};

describe("this repository", () => {
  // A run's evidence (transcripts, screenshots) names real products' paths and findings; it stays with the run.
  test("holds no run evidence: evidence/ is ignored and nothing in it is tracked", () => {
    expect(tracked("evidence") ?? []).toEqual([]);
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n")).toContain("evidence/");
  });
});
