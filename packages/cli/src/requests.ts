/**
 * `youiyoux requests`: the comments and change requests people pinned to components on captured
 * screens (`.youi/requests`), for an agent without the MCP tools. It lists them, shows one, replies
 * and marks one addressed, as an agent; closing and reopening are a person's, in the hub.
 */
import type { RequestBrief } from "@youiyoux/workflow";
import { style } from "./ui.ts";

/** The next step in commands rather than MCP tools. */
function cliNext(brief: RequestBrief): string {
  return brief.next
    .replace(/call request_addressed with what you changed \(file:line\)/, `run youiyoux requests addressed ${brief.id} --message "<what you changed, with file:line>"`)
    .replace(/request_reply/g, `youiyoux requests reply ${brief.id} --message "…"`);
}

export function renderBrief(brief: RequestBrief, full = false): string {
  const lines = [
    `${style.bold(brief.id)}  ${brief.kind}  ${brief.status === "open" ? style.warn(brief.status) : style.dim(brief.status)}  ${brief.route}  ${brief.component}${brief.lookalike ? style.dim(" (hand-built lookalike)") : ""}${brief.at ? `  ${brief.at}` : ""}`,
    `  “${brief.ask}” ${style.dim(`· ${brief.from} · ${brief.scope}`)}`,
  ];
  if (brief.picture) lines.push(`  ${style.dim("picture")} ${brief.picture}${brief.box ? style.dim(` (box ${brief.box.x},${brief.box.y} ${brief.box.width}×${brief.box.height} px)`) : ""}`);
  for (const entry of full ? brief.thread : brief.thread.slice(-2)) lines.push(`  ${style.dim("·")} ${entry}`);
  if (!full && brief.thread.length > 2) lines.push(style.dim(`  … ${brief.thread.length - 2} earlier in the thread: youiyoux requests show ${brief.id}`));
  lines.push(`  ${style.dim("next")} ${cliNext(brief)}`);
  return lines.join("\n");
}

export function renderRequests(briefs: readonly RequestBrief[], status: string, unreadable: ReadonlyArray<{ file: string; reason: string }>): string {
  const lines = briefs.length ? briefs.map((b) => renderBrief(b)) : [`No ${status === "all" ? "" : `${status} `}requests on the screens.`];
  for (const u of unreadable) lines.push(style.error(`✖ ${u.file} is not a youi.request/v1: ${u.reason}`));
  return lines.join("\n\n");
}
