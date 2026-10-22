/**
 * `youiyoux gaps`: what each project builds by hand or lacks, with what could stand in for it,
 * from an inventory of the projects (made here, or `--inventory <file>`), the System they follow
 * and the local Discover index (`youiyoux discover sync`; without it there are no candidates, and
 * it says so).
 */
import type { GapConcept, GapsReport } from "@youiyoux/core";
import { style } from "./ui.ts";

const where = (c: GapConcept): string => {
  const first = c.definitions.map((d) => `${d.file}:${d.line}`).slice(0, 2).join(", ");
  const parts = [c.count ? `${c.count} ${c.count === 1 ? "component" : "components"} named for it` : null, c.uses ? `${c.uses} ${c.uses === 1 ? "use" : "uses"}` : null, `in ${c.files} ${c.files === 1 ? "file" : "files"}`].filter(Boolean);
  return `${parts.join(", ")}${first ? ` (${first}${c.definitions.length > 2 ? ", …" : ""})` : ""}`;
};

const offered = (c: GapConcept): string =>
  c.candidates === null ? style.dim("no candidates: the Discover index is not synced") : c.candidates.length === 0 ? style.dim("no licensed candidate in the index") : c.candidates.map((x) => `${x.name} ${style.dim(`(${x.source}, ${x.licence}${x.copyleft ? ", copyleft" : ""})`)}`).join(" · ");

/** The report in a few lines per project, hand-built first, with the next step. */
export function renderGaps(report: GapsReport): string {
  const lines: string[] = [];
  for (const project of report.projects) {
    const by = (status: GapConcept["status"]) => project.concepts.filter((c) => c.status === status);
    const hand = by("hand-built");
    const missing = by("missing");
    lines.push(`${style.bold(project.id)}${project.complete ? "" : style.warn(" (some files could not be read: counts are a lower bound)")}${project.dependencies === "unread" ? style.dim(" (package.json not read: libraries only from imports)") : ""}`);
    if (hand.length) {
      lines.push("  Built by hand, with what could stand in for it:");
      for (const c of hand) lines.push(`    ${c.name.padEnd(16)} ${where(c)}`, `    ${"".padEnd(16)} ${offered(c)}`);
    }
    // Missing kinds in one line: their candidates are in --json and on the hub's Gaps page.
    if (missing.length) lines.push(`  Not in it, from the standard kit (${missing.length}): ${missing.map((c) => c.name).join(", ")}`);
    const library = by("library");
    if (library.length) lines.push(`  From libraries: ${library.map((c) => `${c.name} (${c.packages.join(", ")})`).join(", ")}`);
    const system = by("system");
    if (system.length) lines.push(`  In the System${report.system ? ` (${report.system})` : ""}: ${system.map((c) => c.name).join(", ")}`);
    lines.push("");
  }
  if (report.across.length) {
    lines.push("Built by hand in more than one project, worth adding to the System once:");
    for (const a of report.across) lines.push(`  ${a.name}: ${a.projects.join(", ")} (${a.uses} uses)`);
    lines.push("");
  }
  lines.push(report.discover === "synced" ? "Next: candidates for every gap are in youiyoux gaps --json and on the Gaps page of youiyoux ui; youiyoux discover show <id> for one. Nothing is installed." : "Next: youiyoux discover sync, then run youiyoux gaps again for candidates.");
  return lines.join("\n");
}
