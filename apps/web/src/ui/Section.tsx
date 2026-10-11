/** Detail-pane building blocks: titled sections and key/value facts. */
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface SectionProps {
  title: string;
  count?: number | string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ title, count, aside, children, className }: SectionProps) {
  return (
    <section className={clsx("space-y-2.5", className)}>
      <header className="flex min-h-6 items-center gap-2">
        <h3 className="text-heading">{title}</h3>
        {count !== undefined && <span className="tabular text-small text-muted">{count}</span>}
        {aside && <div className="ml-auto flex items-center gap-1.5">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Facts({ rows, className }: { rows: ReadonlyArray<readonly [string, ReactNode]>; className?: string }) {
  return (
    <dl className={clsx("grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-6 gap-y-2", className)}>
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted">{key}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A bordered table shell with dense rows and a muted header. */
export function Table({ head, children, className }: { head: readonly string[]; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("overflow-x-auto rounded-md border border-line", className)}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-sunken">
            {head.map((label) => (
              <th key={label} scope="col" className="h-8 px-3 text-small font-medium whitespace-nowrap text-muted">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line [&>tr:last-child]:border-0 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}
