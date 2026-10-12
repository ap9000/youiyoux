/**
 * The Inventory page's filters: element type, library or kit, project, near-duplicates only, and
 * search by name or file. They combine, each option shows how many families it would show with
 * the others on, and they live in the URL (useFilters). On a phone they sit in a bottom sheet
 * behind a Filters button.
 */
import { clsx } from "clsx";
import { Check, SlidersHorizontal } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { activeFilters, filtersToSearch, NO_FILTERS, parseFilters, type FilterOption, type Filters, type filterCounts } from "../../data/inventory-view.ts";
import type { InventoryIndex } from "../../data/types.ts";
import { Button } from "../../ui/Button.tsx";
import { SearchField } from "../../ui/SearchField.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Sheet } from "./Sheet.tsx";

export type Counts = ReturnType<typeof filterCounts>;

/** The filters in the URL's query: read on every location change, written back in place (replace), so a reload keeps them. */
export function useFilters(index: Pick<InventoryIndex, "projects">): [Filters, (next: Filters) => void] {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const filters = useMemo(() => parseFilters(search, index), [search, index]);
  const set = useCallback((next: Filters) => navigate(`${path}${filtersToSearch(next)}`, { replace: true }), [path, navigate]);
  return [filters, set];
}

const ALL = "__all";

/** A count, or an ellipsis while the looks it needs are still loading. */
function CountLabel({ label, count }: { label: string; count: number | null }) {
  return (
    <>
      {label}
      <span className="tabular text-caption text-faint" title={count === null ? "Counting once its looks load" : undefined}>
        {count === null ? "…" : count}
      </span>
    </>
  );
}

function Choice<T extends string>({ label, value, all, options, onChange }: { label: string; value: T | null; all: number | null; options: ReadonlyArray<FilterOption<T>>; onChange: (value: T | null) => void }) {
  return (
    <div className="flex min-w-0 items-start gap-3 max-md:flex-col max-md:gap-1.5">
      <span className="w-16 shrink-0 pt-1 text-small text-muted md:text-right">{label}</span>
      <Segmented<string>
        label={label}
        wrap
        value={value ?? ALL}
        onChange={(next) => onChange(next === ALL ? null : (next as T))}
        options={[{ value: ALL, label: <CountLabel label="All" count={all} /> }, ...options.map((o) => ({ value: o.value, label: <CountLabel label={o.label} count={o.count} /> }))]}
      />
    </div>
  );
}

export function FilterControls({ filters, onChange, counts }: { filters: Filters; onChange: (next: Filters) => void; counts: Counts }) {
  return (
    <div className="space-y-2.5" data-testid="filter-controls">
      <Choice label="Type" value={filters.type} all={counts.all.type} options={counts.types} onChange={(type) => onChange({ ...filters, type })} />
      <Choice label="Library" value={filters.lib} all={counts.all.lib} options={counts.libs} onChange={(lib) => onChange({ ...filters, lib })} />
      <Choice label="Project" value={filters.project} all={counts.all.project} options={counts.projects} onChange={(project) => onChange({ ...filters, project })} />
    </div>
  );
}

function NearToggle({ filters, onChange, counts }: { filters: Filters; onChange: (next: Filters) => void; counts: Counts }) {
  return (
    <Button aria-pressed={filters.near} onClick={() => onChange({ ...filters, near: !filters.near })} className={clsx("inv-press", filters.near && "border-warning text-warning")}>
      <span aria-hidden className={clsx("grid size-3.5 place-items-center rounded-xs border", filters.near ? "border-warning bg-warning text-on-accent" : "border-line-strong")}>
        {filters.near && <Check className="size-2.5!" />}
      </span>
      Near-duplicates only
      <span className="tabular text-caption text-faint">{counts.near === null ? "…" : counts.near}</span>
    </Button>
  );
}

function Search({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  return <SearchField value={filters.q} onChange={(q) => onChange({ ...filters, q })} label="Search by name or file" placeholder="Search by name or file" className="w-full md:w-72" />;
}

function Summary({ shown, total, filters, onChange }: { shown: number | null; total: number; filters: Filters; onChange: (next: Filters) => void }): ReactNode {
  return (
    <p className="flex items-center gap-2 text-small text-muted" aria-live="polite">
      <span className="tabular">{shown === null ? `Counting ${total} families…` : `${shown} of ${total} ${total === 1 ? "family" : "families"}`}</span>
      {activeFilters(filters) > 0 && (
        <button type="button" className="inv-link inv-press text-accent" onClick={() => onChange(NO_FILTERS)}>
          Clear filters
        </button>
      )}
    </p>
  );
}

/** Above the wall on a desktop; a Filters button and a bottom sheet on a phone. */
export function FilterBar({ filters, onChange, counts, shown, total }: { filters: Filters; onChange: (next: Filters) => void; counts: Counts; shown: number | null; total: number }) {
  const [sheet, setSheet] = useState(false);
  const active = activeFilters(filters);
  return (
    <>
      <section aria-label="Filters" className="space-y-3 rounded-lg border border-line bg-surface p-4 max-md:hidden" data-testid="filter-bar">
        <div className="flex flex-wrap items-center gap-3">
          <Search filters={filters} onChange={onChange} />
          <NearToggle filters={filters} onChange={onChange} counts={counts} />
          <div className="ml-auto">
            <Summary shown={shown} total={total} filters={filters} onChange={onChange} />
          </div>
        </div>
        <FilterControls filters={filters} onChange={onChange} counts={counts} />
      </section>
      <div className="flex items-center gap-2 md:hidden" data-testid="filter-phone">
        <Button onClick={() => setSheet(true)} className="inv-press">
          <SlidersHorizontal /> Filters{active > 0 && <span className="tabular text-caption text-accent">{active}</span>}
        </Button>
        <Summary shown={shown} total={total} filters={filters} onChange={onChange} />
      </div>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        variant="sheet"
        title="Filters"
        description="They combine, and stay in the page's address."
        testId="filter-sheet"
        footer={
          <Button variant="primary" className="inv-press w-full" onClick={() => setSheet(false)}>
            {shown === null ? "Show families" : `Show ${shown} ${shown === 1 ? "family" : "families"}`}
          </Button>
        }
      >
        <div className="space-y-4 px-5 py-4">
          <Search filters={filters} onChange={onChange} />
          <NearToggle filters={filters} onChange={onChange} counts={counts} />
          <FilterControls filters={filters} onChange={onChange} counts={counts} />
        </div>
      </Sheet>
    </>
  );
}
