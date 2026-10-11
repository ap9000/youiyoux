/**
 * One usage site as a row: where it is, the contract props it chooses (variant, size),
 * and everything else (handlers, aria, keys) behind an expand, wrapped rather than cut off.
 */
import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { ComponentContract, PropValue } from "../../data/types.ts";
import type { Site } from "../../data/usage.ts";

const HIDDEN_PROPS = new Set(["children"]);
/** Long lists render this many rows until asked for the rest. */
const PAGE = 50;

/** List items, the first PAGE of them until someone asks for all. */
export function Capped<T>({ items, render }: { items: readonly T[]; render: (item: T, i: number) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, PAGE);
  return (
    <>
      {shown.map(render)}
      {items.length > shown.length && (
        <li className="px-3 py-1.5">
          <button type="button" onClick={() => setAll(true)} className="text-small text-accent hover:underline">
            Show all {items.length}
          </button>
        </li>
      )}
    </>
  );
}

/** The props a contract defines as a choice (enums): what a reader of usage cares about first. */
export function choiceProps(contract: ComponentContract | undefined): string[] {
  if (!contract) return [];
  return Object.entries(contract.props)
    .filter(([, spec]) => spec.type === "enum")
    .map(([name]) => name);
}

function valueText(value: PropValue): string {
  return "literal" in value ? String(value.literal) : `{${value.dynamic}}`;
}

/** `dir/` (truncates first, hidden when narrow) then `file.tsx:12`, which always stays whole. */
export function SiteLocation({ site, className }: { site: Pick<Site, "file" | "line" | "column">; className?: string }) {
  const slash = site.file.lastIndexOf("/");
  return (
    <span className={clsx("flex min-w-0 font-mono text-mono-sm", className)} title={`${site.file}:${site.line}:${site.column}`}>
      <span className="min-w-0 truncate text-faint max-lg:hidden">{site.file.slice(0, slash + 1)}</span>
      <span className="shrink-0 text-ink-2">
        {site.file.slice(slash + 1)}
        <span className="text-muted">:{site.line}</span>
      </span>
    </span>
  );
}

function ChoiceChip({ name, value, fallback }: { name: string; value: PropValue | undefined; fallback: string | undefined }) {
  if (value === undefined) {
    return (
      <span className="shrink-0 font-mono text-mono-sm text-faint" title={`${name} not set: the default (${fallback ?? "none"}) applies`}>
        {name}={fallback ?? "–"}
      </span>
    );
  }
  const literal = "literal" in value;
  return (
    <span
      className={clsx("max-w-48 shrink-0 truncate rounded-xs px-1 font-mono text-mono-sm", literal ? "bg-neutral-soft text-ink-2" : "border border-dashed border-line-strong text-muted")}
      title={literal ? undefined : `Computed: ${value.dynamic}`}
    >
      {name}={literal ? String(value.literal) : "{…}"}
    </span>
  );
}

interface SiteRowProps {
  site: Site;
  choices: readonly string[];
  contract: ComponentContract | undefined;
  /** Shown at the end of the row, e.g. how the site reaches its screen. */
  aside?: string;
  /** Open with every prop visible. */
  showAll?: boolean;
}

export function SiteRow({ site, choices, contract, aside, showAll = false }: SiteRowProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const others = Object.entries(site.props).filter(([name]) => !choices.includes(name) && !HIDDEN_PROPS.has(name));
  const extra = others.length + (site.spread ? 1 : 0);
  const expanded = showAll || open;
  return (
    <li className="group px-3 py-1.5 hover:bg-raised">
      <div className="flex min-w-0 items-center gap-3">
        <SiteLocation site={site} className="w-[min(18rem,40%)] shrink-0" />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {choices.map((name) => {
            const spec = contract?.props[name];
            const fallback = spec && "default" in spec && spec.default !== undefined ? String(spec.default) : undefined;
            return <ChoiceChip key={name} name={name} value={site.props[name]} fallback={fallback} />;
          })}
        </span>
        {aside && <span className="shrink-0 text-caption text-faint max-md:hidden">{aside}</span>}
        {extra > 0 && !showAll && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-xs px-1 text-caption text-muted hover:bg-neutral-soft hover:text-ink"
            title={open ? "Hide other props" : "Show other props"}
          >
            <ChevronRight className={clsx("size-3 transition-transform duration-100", open && "rotate-90")} />+{extra}
            <span className="sr-only">{open ? "Hide" : "Show"} other props</span>
          </button>
        )}
      </div>
      {expanded && extra > 0 && (
        <dl id={detailsId} className="mt-1.5 mb-0.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 border-l border-line pl-3 font-mono text-mono-sm">
          {others.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted">{name}</dt>
              <dd className={clsx("min-w-0 break-words whitespace-pre-wrap", "literal" in value ? "text-ink-2" : "text-muted")}>{valueText(value)}</dd>
            </div>
          ))}
          {site.spread && (
            <div className="contents">
              <dt className="text-muted">{"{...}"}</dt>
              <dd className="text-muted">spread props: the scanner can't see what they set</dd>
            </div>
          )}
        </dl>
      )}
    </li>
  );
}
