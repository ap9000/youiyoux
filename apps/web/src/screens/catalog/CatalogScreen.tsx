/** Elements: every component, token and rule of the system in one searchable list, with the element page beside it. */
import { Boxes } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { type ElementTab, formatId, tabOf } from "../../data/ids.ts";
import { countByKind, type ElementSummary, type Model } from "../../data/model.ts";
import { retryModel, useModelState } from "../../data/store.ts";
import type { ElementKind } from "../../data/types.ts";
import { useSearch } from "../../search/client.ts";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Keys } from "../../ui/Kbd.tsx";
import { ResourceState, SplitView } from "../../ui/Pane.tsx";
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

function NothingSelected({ model }: { model: Model }) {
  const counts = countByKind(model.elements);
  const { system } = model.catalog;
  return (
    <EmptyState icon={Boxes} title={`${system.name} v${system.version}`}>
      <p>
        {counts.component} components, {counts.token} tokens and {counts.rule} rules. Pick one to see its contract, tokens, rules and where it lives.
      </p>
      <p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
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
    </EmptyState>
  );
}
