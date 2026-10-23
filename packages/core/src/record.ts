/**
 * youi.record/v1: what CI tells a hosted hub about one repository at one commit (`youiyoux record`):
 * the status of each product in it, every string redacted as the shareable report's are. No
 * source code is in it. youi.org/v1: what the hosted hub serves (`youiyoux hub serve`): each
 * repository's latest record, and every System's adoption by the version products have synced.
 */
import { z } from "zod";
import { ProjectStatus, ProjectStatusFailure } from "./status.ts";

const IsoTime = z.string().datetime({ offset: true });
const Count = z.number().int().min(0);

/** `owner/name`, as GitHub writes it (GITHUB_REPOSITORY). */
export const RepoName = z.string().regex(/^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}$/, "expected owner/name, such as acme/billing");

export const CiRecord = z
  .object({
    $schema: z.string().optional(),
    schema: z.literal("youi.record/v1"),
    repo: RepoName,
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    /** The branch or tag CI ran on. */
    ref: z.string().max(200).nullable(),
    generatedAt: IsoTime,
    /** The youiyoux version that made it. */
    tool: z.string().max(50),
    products: z.array(z.union([ProjectStatus, ProjectStatusFailure])).max(500),
  })
  .strict();
export type CiRecord = z.infer<typeof CiRecord>;

const ProductRef = z.object({ repo: z.string(), id: z.string() });

export const OrgView = z.object({
  schema: z.literal("youi.org/v1"),
  generatedAt: IsoTime,
  /** Each repository's latest record, by repository name. */
  repos: z.array(z.object({ repo: z.string(), commit: z.string().nullable(), ref: z.string().nullable(), generatedAt: IsoTime, receivedAt: IsoTime, products: z.array(z.union([ProjectStatus, ProjectStatusFailure])) })),
  /** Every System the products follow: the newest version any product's source names, and who has synced which version. */
  systems: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      latest: z.string(),
      /** Newest first; `never synced` products have version null. */
      versions: z.array(z.object({ version: z.string().nullable(), products: z.array(ProductRef) })),
    }),
  ),
  totals: z.object({ repos: Count, products: Count, unreadable: Count, behind: Count, failing: Count }),
});
export type OrgView = z.infer<typeof OrgView>;
