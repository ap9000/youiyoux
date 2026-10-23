/**
 * Usage: the summary first (what needs a look, how the contract's choices are spread,
 * the top screens), then every site, collapsed per screen, filterable by those choices.
 */
import { clsx } from "clsx";
import { ArrowUpRight, ChevronRight, MapPinOff, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useTheme } from "../../app/theme.tsx";
import type { Model } from "../../data/model.ts";
import { screenHref, screensOf, screensOfElement } from "../../data/screens.ts";
import { retryUsage, type Resource } from "../../data/store.ts";
import type { ComponentContract } from "../../data/types.ts";
import { elementIssues, enumDefault, EVERY_SCREEN, filterSites, groupByScreen, propDistribution, type PropFilters, type Site, summarize, UNROUTED, type UsageIndex, valueLabel } from "../../data/usage.ts";
import { shortSha } from "../../lib/format.ts";
import { Badge } from "../../ui/Badge.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { ResourceState } from "../../ui/Pane.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Capped, choiceProps, SiteLocation, SiteRow } from "./sites.tsx";
import { Distribution, IssueList, type ShowRequest, TopScreens, type UsageView } from "./UsageSummary.tsx";

/** Lists this short open every screen group; longer ones start collapsed. */
const AUTO_OPEN_SITES = 24;

const ROUTE_SOURCE: Record<Site["routeSource"], string> = {
  "route-file": "screen file",
  "imported-by": "imported by a screen",
  shell: "app shell",
  unrouted: "not on a screen",
};

