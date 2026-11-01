/**
 * `youi.proposal/v1`: options an agent puts on the Screens canvas for a person to pick from, one
 * file each in the product's `.youi/proposals/<id>.json`, written through the workflow's store.
 *
 * A proposal is about one component on one captured screen (its name as the page knows it, its
 * file and line, and its box, where it is pinned). Each option is a few design-system edits: prop
 * values its contract allows, and new text. A person previews them on the live screen, picks one
 * (written into the code, or filed as a change request) or dismisses them all; an agent proposes
 * but never picks.
 */
import { z } from "zod";
import { ElementId } from "./ids.ts";
import { REQUEST_ID, RequestAuthor } from "./requests.ts";

const IsoTime = z.string().datetime({ offset: true });
const Box = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });
const Size = z.object({ width: z.number().positive(), height: z.number().positive() });

export const PROPOSAL_ID = /^p-[0-9a-f]{10}$/;
export const PROPOSAL_STATUSES = ["open", "chosen", "dismissed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
/** Options are lettered, as a person reads them out. */
export const OPTION_IDS = ["a", "b", "c", "d"] as const;

/** A prop value an option sets: what a contract's enum, string, boolean and number props take. */
export const ProposalValue = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);

export const ProposalOption = z
  .object({
    id: z.enum(OPTION_IDS),
    /** A few words a person picks by: "Quieter", "One primary action". */
    label: z.string().min(1).max(60),
    /** Why this one, in a sentence or two. */
    why: z.string().min(1).max(500),
    set: z.array(z.object({ prop: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/), value: ProposalValue })).max(20),
    /** New text for the component, or null to keep its own. */
    text: z.string().min(1).max(2000).nullable(),
  })
  .refine((o) => o.set.length > 0 || o.text !== null, "an option changes something: a prop or the text");
export type ProposalOption = z.infer<typeof ProposalOption>;

export const ProposalTarget = z.object({
  /** The component as the page names it (`Button`): how the live screen finds it again. */
  name: z.string().min(1).max(200),
  /** The System element it is, when its file and line are one of the element's sites. */
  element: ElementId.optional(),
  file: z.string().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
  /** Where it is on the captured screen, in its picture's pixels, and that picture's size. */
  box: Box,
  page: Size.optional(),
});
export type ProposalTarget = z.infer<typeof ProposalTarget>;

export const ProposalDoc = z
  .object({
    $schema: z.string().optional(),
    schema: z.literal("youi.proposal/v1"),
    id: z.string().regex(PROPOSAL_ID, "expected p-<10 hex>"),
    project: z.string().min(1).max(200),
    /** The captured screen's route. */
    route: z.string().min(1).max(300),
    target: ProposalTarget,
    /** What was asked for, in the asker's words. */
    ask: z.string().min(1).max(1000),
    author: RequestAuthor,
    createdAt: IsoTime,
    updatedAt: IsoTime,
    options: z.array(ProposalOption).min(2).max(4),
    status: z.enum(PROPOSAL_STATUSES),
    /** The option a person picked, who, and when; with the change request it became, when it couldn't be written. */
    choice: z.enum(OPTION_IDS).optional(),
    decidedBy: RequestAuthor.optional(),
    decidedAt: IsoTime.optional(),
    request: z.string().regex(REQUEST_ID, "expected r-<10 hex>").optional(),
    /** The options request it answers, whose hex its id shares. */
    for: z.string().regex(REQUEST_ID, "expected r-<10 hex>").optional(),
    /** A decision's seal: made by the hub that recorded it, with a key only its person can read. */
    seal: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .refine((p) => new Set(p.options.map((o) => o.id)).size === p.options.length, "each option has its own letter")
  .refine((p) => p.for === undefined || p.for.slice(2) === p.id.slice(2), "a proposal for a request shares its id: p-<the request's hex>")
  .refine((p) => (p.status === "chosen") === (p.choice !== undefined), "a chosen proposal names its choice, and only then")
  .refine((p) => p.status === "open" || (p.decidedBy !== undefined && p.decidedAt !== undefined), "a decided proposal says who decided, and when");
export type ProposalDoc = z.infer<typeof ProposalDoc>;
