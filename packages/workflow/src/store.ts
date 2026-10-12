/**
 * Workflow storage. The service depends only on `WorkflowStore`, so the local file store
 * can later give way to the hosted database without touching the workflow rules.
 *
 * FileStore keeps one JSON file per draft, written atomically (temp file + rename), so
 * a crash or restart never leaves a half-written draft and every draft survives restarts.
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import type { Draft } from "./api.ts";

export const DRAFT_ID = /^d-[0-9a-f]{10}$/;

export interface StoredDrafts {
  readonly drafts: readonly Draft[];
  /** Files that could not be read back, with why: shown, never silently dropped. */
  readonly unreadable: ReadonlyArray<{ file: string; reason: string }>;
}

export interface WorkflowStore {
  /** Human-readable location, for logs and the info endpoint. */
  readonly location: string;
  list(): Promise<StoredDrafts>;
  get(id: string): Promise<Draft | null>;
  put(draft: Draft): Promise<void>;
  /** Keep a generated artifact (a review patch); returns where it is. */
  putArtifact(name: string, content: string): Promise<string>;
}

const FORMAT = "youiyoux.draft/v1";
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function decode(text: string, file: string): Draft {
  const parsed = JSON.parse(text) as { schema?: unknown; draft?: Partial<Draft> };
  const draft = parsed.draft;
  if (parsed.schema !== FORMAT || !draft || typeof draft.id !== "string" || !DRAFT_ID.test(draft.id) || typeof draft.revision !== "number" || !draft.content || !draft.base) {
    throw new Error(`${file} is not a ${FORMAT} document`);
  }
  // Commit ids reach git as arguments: anything but a full object id is refused.
  const commits = [draft.base.commit, draft.approval?.baseCommit, draft.handoff?.base, draft.handoff?.commit].filter((c) => c !== undefined);
  if (!commits.every((c) => typeof c === "string" && COMMIT.test(c))) throw new Error(`${file} names a commit that is not a git object id`);
  // Drafts written before style drafts existed are rule drafts.
  const kind = (draft as { kind?: unknown }).kind ?? "rule";
  if (kind !== "rule" && kind !== "style") throw new Error(`${file} is a "${String(kind)}" draft, which this youi does not know`);
  return { ...draft, kind } as Draft;
}

function checkId(id: string): void {
  if (!DRAFT_ID.test(id)) throw new Error(`not a draft id: ${id}`);
}

export class FileStore implements WorkflowStore {
  readonly location: string;
  private readonly drafts: string;
  private readonly artifacts: string;

  constructor(dir: string) {
    this.location = dir;
    this.drafts = join(dir, "drafts");
    this.artifacts = join(dir, "handoffs");
  }

  async list(): Promise<StoredDrafts> {
    await mkdir(this.drafts, { recursive: true });
    const names = (await readdir(this.drafts)).filter((name) => /^d-[0-9a-f]{10}\.json$/.test(name)).sort();
    const drafts: Draft[] = [];
    const unreadable: Array<{ file: string; reason: string }> = [];
    for (const name of names) {
      const file = join(this.drafts, name);
      try {
        drafts.push(decode(await readFile(file, "utf8"), file));
      } catch (error: unknown) {
        unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { drafts, unreadable };
  }

  async get(id: string): Promise<Draft | null> {
    checkId(id);
    const file = join(this.drafts, `${id}.json`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return decode(text, file);
  }

  async put(draft: Draft): Promise<void> {
    checkId(draft.id);
    await writeFileAtomic(join(this.drafts, `${draft.id}.json`), `${JSON.stringify({ schema: FORMAT, draft }, null, 2)}\n`);
  }

  async putArtifact(name: string, content: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`not an artifact name: ${name}`);
    const file = join(this.artifacts, name);
    await writeFileAtomic(file, content);
    return file;
  }
}

/** In memory, for tests: JSON round-trips each write, as the file store does. */
export class MemoryStore implements WorkflowStore {
  readonly location = "memory";
  private readonly drafts = new Map<string, string>();
  readonly artifacts = new Map<string, string>();

  async list(): Promise<StoredDrafts> {
    return { drafts: [...this.drafts.keys()].sort().map((id) => JSON.parse(this.drafts.get(id)!) as Draft), unreadable: [] };
  }

  async get(id: string): Promise<Draft | null> {
    const text = this.drafts.get(id);
    return text === undefined ? null : (JSON.parse(text) as Draft);
  }

  async put(draft: Draft): Promise<void> {
    this.drafts.set(draft.id, JSON.stringify(draft));
  }

  async putArtifact(name: string, content: string): Promise<string> {
    this.artifacts.set(name, content);
    return `memory:${name}`;
  }
}
