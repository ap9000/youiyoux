/** `youiyoux inventory` text output: roles × projects, families, near-duplicates, flags and Storybook stories. */
import { INVENTORY_ROLES, type InventoryFamily, type InventoryReport, type InventoryShape } from "@youiyoux/core";
import { padEnd, padStart, plural, rule, style } from "./ui.ts";

const FAMILIES_PER_ROLE = 6;

/** `h32 px12 py0 r8 14px 500`; unknown dimensions show as `?`. */
function shapeLabel(shape: InventoryShape): string {
  const v = (n: number | null): string => (n === null ? "?" : String(n));
  const radius = shape.radius === 9999 ? "pill" : v(shape.radius);
  return `h${v(shape.height)} px${v(shape.paddingX)} py${v(shape.paddingY)} r${radius} ${v(shape.fontSize)}px ${v(shape.fontWeight)}`;
}

function kitName(kit: string | null): string {
  return kit ? kit.slice(kit.indexOf(":") + 1) : "no kit";
}

function familyLines(family: InventoryFamily): string[] {
  const stories = family.stories ? style.dim(`  + ${plural(family.stories, "story", "stories")}`) : "";
  if (family.authored) return [`  ${padEnd(family.id, 18)} ${padEnd(shapeLabel(family.shape), 30)} ${padStart("0 looks", 9)}  ${family.projects.join(", ")}  ${style.dim(`only in Storybook: ${plural(family.stories ?? 0, "story", "stories")}`)}`];
  const head = `  ${padEnd(family.id, 18)} ${padEnd(shapeLabel(family.shape), 30)} ${padStart(plural(family.looks, "look"), 9)}  ${family.projects.join(", ")}${family.nearDuplicate ? `  ${style.warn("near-duplicate")}` : ""}${stories}`;
  const sides = family.sides.map((side) => {
    const first = side.examples[0];
    const at = first ? `${first.file}:${first.line}${first.routes.length > 0 ? ` ${style.dim(first.routes.join(" "))}` : ""}` : "";
    return `      ${style.dim(padEnd(`${side.project} · ${kitName(side.kit)}`, 40))} ${padStart(String(side.looks), 3)}  ${at}`;
  });
  return [head, ...sides];
}

/**
 * Per project with Storybook: how many stories were read and drawn, each one skipped with
 * file:line and why, and what drawn stories were drawn without. Nothing when no project has stories.
 */
function storyLines(report: InventoryReport): string[] {
  const lines: string[] = [];
  for (const project of report.projects) {
    const stories = project.stories;
    if (!stories) continue;
    const head = `${plural(stories.read, "story", "stories")} in ${plural(stories.files, "file")}, ${stories.drawn} added as authored states beside their components`;
    lines.push(`${style.bold("Storybook")}${report.projects.length > 1 ? ` ${style.dim(project.id)}` : ""}: ${head}${stories.skipped.length > 0 ? `; ${stories.skipped.length} skipped:` : ""}`);
    for (const skip of stories.skipped) lines.push(`  ${style.warn("!")} ${skip.file}:${skip.line} ${skip.name} ${style.dim("—")} ${skip.reason}`);
    for (const note of stories.notes) lines.push(style.dim(`  · ${note}`));
  }
  return lines;
}

/** What to do next with the stories: fix the skipped ones, or see the drawn ones beside the real uses. */
function storyNext(report: InventoryReport, outFile: string): string | null {
  const stories = report.projects.flatMap((p) => (p.stories ? [p.stories] : []));
  if (stories.length === 0) return null;
  const open = `youiyoux ui --inventory ${outFile}`;
  const skipped = stories.reduce((n, s) => n + s.skipped.length, 0);
  if (skipped > 0) return `Next: rewrite the skipped stories as CSF 3 args stories of a component in this project (or fix the file), run youiyoux inventory again, then see them beside their real uses with ${open}`;
  return `Next: see the stories beside their real uses with ${open}`;
}

