import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canMove, copyleft, DefinitionError, ELEMENT_STAGES, isFamilyId, isLibraryId, LibraryEntry, loadLibrary, systemStage } from "../src/index.ts";

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

describe("youi.library/v1, additive Discover fields", () => {
  const discovered = {
    ...entry,
    id: "lib:coss/component/command",
    name: "command",
    title: "Command",
    source: { name: "@coss", url: "https://coss.com/ui", ingestedAt: "2026-10-12T00:00:00Z", kind: "shadcn-registry", ref: "@coss/command" },
    provenance: { fetchedAt: "2026-10-12T00:00:00Z", url: "https://coss.com/ui/r/registry.json", sha256: "a".repeat(64), files: [{ path: "ui/command.tsx", sha256: null }], registryHealth: { status: "healthy", score: 96.5, checkedAt: "2026-10-12T00:00:00Z" } },
    license: "unknown",
    install: { command: "npx shadcn add @coss/command", npm: ["@base-ui/react"], registryDeps: ["@coss/autocomplete"], implicitDeps: ["lucide-react"] },
    signals: { weeklyDownloads: 1200, stars: null, pushedAt: null },
    swapsWith: ["button-2", "youi:demo/component/input"],
  };

  test("old entries stay valid and gain nothing they did not have", () => {
    const parsed = LibraryEntry.parse(entry);
    expect(parsed).not.toHaveProperty("license");
    expect(parsed).not.toHaveProperty("provenance");
    expect(parsed.source).toEqual(entry.source);
  });

  test("a discovered entry carries source, provenance, licence, install and signals", () => {
    const parsed = LibraryEntry.parse(discovered);
    expect(parsed.source).toMatchObject({ kind: "shadcn-registry", ref: "@coss/command" });
    expect(parsed.license).toBe("unknown");
    expect(parsed.signals).toEqual({ weeklyDownloads: 1200, stars: null, pushedAt: null, archived: null, package: null, repo: null });
    expect(LibraryEntry.parse({ ...discovered, license: { spdx: "MIT", evidenceUrl: "https://github.com/dip/cmdk", verifiedAt: "2026-10-12T00:00:00Z" } }).license).toMatchObject({ spdx: "MIT" });
  });

  test("swapsWith takes System ids and inventory family ids, nothing else", () => {
    expect(isFamilyId("button-2")).toBe(true);
    expect(isFamilyId("link-as-button-10")).toBe(true);
    expect(isFamilyId("button")).toBe(false);
    expect(LibraryEntry.safeParse({ ...discovered, swapsWith: ["lib:x/component/y"] }).success).toBe(false);
    expect(LibraryEntry.safeParse({ ...discovered, source: { ...discovered.source, kind: "website" } }).success).toBe(false);
    expect(LibraryEntry.safeParse({ ...discovered, license: { spdx: "MIT" } }).success).toBe(false);
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

describe("copyleft", () => {
  test("GPL and AGPL are strong copyleft; LGPL, MPL and permissive licences are not", () => {
    for (const spdx of ["AGPL-3.0", "AGPL-3.0-only", "GPL-3.0-or-later", "GPL-2.0", "MIT AND GPL-3.0", "(GPL-2.0 WITH Classpath-exception-2.0)"]) expect(copyleft(spdx), spdx).toBe(true);
    for (const spdx of ["MIT", "Apache-2.0", "LGPL-3.0", "MPL-2.0", "ISC"]) expect(copyleft(spdx), spdx).toBe(false);
  });

  test("a choice that offers a permissive licence is not copyleft", () => {
    expect(copyleft("(MIT OR GPL-3.0)")).toBe(false);
    expect(copyleft("GPL-2.0 OR AGPL-3.0")).toBe(true);
  });
});
