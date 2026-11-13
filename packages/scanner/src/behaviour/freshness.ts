/**
 * What a behaviour result is made against (docs/plans/behaviour-rules.md, "Results and rule
 * execution"): the rule and its options, the youiyoux version, the probed origin, screens.json's
 * behaviour config with the route's screen path, the viewport, and the app's source fingerprint.
 * Computed now, both when a probe stores a result and when `youiyoux check` reads one back; a stored
 * result is fresh only when every part it carries equals what is computed now. Nothing in the
 * stored file can say it is fresh.
 */
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BehaviourConsent, findFiles, sha256, stableStringify, type Freshness, type RuleSpec } from "@youiyoux/core";
import { langOf } from "../parse.ts";
import type { Project } from "../project.ts";
import type { ScreensSpec } from "../screens/capture.ts";
import { behaviourConsent } from "./guards.ts";

/** Lockfiles, looked for from the project's root up to its repository's top. */
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"];

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** The lockfile nearest `root`, from it upward to its repository's top (the folder holding .git); null when there is none. */
async function lockfileOf(root: string): Promise<string | null> {
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of LOCKFILES) if (await exists(join(dir, name))) return join(dir, name);
    if ((await exists(join(dir, ".git"))) || dirname(dir) === dir) return null;
  }
}

/**
 * The app's source fingerprint: a digest of the content of every file the scan covers (the
 * scanner's own file list, `findFiles` with the project's include and exclude, kept to the
 * languages it parses: TypeScript, JavaScript and CSS), plus package.json and the lockfile. Read
 * from disk as it is now; a file that can't be read is marked, never skipped.
 */
export async function appFingerprint(project: Pick<Project, "root" | "config">): Promise<string> {
  const files = (await findFiles(project.root, project.config.include, project.config.exclude)).filter((f) => langOf(f) !== null).sort();
  const lockfile = await lockfileOf(project.root);
  const all = [...files.map((f) => ({ name: f, path: join(project.root, f) })), { name: "(package.json)", path: join(project.root, "package.json") }, { name: "(lockfile)", path: lockfile }];
  const entries: string[] = [];
  // A few at a time: a large project's files aren't all opened at once.
  for (let i = 0; i < all.length; i += 64) {
    entries.push(
      ...(await Promise.all(
        all.slice(i, i + 64).map(async ({ name, path }) => {
          if (path === null) return `${name}:none`;
          try {
            return `${name}:${sha256(await readFile(path))}`;
          } catch (error: unknown) {
            return `${name}:${(error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable"}`;
          }
        }),
      )),
    );
  }
  return sha256(entries.join("\n")).slice(0, 32);
}

/** A rule's digest: its whole definition (statement, severity, check and options), as loaded. */
export const ruleDigest = (rule: RuleSpec): string => sha256(stableStringify(rule)).slice(0, 32);

/** The digest of screens.json's behaviour config with the route and the path its screen opens. */
export function behaviourConfigDigest(spec: Pick<ScreensSpec, "behaviour" | "screens">, route: string): string {
  const screen = spec.screens.find((s) => s.route === route);
  return sha256(stableStringify({ behaviour: spec.behaviour ?? null, route, path: screen?.path ?? null })).slice(0, 32);
}

/**
 * The routes behaviour rules are held to (the plan's denominator): `behaviour.routes` when set, else
 * every route screens.json lists. `unknown`: routes `behaviour.routes` names that screens.json
 * doesn't list (never probed, so never fresh).
 */
export function behaviourRoutes(spec: Pick<ScreensSpec, "behaviour" | "screens">): { readonly routes: readonly string[]; readonly unknown: readonly string[] } {
  const consent = BehaviourConsent.safeParse(spec.behaviour ?? {});
  const listed = spec.screens.map((s) => s.route);
  const wanted = consent.success && consent.data.routes ? [...new Set(consent.data.routes)] : [...new Set(listed)];
  return { routes: wanted, unknown: wanted.filter((r) => !listed.includes(r)) };
}

/** What a result made now, on `route`, for a rule with `ruleDigest`, would carry. `origin` is null without consent now. */
export interface FreshnessNow {
  readonly tool: string;
  readonly origin: string | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly app: string;
}

export function freshnessNow(spec: Pick<ScreensSpec, "base" | "behaviour" | "viewport">, app: string, tool: string): FreshnessNow {
  const consent = behaviourConsent(spec);
  return { tool, origin: consent.ok ? consent.origin : null, viewport: { width: spec.viewport.width, height: spec.viewport.height }, app };
}

/**
 * Why a stored result (its freshness key, route and viewport) isn't fresh now, in words; empty when
 * every part matches.
 */
export function staleParts(stored: { readonly freshness: Freshness; readonly viewport: { readonly width: number; readonly height: number } }, now: FreshnessNow & { readonly rule: string; readonly config: string }): string[] {
  const parts: string[] = [];
  if (stored.freshness.app !== now.app) parts.push("the code changed");
  if (stored.freshness.rule !== now.rule) parts.push("the rule changed");
  if (stored.freshness.tool !== now.tool) parts.push("youiyoux changed");
  if (stored.freshness.origin !== now.origin) parts.push(now.origin === null ? "probing isn't switched on now" : "the app's address changed");
  if (stored.freshness.config !== now.config) parts.push("screens.json's behaviour settings or the screen's path changed");
  if (stored.viewport.width !== now.viewport.width || stored.viewport.height !== now.viewport.height) parts.push("the viewport changed");
  return parts;
}
