/**
 * The rule editor that `youiyoux ui --project` runs beside the hub: the workflow service
 * (drafts, impact preview, approval, review branch) on an ephemeral loopback port, which
 * the hub's dev server proxies at /api. Writes need this run's session key, which travels
 * only in the link printed to the terminal (as a URL fragment, which no request carries).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { shortHash, type LibraryEntry } from "@youiyoux/core";
import { loadProject } from "@youiyoux/scanner";
import type { WorkflowInfo } from "@youiyoux/workflow";

interface RuleEditorOptions {
  readonly project: string;
  readonly config?: string;
  readonly design?: string;
  /** The product root, when the config names another (or none). */
  readonly root?: string;
  /** Where drafts live; default ~/.youi/workflow/<design repo + project>. */
  readonly state?: string;
}

export interface RuleEditor {
  /** The service's own address, for the hub's /api proxy. */
  readonly url: string;
  readonly sessionKey: string;
  readonly stateDir: string;
  readonly info: WorkflowInfo;
  close(): Promise<void>;
}

/** What swapping a Library item in for an inventory family touches, from the local index `youiyoux inventory` records into; null when it cannot say. */
async function swapImpact(candidate: string, family: string): Promise<{ looks: number; files: number; routes: number; listed: boolean } | null> {
  try {
    const { discoverIndexPath, sharedStore } = await import("@youiyoux/discover");
    const path = discoverIndexPath();
    if (!process.env.DATABASE_URL && !existsSync(path)) return null;
    const impact = await (await sharedStore(path, process.env, { readOnly: true })).swapImpact(candidate, family);
    return impact && !("choices" in impact) ? { looks: impact.looks, files: impact.files.length, routes: impact.routes.length, listed: impact.listed } : null;
  } catch {
    return null;
  }
}

/** The licence the local Discover index lists for a Library id, or null when it lists none (or there is no index). */
async function libraryLicence(id: string): Promise<LibraryEntry["license"] | null> {
  try {
    const { discoverCacheDir, findListing } = await import("@youiyoux/discover");
    const { entry } = await findListing(discoverCacheDir(undefined, process.env), id);
    return entry.id === id ? entry.license : null;
  } catch {
    return null;
  }
}

export async function startRuleEditor(options: RuleEditorOptions): Promise<RuleEditor> {
  const { FileStore, RuleWorkflow, serveWorkflow } = await import("@youiyoux/workflow");
  const projectRoot = resolve(options.project);
  const load = { ...(options.config ? { configPath: resolve(options.config) } : {}), ...(options.design ? { designRoot: resolve(options.design) } : {}), ...(options.root ? { productRoot: resolve(options.root) } : {}) };
  const project = await loadProject(projectRoot, load);
  const stateDir = resolve(options.state ?? join(homedir(), ".youi", "workflow", shortHash(`${project.repo.root}\0${project.root}`)));
  const workflow = new RuleWorkflow({ projectRoot, store: new FileStore(stateDir), swapImpact, libraryLicence, ...load });
  const actor = { kind: "person" as const, name: userInfo().username };
  // Fails here, before the hub starts, when the design repo is not a git checkout.
  const info = await workflow.info(actor);
  const sessionKey = randomBytes(24).toString("base64url");
  const service = await serveWorkflow({ workflow, actor, sessionKey, port: 0 });
  return { url: service.url, sessionKey, stateDir, info, close: () => service.close() };
}