export function renderInventory(report: InventoryReport, outFile: string): string {
  const projects = report.projects.map((p) => p.id);
  // Stories are authored states, not uses: the counts are of real looks.
  const uses = report.looks.filter((l) => !l.story);
  const roles = INVENTORY_ROLES.filter((role) => uses.some((l) => l.role === role));
  const width = Math.max(...projects.map((p) => p.length), 9);
  const cell = (role: string, project: string): string => {
    const looks = uses.filter((l) => l.role === role && l.project === project);
    const families = new Set(looks.flatMap((l) => (l.family ? [l.family] : []))).size;
    return looks.length === 0 ? style.dim("·") : `${families}f ${looks.length}`;
  };
  const lines = [
    `${style.bold("inventory")} ${style.dim(`· ${plural(report.projects.length, "project")} · ${plural(report.summary.looks, "look")} in ${plural(report.families.length, "family", "families")}${report.summary.stories ? ` · ${plural(report.summary.stories, "story", "stories")} beside them` : ""}`)}`,
    "",
    `  ${padEnd("", 15)}${projects.map((p) => padStart(p, width + 2)).join("")}   ${style.dim("families (f) and looks per project")}`,
    ...roles.map((role) => `  ${padEnd(role, 15)}${projects.map((p) => padStart(cell(role, p), width + 2)).join("")}`),
    "",
  ];
  for (const role of INVENTORY_ROLES) {
    const families = report.families.filter((f) => f.role === role);
    if (families.length === 0) continue;
    lines.push(style.bold(role));
    for (const family of families.slice(0, FAMILIES_PER_ROLE)) lines.push(...familyLines(family));
    if (families.length > FAMILIES_PER_ROLE) lines.push(style.dim(`  … ${families.length - FAMILIES_PER_ROLE} more (--json)`));
  }
  const near = report.families.filter((f) => f.nearDuplicate).length;
  lines.push("", rule(), `${plural(near, "near-duplicate family", "near-duplicate families")} ${style.dim("(one look built in more than one project or kit)")}`);
  for (const flag of report.flags) {
    if (flag.kind === "duplicate-definition") lines.push(style.warn(`  ! ${flag.name} is defined ${flag.locations.length} times: `) + flag.locations.map((l) => `${l.project}:${l.file}:${l.line}`).join(", "));
    else lines.push(style.warn(`  ! ${flag.project}:${flag.file} imports ${new Set(flag.imports.map((i) => i.kit)).size} kits' ${flag.role} in ${plural(flag.imports.length, "import")}: `) + flag.imports.map((i) => `${i.name} from ${kitName(i.kit)} (line ${i.line})`).join(", "));
  }
  lines.push(
    "",
    style.dim(`${plural(report.summary.notClustered, "breakpoint/state class", "breakpoint/state classes")} recorded, not clustered · ${plural(report.summary.unshaped, "look")} with no resolved shape, not clustered`),
    style.dim(`a family's looks are all within: height ±${report.tolerance.height}px · padding ±${report.tolerance.padding}px · radius ±${report.tolerance.radius}px · font size ±${report.tolerance.fontSize}px · weight ±${report.tolerance.fontWeight} · colour ignored`),
  );
  for (const project of report.projects) {
    const status = project.status === "complete" ? style.ok("complete") : style.warn(`partial: ${plural(project.failed.length, "file")} not fully read`);
    lines.push(style.dim(`${project.id}: ${plural(project.files, "file")} in ${project.root}${project.commit ? ` at ${project.commit.slice(0, 12)}` : ""} · routes: ${project.routes} · `) + status);
    for (const f of project.failed) lines.push(style.warn(`  ! ${f.file}: ${f.reason}`));
    for (const w of project.warnings) lines.push(style.warn(`  ! ${w}`));
  }
  const stories = storyLines(report);
  if (stories.length > 0) lines.push("", ...stories);
  lines.push(style.dim(`inventory → ${outFile}`));
  const next = storyNext(report, outFile);
  if (next) lines.push(next);
  return lines.join("\n");
}
