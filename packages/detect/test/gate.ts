/**
 * Whether `pnpm test` runs the site tests (site.test.ts launches Chromium): YOUI_DETECT_SITE
 * decides when set; otherwise they run when anything in detect changed against origin/main,
 * committed, uncommitted or untracked, and whenever git cannot tell.
 */
import { execFileSync } from "node:child_process";

export const SITE_TEST = "packages/detect/test/site.test.ts";
export const DETECT_PATHS = /^packages\/detect\/|^packages\/core\/src\/detect/;

/** The decision on its own: `changed` is null when git failed. */
export function runSiteTests(flag: string | undefined, changed: readonly string[] | null): boolean {
  const value = flag?.trim().toLowerCase();
  if (value) return !["0", "false", "no", "off"].includes(value);
  return changed === null || changed.some((path) => DETECT_PATHS.test(path));
}

/** Paths changed versus the merge-base with origin/main, plus untracked files; null if git fails. */
export function changedFiles(cwd: string): string[] | null {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const base = git("merge-base", "HEAD", "origin/main").trim();
    const lines = `${git("diff", "--name-only", base)}\n${git("ls-files", "-o", "--exclude-standard", "--full-name")}`;
    return lines.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

export function detectChanged(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.YOUI_DETECT_SITE;
  return runSiteTests(flag, flag?.trim() ? [] : changedFiles(cwd));
}
