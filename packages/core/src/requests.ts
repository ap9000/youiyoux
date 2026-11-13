/**
 * `youi.request/v1`: a comment or a change request pinned to what someone picked out on a captured
 * screen. One file per request in the product repo (`.youi/requests/<id>.json`), so it is
 * reviewed in git and any agent can read it without the hub running.
 *
 * Its target names what was picked: the route and the component, the file and line that rendered
 * it and its box on the picture; `scope: "element"` asks for every place the element is used, not
 * only this one. Its thread is the conversation: replies, and the status changes with who made
 * them. An agent may reply and mark a request addressed; opening and closing it is a person's.
 *
 * A change request carries the task it asks for (`task`), scoped so a runner can file it as it is:
 * the goal in plain words, the files it may touch (when they are known), what is out of bounds,
 * and what shows it is done. A runner that takes it on (Toolroll, say) writes `<id>.task.json`
 * beside it (`youi.request-task/v1`): its task, where to see it, and how far it has got. The
 * request file stays youiyoux's and the task file the runner's, so neither overwrites the other.
 */
import { z } from "zod";
import { BehaviourCheckId, BehaviourRunId, BehaviourTargetIdentity } from "./behaviour.ts";
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
  /** Plain HTML React did not create (a server's fragment): its tag; `file:line` is the component that placed it. */
  html: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
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

/** What a request asks for. */
export const REQUEST_KINDS = ["comment", "change", "options"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** A prop an option may set, from the component's contract: its type, an enum's values, its default. */
export const OptionChoice = z.object({ type: z.enum(["enum", "string", "boolean", "number"]), values: z.array(z.string().min(1).max(200)).max(50).optional(), default: z.union([z.string().max(200), z.number(), z.boolean()]).optional() });
export type OptionChoice = z.infer<typeof OptionChoice>;

/**
 * What an options request's task writes (`task.offer`): one `youi.proposal/v1` file for the
 * component, its id the request's own hex (`p-…` for `r-…`), each option setting only `choices`
 * (or the text, with `text`). A runner's agent needs no youiyoux tools to do it; youiyoux checks
 * the file against the contract when it reads it.
 */
export const RequestOffer = z.object({
  proposal: z.string().regex(/^p-[0-9a-f]{10}$/, "expected p-<10 hex>"),
  file: z.string().regex(/^\.youi\/proposals\/p-[0-9a-f]{10}\.json$/, "expected .youi/proposals/p-<10 hex>.json"),
  choices: z.record(z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/), OptionChoice),
  text: z.boolean(),
});
export type RequestOffer = z.infer<typeof RequestOffer>;

/** What shows a task is done, as a runner checks it. */
export const TASK_EVIDENCE = ["screenshot", "check", "changed-path", "manual-review"] as const;

/** The task a change request asks for, scoped for a runner to file as it is. */
export const RequestTask = z.object({
  /** One line: the screen, the component and what to do. */
  title: z.string().min(1).max(120),
  /** In plain words: what was asked, where, and what the design system says about it. */
  goal: z.string().min(1).max(4000),
  /** Project-relative files the change may touch; empty when they cannot be known up front. */
  touches: z.array(z.string().min(1).max(500)).max(50),
  /** The files are known: a runner may hold the change to them. False: a person scopes it. */
  touchesKnown: z.boolean(),
  /** Why the files are not known, when they are not. */
  why: z.string().min(1).max(500).optional(),
  /** What the change must not do. */
  not: z.array(z.string().min(1).max(300)).max(10),
  acceptance: z.array(z.object({ statement: z.string().min(1).max(300), evidence: z.array(z.enum(TASK_EVIDENCE)).min(1) })).min(1).max(10),
  /** An options request's: the one file it writes, and what its options may set. */
  offer: RequestOffer.optional(),
});
export type RequestTask = z.infer<typeof RequestTask>;

/**
 * A change request filed from a failed behaviour result (the hub's Behaviour tab): the rule, check
 * and target it failed for, the run that failed and when. Set only by youiyoux from the stored
 * result it names, never taken from a caller. Moving the request to addressed needs a stored,
 * fresh, passed result for the same rule, check and target from a run newer than the request.
 */
export const RequestBehaviour = z
  .object({ rule: ElementId, check: BehaviourCheckId, target: BehaviourTargetIdentity, runId: BehaviourRunId, failedAt: IsoTime })
  .strict();
export type RequestBehaviour = z.infer<typeof RequestBehaviour>;

export const RequestDoc = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.request/v1"),
  id: z.string().regex(REQUEST_ID, "expected r-<10 hex>"),
  /** The project id from youi.project.json. */
  project: z.string().min(1).max(200),
  /** comment: a note; change: something to do. */
  /** comment: words on it; change: make a change; options: offer a few design-system options for a person to pick from. */
  kind: z.enum(REQUEST_KINDS),
  status: z.enum(REQUEST_STATUSES),
  body: z.string().min(1).max(4000),
  author: RequestAuthor,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  target: RequestTarget,
  /** The screen as it was when this was filed (`<id>.before.webp` beside it), to compare with after a change. */
  before: z.string().regex(/^r-[0-9a-f]{10}\.before\.webp$/).optional(),
  /** A change request's task, scoped for a runner (none on a comment, or on a request filed before tasks were). */
  task: RequestTask.optional(),
  /** A request filed from a failed behaviour result: what must pass, in a newer run, before it is addressed. */
  behaviour: RequestBehaviour.optional(),
  thread: z.array(RequestEntry).max(500),
});
export type RequestDoc = z.infer<typeof RequestDoc>;

/** A page a person opens: only http(s) is kept. */
const WebAddress = z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), "expected an http(s) address");

/** How far a runner's task for a request has got. */
export const RUN_STATUSES = ["queued", "needs-you", "building", "ready", "done", "failed", "stopped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * `youi.request-task/v1`: a runner's task for a request (`.youi/requests/<id>.task.json`, the
 * runner's to write). `url` is where a person sees the task and `home` all its waiting work; only
 * http(s) is kept.
 */
export const RequestRun = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.request-task/v1"),
  request: z.string().regex(REQUEST_ID, "expected r-<10 hex>"),
  /** The runner's name (`Toolroll`). */
  runner: z.string().min(1).max(60),
  task: z.object({ id: z.string().min(1).max(120), url: WebAddress.nullable() }),
  /** Where a person sees all the runner's waiting work for this project, to approve it there. */
  home: WebAddress.optional(),
  status: z.enum(RUN_STATUSES),
  /** The runner's own words for where it is (`Ready for review`). */
  detail: z.string().max(300).optional(),
  updatedAt: IsoTime,
});
export type RequestRun = z.infer<typeof RequestRun>;
