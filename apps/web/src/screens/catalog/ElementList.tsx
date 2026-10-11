/** The element list: search, kind filter, and a virtualized, keyboard-driven list of rows. */
import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import { SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useTheme } from "../../app/theme.tsx";
import { type ElementTab, elementHref } from "../../data/ids.ts";
import type { ElementSummary, Model } from "../../data/model.ts";
import type { ElementKind } from "../../data/types.ts";
import { markNavigation } from "../../lib/perf.ts";
import { useListKeys } from "../../shell/keyboard.ts";
import { SeverityBadge, StatusBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";
import { SearchField } from "../../ui/SearchField.tsx";
import { Segmented } from "../../ui/Segmented.tsx";

export type KindFilter = "all" | Exclude<ElementKind, "migration">;

type Row = { readonly type: "header"; readonly label: string; readonly count: number } | { readonly type: "item"; readonly element: ElementSummary; readonly index: number };

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 30;
const OVERSCAN = 12;

const GROUP_LABEL: Record<string, string> = { component: "Components", rule: "Rules" };
const groupLabel = (element: ElementSummary): string => GROUP_LABEL[element.group] ?? `${element.group[0]!.toUpperCase()}${element.group.slice(1)} tokens`;

/** Flatten results into rows; with no query they are grouped under section headers. */
export function toRows(results: readonly ElementSummary[], grouped: boolean): Row[] {
  if (!grouped) return results.map((element, index) => ({ type: "item", element, index }));
  const counts = new Map<string, number>();
  for (const element of results) counts.set(groupLabel(element), (counts.get(groupLabel(element)) ?? 0) + 1);
  const rows: Row[] = [];
  let current = "";
  results.forEach((element, index) => {
    const label = groupLabel(element);
    if (label !== current) {
      rows.push({ type: "header", label, count: counts.get(label) ?? 0 });
      current = label;
    }
    rows.push({ type: "item", element, index });
  });
  return rows;
}

function Trailing({ element }: { element: ElementSummary }) {
  if (element.status) return element.status === "stable" ? null : <StatusBadge status={element.status} />;
  if (element.severity) return <SeverityBadge severity={element.severity} />;
  return null;
}

interface ElementListProps {
  model: Model;
  results: readonly ElementSummary[];
  grouped: boolean;
  selectedId: string | null;
  tab: ElementTab;
  query: string;
  onQuery: (query: string) => void;
  filter: KindFilter;
  onFilter: (filter: KindFilter) => void;
  counts: Record<ElementKind, number>;
  total: number;
  searchMs: number | null;
}

export function ElementList({ model, results, grouped, selectedId, tab, query, onQuery, filter, onFilter, counts, total, searchMs }: ElementListProps) {
  const [, navigate] = useLocation();
  const { scheme } = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => toRows(results, grouped), [results, grouped]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    // Keys tied to the rows: a new row list with the same length must not reuse old offsets.
    getItemKey: useCallback((i: number) => { const row = rows[i]; return !row ? i : row.type === "header" ? `h:${row.label}` : row.element.id; }, [rows]),
    overscan: OVERSCAN,
  });

  const selectedIndex = results.findIndex((e) => e.id === selectedId);
  const hrefFor = (element: ElementSummary): string => elementHref(element.id, element.kind === "component" ? tab : undefined);

  useListKeys({
    count: results.length,
    index: selectedIndex,
    onMove: (index) => {
      const element = results[index];
      if (!element) return;
      markNavigation(hrefFor(element));
      navigate(hrefFor(element), { replace: true });
    },
    onOpen: () => document.querySelector<HTMLElement>("[data-detail-heading]")?.focus(),
  });

  useEffect(() => {
    const rowIndex = rows.findIndex((row) => row.type === "item" && row.element.id === selectedId);
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
  }, [rows, selectedId, virtualizer]);

  return (
    <>
      <PaneHeader title="Elements" count={model.elements.length} />
      <div className="space-y-2 border-b border-line p-3">
        <SearchField value={query} onChange={onQuery} label="Search elements" placeholder="Search name, value, prop, rule…" />
        <Segmented
          label="Element kind"
          value={filter}
          onChange={onFilter}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          options={[
            { value: "all", label: "All", count: total },
            { value: "component", label: "Components", count: counts.component },
            { value: "token", label: "Tokens", count: counts.token },
            { value: "rule", label: "Rules", count: counts.rule },
          ]}
        />
      </div>
      {results.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No matches"
          actions={
            <Button size="sm" onClick={() => (onQuery(""), onFilter("all"))}>
              Clear search
            </Button>
          }
        >
          Nothing in {model.catalog.system.name} matches “{query.trim()}”{filter !== "all" ? ` among ${filter}s` : ""}.
        </EmptyState>
      ) : (
        <div ref={scrollRef} data-list-pane className="min-h-0 flex-1 overflow-y-auto py-1.5">
          <div role="list" aria-label="Elements" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const style = { height: item.size, transform: `translateY(${item.start}px)` };
              if (row.type === "header") {
                return (
                  <div key={item.key} role="presentation" className="absolute inset-x-0 top-0 flex items-end gap-2 px-4.5 pb-1 text-caption text-muted" style={style}>
                    {row.label}
                    <span className="tabular text-faint">{row.count}</span>
                  </div>
                );
              }
              const { element } = row;
              const selected = element.id === selectedId;
              return (
                <div key={item.key} role="listitem" className="absolute inset-x-0 top-0 px-1.5" style={style}>
                  <Link
                    href={hrefFor(element)}
                    aria-current={selected ? "true" : undefined}
                    className={clsx(
                      "flex h-full items-center gap-2.5 rounded-md px-3 transition-colors duration-75",
                      selected ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-raised hover:text-ink",
                    )}
                  >
                    <KindIcon element={element} scheme={scheme} />
                    <span className={clsx("truncate", selected ? "font-medium" : "")}>{element.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-mono-sm text-faint">{element.kind === "rule" || element.key !== element.name ? (element.kind === "token" ? "" : element.key) : ""}</span>
                    <Trailing element={element} />
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-line px-4 text-caption text-muted">
        <span className="tabular">
          {results.length === model.elements.length ? `${results.length} elements` : `${results.length} of ${model.elements.length}`}
        </span>
        {searchMs !== null && <span className="tabular">searched in {searchMs.toFixed(1)} ms</span>}
      </footer>
    </>
  );
}
