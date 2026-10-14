/**
 * Live snapshot status for `youiyoux ui --watch`: one dot in the nav rail that says whether
 * what is on screen is current and complete. Hidden for one-off snapshots.
 */
import { clsx } from "clsx";
import { useLiveState, type LiveState } from "../data/store.ts";

export type LiveTone = "live" | "incomplete" | "failed";

export interface LiveSummary {
  readonly tone: LiveTone;
  /** Short status for the tooltip's first line and for screen readers. */
  readonly label: string;
  readonly detail: string | null;
}

const TONE: Record<LiveTone, string> = { live: "bg-success", incomplete: "bg-warning", failed: "bg-danger" };

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** What the dot means right now, or null when the snapshot is not live. */
export function liveSummary(state: LiveState): LiveSummary | null {
  const info = state.manifest?.live;
  if (state.error) return { tone: "failed", label: "Not updating: the newest scan could not be loaded", detail: state.error };
  if (!info) return null;
  if (info.status === "failed") return { tone: "failed", label: `Scan failed at ${timeOf(info.updatedAt)}; showing the last good results`, detail: info.message ?? null };
  if (info.status === "partial") return { tone: "incomplete", label: `Incomplete: some files could not be analysed (${timeOf(info.updatedAt)})`, detail: info.message ?? info.rules ?? null };
  return { tone: "live", label: `Live: re-checked at ${timeOf(info.updatedAt)}`, detail: info.rules ?? null };
}

export function LiveStatus() {
  const summary = liveSummary(useLiveState());
  if (!summary) return null;
  return (
    <div className="group relative grid size-9 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus" tabIndex={0} aria-label={summary.label}>
      <span className={clsx("size-2 rounded-full", TONE[summary.tone])} />
      <span role="status" className="sr-only">
        {summary.label}
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-full z-40 ml-2.5 w-max max-w-80 rounded-md border border-line bg-surface px-2 py-1.5 text-small text-ink opacity-0 shadow-popover transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-300 group-focus-visible:opacity-100"
      >
        <span className="block font-medium">{summary.label}</span>
        {summary.detail && <span className="mt-0.5 block font-mono break-words text-muted">{summary.detail}</span>}
      </span>
    </div>
  );
}
