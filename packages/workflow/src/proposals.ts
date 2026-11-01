/**
 * Options an agent puts on the Screens canvas (`youi.proposal/v1`), one file each in the product's
 * `.youi/proposals/`: the MCP tool `screens_offer` writes them, the hub shows and decides them,
 * both through this store, so the rules are the same everywhere.
 *
 * Every option is held to the component's contract before it is written: a prop it names must be
 * one the contract types as a value (enum, string, boolean, number), not deprecated, and an enum's
 * value one of its values; a component with no contract can only have its text changed. A prop
 * that carries a URL, HTML, a style or a handler is never proposed. So what a person previews is
 * always the design system's own. Only a person picks an option or dismisses them; an agent
 * proposes, and reads what was picked. A file that does not validate is listed as unreadable,
 * never dropped and never rewritten.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPTION_IDS, PROPOSAL_ID, ProposalDoc, REQUEST_ID, writeFileAtomic, type ComponentContract, type ProposalOption, type ProposalTarget, type RequestAuthor } from "@youiyoux/core";
import { EDIT_REFUSED, isScriptValue, screenSlug } from "@youiyoux/scanner";
import { authorize, WorkflowError } from "./policy.ts";
import type { Actor } from "./api.ts";

export const PROPOSALS_DIR = ".youi/proposals";
const FILE = /^(p-[0-9a-f]{10})\.json$/;

export interface ProposalInput {
  readonly route: string;
  readonly target: ProposalTarget;
  readonly ask: string;
  readonly options: ReadonlyArray<Omit<ProposalOption, "id">>;
}

export interface ProposalList {
  readonly proposals: ProposalDoc[];
  readonly unreadable: Array<{ file: string; reason: string }>;
}

/** A person's decision: one option (and the change request it became, when it couldn't be written), or none of them. */
export type ProposalDecision = { readonly choice: (typeof OPTION_IDS)[number]; readonly request?: string } | { readonly dismiss: true };

export interface ProposalStoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const authorOf = (actor: Actor): RequestAuthor => ({ kind: actor.kind, name: actor.name });

/** Why an option can't be proposed for this component, or null: the contract's own values only. */
export function optionProblem(option: Omit<ProposalOption, "id">, contract: ComponentContract | null, name: string): string | null {
  if (option.set.length > 0 && !contract) return `${name} isn't a design-system component, so options for it can only change its text`;
  for (const { prop, value } of option.set) {
    if (EDIT_REFUSED.test(prop)) return `${prop} is never proposed: it can carry a URL, HTML, a style or a handler`;
    if (typeof value === "string" && isScriptValue(value)) return `${prop}'s value is a script address, which is never proposed`;
    // Only a prop the contract names itself: never one an object inherits (constructor, toString).
    const spec = Object.hasOwn(contract!.props, prop) ? contract!.props[prop] : undefined;
    const choices = Object.entries(contract!.props).filter(([, s]) => ["enum", "string", "boolean", "number"].includes(s.type) && !s.deprecated).map(([key]) => key);
    if (!spec) return `${contract!.name} has no prop ${prop}: its contract offers ${choices.join(", ") || "none to choose"}`;
    if (spec.type !== "enum" && spec.type !== "string" && spec.type !== "boolean" && spec.type !== "number") return `${contract!.name}'s ${prop} is a ${spec.type === "node" ? "slot for elements" : String(spec.type)}, not a value to choose`;
    if (spec.deprecated) return `${contract!.name}'s ${prop} is deprecated: ${spec.deprecated}`;
    if (spec.type === "enum" && (typeof value !== "string" || !spec.values.includes(value))) return `${contract!.name}'s ${prop} is one of ${spec.values.join(", ")}, not ${JSON.stringify(value)}`;
    if ((spec.type === "string" && typeof value !== "string") || (spec.type === "boolean" && typeof value !== "boolean") || (spec.type === "number" && typeof value !== "number")) return `${contract!.name}'s ${prop} is a ${spec.type}, not ${JSON.stringify(value)}`;
  }
  return null;
}

export class ProposalStore {
  readonly dir: string;
  private readonly project: string;
  private readonly options: ProposalStoreOptions;

