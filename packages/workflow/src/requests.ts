/**
 * Comments and change requests on captured screens (`youi.request/v1`), one file each in the
 * product repo's `.youi/requests/`. The hub writes them through the loopback service, agents
 * through the MCP tools or `youiyoux requests`; all of them through this store, so the rules are
 * the same everywhere: anyone may comment and reply, an agent may mark a request addressed (with
 * what it did), and only a person closes or reopens one. A file that does not validate is listed
 * as unreadable, never dropped silently, and never rewritten.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { REQUEST_ID, RequestDoc, writeFileAtomic, type RequestAuthor, type RequestStatus, type RequestTarget } from "@youiyoux/core";
import { PICTURE_SCALE, screenSlug } from "@youiyoux/scanner";
import { authorize, WorkflowError } from "./policy.ts";
import type { Actor } from "./api.ts";

export const REQUESTS_DIR = ".youi/requests";
const FILE = /^(r-[0-9a-f]{10})\.json$/;

export interface RequestInput {
  readonly kind: RequestDoc["kind"];
  readonly body: string;
  readonly target: RequestTarget;
}

export interface RequestList {
  readonly requests: readonly RequestDoc[];
  /** Files in the directory that are not valid requests, with why. */
  readonly unreadable: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

export interface RequestStoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const authorOf = (actor: Actor): RequestAuthor => ({ kind: actor.kind, name: actor.name });

/** A picture of the request's screen, and where its component is on it (CSS pixels of the page). */
export interface RequestPicture {
  /** Absolute path of the image. */
  readonly file: string;
  readonly box: RequestTarget["box"] | null;
  readonly page: RequestTarget["page"] | null;
  /** When it was taken: the filing time for before, the picture's own time for after. */
  readonly at: string;
}

export interface RequestComparison {
  readonly before: RequestPicture | null;
  /** The screen's current picture, with the component found again by its file and line. */
  readonly after: (RequestPicture & {
    /** Taken after the request was filed, or last reopened: it can show the work done for it. */
    readonly sinceFiled: boolean;
    /** The component was found on the new picture by its line (false: shown where it was). */
    readonly found: boolean;
  }) | null;
}

const screensDir = (root: string): string => join(root, ".youi/screens");

export class RequestStore {
  readonly dir: string;
  private readonly root: string;
  private readonly project: string;
  private readonly options: RequestStoreOptions;

