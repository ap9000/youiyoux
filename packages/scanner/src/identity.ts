/**
 * What a check result is bound to: the scanner version, a digest of exactly the
 * definitions that decide findings, and both repositories' revisions. Two results
 * with the same identity and content digest are interchangeable; anything else
 * (an edited rule body, a token value, a dirty file) gives a different identity.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shortHash, stableStringify, type CheckIdentity } from "@youiyoux/core";
import type { ResolvedToken } from "@youiyoux/tokens";
import type { Project } from "./project.ts";

export const SCANNER_VERSION = "youi-scanner/0.1.0";

const run = promisify(execFile);

export interface GitState {
  readonly commit: string | null;
  readonly dirty: boolean;
}

/** HEAD and whether the working tree under `root` differs from it; null/false outside a git checkout. */
export async function gitState(root: string): Promise<GitState> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd: root }),
      run("git", ["status", "--porcelain", "--", "."], { cwd: root }),
    ]);
    return { commit: head.trim() || null, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: false };
  }
}

/**
 * Digest of everything that decides findings: the project config, the system config,
 * every contract and migration, every rule body and every resolved token value. It is
 * computed from the loaded content, so an in-memory change (a draft rule) changes it too.
 */
export function definitionsDigest(project: Project, tokens: readonly ResolvedToken[]): string {
  const { system } = project;
  return shortHash(
    stableStringify({
      scanner: SCANNER_VERSION,
      config: project.config,
      system: system.config,
      components: system.components.map((c) => ({ contract: c.contract, migrations: c.migrations })),
      rules: system.rules,
      tokens,
    }),
  );
}

export function checkIdentity(project: Project, definitions: string, design: GitState, consumer: GitState): CheckIdentity {
  return {
    tool: SCANNER_VERSION,
    system: { id: project.system.config.id, version: project.system.config.version },
    definitions,
    design: { commit: design.commit, dirty: design.dirty },
    project: { commit: consumer.commit, dirty: consumer.dirty },
  };
}

/** A short label for people: `demo@1.0.0 · defs 59c2e32d7916 · design 1a2b3c4 · project 5d6e7f8+dirty`. */
export function describeIdentity(identity: CheckIdentity): string {
  const rev = (state: GitState): string => (state.commit ? `${state.commit.slice(0, 7)}${state.dirty ? "+dirty" : ""}` : "no commit");
  return `${identity.system.id}@${identity.system.version} · defs ${identity.definitions} · design ${rev(identity.design)} · project ${rev(identity.project)}`;
}
