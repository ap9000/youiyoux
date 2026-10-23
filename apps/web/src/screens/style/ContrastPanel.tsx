/** Colour pairs below WCAG AA with the edits applied: new ones first, each with its ratio and what it needs. */
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Badge, GRADE_TONE } from "../../ui/Badge.tsx";
import type { ContrastWarning } from "./model.ts";

export function ContrastPanel({ warnings }: { warnings: readonly ContrastWarning[] }) {
  const fresh = warnings.filter((w) => w.isNew).length;
  return (
    <section aria-labelledby="contrast-heading" className="space-y-2">
      <header className="flex items-center gap-2">
        {warnings.length > 0 ? <TriangleAlert aria-hidden className="size-4 text-warning" /> : <CircleCheck aria-hidden className="size-4 text-success" />}
        <h3 id="contrast-heading" className="text-heading">
          Contrast
        </h3>
        <span className="text-small text-muted" role="status">
          {warnings.length === 0 ? "every checked pair meets WCAG AA" : `${warnings.length} pair(s) below WCAG AA${fresh ? `, ${fresh} from these edits` : ""}`}
        </span>
      </header>
      {warnings.length > 0 && (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {warnings.map((w) => (
            <li key={`${w.pair.key}|${w.scheme}`} className="flex items-center gap-2.5 px-3 py-2">
              <span aria-hidden className="edge grid size-7 shrink-0 place-items-center rounded-sm text-small font-semibold" style={{ background: w.background, color: w.foreground }}>
                Aa
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small text-ink">{w.pair.label}</span>
                <span className="block text-caption text-muted">
                  <span className="capitalize">{w.scheme}</span> · needs {w.required}:1 {w.pair.kind === "ui" ? "(UI part)" : w.pair.kind === "large" ? "(large text)" : "(text)"}
                  {w.unreadable && <span className="block truncate text-danger">{w.unreadable}</span>}
                </span>
              </span>
              <span className="tabular font-mono text-mono-sm text-ink">{w.ratio?.toFixed(2) ?? "?"}</span>
              {w.grade ? <Badge tone={GRADE_TONE[w.grade]}>{w.grade}</Badge> : <Badge tone="danger">Unreadable</Badge>}
              {w.isNew && <Badge tone="danger">New</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
