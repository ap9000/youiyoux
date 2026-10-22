/**
 * `youi.gaps/v1`: what a project adds next. For each kind of element (Discover's concepts: date
 * picker, combobox, toast…), whether each project has it from the System, from a library, built
 * by hand (components named for it, with their uses), or not at all when the standard kit has
 * one; with the licensed candidates that could stand in for what is hand-built or missing, and
 * the kinds hand-built in more than one project, worth adding to the System once.
 */
import { z } from "zod";

const IsoTime = z.string().datetime({ offset: true });

export const GAP_STATUSES = ["system", "library", "hand-built", "missing"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const GapCandidate = z.object({
  /** The Discover id (`lib:shadcn/component/calendar`). */
  id: z.string(),
  name: z.string(),
  /** Its registry or `npm`. */
  source: z.string(),
  /** An SPDX id; unknown licences are never offered. */
  licence: z.string(),
  /** GPL or AGPL: shipping it releases your code under the same licence. */
  copyleft: z.boolean(),
  install: z.string().nullable(),
});
export type GapCandidate = z.infer<typeof GapCandidate>;

export const GapConcept = z.object({
  /** Discover's concept id (`date-picker`). */
  concept: z.string(),
  /** How people call it (`date picker`). */
  name: z.string(),
  status: z.enum(GAP_STATUSES),
  /** The System's components for it. */
  system: z.array(z.string()),
  /** The packages that provide it: imported, or declared for it in package.json. */
  packages: z.array(z.string()),
  /** The project's own components named for it, first few. */
  definitions: z.array(z.object({ name: z.string(), file: z.string(), line: z.number().int().positive() })),
  /** Components named for it, and the looks they and styled native elements of its kind render. */
  count: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  /** For what is hand-built or missing; null when the Discover index is not synced (never "none"). */
  candidates: z.array(GapCandidate).nullable(),
});
export type GapConcept = z.infer<typeof GapConcept>;

export const GapsProject = z.object({
  id: z.string(),
  /** False when the inventory could not read every file: hand-built counts are then a lower bound. */
  complete: z.boolean(),
  /** Whether its package.json was read (its declared packages count as libraries). */
  dependencies: z.enum(["read", "unread"]),
  /** Hand-built first (most uses first), then missing, from a library, in the System. */
  concepts: z.array(GapConcept),
});
export type GapsProject = z.infer<typeof GapsProject>;

export const GapsReport = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.gaps/v1"),
  generatedAt: IsoTime,
  /** The System the projects follow, when they follow one. */
  system: z.string().nullable(),
  /** synced: candidates come from the local Discover index; not-synced: there are none to offer yet. */
  discover: z.enum(["synced", "not-synced"]),
  /** The kinds a project is expected to have (the standard kit): only these are ever "missing". */
  kit: z.array(z.string()),
  projects: z.array(GapsProject),
  /** Kinds hand-built in more than one project, most uses first. */
  across: z.array(z.object({ concept: z.string(), name: z.string(), projects: z.array(z.string()), uses: z.number().int().nonnegative() })),
});
export type GapsReport = z.infer<typeof GapsReport>;
