/** Elements: every component, token and rule of the system in one searchable list, with the element page beside it. */
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { type ElementTab, elementHref, formatId, tabOf } from "../../data/ids.ts";
import { countByKind, type ElementSummary, type Model } from "../../data/model.ts";
import { retryModel, useModelState, useUsageState } from "../../data/store.ts";
import type { ElementKind } from "../../data/types.ts";
import type { UsageIndex } from "../../data/usage.ts";
import { append } from "../../lib/append.ts";
import { noun } from "../../lib/plural.ts";
import { useSearch } from "../../search/client.ts";
import { Badge, SeverityBadge, StatusBadge } from "../../ui/Badge.tsx";
import { Keys } from "../../ui/Kbd.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { ResourceState, SplitView } from "../../ui/Pane.tsx";
import { Section } from "../../ui/Section.tsx";
import { Swatch } from "../../ui/Swatch.tsx";
import { ElementPage } from "../element/ElementPage.tsx";
import { ElementList, type KindFilter } from "./ElementList.tsx";

const KINDS: readonly ElementKind[] = ["token", "component", "rule", "migration"];

interface Selection {
  readonly id: string | null;
  readonly tab: ElementTab;
}

/** `/elements/<system>/<kind>/<name>[/<tab>]` → the selected element and tab. */
export function readSelection(rest: string): Selection {
  const [system, kind, name, tab] = rest.split("/");
  const validKind = KINDS.find((k) => k === kind);
  const id = system && validKind && name ? formatId(system, validKind, name) : null;
  return { id, tab: tabOf(tab) };
}

export function CatalogScreen() {
  const state = useModelState();
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryModel} what="the catalog" />;
  return <Catalog model={state.value} />;
}

function Catalog({ model }: { model: Model }) {
  const params = useParams<{ "*"?: string }>();
  const { id: selectedId, tab } = readSelection(params["*"] ?? "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<KindFilter>("all");
  const search = useSearch(model, query);

  const matched = useMemo((): readonly ElementSummary[] => (search.ids === null ? model.elements : search.ids.flatMap((id) => model.byId.get(id) ?? [])), [model, search.ids]);
  const results = useMemo(() => (filter === "all" ? matched : matched.filter((e) => e.kind === filter)), [matched, filter]);
  const counts = useMemo(() => countByKind(matched), [matched]);

  return (
    <SplitView
      listLabel="Elements"
      backHref="/elements"
      hasDetail={selectedId !== null}
      list={
        <ElementList
          model={model}
          results={results}
          grouped={search.ids === null}
          selectedId={selectedId}
          tab={tab}
          query={query}
          onQuery={setQuery}
          filter={filter}
          onFilter={setFilter}
          counts={counts}
          total={matched.length}
          searchMs={search.totalMs}
        />
      }
      detail={selectedId ? <ElementPage model={model} id={selectedId} tab={tab} /> : <NothingSelected model={model} />}
    />
  );
}

const SWATCHES = 16;
const TOKEN_NAMES = 3;

const ROW = "flex min-h-10 items-center gap-3 px-3 py-2 hover:bg-raised";
const PANEL = "divide-y divide-line overflow-hidden rounded-md border border-line";

/** A count from the usage map, or a dash while it is loading or could not be read (never a 0 it did not count). */
function Count({ value, unit }: { value: number | null; unit: string }) {
  if (value === null) return <span className="tabular text-small text-faint">–</span>;
  return (
    <span className="shrink-0 tabular text-small text-muted">
      <span className="text-ink">{value}</span> {unit}
    </span>
  );
}

/** With nothing picked, the detail pane shows the whole system at a glance instead of an empty state. */
function NothingSelected({ model }: { model: Model }) {
  const { scheme } = useTheme();
  const usage = useUsageState();
  return <SystemOverview model={model} index={usage.status === "ready" ? usage.value : null} scheme={scheme} />;
}

/** The overview itself: `index` is null while the usage map loads or when it could not be read. */
export function SystemOverview({ model, index, scheme }: { model: Model; index: UsageIndex | null; scheme: Scheme }) {
  const counts = countByKind(model.elements);
  const { system } = model.catalog;
  const components = model.elements.filter((e) => e.kind === "component");
  const rules = model.elements.filter((e) => e.kind === "rule");
  const groups = new Map<string, ElementSummary[]>();
  for (const token of model.elements) if (token.kind === "token") append(groups, token.group, token);
  // The model's tokens are in group order already, so the groups come out in it.
  const tokenGroups = [...groups];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div data-system-overview className="mx-auto max-w-4xl space-y-8 px-8 py-8 max-md:px-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-display">{system.name}</h2>
            <Badge tone="outline" className="tabular">
              v{system.version}
            </Badge>
          </div>
          <p className="text-reading text-muted">
            {counts.component} {noun(counts.component, "component")}, {counts.token} {noun(counts.token, "token")} and {counts.rule} {noun(counts.rule, "rule")}. Pick one to see its contract, tokens, rules and where it lives.
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-muted">
            <span className="flex items-center gap-1.5">
              <Keys keys={["j"]} /> <Keys keys={["k"]} /> browse
            </span>
            <span className="flex items-center gap-1.5">
              <Keys keys={["/"]} /> search
            </span>
            <span className="flex items-center gap-1.5">
              <Keys keys={["⌘", "K"]} /> jump anywhere
            </span>
          </p>
        </header>

        <Section title="Components" count={components.length}>
          <ul className={PANEL}>
            {components.map((component) => (
              <li key={component.id}>
                <Link href={elementHref(component.id)} className={ROW}>
                  <KindIcon element={component} scheme={scheme} />
                  <span className="shrink-0 font-medium text-ink">{component.name}</span>
                  <span className="min-w-0 flex-1 truncate text-small text-muted">{component.summary}</span>
                  {component.status && component.status !== "stable" && <StatusBadge status={component.status} />}
                  <Count value={index ? (index.sitesByElement.get(component.id)?.length ?? 0) : null} unit="sites" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Tokens" count={counts.token}>
          <ul className={PANEL}>
            {tokenGroups.map(([group, tokens]) => {
              const swatches = tokens.flatMap((t) => (t.swatch ? [t.swatch[scheme]] : []));
              return (
                <li key={group}>
                  <Link href={elementHref(tokens[0]!.id)} className={ROW}>
                    <span className="w-28 shrink-0 font-medium text-ink capitalize">{group}</span>
                    <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                      {swatches.length > 0
                        ? swatches.slice(0, SWATCHES).map((color, i) => <Swatch key={i} color={color} size="sm" />)
                        : <span className="truncate font-mono text-mono-sm text-muted">{tokens.slice(0, TOKEN_NAMES).map((t) => t.name).join("  ")}</span>}
                    </span>
                    <span className="shrink-0 tabular text-small text-muted">{tokens.length}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Rules" count={rules.length}>
          <ul className={PANEL}>
            {rules.map((rule) => {
              const broken = index ? (index.violationsByRule.get(rule.id)?.length ?? 0) : null;
              return (
                <li key={rule.id}>
                  <Link href={elementHref(rule.id)} className={ROW}>
                    <KindIcon element={rule} scheme={scheme} />
                    <span className="min-w-0 flex-1 truncate text-ink">{rule.name}</span>
                    {rule.severity && <SeverityBadge severity={rule.severity} />}
                    {broken === 0 ? <span className="shrink-0 text-small text-success">Clean</span> : <Count value={broken} unit={broken === 1 ? "violation" : "violations"} />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      </div>
    </div>
  );
}
