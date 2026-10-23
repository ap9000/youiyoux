/**
 * youi.workspace/v1: the products one person or team manages together, and youi.status/v1: where
 * each one stands (`youiyoux status --json`, read by the hub's workspace page).
 */
import { z } from "zod";

export const WORKSPACE_FILE = "youi.workspace.json";

export const WorkspaceConfig = z
  .object({
    $schema: z.string().optional(),
    schema: z.literal("youi.workspace/v1"),
    name: z.string().min(1).optional(),
    /**
     * Product folders, each holding a youi.project.json: relative to this file, or absolute. A
     * product in another repository is listed by the path of its checkout (`../billing`).
     */
    projects: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

const IsoTime = z.string().datetime({ offset: true });
const Count = z.number().int().min(0);

export const ProjectStatus = z.object({
  id: z.string(),
  /** The product root, relative to where status ran. */
  root: z.string(),
  system: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    /** Where the design system comes from, as a person reads it: `package @acme/design`, `git github:acme/design at v3`, `path ../design`, `this repo`. */
    source: z.string(),
    /** The person's own checkout, from youiyoux link, is used instead of the source. */
    linked: z.boolean(),
    /** A git source's commit. */
    commit: z.string().nullable(),
  }),
  /** What the lockfile records: the version last synced and when; null before the first sync. */
  lock: z.object({ systemVersion: z.string(), syncedAt: IsoTime }).nullable(),
  /** What a sync would change now (a dry run, offline: a git source at the commit the lockfile records). */
  sync: z.object({
    state: z.enum(["current", "behind", "conflict", "never"]),
    changes: z.array(z.object({ file: z.string(), action: z.string() })),
  }),
  /** Lockfile issues: generated files edited, owned components edited locally, files missing. */
  drift: z.array(z.object({ file: z.string(), severity: z.enum(["error", "warn"]), message: z.string() })),
  check: z.object({
    /** Errors that fail youiyoux check: beyond the baseline when there is one, plus lockfile errors. */
    errors: Count,
    /** Warnings, beyond the baseline when there is one. */
    warnings: Count,
    baseline: z.object({ known: Count, new: Count, fixed: Count }).nullable(),
    /** Some files or rules could not be checked: the counts are not a pass. */
    incomplete: z.boolean(),
  }),
  components: z.object({ system: Count, used: Count, sites: Count }),
  requests: z.object({ open: Count, addressed: Count, unreadable: Count }),
  /** The one thing to do next, as a command. */
  next: z.string(),
});
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** A product status could not read: what went wrong, never a status of zeros. */
export const ProjectStatusFailure = z.object({ root: z.string(), error: z.string(), next: z.string() });
export type ProjectStatusFailure = z.infer<typeof ProjectStatusFailure>;

export const StatusReport = z.object({
  schema: z.literal("youi.status/v1"),
  generatedAt: IsoTime,
  /** The workspace file the projects came from, relative to where status ran; null for one project or projects found in the repo. */
  workspace: z.string().nullable(),
  projects: z.array(z.union([ProjectStatus, ProjectStatusFailure])),
});
export type StatusReport = z.infer<typeof StatusReport>;
