// @vitest-environment jsdom
/** Library > Gaps: what each project builds by hand or lacks, with candidates that open in Discover. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { GapsReport } from "@youiyoux/core";
import { discoverHref, evidence, GapsReportView, kindLabel } from "../src/screens/gaps/GapsScreen.tsx";

afterEach(cleanup);

const candidate = (name: string, licence = "MIT") => ({ id: `lib:shadcn/component/${name}`, name, source: "shadcn/ui", licence, copyleft: licence.startsWith("AGPL"), install: `npx shadcn add ${name}` });
const concept = (id: string, name: string, status: "system" | "library" | "hand-built" | "missing", extra: Partial<GapsReport["projects"][number]["concepts"][number]> = {}) => ({ concept: id, name, status, system: [], packages: [], definitions: [], count: 0, uses: 0, files: 0, candidates: status === "hand-built" || status === "missing" ? [] : [], ...extra });

const report: GapsReport = {
  schema: "youi.gaps/v1",
  generatedAt: "2026-10-22T12:00:00.000Z",
  system: "Acme",
  discover: "synced",
  kit: ["button", "date-picker", "otp"],
  projects: [
    {
      id: "app",
      complete: false,
      dependencies: "read",
      concepts: [
        concept("date-picker", "date picker", "hand-built", { definitions: [{ name: "DatePicker", file: "src/date-picker.tsx", line: 3 }], count: 1, uses: 12, files: 5, candidates: [candidate("calendar"), candidate("date-picker", "AGPL-3.0")] }),
        concept("otp", "otp", "missing", { candidates: [candidate("input-otp")] }),
        concept("tabs", "tabs", "library", { packages: ["@radix-ui/react-tabs"] }),
        concept("button", "button", "system", { system: ["Button"] }),
      ],
    },
  ],
  across: [{ concept: "date-picker", name: "date picker", projects: ["app", "admin"], uses: 17 }],
};

describe("Gaps", () => {
  test("hand-built kinds show their evidence and candidates, each opening in Discover; missing ones their best candidate", () => {
    render(<GapsReportView report={report} />);
    const picker = document.querySelector<HTMLElement>('[data-gap="date-picker"][data-status="hand-built"]')!;
    expect(within(picker).getByRole("heading", { name: "Date picker" })).toBeTruthy();
    expect(picker.textContent).toContain("1 component named for it, 12 uses in 5 files");
    expect(picker.textContent).toContain("src/date-picker.tsx:3");
    expect(within(picker).getByRole("link", { name: "calendar" }).getAttribute("href")).toBe("/discover?q=date+picker&role=date-picker&open=lib%3Ashadcn%2Fcomponent%2Fcalendar");
    // A copyleft candidate says so.
    expect(picker.querySelector("[data-copyleft]")?.textContent).toBe("AGPL-3.0 · copyleft");
    const otp = document.querySelector<HTMLElement>('[data-gap="otp"][data-status="missing"]')!;
    expect(within(otp).getByRole("link", { name: "OTP" })).toBeTruthy();
    expect(otp.textContent).toContain("input-otp · shadcn/ui");
  });

  test("what is built by hand in several projects leads; what is covered is one line each; a partial project says its counts are a floor", () => {
    render(<GapsReportView report={report} />);
    const across = document.querySelector<HTMLElement>("[data-across]")!;
    expect(across.textContent).toContain("Date picker");
    expect(across.textContent).toContain("17 uses");
    expect(screen.getByText("In the System (Acme)")).toBeTruthy();
    expect(screen.getByText("tabs (@radix-ui/react-tabs)")).toBeTruthy();
    expect(screen.getByText("Partial").getAttribute("title")).toMatch(/lower bound/);
    expect(document.querySelector("[data-not-synced]")).toBeNull();
  });

  test("without the Discover index it says how to get candidates, never that there are none", () => {
    render(<GapsReportView report={{ ...report, discover: "not-synced", projects: [{ ...report.projects[0]!, concepts: report.projects[0]!.concepts.map((c) => ({ ...c, candidates: c.status === "hand-built" || c.status === "missing" ? null : c.candidates })) }] }} />);
    expect(document.querySelector("[data-not-synced]")!.textContent).toContain("youiyoux discover sync");
    expect(document.querySelector('[data-gap="date-picker"]')!.textContent).toContain("No candidates yet: Discover is not synced.");
    expect(document.querySelector('[data-gap="otp"]')!.textContent).toContain("Discover not synced");
  });

  test("labels and evidence read as words", () => {
    expect(kindLabel("otp")).toBe("OTP");
    expect(kindLabel("date picker")).toBe("Date picker");
    expect(evidence({ ...report.projects[0]!.concepts[0]!, count: 0, uses: 1, files: 1 })).toBe("1 use in 1 file");
    expect(discoverHref({ concept: "toast", name: "toast" })).toBe("/discover?q=toast&role=toast");
  });

  test("the committed snapshot's gaps draw", () => {
    const data = join(import.meta.dirname, "../snapshot/public/data");
    const manifest = JSON.parse(readFileSync(join(data, "manifest.json"), "utf8")) as { gaps: string };
    render(<GapsReportView report={JSON.parse(readFileSync(join(data, manifest.gaps), "utf8")) as GapsReport} />);
    expect(document.querySelectorAll('[data-status="hand-built"]').length).toBeGreaterThan(0);
  });
});
