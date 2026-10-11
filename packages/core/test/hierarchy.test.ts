import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canMove, DefinitionError, ELEMENT_STAGES, isLibraryId, LibraryEntry, loadLibrary, systemStage } from "../src/index.ts";

const entry = {
  schema: "youi.library/v1",
  id: "lib:example/component/date-picker",
  name: "DatePicker",
  kind: "component",
  summary: "A calendar popover for picking one date.",
  source: { name: "Example kit", ingestedAt: "2026-01-01T00:00:00Z" },
  categories: ["forms"],
  swapsWith: ["youi:demo/component/input"],
};

describe("element stages", () => {
  test("run library → candidate → adopted → in-use", () => {
    expect(ELEMENT_STAGES).toEqual(["library", "candidate", "adopted", "in-use"]);
  });

  test("in-use is read off usage, never declared", () => {
    expect(systemStage(0)).toBe("adopted");
    expect(systemStage(3)).toBe("in-use");
  });

  test("an agent may only request adoption; only a person crosses into the System", () => {
    expect(canMove("library", "candidate", "agent")).toBe(true);
    expect(canMove("candidate", "adopted", "agent")).toBe(false);
    expect(canMove("candidate", "adopted", "person")).toBe(true);
    expect(canMove("library", "adopted", "person")).toBe(false);
    expect(canMove("adopted", "in-use", "person")).toBe(false);
    expect(canMove("adopted", "in-use", "scan")).toBe(true);
  });
});

describe("youi.library/v1", () => {
  test("accepts an entry and defaults it to the library stage", () => {
    expect(LibraryEntry.parse(entry).stage).toBe("library");
  });

  test("refuses System ids and System stages, so a Library item can never pass as approved", () => {
    expect(LibraryEntry.safeParse({ ...entry, id: "youi:demo/component/date-picker" }).success).toBe(false);
    expect(LibraryEntry.safeParse({ ...entry, stage: "adopted" }).success).toBe(false);
    expect(isLibraryId(entry.id)).toBe(true);
    expect(isLibraryId("youi:demo/component/button")).toBe(false);
  });
});

describe("loadLibrary", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  test("an absent library directory is an empty Library", async () => {
    root = await mkdtemp(join(tmpdir(), "youi-lib-"));
    expect(await loadLibrary(root)).toEqual({ entries: [] });
  });

  test("loads entries and rejects duplicate ids", async () => {
    root = await mkdtemp(join(tmpdir(), "youi-lib-"));
    await mkdir(join(root, "library/example"), { recursive: true });
    await writeFile(join(root, "library/example/date-picker.library.json"), JSON.stringify(entry));
    expect((await loadLibrary(root)).entries.map((e) => e.id)).toEqual([entry.id]);
    await writeFile(join(root, "library/example/copy.library.json"), JSON.stringify(entry));
    await expect(loadLibrary(root)).rejects.toBeInstanceOf(DefinitionError);
  });
});
