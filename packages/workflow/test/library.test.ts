/**
 * Library drafts (c4): Save to Library and Add to my project become drafts for a person to approve,
 * written as youi.library/v1 on a review branch; an adoption request for an item whose licence is
 * unknown is refused with a plain reason.
 */
import { request } from "node:http";
import { LibraryEntry } from "@youiyoux/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileStore, RuleWorkflow, serveWorkflow, type Actor, type LibraryDraftContent, type LibraryDraftView } from "../src/index.ts";
import { git, sandbox, type Sandbox } from "./helpers.ts";

const PERSON: Actor = { kind: "person", name: "captain" };
const AGENT: Actor = { kind: "agent", name: "claude" };

/** As Discover lists them (recorded fixtures): shadcn's command with an MIT licence, coss's with none known. */
const SHADCN_COMMAND = LibraryEntry.parse({
  schema: "youi.library/v1",
  id: "lib:shadcn/component/command",
  name: "command",
  title: "Command",
  kind: "component",
  stage: "library",
  summary: "Fast, composable, unstyled command menu for React.",
  source: { name: "shadcn/ui", url: "https://ui.shadcn.com/docs/components/command", ingestedAt: "2026-10-12T12:00:00.000Z", kind: "shadcn-registry", ref: "@shadcn/command" },
  categories: ["command"],
  swapsWith: [],
  license: { spdx: "MIT", evidenceUrl: "https://github.com/shadcn-ui/ui", verifiedAt: "2026-10-12T12:00:00.000Z" },
  install: { command: "npx shadcn add command", npm: ["cn", "cmdk"], registryDeps: ["dialog"], implicitDeps: ["lucide-react"] },
  signals: { via: { package: "cmdk", weeklyDownloads: 41566267 }, weeklyDownloads: null, stars: null, pushedAt: null, archived: null, package: null, repo: null },
});
const COSS_COMMAND = LibraryEntry.parse({
  ...SHADCN_COMMAND,
  id: "lib:coss/component/command",
  title: undefined,
  source: { name: "@coss", ingestedAt: "2026-10-12T12:00:00.000Z", kind: "shadcn-registry", ref: "@coss/command" },
  license: "unknown",
  install: { command: "npx shadcn add @coss/command", npm: ["@base-ui/react"], registryDeps: ["@coss/autocomplete"], implicitDeps: [] },
  signals: undefined,
});

let box: Sandbox;
let impacts: Array<[string, string]>;
/** The local Discover index's licences, by id: what the service checks a draft's licence against. */
const INDEX = new Map([SHADCN_COMMAND, COSS_COMMAND].map((entry) => [entry.id, entry.license]));
const open = (index: boolean = true): RuleWorkflow =>
  new RuleWorkflow({
    projectRoot: box.project,
    designRoot: box.design,
    store: new FileStore(box.state),
    swapImpact: async (candidate, family) => (impacts.push([candidate, family]), family === "button-1" ? { looks: 12, files: 4, routes: 3, listed: true } : null),
    ...(index ? { libraryLicence: async (id: string) => INDEX.get(id) ?? null } : {}),
  });

beforeEach(async () => {
  box = await sandbox();
  impacts = [];
});
afterEach(async () => {
  await box.dispose();
});

const content = (entry: LibraryEntry, request: "save" | "adopt", swapsWith: string[] = []): LibraryDraftContent => ({ entry, request, reason: request === "adopt" ? "The console needs a command menu; this one is built on cmdk." : "", swapsWith });

async function handedOff(workflow: RuleWorkflow, draft: LibraryDraftView) {
  const previewed = await workflow.preview(PERSON, draft.id);
  await workflow.approve(PERSON, draft.id, { revision: previewed.revision, previewId: previewed.preview!.id });
  return workflow.handoff(PERSON, draft.id);
}

