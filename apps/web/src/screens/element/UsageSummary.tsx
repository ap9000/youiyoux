/**
 * The top of Usage: what needs a look, how the contract's choices are spread
 * (bars, unused values tucked away), and the screens that use the element most.
 */
import { clsx } from "clsx";
import { CircleHelp, Copy, type LucideIcon, SquareDashed } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { Scheme } from "../../app/theme.tsx";
import { type ElementScreen, routeLabel, screenHref } from "../../data/screens.ts";
import { DYNAMIC, type ElementIssues, type PropFilters, UNSET, type ValueCount } from "../../data/usage.ts";
import { ScreenImage } from "../../ui/ScreenImage.tsx";
import { Section } from "../../ui/Section.tsx";

export type UsageView = "sites" | "lookalikes" | "unresolved";
export type ShowRequest = { readonly view: UsageView } | { readonly filter: readonly [prop: string, value: string] };

interface IssueRowProps {
  icon: LucideIcon;
  count: number;
  title: string;
  body: string;
  onShow: () => void;
}

function IssueRow({ icon: Icon, count, title, body, onShow }: IssueRowProps) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">
          <span className="tabular font-medium">{count}</span> {title}
        </p>
        <p className="text-small text-muted">{body}</p>
      </div>
      <button type="button" onClick={onShow} aria-label={`Show the ${count} ${title}`} className="shrink-0 rounded-sm px-1.5 py-0.5 text-small text-accent hover:bg-accent-soft">
        Show
      </button>
    </li>
  );
}

export function IssueList({ issues, name, fallback, onShow }: { issues: ElementIssues; name: string; fallback: string | undefined; onShow: (request: ShowRequest) => void }) {
  if (issues.total === 0) return null;
  const { unset } = issues;
  return (
    <Section title="To look at" count={issues.total}>
      <ul className="divide-y divide-line rounded-md border border-line">
        {issues.lookalikes > 0 && (
          <IssueRow
            icon={Copy}
            count={issues.lookalikes}
            title={issues.lookalikes === 1 ? "lookalike" : "lookalikes"}
            body={`Local components named ${name} that resolve elsewhere: candidates to replace with the owned one. Never counted as uses.`}
            onShow={() => onShow({ view: "lookalikes" })}
          />
        )}
        {unset && (
          <IssueRow
            icon={SquareDashed}
            count={unset.count}
            title={`${unset.count === 1 ? "site doesn't" : "sites don't"} set ${unset.prop}`}
            body={`They get the default ${unset.prop}${fallback && fallback !== "default" ? `, ${fallback}` : ""}. Worth checking that each one means it.`}
            onShow={() => onShow({ filter: [unset.prop, UNSET] })}
          />
        )}
        {issues.unresolved > 0 && (
          <IssueRow
            icon={CircleHelp}
            count={issues.unresolved}
            title={issues.unresolved === 1 ? "unresolved site" : "unresolved sites"}
            body={`The scanner couldn't tell whether these render ${name}. They are not counted either way.`}
            onShow={() => onShow({ view: "unresolved" })}
          />
        )}
      </ul>
    </Section>
  );
}

const valueLabel = (value: string): string => (value === UNSET ? "not set" : value === DYNAMIC ? "computed" : value);

function PropBars({ prop, counts, active, onToggle }: { prop: string; counts: readonly ValueCount[]; active: string | undefined; onToggle: (value: string) => void }) {
  const [showUnused, setShowUnused] = useState(false);
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const max = Math.max(1, ...counts.map((c) => c.count));
  const used = counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
  const unused = counts.filter((c) => c.count === 0 && c.value !== UNSET && c.value !== DYNAMIC);
  const rows = showUnused ? [...used, ...unused] : used;
  return (
    <div className="space-y-1.5">
      <h4 className="px-1.5 font-mono text-mono-sm text-muted">{prop}</h4>
      <ul className="space-y-0.5">
        {rows.map(({ value, count }) => {
          const selected = active === value;
          const special = value === UNSET || value === DYNAMIC;
          return (
            <li key={value}>
              <button
                type="button"
                aria-pressed={selected}
                disabled={count === 0}
                onClick={() => onToggle(value)}
                aria-label={`${prop} ${valueLabel(value)}: ${count} ${count === 1 ? "site" : "sites"}`}
                title={count === 0 ? "No site uses this value" : `${Math.round((count / total) * 100)}% of sites. Click to filter the list.`}
                className={clsx(
                  "grid w-full grid-cols-[6.5rem_1fr_2.5rem] items-center gap-2.5 rounded-sm px-1.5 py-1 text-left transition-colors duration-100 disabled:cursor-default",
                  selected ? "bg-accent-soft" : "enabled:hover:bg-raised",
                )}
              >
                <span className={clsx("truncate text-small", special ? "text-muted italic" : "font-mono text-ink-2", count === 0 && "text-faint")}>{valueLabel(value)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-neutral-soft">
                  <span className={clsx("block h-full rounded-full", selected ? "bg-accent" : special ? "bg-line-strong" : "bg-ink-2")} style={{ width: `${(count / max) * 100}%` }} />
                </span>
                <span className={clsx("tabular text-right text-small", count === 0 ? "text-faint" : "text-ink-2")}>{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {unused.length > 0 && (
        <button type="button" onClick={() => setShowUnused((v) => !v)} aria-expanded={showUnused} className="px-1.5 text-left text-small text-muted hover:text-ink">
          {showUnused ? "Hide unused values" : `${unused.length} unused: ${unused.map((u) => u.value).join(", ")}`}
        </button>
      )}
    </div>
  );
}

export function Distribution({ distribution, filters, onToggle }: { distribution: ReadonlyMap<string, readonly ValueCount[]>; filters: PropFilters; onToggle: (prop: string, value: string) => void }) {
  if (distribution.size === 0) return null;
  return (
    <Section title="How it's used" aside={<span className="text-small text-muted max-sm:hidden">Click a value to filter the sites</span>}>
      <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
        {[...distribution].map(([prop, counts]) => (
          <PropBars key={prop} prop={prop} counts={counts} active={filters[prop]} onToggle={(value) => onToggle(prop, value)} />
        ))}
      </div>
    </Section>
  );
}

const TOP_SCREENS = 4;

export function TopScreens({ list, scheme }: { list: readonly ElementScreen[]; scheme: Scheme }) {
  if (list.length === 0) return null;
  return (
    <Section title="Top screens">
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {list.slice(0, TOP_SCREENS).map(({ screen, sites }) => (
          <li key={`${screen.project}:${screen.route}`}>
            <Link href={screenHref(screen.project, screen.route)} className="group block overflow-hidden rounded-md border border-line transition-colors duration-100 hover:border-line-strong">
              <ScreenImage shot={screen.shot} scheme={scheme} size="thumb" label={`${screen.project} ${routeLabel(screen.route)}`} className="border-b border-line" />
              <span className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="truncate font-mono text-mono-sm text-ink">{routeLabel(screen.route)}</span>
                <span className="ml-auto tabular text-small text-muted">{sites}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
