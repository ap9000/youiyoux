/**
 * The rule editor that `youi ui --project` runs beside the hub: the workflow service
 * (drafts, impact preview, approval, review branch) on an ephemeral loopback port, which
 * the hub's dev server proxies at /api. Writes need this run's session key, which travels
 * only in the link printed to the terminal (as a URL fragment, which no request carries).
 */
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { shortHash } from "@youiyoux/core";
import { loadProject } from "@youiyoux/scanner";
import type { WorkflowInfo } from "@youiyoux/workflow";

export interface RuleEditorOptions {
  readonly project: string;
  readonly config?: string;
  readonly design?: string;
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

export async function startRuleEditor(options: RuleEditorOptions): Promise<RuleEditor> {
  const { FileStore, RuleWorkflow, serveWorkflow } = await import("@youiyoux/workflow");
  const projectRoot = resolve(options.project);
  const load = { ...(options.config ? { configPath: resolve(options.config) } : {}), ...(options.design ? { designRoot: resolve(options.design) } : {}) };
  const project = await loadProject(projectRoot, load);
  const stateDir = resolve(options.state ?? join(homedir(), ".youi", "workflow", shortHash(`${project.repo.root}\0${project.root}`)));
  const workflow = new RuleWorkflow({ projectRoot, store: new FileStore(stateDir), ...load });
  const actor = { kind: "person" as const, name: userInfo().username };
  // Fails here, before the hub starts, when the design repo is not a git checkout.
  const info = await workflow.info(actor);
  const sessionKey = randomBytes(24).toString("base64url");
  const service = await serveWorkflow({ workflow, actor, sessionKey, port: 0 });
  return { url: service.url, sessionKey, stateDir, info, close: () => service.close() };
}
