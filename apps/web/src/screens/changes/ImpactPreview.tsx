/** "This would flag N places": the preview's count, what it cannot promise, and the list. */
import { clsx } from "clsx";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { Preview, PreviewFinding } from "../../data/workflow.ts";
import { Badge, type BadgeTone } from "../../ui/Badge.tsx";
import { Segmented } from "../../ui/Segmented.tsx";

const MAX_SHOWN = 150;

const CHANGE: Record<PreviewFinding["change"], { label: string; tone: BadgeTone }> = {
  new: { label: "New", tone: "accent" },
  kept: { label: "Already flagged", tone: "neutral" },
  resolved: { label: "No longer flagged", tone: "success" },
};

type Filter = "all" | PreviewFinding["change"];

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

export function ImpactPreview({ preview, project, stale }: { preview: Preview; project: string; stale: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => (filter === "all" ? preview.findings : preview.findings.filter((f) => f.change === filter)), [preview, filter]);
  const options = [
    { value: "all" as const, label: "All", count: preview.findings.length },
    { value: "new" as const, label: "New", count: preview.counts.new },
    ...(preview.counts.kept ? [{ value: "kept" as const, label: "Already", count: preview.counts.kept }] : []),
    ...(preview.counts.resolved ? [{ value: "resolved" as const, label: "No longer", count: preview.counts.resolved }] : []),
  ];
  return (
    <div className={clsx("space-y-4", stale && "opacity-60")}>
      <div className="space-y-1">
        <p className="text-title">
          {preview.enforced ? (
            <>
              Would flag <span className="tabular">{plural(preview.flagged, "place")}</span>
              {preview.flagged > 0 && <span className="text-muted"> in {plural(preview.files, "file")}</span>}
            </>
          ) : (
            "Flags nothing"
          )}
        </p>
        <p className="text-small text-muted">
          <span className="tabular">{preview.counts.new}</span> new · <span className="tabular">{preview.counts.kept}</span> already flagged · <span className="tabular">{preview.counts.resolved}</span> no longer flagged
          {preview.counts.suppressed > 0 && (
            <>
              {" "}
              · <span className="tabular">{preview.counts.suppressed}</span> silenced by youi-ignore
            </>
          )}
        </p>
        <p className="font-mono text-mono-sm text-muted">
          {project}
          {preview.snapshot.projectCommit ? ` @ ${preview.snapshot.projectCommit.slice(0, 7)}` : ""}
          {preview.snapshot.projectChanges ? " + uncommitted edits" : ""} · {plural(preview.scan.files, "file")} scanned · {preview.durationMs} ms · {new Date(preview.at).toLocaleTimeString()}
        </p>
      </div>
      {preview.limits.length > 0 && (
        <ul className="space-y-1.5 rounded-md bg-warning-soft px-3 py-2">
          {preview.limits.map((limit) => (
            <li key={limit} className="flex gap-2 text-small text-ink-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              {limit}
            </li>
          ))}
        </ul>
      )}
      {preview.findings.length > 0 && (
        <div className="space-y-2">
          <Segmented label="Show" value={filter} options={options} onChange={setFilter} />
          <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto rounded-md border border-line">
            {shown.slice(0, MAX_SHOWN).map((f) => (
              <li key={`${f.change}:${f.file}:${f.line}:${f.column}:${f.text}`} className="space-y-1 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge tone={CHANGE[f.change].tone}>{CHANGE[f.change].label}</Badge>
                  <span className="min-w-0 truncate font-mono text-mono-sm text-ink-2">
                    {f.file}
                    <span className="text-muted">:{f.line}</span>
                  </span>
                </div>
                <p className="text-small text-ink-2">{f.message}</p>
                <code className="block truncate font-mono text-mono-sm text-muted">{f.text}</code>
                {f.suggestion && <p className="text-small text-muted">Try: {f.suggestion}</p>}
              </li>
            ))}
          </ul>
          {(shown.length > MAX_SHOWN || preview.truncated) && <p className="text-small text-muted">Showing the first {Math.min(shown.length, MAX_SHOWN)}. Run youi check in the project for the full list.</p>}
        </div>
      )}
    </div>
  );
}
