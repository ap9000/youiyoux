/**
 * Where it lives: every site that renders the component, grouped project → screen,
 * filterable by the props it is given. Long site lists are virtualized.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import { FolderGit2, MapPinOff } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { retryUsage, type Resource } from "../../data/store.ts";
import type { ComponentContract } from "../../data/types.ts";
import { DYNAMIC, EVERY_SCREEN, filterSites, groupByScreen, propDistribution, type PropFilters, type Site, summarize, UNSET, type UsageIndex, type ValueCount } from "../../data/usage.ts";
import { Badge } from "../../ui/Badge.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { ResourceState } from "../../ui/Pane.tsx";
import { Segmented } from "../../ui/Segmented.tsx";

type Row =
  | { readonly type: "project"; readonly project: string; readonly commit: string | null; readonly sites: number; readonly screens: number }
  | { readonly type: "screen"; readonly route: string; readonly sites: number }
  | { readonly type: "site"; readonly site: Site }
  | { readonly type: "other"; readonly project: string; readonly file: string; readonly line: number; readonly label: string; readonly detail: string };

type View = "sites" | "lookalikes" | "unresolved";

const SIZES = { project: 44, screen: 34, site: 30, other: 48 } as const;
const OVERSCAN = 16;
const SHORT_SHA = 7;

const ROUTE_SOURCE: Record<Site["routeSource"], string> = {
  "route-file": "screen file",
  "imported-by": "imported by a screen",
  shell: "app shell",
  unrouted: "not on a screen",
};

/** A key unique per row and stable across filters, so the virtualizer never reuses stale offsets. */
function rowKey(row: Row | undefined, index: number): string {
  if (!row) return String(index);
  if (row.type === "project") return `p:${row.project}`;
  if (row.type === "screen") return `s:${row.route}`;
  if (row.type === "site") return `x:${row.site.routes.join(",")}:${row.site.fingerprint}:${index}`;
  return `o:${row.file}:${row.line}:${row.label}`;
}

function toRows(sites: readonly Site[]): Row[] {
  return groupByScreen(sites).flatMap((project): Row[] => [
    { type: "project", project: project.project, commit: project.commit, sites: project.sites, screens: project.screens.filter((s) => s.route !== EVERY_SCREEN).length },
    ...project.screens.flatMap((screen): Row[] => [{ type: "screen", route: screen.route, sites: screen.sites.length }, ...screen.sites.map((site): Row => ({ type: "site", site }))]),
  ]);
}

function PropChips({ site }: { site: Site }) {
  const entries = Object.entries(site.props).filter(([name]) => name !== "children" && name !== "className");
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {entries.map(([name, value]) => (
        <span key={name} className={clsx("shrink-0 rounded-xs px-1 font-mono text-mono-sm", "literal" in value ? "bg-neutral-soft text-ink-2" : "border border-dashed border-line-strong text-muted")}>
          {name}={"literal" in value ? String(value.literal) : `{${value.dynamic}}`}
        </span>
      ))}
      {site.spread && <span className="shrink-0 font-mono text-mono-sm text-muted">{"{...}"}</span>}
    </span>
  );
}

function PropFilter({ prop, counts, active, onToggle }: { prop: string; counts: readonly ValueCount[]; active: string | undefined; onToggle: (value: string) => void }) {
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 font-mono text-mono-sm text-muted">{prop}</span>
      {counts
        .filter((c) => c.count > 0 || (c.value !== UNSET && c.value !== DYNAMIC))
        .map(({ value, count }) => {
          const selected = active === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              disabled={count === 0}
              onClick={() => onToggle(value)}
              title={total ? `${Math.round((count / total) * 100)}% of sites` : undefined}
              className={clsx(
                "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-small transition-colors duration-100 disabled:opacity-45",
                selected ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:border-line-strong hover:text-ink",
                value === UNSET || value === DYNAMIC ? "italic" : "font-mono",
              )}
            >
              {value === UNSET ? "not set" : value}
              <span className="tabular text-caption not-italic text-muted">{count}</span>
            </button>
          );
        })}
    </div>
  );
}