  /** `root`: the product's root, where `.youi/` lives; `project`: its id. */
  constructor(root: string, project: string, options: RequestStoreOptions = {}) {
    this.dir = join(root, REQUESTS_DIR);
    this.root = root;
    this.project = project;
    this.options = options;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private file(id: string): string {
    if (!REQUEST_ID.test(id)) throw new WorkflowError("bad-request", `"${id.slice(0, 40)}" is not a request id (r-<10 hex>)`);
    return join(this.dir, `${id}.json`);
  }

  private async write(request: RequestDoc): Promise<RequestDoc> {
    const checked = RequestDoc.parse(request);
    await writeFileAtomic(this.file(checked.id), `${JSON.stringify(checked, null, 2)}\n`);
    return checked;
  }

  /** Every request, newest first. */
  async list(): Promise<RequestList> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const requests: RequestDoc[] = [];
    const unreadable: Array<{ file: string; reason: string }> = [];
    for (const name of names.sort()) {
      const match = FILE.exec(name);
      if (!match) continue;
      const file = join(REQUESTS_DIR, name);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(this.dir, name), "utf8"));
      } catch (error: unknown) {
        unreadable.push({ file, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
        continue;
      }
      const result = RequestDoc.safeParse(value);
      if (!result.success) unreadable.push({ file, reason: result.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ") });
      else if (result.data.id !== match[1]) unreadable.push({ file, reason: "its id is not its file name" });
      else requests.push(result.data);
    }
    requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { requests, unreadable };
  }

  async get(id: string): Promise<RequestDoc> {
    const text = await readFile(this.file(id), "utf8").catch(() => null);
    if (text === null) throw new WorkflowError("not-found", `no request ${id}`);
    const parsed = RequestDoc.safeParse(JSON.parse(text));
    if (!parsed.success) throw new WorkflowError("invalid", `${REQUESTS_DIR}/${id}.json is not a valid youi.request/v1`, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    return parsed.data;
  }

  async create(actor: Actor, input: RequestInput): Promise<RequestDoc> {
    authorize(actor, "draft");
    const body = input.body.trim();
    if (!body) throw new WorkflowError("invalid", "a request needs words: what to look at, or what to change");
    const at = this.now();
    const id = (this.options.newId ?? (() => `r-${randomBytes(5).toString("hex")}`))();
    // The screen as it is now, kept beside the request: what "after" is compared with.
    const shot = join(screensDir(this.root), `${screenSlug(input.target.route)}.light.webp`);
    let before: string | undefined;
    if (existsSync(shot)) {
      before = `${id}.before.webp`;
      await mkdir(this.dir, { recursive: true });
      await copyFile(shot, join(this.dir, before));
    }
    return this.write({ schema: "youi.request/v1", id, project: this.project, kind: input.kind, status: "open", body, author: authorOf(actor), createdAt: at, updatedAt: at, target: input.target, ...(before ? { before } : {}), thread: [] });
  }

  async reply(actor: Actor, id: string, body: string): Promise<RequestDoc> {
    authorize(actor, "draft");
    const text = body.trim();
    if (!text) throw new WorkflowError("invalid", "a reply needs words");
    const request = await this.get(id);
    const at = this.now();
    return this.write({ ...request, updatedAt: at, thread: [...request.thread, { author: authorOf(actor), at, body: text }] });
  }

  /**
   * Before and after for a request: the picture kept when it was filed, and the screen's picture
   * now, with the component found again on it by its file and line (from the new capture's places).
   */
  async compare(id: string): Promise<RequestComparison> {
    const request = await this.get(id);
    const t = request.target;
    const before = request.before === `${request.id}.before.webp` && existsSync(join(this.dir, request.before)) ? { file: join(this.dir, request.before), box: t.box ?? null, page: t.page ?? null, at: request.createdAt } : null;
    const slug = screenSlug(t.route);
    const shot = join(screensDir(this.root), `${slug}.light.webp`);
    const info = await stat(shot).catch(() => null);
    if (!info) return { before, after: null };
    let box = t.box ?? null;
    let page = t.page ?? null;
    let found = false;
    try {
      const places = JSON.parse(await readFile(join(screensDir(this.root), `${slug}.places.json`), "utf8")) as { size?: { width: number; height: number }; places?: Array<{ name: string; file: string | null; line: number | null; box: NonNullable<RequestTarget["box"]> }> };
      const again = t.file && t.line ? places.places?.find((p) => p.file === t.file && p.line === t.line && p.name === t.name) : undefined;
      if (places.size) page = places.size;
      if (again) {
        box = again.box;
        found = true;
      }
    } catch {
      // No places for the new picture: the component is shown where it was.
    }
    const since = request.thread.filter((e) => e.status === "open").at(-1)?.at ?? request.createdAt;
    const at = info.mtime.toISOString();
    return { before, after: { file: shot, box, page, at, sinceFiled: at > since, found } };
  }

  /**
   * Move a request on: `addressed` (anyone; an agent says what it did), or `closed` and `open`
   * (a person's: closing accepts the work, reopening says it is not done).
   */
  async setStatus(actor: Actor, id: string, status: RequestStatus, body = ""): Promise<RequestDoc> {
    if (status !== "addressed") authorize(actor, "close");
    else authorize(actor, "draft");
    const request = await this.get(id);
    if (request.status === status) throw new WorkflowError("conflict", `${id} is already ${status}`);
    if (status === "addressed" && request.status === "closed") throw new WorkflowError("conflict", `${id} is closed: a person reopens it first`);
    const at = this.now();
    return this.write({ ...request, status, updatedAt: at, thread: [...request.thread, { author: authorOf(actor), at, body: body.trim(), status }] });
  }
}

/** A request as an agent reads it: what is asked, where to look and the line to change, and what to do next. */
export interface RequestBrief {
  readonly id: string;
  readonly kind: RequestDoc["kind"];
  readonly status: RequestStatus;
  readonly ask: string;
  readonly from: string;
  readonly createdAt: string;
  readonly route: string;
  readonly component: string;
  readonly element: string | null;
  /** The component is a hand-built lookalike of `element`. */
  readonly lookalike: boolean;
  /** `file:line` that rendered it, when the capture found it. */
  readonly at: string | null;
  readonly scope: string;
  /** The captured screen (absolute), when it is on disk, and the component's box on it in its own pixels. */
  readonly picture: string | null;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  readonly thread: readonly string[];
  readonly next: string;
}

export function requestBrief(request: RequestDoc, root: string): RequestBrief {
  const t = request.target;
  const picture = join(root, ".youi/screens", `${screenSlug(t.route)}.light.webp`);
  const at = t.file && t.line ? `${t.file}:${t.line}` : null;
  const every = t.scope === "element" && t.element;
  const where = every ? `every use of ${t.element} (system_where_used lists them)` : at ? `${at}` : `the ${t.name} on ${t.route} (its line was not captured: find it from the picture and the route)`;
  const next =
    request.status === "closed" ? "Closed by a person: nothing to do."
      : request.status === "addressed" ? "Marked addressed: a person checks it and closes or reopens it. Reply only if asked."
        : request.kind === "comment" ? `A comment on ${where}: reply with request_reply if it asks something; change code only if it asks for a change.`
          : `Make the change at ${where}${t.lookalike && t.element ? `, using the System's ${t.element} rather than the hand-built lookalike where that is the fix` : ""}; capture the screen again (youiyoux screens capture --base <the app in development> --route ${t.route}) so the person sees it after; then call request_addressed with what you changed (file:line). Ask with request_reply first if it is unclear. A person closes it.`;
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    ask: request.body,
    from: `${request.author.kind} ${request.author.name}`,
    createdAt: request.createdAt,
    route: t.route,
    component: t.name,
    element: t.element ?? null,
    lookalike: t.lookalike === true,
    at,
    scope: every ? `everywhere ${t.element} is used` : "this one, on this screen",
    picture: existsSync(picture) ? picture : null,
    box: t.box ? { x: Math.round(t.box.x * PICTURE_SCALE), y: Math.round(t.box.y * PICTURE_SCALE), width: Math.round(t.box.width * PICTURE_SCALE), height: Math.round(t.box.height * PICTURE_SCALE) } : null,
    thread: request.thread.map((e) => `${e.author.kind} ${e.author.name}${e.status ? ` (marked ${e.status})` : ""}: ${e.body || "(no words)"}`),
    next,
  };
}
