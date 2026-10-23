/**
 * `youiyoux status`: where a product stands with its design system, in a few lines, and the one
 * thing to do next. In a workspace (youi.workspace.json, or a repo holding several products), one
 * block per product. It writes nothing: what a sync would change comes from a dry run, offline
 * (a git source at the commit the lockfile records), and the check is the full check, against
 * the baseline when there is one.
 */
import { realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { findFiles, findUp, readDefinition, readTextOrNull, WORKSPACE_FILE, WorkspaceConfig, type ProjectStatus, type ProjectStatusFailure, type StatusReport } from "@youiyoux/core";
import { loadProject, PROJECT_FILE, type Project } from "@youiyoux/scanner";
import { baselinePath, runCheck } from "./check.ts";
import { readLock, syncProject, verifyLock } from "./sync.ts";
import { pendingMigrations } from "./upgrade.ts";
import { padEnd, plural, style } from "./ui.ts";

/** A product's folder as a person reads it: relative to here, or a sibling (`../billing`); anything further is absolute. */
export const placeOf = (cwd: string, root: string): string => {
  const rel = relative(cwd, root) || ".";
  return rel.split(/[\\/]/).filter((part) => part === "..").length > 1 ? resolve(root) : rel;
};

const WRITES = new Set(["created", "updated", "merged", "adopted", "conflict", "removed"]);

/** Where a product's design system comes from, as a person reads it. */
function sourceOf(project: Project): string {
  if (project.linked) return `your checkout ${project.linked}`;
  const source = project.config.source;
  if ("package" in source) return `package ${source.package}`;
  if ("git" in source) return `git ${source.git} at ${source.ref}`;
  return resolve(project.root) === resolve(project.repo.root) ? "this repo" : `path ${source.path}`;
}

/** The one next step, most pressing first. */
function nextStep(s: Omit<ProjectStatus, "next">, migrations: number): string {
  if (s.sync.state === "never") return "youiyoux sync: this product has never been synced with its System";
  if (s.sync.state === "conflict") return "youiyoux sync: resolve the conflicts it reports, then youiyoux sync --adopt records them";
  if (migrations > 0) return `youiyoux upgrade: ${s.system.name} v${s.system.version} comes with ${plural(migrations, "migration")} for this product's code, which upgrade runs with the sync`;
  if (s.sync.state === "behind") return `youiyoux sync: ${plural(s.sync.changes.length, "file")} would change`;
  if (s.check.incomplete) return "youiyoux check: some files or rules could not be checked, and it says which";
  if (s.check.errors > 0) return `youiyoux check: fix ${plural(s.check.errors, "error")}`;
  if (s.requests.open > 0) return `youiyoux requests: answer ${plural(s.requests.open, "open request")}`;
  if (s.check.warnings > 0 && !s.check.baseline) return `youiyoux check: ${plural(s.check.warnings, "warning")} to fix, or youiyoux baseline records them as accepted debt`;
  return "nothing to do";
}

export async function projectStatus(project: Project, cwd = process.cwd()): Promise<ProjectStatus> {
  const lock = await readLock(project.root);
  const { actions } = await syncProject(project, { dryRun: true });
  // What a sync would write: a file kept as the product has it, or skipped, changes nothing.
  const changes = actions.filter((a) => WRITES.has(a.action)).map((a) => ({ file: a.file, action: a.action }));
  const baselineFile = baselinePath(project);
  const check = await runCheck(project, { baseline: (await readTextOrNull(baselineFile)) === null ? null : baselineFile });
  const comparison = check.baseline?.comparison;
  const counted = comparison ? [...comparison.new, ...comparison.regressed] : check.violations;
  const usages = check.scan.report.usages;
  const { RequestStore } = await import("@youiyoux/workflow");
  const requests = await new RequestStore(project.root, project.config.id).list();
  const status: Omit<ProjectStatus, "next"> = {
    id: project.config.id,
    root: placeOf(cwd, project.root),
    system: { id: project.system.config.id, name: project.system.config.name, version: project.system.config.version, source: sourceOf(project), linked: Boolean(project.linked), commit: project.designCommit ?? null },
    lock: lock ? { systemVersion: lock.systemVersion, syncedAt: lock.syncedAt } : null,
    sync: { state: lock === null ? "never" : actions.some((a) => a.action === "conflict") ? "conflict" : changes.length > 0 ? "behind" : "current", changes },
    drift: ((await verifyLock(project)) ?? []).map((i) => ({ file: i.file, severity: i.severity, message: i.message })),
    check: {
      errors: check.errors,
      warnings: counted.filter((v) => v.severity === "warn").length,
      baseline: comparison ? { known: comparison.known.length, new: comparison.new.length + comparison.regressed.length, fixed: comparison.fixed.reduce((n, f) => n + f.gone, 0) } : null,
      incomplete: check.incomplete,
    },
    components: { system: project.system.components.length, used: new Set(usages.map((u) => u.element)).size, sites: usages.length },
    requests: { open: requests.requests.filter((r) => r.status === "open").length, addressed: requests.requests.filter((r) => r.status === "addressed").length, unreadable: requests.unreadable.length },
  };
  return { ...status, next: nextStep(status, lock ? pendingMigrations(project, lock).length : 0) };
}

/**
 * The products status reports on: the one named, the nearest youi.project.json upward, else a
 * workspace (the nearest youi.workspace.json upward, its projects), else every youi.project.json
 * in this git repository below here. Each is a folder that should hold youi.project.json.
 */
export async function statusTargets(cwd: string, named?: string): Promise<{ roots: string[]; workspace: string | null }> {
  if (named) return { roots: [resolve(named)], workspace: null };
  const product = findUp(cwd, PROJECT_FILE);
  if (product) return { roots: [product], workspace: null };
  const at = findUp(cwd, WORKSPACE_FILE);
  if (at) {
    const file = join(at, WORKSPACE_FILE);
    const workspace = await readDefinition(file, WorkspaceConfig);
    return { roots: workspace.projects.map((p) => resolve(at, p)), workspace: file };
  }
  // A monorepo: its products below here, inside this repository (never another repository's, nor node_modules).
  const top = findUp(cwd, ".git") ?? null;
  if (top === null) return { roots: [], workspace: null };
  const configs = await findFiles(cwd, [`**/${PROJECT_FILE}`]);
  const roots: string[] = [];
  for (const config of configs) {
    const dir = resolve(cwd, dirname(config));
    if ((await realpath(findUp(dir, ".git") ?? dir)) === (await realpath(top))) roots.push(dir);
  }
  return { roots, workspace: null };
}

export async function workspaceStatus(cwd: string, named?: string): Promise<StatusReport> {
  const { roots, workspace } = await statusTargets(cwd, named);
  const projects: Array<ProjectStatus | ProjectStatusFailure> = [];
  for (const root of roots) {
    try {
      projects.push(await projectStatus(await loadProject(root), cwd));
    } catch (error: unknown) {
      const label = placeOf(cwd, root);
      projects.push({ root: label, error: error instanceof Error ? error.message : String(error), next: (await readTextOrNull(join(root, PROJECT_FILE))) === null ? `youiyoux adopt or youiyoux init --design <dir> in ${label}` : `fix ${join(label, PROJECT_FILE)}` });
    }
  }
  return { schema: "youi.status/v1", generatedAt: new Date().toISOString(), workspace: workspace ? relative(cwd, workspace) || WORKSPACE_FILE : null, projects };
}

const failed = (p: ProjectStatus | ProjectStatusFailure): p is ProjectStatusFailure => "error" in p;

function projectLines(s: ProjectStatus): string[] {
  const row = (label: string, text: string): string => `  ${padEnd(label, 11)} ${text}`;
  const synced = s.lock ? `synced ${s.lock.syncedAt.slice(0, 10)}${s.lock.systemVersion !== s.system.version ? ` at v${s.lock.systemVersion}` : ""}` : "never synced";
  const sync = { current: style.ok("up to date"), behind: style.warn(`behind: ${plural(s.sync.changes.length, "file")} would change`), conflict: style.error(`conflict: ${plural(s.sync.changes.filter((c) => c.action === "conflict").length, "file")}`), never: style.warn("never synced") }[s.sync.state];
  const edited = s.drift.filter((d) => d.severity === "warn");
  const broken = s.drift.filter((d) => d.severity === "error");
  const drift = s.drift.length === 0 ? style.ok("none") : [broken.length > 0 ? style.error(`${plural(broken.length, "file")} wrong (${broken.slice(0, 3).map((d) => d.file.split("/").at(-1)).join(", ")})`) : "", edited.length > 0 ? style.warn(`${plural(edited.length, "owned file")} edited locally, merged on sync (${edited.slice(0, 3).map((d) => d.file.split("/").at(-1)).join(", ")})`) : ""].filter(Boolean).join("; ");
  const { check } = s;
  const counts = `${check.errors > 0 ? style.error(plural(check.errors, "error")) : style.ok("0 errors")} · ${plural(check.warnings, "warning")}`;
  const baseline = check.baseline ? style.dim(` beyond the baseline (${check.baseline.known} accepted${check.baseline.fixed > 0 ? `, ${check.baseline.fixed} fixed` : ""})`) : "";
  return [
    `${style.bold(s.id)}${s.root === s.id ? "" : ` ${style.dim(`· ${s.root}`)}`} · ${s.system.name} v${s.system.version} ${style.dim(`(${s.system.source}${s.system.linked ? ", linked" : ""}) · ${synced}`)}`,
    row("sync", sync),
    row("drift", drift),
    row("check", `${counts}${baseline}${check.incomplete ? style.warn(" · incomplete: not a pass") : ""}`),
    row("components", `${s.components.used} of ${s.components.system} System components used, at ${plural(s.components.sites, "site")}`),
    row("requests", s.requests.open + s.requests.addressed + s.requests.unreadable === 0 ? style.dim("none") : [s.requests.open > 0 ? style.warn(`${s.requests.open} open`) : "0 open", `${s.requests.addressed} addressed`, ...(s.requests.unreadable > 0 ? [style.error(`${s.requests.unreadable} unreadable`)] : [])].join(" · ")),
    `${style.bold("Next:")} ${s.next}`,
  ];
}

export function renderStatus(report: StatusReport): string {
  if (report.projects.length === 0) return `${style.warn("!")} no product here: no ${PROJECT_FILE} upward, no ${WORKSPACE_FILE}, and none in this repository below here\nNext: youiyoux adopt makes this product's own UI its design system, or youiyoux init --design <dir> follows one`;
  const blocks = report.projects.map((p) => (failed(p) ? [`${style.bold(p.root)} ${style.error("✖")} ${p.error}`, `${style.bold("Next:")} ${p.next}`] : projectLines(p)));
  const head = report.projects.length > 1 ? [`${style.bold("workspace")} ${style.dim(`· ${plural(report.projects.length, "product")}${report.workspace ? ` from ${report.workspace}` : " in this repository"}`)}`, ""] : [];
  return [...head, ...blocks.flatMap((b, i) => (i === 0 ? b : ["", ...b]))].join("\n");
}

/** 1 when any product could not be read, or its check is incomplete or failing; 0 otherwise. */
export const statusExitCode = (report: StatusReport): number => (report.projects.some((p) => failed(p) || p.check.incomplete || p.check.errors > 0 || p.sync.state === "conflict") ? 1 : 0);