function RowView({ row }: { row: Row }) {
  if (row.type === "other") {
    return (
      <div className="flex h-full flex-col justify-center gap-0.5 border-b border-line px-6">
        <span className="flex items-center gap-2 font-mono text-mono-sm">
          <span className="text-muted">{row.project}</span>
          <span className="truncate text-ink-2">
            {row.file}
            <span className="text-muted">:{row.line}</span>
          </span>
          <span className="text-ink">{row.label}</span>
        </span>
        <span className="truncate text-small text-muted">{row.detail}</span>
      </div>
    );
  }
  if (row.type === "project") {
    return (
      <div className="flex h-full items-end gap-2 border-b border-line px-6 pb-2">
        <FolderGit2 className="mb-0.5 size-4 text-muted" />
        <span className="font-medium text-ink">{row.project}</span>
        {row.commit && <span className="font-mono text-mono-sm text-muted">@{row.commit.slice(0, SHORT_SHA)}</span>}
        <span className="ml-auto tabular text-small text-muted">
          {row.sites} sites · {row.screens} screens
        </span>
      </div>
    );
  }
  if (row.type === "screen") {
    return (
      <div className="flex h-full items-center gap-2 px-6 pt-1">
        <span className="font-mono text-mono text-ink">{row.route === EVERY_SCREEN ? "every screen" : row.route}</span>
        {row.route === EVERY_SCREEN && <Badge tone="outline">app shell</Badge>}
        <span className="tabular text-small text-muted">{row.sites}</span>
      </div>
    );
  }
  const { site } = row;
  return (
    <div className="group flex h-full items-center gap-3 pr-6 pl-10 hover:bg-raised max-sm:pl-6">
      <span className="w-72 shrink-0 truncate font-mono text-mono-sm text-ink-2 max-lg:w-48 max-sm:w-32" title={`${site.file}:${site.line}:${site.column}`}>
        {site.file.split("/").pop()}
        <span className="text-muted">:{site.line}</span>
      </span>
      <PropChips site={site} />
      <span className="ml-auto shrink-0 text-caption text-faint opacity-0 group-hover:opacity-100">{site.via ? `via ${site.via.split("/").pop()}` : ROUTE_SOURCE[site.routeSource]}</span>
    </div>
  );
}

function Sites({ contract, index }: { contract: ComponentContract; index: UsageIndex }) {
  const all = useMemo(() => index.sitesByElement.get(contract.id) ?? [], [index, contract.id]);
  const [filters, setFilters] = useState<PropFilters>({});
  const distribution = useMemo(() => propDistribution(all, contract), [all, contract]);
  const sites = useMemo(() => filterSites(all, filters), [all, filters]);
  const [view, setView] = useState<View>("sites");
  const lookalikes = index.lookalikesByElement.get(contract.id) ?? [];
  const unresolved = index.unknownsByCandidate.get(contract.id) ?? [];
  const rows = useMemo((): Row[] => {
    if (view === "lookalikes") return lookalikes.map((l) => ({ type: "other", project: l.project, file: l.file, line: l.line, label: `<${l.local}>`, detail: `Resolves to ${l.resolved}, not ${contract.name}. Not counted as usage.` }));
    if (view === "unresolved") return unresolved.map((u) => ({ type: "other", project: u.project, file: u.file, line: u.line, label: u.name, detail: `${u.reason}: ${u.detail}` }));
    return toRows(sites);
  }, [view, sites, lookalikes, unresolved, contract.name]);
  const summary = summarize(sites);
  const scrollRef = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((i: number) => rowKey(rows[i], i), [rows]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (i) => SIZES[rows[i]?.type ?? "site"], getItemKey, overscan: OVERSCAN });
  const report = index.reports[0];

  const toggle = (prop: string, value: string): void =>
    setFilters((current) => {
      const { [prop]: previous, ...rest } = current;
      return previous === value ? rest : { ...rest, [prop]: value };
    });

  if (all.length === 0) {
    return (
      <EmptyState icon={MapPinOff} title="Not used yet">
        No scanned project renders {contract.name}. It may be new, or only reached through code the scanner could not resolve.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-line px-6 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-muted">
          <span className="tabular">
            <span className="text-heading text-ink">{summary.sites}</span> sites · <span className="text-ink-2">{summary.screens}</span> screens · <span className="text-ink-2">{summary.files}</span> files · <span className="text-ink-2">{summary.projects}</span> {summary.projects === 1 ? "project" : "projects"}
          </span>
          {report && report.status === "partial" && (
            <Badge tone="warning" title={report.scanner}>
              Partial scan
            </Badge>
          )}
          {Object.keys(filters).length > 0 && (
            <button type="button" onClick={() => setFilters({})} className="ml-auto text-small text-accent hover:underline">
              Clear filters
            </button>
          )}
        </div>
        {(lookalikes.length > 0 || unresolved.length > 0) && (
          <Segmented<View>
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "sites", label: "Sites", count: summary.sites },
              { value: "lookalikes", label: "Lookalikes", count: lookalikes.length },
              { value: "unresolved", label: "Unresolved", count: unresolved.length },
            ]}
          />
        )}
        {view === "sites" &&
          [...distribution].map(([prop, counts]) => <PropFilter key={prop} prop={prop} counts={counts} active={filters[prop]} onToggle={(value) => toggle(prop, value)} />)}
        {view !== "sites" && (
          <p className="text-small text-muted">
            {view === "lookalikes" ? `Components named like ${contract.name} that resolve elsewhere: candidates to replace with the owned one.` : "Sites the scanner could not resolve. They might be this component; they are never counted as zero."}
          </p>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div key={item.key} className="absolute inset-x-0 top-0" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
              <RowView row={rows[item.index]!} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WhereTab({ contract, usage }: { contract: ComponentContract; usage: Resource<UsageIndex> }) {
  if (usage.status !== "ready") return <ResourceState state={usage} onRetry={retryUsage} what="the usage map" />;
  return <Sites contract={contract} index={usage.value} />;
}
