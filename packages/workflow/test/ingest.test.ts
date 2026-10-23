/**
 * Ingest drafts: everything one link holds, read by the service itself, filed as one draft. A
 * person keeps or drops items (the only thing a save changes), previews, approves, and the kept
 * items land as youi.library/v1 files on a review branch; main is untouched.
 */
import { request } from "node:http";
import { LibraryEntry } from "@youiyoux/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileStore, RuleWorkflow, serveWorkflow, type Actor, type IngestDraftView, type IngestReading } from "../src/index.ts";
import { git, sandbox, type Sandbox } from "./helpers.ts";

const PERSON: Actor = { kind: "person", name: "captain" };
const AGENT: Actor = { kind: "agent", name: "claude" };
const AT = "2026-10-24T09:00:00.000Z";
const MIT = { spdx: "MIT", evidenceUrl: "https://github.com/acme/ui/blob/main/LICENSE", verifiedAt: AT } as const;

const item = (name: string, kind: "component" | "token" = "component", extra: Partial<LibraryEntry> = {}): LibraryEntry =>
  LibraryEntry.parse({
    schema: "youi.library/v1",
    id: `lib:acme-ui/${kind}/${name.toLowerCase()}`,
    name,
    kind,
    stage: "library",
    summary: `${name}, from acme/ui.`,
    source: { name: "acme/ui", url: `https://github.com/acme/ui/blob/${"a".repeat(40)}/src/components/${name}.tsx`, ingestedAt: AT, kind: "github", ref: `src/components/${name}.tsx` },
    categories: [name.toLowerCase()],
    swapsWith: [],
    provenance: { fetchedAt: AT, url: "https://github.com/acme/ui", sha256: "b".repeat(64), files: [], registryHealth: null },
    license: MIT,
    ...extra,
  });

const READING: IngestReading = { link: "github:acme/ui", source: { kind: "github", name: "acme/ui", url: "https://github.com/acme/ui" }, license: MIT, fetchedAt: AT, entries: [item("Button"), item("Dialog"), item("Tooltip")], skipped: [{ name: "theme", reason: "registry:style: not a component or block" }], notes: ["read at aaaaaaa (main)"] };

let box: Sandbox;
let links: string[];
const open = (reading: IngestReading | Error = READING): RuleWorkflow =>
  new RuleWorkflow({
    projectRoot: box.project,
    designRoot: box.design,
    store: new FileStore(box.state),
    ingest: async (link) => {
      links.push(link);
      if (reading instanceof Error) throw reading;
      return reading;
    },
  });

beforeEach(async () => {
  box = await sandbox();
  links = [];
});
afterEach(async () => {
  await box.dispose();
});