describe("library drafts (c4)", () => {
  test("Save to Library: a draft, previewed and approved by a person, lands as a youi.library/v1 file on a review branch; main is untouched", async () => {
    const workflow = open();
    const draft = await workflow.create(PERSON, { kind: "library", content: content(COSS_COMMAND, "save", ["button-1"]) });
    expect(draft).toMatchObject({ kind: "library", status: "draft", problems: [], content: { request: "save", entry: { stage: "library", swapsWith: ["button-1"] } } });
    const previewed = await workflow.preview(PERSON, draft.id);
    expect(previewed.kind === "library" && previewed.preview).toMatchObject({ file: "library/coss/command.library.json", exists: false, stage: "library", license: "unknown", swaps: [{ target: "button-1", kind: "family", looks: 12, files: 4, routes: 3, listed: true }] });
    expect(impacts).toEqual([["lib:coss/component/command", "button-1"]]);
    // An agent may draft and preview, never approve.
    await expect(workflow.approve(AGENT, draft.id, { revision: previewed.revision, previewId: previewed.preview!.id })).rejects.toMatchObject({ code: "forbidden" });
    const main = git(box.design, "rev-parse", "main");
    const done = await handedOff(workflow, draft);
    expect(done.handoff).toMatchObject({ branch: `youi/library/coss-command-${draft.id.slice(2, 8)}`, files: ["library/coss/command.library.json"] });
    expect(git(box.design, "rev-parse", "main")).toBe(main);
    expect(git(box.design, "status", "--porcelain")).toBe("");
    const written = JSON.parse(git(box.design, "show", `${done.handoff!.branch}:library/coss/command.library.json`)) as Record<string, unknown>;
    expect(written.$schema).toBe("../../schema/youi.library.schema.json");
    expect(LibraryEntry.parse(written)).toMatchObject({ id: "lib:coss/component/command", stage: "library", license: "unknown", source: { ref: "@coss/command" }, install: { command: "npx shadcn add @coss/command" }, swapsWith: ["button-1"] });
  });

  test("Add to my project: an adoption request (stage candidate) with the exact install command, for a person to decide", async () => {
    const workflow = open();
    const draft = await workflow.create(PERSON, { kind: "library", content: content(SHADCN_COMMAND, "adopt", ["button-1"]) });
    const done = await handedOff(workflow, draft);
    const written = LibraryEntry.parse(JSON.parse(git(box.design, "show", `${done.handoff!.branch}:library/shadcn/command.library.json`)));
    expect(written).toMatchObject({ stage: "candidate", license: { spdx: "MIT" }, install: { command: "npx shadcn add command", npm: ["cn", "cmdk"] }, swapsWith: ["button-1"], source: { kind: "shadcn-registry", ref: "@shadcn/command" } });
    const message = git(box.design, "log", "-1", "--format=%B", done.handoff!.branch);
    expect(message).toContain("library: request adoption of @shadcn/command for button-1 (licence MIT)");
    expect(message).toContain("Install, after adoption: npx shadcn add command");
    expect(done.events.map((e) => e.type)).toEqual(["created", "previewed", "approved", "handed-off"]);
  });

  test("an adoption request for an item whose licence is unknown is refused, in plain words, when drafted and when saved", async () => {
    const workflow = open();
    await expect(workflow.create(PERSON, { kind: "library", content: content(COSS_COMMAND, "adopt") })).rejects.toMatchObject({ code: "invalid", message: "command's licence is unknown: nothing backs one, so it cannot be adopted. Save it to the Library as a reference, or find its licence first." });
    const saved = await workflow.create(PERSON, { kind: "library", content: content(COSS_COMMAND, "save") });
    await expect(workflow.save(PERSON, saved.id, { revision: 1, content: content(COSS_COMMAND, "adopt") })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/licence is unknown/) });
    // Nothing was drafted for the refused request.
    expect((await workflow.list(PERSON)).drafts.map((d) => d.id)).toEqual([saved.id]);
  });

  test("an adoption request needs a reason, and swaps name families or System elements that exist", async () => {
    const workflow = open();
    const draft = await workflow.create(PERSON, { kind: "library", content: { ...content(SHADCN_COMMAND, "adopt", ["button-1", "youi:demo/component/nope", "not a target"]), reason: " " } });
    expect(draft.problems).toEqual(["reason: say why the System needs it", "swapsWith: no System element youi:demo/component/nope", "swapsWith: not a target is neither an inventory family (button-1) nor a System element"]);
    await expect(workflow.preview(PERSON, draft.id)).rejects.toMatchObject({ code: "invalid" });
  });

  test("the service takes library drafts over its API and refuses an unknown-licence adoption there too", async () => {
    const workflow = open();
    const service = await serveWorkflow({ workflow, actor: PERSON, sessionKey: "k", port: 0 });
    try {
      const post = (body: unknown) =>
        new Promise<{ status: number; json: Record<string, unknown> }>((done, reject) => {
          const req = request(new URL("/api/drafts", service.url), { method: "POST", headers: { "content-type": "application/json", "x-youi-session": "k" } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => done({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
          });
          req.on("error", reject);
          req.end(JSON.stringify(body));
        });
      expect(await post({ kind: "library", content: content(SHADCN_COMMAND, "save") })).toMatchObject({ status: 201, json: { kind: "library", status: "draft" } });
      expect(await post({ kind: "library", content: content(COSS_COMMAND, "adopt") })).toMatchObject({ status: 422, json: { code: "invalid", error: expect.stringMatching(/licence is unknown/) } });
      expect((await workflow.info(PERSON)).kinds).toContain("library");
    } finally {
      await service.close();
    }
  });

  test("the licence is the index's, never the client's: a claimed MIT on coss's command is still refused, and a listed MIT is written whatever was sent", async () => {
    const workflow = open();
    const claimed = LibraryEntry.parse({ ...COSS_COMMAND, license: SHADCN_COMMAND.license });
    await expect(workflow.create(PERSON, { kind: "library", content: content(claimed, "adopt") })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/licence is unknown/) });
    const unlisted = LibraryEntry.parse({ ...SHADCN_COMMAND, id: "lib:shadcn/component/not-listed", name: "not-listed" });
    await expect(workflow.create(PERSON, { kind: "library", content: content(unlisted, "adopt") })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/licence is unknown/) });
    const understated = LibraryEntry.parse({ ...SHADCN_COMMAND, license: "unknown" });
    const draft = await workflow.create(PERSON, { kind: "library", content: content(understated, "adopt") });
    expect(draft.content.entry.license).toEqual(SHADCN_COMMAND.license);
    // Without an index nothing can check a licence: saving a reference is fine, adopting is not.
    const blind = open(false);
    await expect(blind.create(PERSON, { kind: "library", content: content(SHADCN_COMMAND, "adopt") })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/cannot be checked: the hub has no Discover index/) });
    expect(await blind.create(PERSON, { kind: "library", content: content(SHADCN_COMMAND, "save") })).toMatchObject({ kind: "library", status: "draft" });
  });
});
