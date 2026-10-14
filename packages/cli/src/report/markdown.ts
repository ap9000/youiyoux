/**
 * youiyoux-summary.md: a short summary to paste into a README or a pull request: the five
 * summary lines, the headline numbers, the top fixes with their next steps and the agent setup
 * line. Like the HTML, it is written from the cleaned model and holds no code by default.
 */
import { NPX, type ReportModel } from "./model.ts";

const STEPS_SHOWN = 5;

/** Text that stays text in Markdown: no stray emphasis, links, HTML or table breaks. */
const md = (text: string): string => text.replace(/([\\`*_[\]<>|#])/g, "\\$1");

export function renderMarkdown(model: ReportModel, reportFile: string): string {
  const t = model.totals;
  const lines = [
    `## youiyoux report: ${md(model.repo)}`,
    "",
    ...model.summary.map((line) => `- ${md(line)}`),
    "",
    "| Projects | Components | Near-duplicate groups | Hardcoded values | Off-library imports |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${t.projects} | ${t.definitions} | ${t.nearDuplicates} | ${t.hardcoded} | ${t.offLibrary} |`,
    "",
  ];
  if (model.topFixes.length > 0) {
    lines.push("**Top fixes**", "");
    model.topFixes.forEach((fix, i) => {
      lines.push(`${i + 1}. ${md(fix.title)}${model.projects.length > 1 && fix.project !== "." ? ` (${md(fix.project)})` : ""}  `);
      if (fix.lead && fix.steps && fix.steps.length > 0) {
        // What to keep, then the first few files; the full list is in the report.
        lines.push(`   Next: ${md(fix.lead)}.`, ...fix.steps.slice(0, STEPS_SHOWN).map((step) => `   - ${md(step.replace(/\.$/, ""))}`));
        if (fix.steps.length > STEPS_SHOWN) lines.push(`   - and ${fix.steps.length - STEPS_SHOWN} more ${fix.steps.length - STEPS_SHOWN === 1 ? "file" : "files"}, listed in the report`);
      } else lines.push(`   Next: ${md(fix.next.replace(/\.$/, ""))}.`);
    });
    lines.push("");
  }
  if (model.render.state !== "drawn" && model.render.note) lines.push(`${md(model.render.note)}${model.render.next ? ` Next: ${md(model.render.next)}.` : ""}`, "");
  lines.push(md(model.agent), "", `Full report: \`${reportFile}\`, made with \`${NPX}\`; paths are relative to the repo${model.includeCode ? "" : "; includes component names, class lists and counts, without source lines or literal prop/text captions"}.`, "");
  return lines.join("\n");
}
