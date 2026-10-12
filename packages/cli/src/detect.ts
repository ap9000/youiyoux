/** Terminal output for `youi detect`: which UI libraries a repo or website uses, and what that covers. */
import type { DetectConfidence, DetectReport } from "@youiyoux/core";
import { padEnd, plural, style } from "./ui.ts";

const TONE: Record<DetectConfidence, (text: string) => string> = { high: style.ok, medium: style.warn, low: style.dim };

/** A repo path or URLs, never both: one report covers one kind of target. */
export function detectTarget(inputs: readonly string[]): { kind: "repo"; path: string } | { kind: "site"; urls: string[] } | null {
  const urls = inputs.filter((i) => /^https?:\/\//.test(i));
  if (inputs.length > 0 && urls.length === inputs.length) return { kind: "site", urls };
  if (inputs.length === 1 && urls.length === 0) return { kind: "repo", path: inputs[0]! };
  return null;
}

export function renderDetect(report: DetectReport, file: string): string {
  const lines = [`${style.bold("Detect")} ${style.dim(`· ${report.target.name} (${report.target.kind === "site" ? plural(report.pages.length, "page") : "repo"})`)}`, ""];
  if (report.libraries.length === 0) lines.push(style.dim("  no UI library found"));
  const width = Math.max(0, ...report.libraries.map((l) => l.name.length));
  for (const library of report.libraries) {
    lines.push(`  ${padEnd(library.name, width)}  ${TONE[library.confidence](padEnd(library.confidence, 6))}  ${style.dim(library.evidence.slice(0, 3).map((e) => `${e.detail}${e.count > 1 ? ` ×${e.count}` : ""}`).join(" · "))}`);
  }
  if (report.elements.length > 0) {
    lines.push("", style.bold("Elements"));
    for (const element of report.elements) lines.push(`  ${padEnd(element.type, 10)} ${element.library}${element.also.length ? style.dim(` (also ${element.also.join(", ")})`) : ""}${element.screenshot ? style.dim(`  ${element.screenshot}`) : ""}`);
  }
  if (report.unused.length > 0) {
    lines.push("", `${style.bold("Declared, never imported")} ${style.dim("· not counted")}`);
    for (const unused of report.unused) lines.push(`  ${unused.package}@${unused.version} ${style.dim(`in ${unused.declaredIn}`)}`);
  }
  if (report.fonts.length > 0) lines.push("", `${style.bold("Fonts")}  ${report.fonts.map((f) => f.family).join(", ")}`);
  for (const page of report.pages.filter((p) => p.status === "failed")) lines.push(style.error(`  ✖ ${page.url}: ${page.error ?? "failed"}`));
  for (const note of report.notes) lines.push(style.dim(`  · ${note}`));
  lines.push("", report.coverage, "", `${style.ok("wrote")} ${file} ${style.dim(`· see it in the hub: youi ui --detect ${file}`)}`);
  return lines.join("\n");
}