describe("ingest drafts", () => {
  test("one draft per link, every item kept; drop one, preview, approve: the kept items land on a review branch, main untouched", async () => {
    const workflow = open();
    const draft = (await workflow.create(PERSON, { kind: "ingest", link: "github:acme/ui" })) as IngestDraftView;
    expect(links).toEqual(["github:acme/ui"]);
    expect(draft).toMatchObject({ kind: "ingest", status: "draft", problems: [], content: { keep: ["lib:acme-ui/component/button", "lib:acme-ui/component/dialog", "lib:acme-ui/component/tooltip"] } });
    expect(draft.events[0]!.note).toBe("Ingest 3 items from acme/ui into the Library: read from github:acme/ui, from main@" + git(box.design, "rev-parse", "main").slice(0, 7) + ".");

    const kept = await workflow.save(PERSON, draft.id, { revision: draft.revision, content: { keep: ["lib:acme-ui/component/button", "lib:acme-ui/component/dialog"] } });
    expect(kept.events.at(-1)!.note).toBe("Revision 2: ingest 2 of 3 items from acme/ui into the Library.");
    const previewed = await workflow.preview(PERSON, draft.id);
    expect(previewed.kind === "ingest" && previewed.preview).toMatchObject({ files: [{ id: "lib:acme-ui/component/button", file: "library/acme-ui/button.library.json", exists: false }, { id: "lib:acme-ui/component/dialog", file: "library/acme-ui/dialog.library.json", exists: false }], dropped: 1, license: "MIT" });
    // An agent may draft and preview, never approve.
    await expect(workflow.approve(AGENT, draft.id, { revision: previewed.revision, previewId: previewed.preview!.id })).rejects.toMatchObject({ code: "forbidden" });
    const main = git(box.design, "rev-parse", "main");
    await workflow.approve(PERSON, draft.id, { revision: previewed.revision, previewId: previewed.preview!.id });
    const done = await workflow.handoff(PERSON, draft.id);
    expect(done.handoff).toMatchObject({ branch: `youi/library/ingest-acme-ui-${draft.id.slice(2, 8)}`, files: ["library/acme-ui/button.library.json", "library/acme-ui/dialog.library.json"] });
    expect(git(box.design, "rev-parse", "main")).toBe(main);
    const written = LibraryEntry.parse(JSON.parse(git(box.design, "show", `${done.handoff!.branch}:library/acme-ui/button.library.json`)));
    expect(written).toMatchObject({ id: "lib:acme-ui/component/button", stage: "library", license: MIT, source: { kind: "github", ref: "src/components/Button.tsx" } });
    expect(git(box.design, "show", "--stat", "--format=%B", done.handoff!.branch)).toContain("library: ingest 2 of 3 items from acme/ui into the Library");
  });

  test("a save names only the items kept: nothing else about an item, its source or its licence can be changed, and an id it did not read is refused", async () => {
    const workflow = open();
    const draft = await workflow.create(PERSON, { kind: "ingest", link: "github:acme/ui" });
    await expect(workflow.save(PERSON, draft.id, { revision: 1, content: { keep: ["lib:evil/component/x"] } })).rejects.toMatchObject({ code: "invalid", message: "lib:evil/component/x is not in what acme/ui held" });
    // Library content sent to an ingest draft is refused, so no entry or licence can be swapped in.
    await expect(workflow.save(PERSON, draft.id, { revision: 1, content: { entry: { ...item("Button"), license: "unknown" }, request: "save", reason: "", swapsWith: [] } })).rejects.toMatchObject({ code: "bad-request" });
    const none = await workflow.save(PERSON, draft.id, { revision: 1, content: { keep: [] } });
    expect(none.problems).toEqual(["keep at least one item, or discard the draft"]);
    expect(none.canApprove).toBe(false);
  });

  test("a link that cannot be read, or reads into items the Library does not take, starts no draft and says why", async () => {
    await expect(open(new Error("could not read the repository acme/gone: not found")).create(PERSON, { kind: "ingest", link: "github:acme/gone" })).rejects.toMatchObject({ code: "invalid", message: "could not read the repository acme/gone: not found" });
    const mixed: IngestReading = { ...READING, entries: [item("Button"), item("Button")] };
    await expect(open(mixed).create(PERSON, { kind: "ingest", link: "github:acme/ui" })).rejects.toMatchObject({ code: "invalid", problems: ["lib:acme-ui/component/button is listed twice"] });
    const candidate: IngestReading = { ...READING, entries: [item("Button", "component", { stage: "candidate" })] };
    await expect(open(candidate).create(PERSON, { kind: "ingest", link: "github:acme/ui" })).rejects.toMatchObject({ problems: ["lib:acme-ui/component/button: an ingested item is a reference (stage library), not candidate"] });
    expect(await open().list(PERSON).then((l) => l.drafts.length)).toBe(0);
  });

  test("a service that cannot read links offers no ingest drafts", async () => {
    const workflow = new RuleWorkflow({ projectRoot: box.project, designRoot: box.design, store: new FileStore(box.state) });
    expect((await workflow.info(PERSON)).kinds).toEqual(["rule", "style", "library"]);
    await expect(workflow.create(PERSON, { kind: "ingest", link: "github:acme/ui" })).rejects.toMatchObject({ message: "this service cannot read links: run youiyoux library ingest <link> --draft" });
    expect((await open().info(PERSON)).kinds).toEqual(["rule", "style", "library", "ingest"]);
  });

  test("over HTTP: an ingest draft is created from a link and saved with the items kept, and nothing else", async () => {
    const service = await serveWorkflow({ workflow: open(), actor: PERSON, sessionKey: "k".repeat(32), port: 0 });
    const call = (method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
      new Promise((done, fail) => {
        const url = new URL(path, service.url);
        const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers: { "content-type": "application/json", "x-youi-session": "k".repeat(32), host: url.host, origin: service.url } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += String(c)));
          res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(text || "{}") as Record<string, unknown> }));
        });
        req.on("error", fail);
        req.end(JSON.stringify(body));
      });
    try {
      const created = await call("POST", "/api/drafts", { kind: "ingest", link: "github:acme/ui" });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      // Anything beside the kept ids is refused by the shape itself.
      expect((await call("PUT", `/api/drafts/${id}`, { revision: 1, content: { keep: [], reading: READING } })).status).toBe(400);
      const saved = await call("PUT", `/api/drafts/${id}`, { revision: 1, content: { keep: ["lib:acme-ui/component/tooltip"] } });
      expect(saved.status).toBe(200);
      expect((saved.body.content as { keep: string[] }).keep).toEqual(["lib:acme-ui/component/tooltip"]);
    } finally {
      await service.close();
    }
  });
});
