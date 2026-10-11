/**
 * The one place that decides who may do what. Locally there is a single person and no
 * accounts, but every workflow operation still passes through `authorize`, so hosted
 * roles can replace this table without touching the workflow. Approving and handing a
 * change to review are a person's decisions: agents may draft and preview, never approve.
 */
import type { Actor, ApiError } from "./api.ts";

export type Action = "read" | "draft" | "preview" | "approve" | "handoff" | "discard";

const PERSON_ONLY: ReadonlySet<Action> = new Set(["approve", "handoff"]);

export class WorkflowError extends Error {
  override name = "WorkflowError";
  readonly code: ApiError["code"];
  readonly problems: readonly string[];
  constructor(code: ApiError["code"], message: string, problems: readonly string[] = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

export function authorize(actor: Actor, action: Action): void {
  if (PERSON_ONLY.has(action) && actor.kind !== "person") throw new WorkflowError("forbidden", `an ${actor.kind} cannot ${action}: approving a design change is a person's decision`);
}