function ScreenGroups({ sites, contract, showAll }: { sites: readonly Site[]; contract: ComponentContract; showAll: boolean }) {
  const groups = useMemo(() => groupByScreen(sites), [sites]);
  const choices = choiceProps(contract);
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>({});
  const autoOpen = sites.length <= AUTO_OPEN_SITES;
  if (sites.length === 0) return <p className="rounded-md border border-line px-3 py-4 text-small text-muted">No site matches these filters.</p>;
  return (
    <div className="space-y-4">
      {groups.map((project) => (
        <div key={project.project} className="space-y-1.5">
          {groups.length > 1 && (
            <h4 className="flex items-baseline gap-2 text-small text-muted">
              <span className="font-medium text-ink">{project.project}</span>
              {project.commit && <span className="font-mono text-mono-sm">@{shortSha(project.commit)}</span>}
            </h4>
          )}
          <div className="rounded-md border border-line">
            {project.screens.map((screen) => {
              const key = `${project.project}\u0000${screen.route}`;
              const isOpen = open[key] ?? autoOpen;
              const label = screen.route === EVERY_SCREEN ? "every screen" : screen.route;
              return (
                <div key={key} className="border-b border-line last:border-b-0">
                  <div className="flex items-center pr-2 hover:bg-raised">
                    <button type="button" aria-expanded={isOpen} onClick={() => setOpen((current) => ({ ...current, [key]: !isOpen }))} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left">
                      <ChevronRight aria-hidden className={clsx("size-3.5 shrink-0 text-faint transition-transform duration-100", isOpen && "rotate-90")} />
                      <span className="truncate font-mono text-mono text-ink">{label}</span>
                      {screen.route === EVERY_SCREEN && <Badge tone="outline">app shell</Badge>}
                      <span className="tabular text-small text-muted">{screen.sites.length}</span>
                    </button>
                    {screen.route !== UNROUTED && (
                      <Link href={screenHref(project.project, screen.route, contract.id)} className="grid size-6 shrink-0 place-items-center rounded-xs text-muted hover:bg-neutral-soft hover:text-ink" aria-label={`Open the ${label} screen`} title="Open the screen">
                        <ArrowUpRight className="size-3.5" />
                      </Link>
                    )}
                  </div>
                  {isOpen && (
                    <ul className="pb-1.5">
                      <Capped
                        items={screen.sites}
                        render={(site) => (
                          <SiteRow key={`${site.fingerprint}:${site.line}:${site.column}`} site={site} choices={choices} contract={contract} showAll={showAll} aside={site.via ? `via ${site.via.split("/").pop()}` : ROUTE_SOURCE[site.routeSource]} />
                        )}
                      />
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

interface OtherRow {
  readonly project: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly label: string;
  readonly detail: string;
}

function OtherList({ rows, intro }: { rows: readonly OtherRow[]; intro: string }) {
  return (
    <div className="space-y-2">
      <p className="text-small text-muted">{intro}</p>
      <ul className="divide-y divide-line rounded-md border border-line">
        <Capped
          items={rows}
          render={(row) => (
            <li key={`${row.project}:${row.file}:${row.line}:${row.column}:${row.label}`} className="space-y-0.5 px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <SiteLocation site={row} className="min-w-0" />
                <code className="shrink-0 font-mono text-mono-sm text-ink">{row.label}</code>
              </div>
              <p className="text-small break-words text-muted">{row.detail}</p>
            </li>
          )}
        />
      </ul>
    </div>
  );
}

function Usage({ model, contract, index }: { model: Model; contract: ComponentContract; index: UsageIndex }) {
  const { scheme } = useTheme();
  const all = useMemo(() => index.sitesByElement.get(contract.id) ?? [], [index, contract.id]);
  const [filters, setFilters] = useState<PropFilters>({});
  const [view, setView] = useState<UsageView>("sites");
  const [showAll, setShowAll] = useState(false);
  const distribution = useMemo(() => propDistribution(all, contract), [all, contract]);
  const sites = useMemo(() => filterSites(all, filters), [all, filters]);
  const issues = useMemo(() => elementIssues(index, contract), [index, contract]);
  const onScreens = useMemo(() => screensOfElement(screensOf(index, model.manifest), contract.id), [index, model.manifest, contract.id]);
  const lookalikes = index.lookalikesByElement.get(contract.id) ?? [];
  const unresolved = index.unknownsByCandidate.get(contract.id) ?? [];
  const listRef = useRef<HTMLElement>(null);
  const summary = summarize(all);
  const report = index.reports[0];

  const toggle = (prop: string, value: string): void => {
    setView("sites");
    setFilters((current) => {
      const { [prop]: previous, ...rest } = current;
      return previous === value ? rest : { ...rest, [prop]: value };
    });
  };
  const show = (request: ShowRequest): void => {
    if ("view" in request) setView(request.view);
    else {
      setView("sites");
      setFilters({ [request.filter[0]]: request.filter[1] });
    }
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: "start" }));
  };

  if (all.length === 0 && issues.total === 0) {
    return (
      <EmptyState icon={MapPinOff} title="Not used yet">
        No scanned project renders {contract.name}. It may be new, or only reached through code the scanner could not resolve.
      </EmptyState>
    );
  }

  const active = Object.entries(filters);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-8 p-6 max-sm:px-4">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
          <span className="tabular">
            <span className="text-heading text-ink">{summary.sites}</span> uses · <span className="text-ink-2">{summary.screens}</span> screens · <span className="text-ink-2">{summary.files}</span> files · <span className="text-ink-2">{summary.projects}</span> {summary.projects === 1 ? "project" : "projects"}
          </span>
          {report?.status === "partial" && (
            <Badge tone="warning" title={report.scanner}>
              Partial scan
            </Badge>
          )}
        </p>
        <IssueList issues={issues} name={contract.name} onShow={show} />
        <Distribution contract={contract} distribution={distribution} filters={filters} onToggle={toggle} />
        <TopScreens list={onScreens} scheme={scheme} select={contract.id} />

        <section ref={listRef} aria-labelledby="usage-sites" className="scroll-mt-4 space-y-3">
          <header className="flex flex-wrap items-center gap-2">
            <h3 id="usage-sites" className="text-heading">
              Where
            </h3>
            {(lookalikes.length > 0 || unresolved.length > 0) && (
              <Segmented<UsageView>
                label="Show"
                value={view}
                onChange={setView}
                options={[
                  { value: "sites", label: "Sites", count: sites.length },
                  ...(lookalikes.length > 0 ? [{ value: "lookalikes" as const, label: "Lookalikes", count: lookalikes.length }] : []),
                  ...(unresolved.length > 0 ? [{ value: "unresolved" as const, label: "Unresolved", count: unresolved.length }] : []),
                ]}
              />
            )}
            {view === "sites" &&
              active.map(([prop, value]) => (
                <button key={prop} type="button" onClick={() => toggle(prop, value)} className="inline-flex h-6 items-center gap-1 rounded-sm bg-accent-soft px-2 text-small text-accent hover:bg-accent-soft/70" aria-label={`Remove filter ${prop} ${valueLabel(value, enumDefault(contract, prop))}`}>
                  <span className="font-mono">{prop}</span> {valueLabel(value, enumDefault(contract, prop))} <X className="size-3" />
                </button>
              ))}
            {view === "sites" && (
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-small text-muted hover:text-ink">
                <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} className="accent-accent" />
                All props
              </label>
            )}
          </header>
          {view === "sites" && <ScreenGroups key={JSON.stringify(filters)} sites={sites} contract={contract} showAll={showAll} />}
          {view === "lookalikes" && (
            <OtherList
              intro={`Components named like ${contract.name} that resolve elsewhere: candidates to replace with the owned one. Not counted as uses.`}
              rows={lookalikes.map((l) => ({ project: l.project, file: l.file, line: l.line, column: l.column, label: `<${l.local}>`, detail: `Resolves to ${l.resolved}` }))}
            />
          )}
          {view === "unresolved" && (
            <OtherList
              intro="Sites the scanner could not resolve. They might be this component; they are never counted as zero."
              rows={unresolved.map((u) => ({ project: u.project, file: u.file, line: u.line, column: u.column, label: u.name, detail: `${u.reason}: ${u.detail}` }))}
            />
          )}
        </section>
      </div>
    </div>
  );
}

export function UsageTab({ model, contract, usage }: { model: Model; contract: ComponentContract; usage: Resource<UsageIndex> }) {
  if (usage.status !== "ready") return <ResourceState state={usage} onRetry={retryUsage} what="the usage map" />;
  return <Usage model={model} contract={contract} index={usage.value} />;
}