  /** `root`: the product's root, where `.youi/` lives; `project`: its id. */
  constructor(root: string, project: string, options: ProposalStoreOptions = {}) {
    this.dir = join(root, PROPOSALS_DIR);
    this.project = project;
    this.options = options;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private file(id: string): string {
    if (!PROPOSAL_ID.test(id)) throw new WorkflowError("bad-request", `"${id.slice(0, 40)}" is not a proposal id (p-<10 hex>)`);
    return join(this.dir, `${id}.json`);
  }

  private async write(proposal: ProposalDoc): Promise<ProposalDoc> {
    const checked = ProposalDoc.parse(proposal);
    await writeFileAtomic(this.file(checked.id), `${JSON.stringify(checked, null, 2)}\n`);
    return checked;
  }

  /** Every proposal, newest first. */
  async list(): Promise<ProposalList> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const proposals: ProposalDoc[] = [];
    const unreadable: Array<{ file: string; reason: string }> = [];
    for (const name of names.sort()) {
      const match = FILE.exec(name);
      if (!match) continue;
      const file = join(PROPOSALS_DIR, name);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(this.dir, name), "utf8"));
      } catch (error: unknown) {
        unreadable.push({ file, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
        continue;
      }
      const result = ProposalDoc.safeParse(value);
      if (!result.success) unreadable.push({ file, reason: result.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ") });
      else if (result.data.id !== match[1]) unreadable.push({ file, reason: "its id is not its file name" });
      else proposals.push(result.data);
    }
    proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { proposals, unreadable };
  }

  async get(id: string): Promise<ProposalDoc> {
    const text = await readFile(this.file(id), "utf8").catch(() => null);
    if (text === null) throw new WorkflowError("not-found", `no proposal ${id}`);
    const parsed = ProposalDoc.safeParse(JSON.parse(text));
    if (!parsed.success) throw new WorkflowError("invalid", `${PROPOSALS_DIR}/${id}.json is not a valid youi.proposal/v1`, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    return parsed.data;
  }

  /** Options for one component, each held to its contract (`contract`, null when it has none). */
  async create(actor: Actor, input: ProposalInput, contract: ComponentContract | null): Promise<ProposalDoc> {
    authorize(actor, "draft");
    const ask = input.ask.trim();
    if (!ask) throw new WorkflowError("invalid", "a proposal says what was asked");
    if (input.options.length < 2 || input.options.length > OPTION_IDS.length) throw new WorkflowError("invalid", `a proposal offers 2 to ${OPTION_IDS.length} options to pick from`);
    const problems = input.options.flatMap((option, i) => {
      const problem = optionProblem(option, contract, input.target.name);
      return problem ? [`option ${OPTION_IDS[i]} (${option.label}): ${problem}`] : [];
    });
    if (problems.length > 0) throw new WorkflowError("invalid", "every option must be the design system's own", problems);
    const at = this.now();
    const id = (this.options.newId ?? (() => `p-${randomBytes(5).toString("hex")}`))();
    const options = input.options.map((option, i) => ({ ...option, id: OPTION_IDS[i]! }));
    return this.write({ schema: "youi.proposal/v1", id, project: this.project, route: input.route, target: input.target, ask, author: authorOf(actor), createdAt: at, updatedAt: at, options, status: "open" });
  }

  /** A person picks one option, or dismisses them all; an agent never decides. */
  async decide(actor: Actor, id: string, decision: ProposalDecision): Promise<ProposalDoc> {
    if (actor.kind !== "person") throw new WorkflowError("forbidden", `an ${actor.kind} cannot pick among options: a person picks one on the Screens canvas`);
    const proposal = await this.get(id);
    if (proposal.status !== "open") throw new WorkflowError("conflict", `${id} is already ${proposal.status}`);
    const at = this.now();
    const decided = { ...proposal, updatedAt: at, decidedBy: authorOf(actor), decidedAt: at };
    if ("dismiss" in decision) return this.write({ ...decided, status: "dismissed" });
    if (!proposal.options.some((o) => o.id === decision.choice)) throw new WorkflowError("bad-request", `${id} has no option ${decision.choice}`);
    if (decision.request !== undefined && !REQUEST_ID.test(decision.request)) throw new WorkflowError("bad-request", "request is r-<10 hex>");
    return this.write({ ...decided, status: "chosen", choice: decision.choice, ...(decision.request ? { request: decision.request } : {}) });
  }
}

/** One option's changes, as a person and an agent read them: `variant="ghost"`, `text "Create flow"`. */
export function optionWords(option: Pick<ProposalOption, "set" | "text">): string {
  return [...option.set.map(({ prop, value }) => (value === true ? prop : `${prop}=${JSON.stringify(value)}`)), ...(option.text === null ? [] : [`text ${JSON.stringify(option.text)}`])].join(", ");
}

/** A proposal as an agent reads it: what was asked, the options, what was picked, and what to do next. */
export interface ProposalBrief {
  readonly id: string;
  readonly route: string;
  readonly component: string;
  readonly at: string | null;
  readonly ask: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string; readonly why: string; readonly changes: string }>;
  readonly status: ProposalDoc["status"];
  readonly choice: string | null;
  readonly request: string | null;
  /** The captured screen it is pinned on (an absolute path). */
  readonly picture: string;
  readonly next: string;
}

export function proposalBrief(proposal: ProposalDoc, root: string): ProposalBrief {
  const t = proposal.target;
  const chosen = proposal.options.find((o) => o.id === proposal.choice);
  const next =
    proposal.status === "open"
      ? `Waiting for a person to pick one on ${proposal.route} in the hub's Screens canvas; call screens_offers later to see which.`
      : proposal.status === "dismissed"
        ? "The person dismissed every option: ask what they want instead, or propose others."
        : proposal.request
          ? `The person picked ${chosen?.label ?? proposal.choice}, filed as change request ${proposal.request}: do that request (requests_list).`
          : `The person picked ${chosen?.label ?? proposal.choice} and the hub wrote it into ${t.file ?? "the code"}${t.line ? `:${t.line}` : ""}; nothing is left to do.`;
  return {
    id: proposal.id,
    route: proposal.route,
    component: t.name,
    at: t.file && t.line ? `${t.file}:${t.line}` : null,
    ask: proposal.ask,
    options: proposal.options.map((o) => ({ id: o.id, label: o.label, why: o.why, changes: optionWords(o) })),
    status: proposal.status,
    choice: proposal.choice ?? null,
    request: proposal.request ?? null,
    picture: join(root, ".youi/screens", `${screenSlug(proposal.route)}.light.webp`),
    next,
  };
}
