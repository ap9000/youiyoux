/**
 * `youi.request/v1`: a comment or a change request pinned to what someone picked out on a captured
 * screen. One file per request in the product repo (`.youi/requests/<id>.json`), so it is
 * reviewed in git and any agent can read it without the hub running.
 *
 * Its target names what was picked: the route and the component, the file and line that rendered
 * it and its box on the picture; `scope: "element"` asks for every place the element is used, not
 * only this one. Its thread is the conversation: replies, and the status changes with who made
 * them. An agent may reply and mark a request addressed; opening and closing it is a person's.
 */
import { z } from "zod";
import { ElementId } from "./ids.ts";

const IsoTime = z.string().datetime({ offset: true });

export const REQUEST_ID = /^r-[0-9a-f]{10}$/;
export const REQUEST_STATUSES = ["open", "addressed", "closed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RequestAuthor = z.object({ kind: z.enum(["person", "agent"]), name: z.string().min(1).max(100) });
export type RequestAuthor = z.infer<typeof RequestAuthor>;

/** A box in CSS pixels of the captured page, and the page's size it is measured against. */
const Box = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });
const Size = z.object({ width: z.number().positive(), height: z.number().positive() });

export const RequestTarget = z.object({
  /** The route as the usage map names it (`/settings`, `*` for the app shell). */
  route: z.string().min(1).max(300),
  /** here: this one, on this screen; element: every place the element is used. */
  scope: z.enum(["here", "element"]),
  /** The component's name as it rendered (`Button`). */
  name: z.string().min(1).max(200),
  /** The System element it is, or the one a lookalike stands in for. */
  element: ElementId.optional(),
  lookalike: z.boolean().optional(),
  /** Project-relative, and the line that rendered it, when the capture found them. */
  file: z.string().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  box: Box.optional(),
  page: Size.optional(),
});
export type RequestTarget = z.infer<typeof RequestTarget>;

export const RequestEntry = z.object({
  author: RequestAuthor,
  at: IsoTime,
  body: z.string().max(4000),
  /** A status change this entry made, if any. */
  status: z.enum(REQUEST_STATUSES).optional(),
});
export type RequestEntry = z.infer<typeof RequestEntry>;

export const RequestDoc = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.request/v1"),
  id: z.string().regex(REQUEST_ID, "expected r-<10 hex>"),
  /** The project id from youi.project.json. */
  project: z.string().min(1).max(200),
  /** comment: a note; change: something to do. */
  kind: z.enum(["comment", "change"]),
  status: z.enum(REQUEST_STATUSES),
  body: z.string().min(1).max(4000),
  author: RequestAuthor,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  target: RequestTarget,
  thread: z.array(RequestEntry).max(500),
});
export type RequestDoc = z.infer<typeof RequestDoc>;
