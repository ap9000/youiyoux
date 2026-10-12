/** Signals → a validated youi.detect/v1 report, and writing it beside its screenshots. */
import { DetectReport, writeFileAtomic, type DetectFont, type DetectPage, type DetectUnused } from "@youiyoux/core";
import { join } from "node:path";
import { detectRepo } from "./repo.ts";
import { scoreElements, scoreLibraries, type ElementHit, type Signal } from "./score.ts";

export const DETECTOR = "youi-detect 0.1.0";
export const REPORT_FILE = "detect.json";

export interface ReportInput {
  readonly kind: "repo" | "site";
  readonly inputs: readonly string[];
  readonly name: string;
  readonly pages?: readonly DetectPage[];
  readonly coverage: string;
  readonly signals: readonly Signal[];
  readonly hits: readonly ElementHit[];
  readonly unused?: readonly DetectUnused[];
  readonly fonts?: readonly DetectFont[];
  readonly notes?: readonly string[];
  readonly now?: Date;
}

export function buildReport(input: ReportInput): DetectReport {
  const pagesOf = (library: string): string[] => [...new Set(input.signals.filter((s) => s.library === library && s.strength !== "support").flatMap((s) => (input.kind === "site" ? (s.where ?? []) : [])))];
  const libraries = scoreLibraries(input.signals, pagesOf);
  return DetectReport.parse({
    schema: "youi.detect/v1",
    generatedAt: (input.now ?? new Date()).toISOString(),
    detector: DETECTOR,
    target: { kind: input.kind, inputs: [...input.inputs], name: input.name },
    pages: [...(input.pages ?? [])],
    coverage: input.coverage,
    libraries,
    elements: scoreElements(input.hits, libraries),
    unused: [...(input.unused ?? [])],
    fonts: [...(input.fonts ?? [])],
    notes: [...new Set(input.notes ?? [])],
  });
}

export async function repoReport(root: string, now?: Date): Promise<DetectReport> {
  const scan = await detectRepo(root);
  return buildReport({ kind: "repo", inputs: [root], name: scan.name, coverage: scan.coverage, signals: scan.signals, hits: scan.hits, unused: scan.unused, fonts: scan.fonts, notes: scan.notes, ...(now ? { now } : {}) });
}

/** `<out>/detect.json`; screenshots already sit in `<out>/screenshots/`. */
export async function writeReport(report: DetectReport, out: string): Promise<string> {
  const file = join(out, REPORT_FILE);
  await writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
