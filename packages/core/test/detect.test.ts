import { describe, expect, test } from "vitest";
import { DetectReport, draftLibraryItem, LibraryEntry, sourceSlug } from "../src/index.ts";

const report = DetectReport.parse({
  schema: "youi.detect/v1",
  generatedAt: "2026-10-12T00:00:00.000Z",
  detector: "test",
  target: { kind: "site", inputs: ["https://www.acme.example/"], name: "www.acme.example" },
  pages: [{ url: "https://www.acme.example/", status: "ok" }],
  coverage: "1 page crawled.",
  libraries: [{ id: "mui", name: "MUI", confidence: "high", score: 0.9, evidence: [{ kind: "class-prefix", strength: "strong", detail: "Mui* classes" }] }],
  elements: [{ type: "button", library: "mui", confidence: "high", count: 3, evidence: [{ kind: "class-prefix", strength: "strong", detail: ".MuiButton-root" }], screenshot: "screenshots/1-mui-button.png", page: "https://www.acme.example/" }],
});

describe("youi.detect/v1", () => {
  test("fills defaults and refuses screenshots outside the report's directory", () => {
    expect(report.unused).toEqual([]);
    expect(report.libraries[0]!.evidence[0]!.count).toBe(1);
    const escaping = { ...report, elements: [{ ...report.elements[0]!, screenshot: "../secret.png" }] };
    expect(DetectReport.safeParse(escaping).success).toBe(false);
    expect(DetectReport.safeParse({ ...report, libraries: [{ ...report.libraries[0]!, evidence: [] }] }).success).toBe(false);
  });

  test("a detected element drafts a valid youi.library/v1 item", () => {
    const draft = LibraryEntry.parse(draftLibraryItem(report, report.elements[0]!, "2026-10-12T01:00:00.000Z"));
    expect(draft.id).toBe("lib:acme-example/component/mui-button");
    expect(draft.summary).toBe("Seen on www.acme.example, likely MUI");
    expect(draft.name).toBe("MUI Button");
    expect(draft.source).toEqual({ name: "www.acme.example", url: "https://www.acme.example/", ingestedAt: "2026-10-12T01:00:00.000Z" });
    expect(draft.stage).toBe("library");
  });

  test("source slugs always start with a letter", () => {
    expect(sourceSlug("127.0.0.1:4173")).toBe("site-127-0-0-1-4173");
    expect(sourceSlug("My App")).toBe("my-app");
  });
});
