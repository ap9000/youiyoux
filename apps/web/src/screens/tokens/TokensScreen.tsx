/** Token explorer: every token grouped by kind, with the palette as the overview and a detail per token. */
import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import { SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { tokenHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { retryModel, useModelState } from "../../data/store.ts";
import type { TokenEntry } from "../../data/types.ts";
import { markNavigation, record } from "../../lib/perf.ts";
import { useListKeys } from "../../shell/keyboard.ts";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { PaneHeader, ResourceState, SplitView } from "../../ui/Pane.tsx";
import { SearchField } from "../../ui/SearchField.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Swatch } from "../../ui/Swatch.tsx";
import { TokenDetail } from "./TokenDetail.tsx";

type Row = { readonly type: "header"; readonly group: string; readonly count: number } | { readonly type: "item"; readonly token: TokenEntry; readonly index: number };

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 30;

/** Tokens are few and their values are what people search for, so a substring match is exact and instant. */
export function filterTokens(tokens: readonly TokenEntry[], query: string): TokenEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tokens];
  return tokens.filter((t) => [t.path, t.cssVar, t.light, t.dark, t.description ?? ""].some((field) => field.toLowerCase().includes(q)));
}

function toRows(tokens: readonly TokenEntry[]): Row[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  const rows: Row[] = [];
  tokens.forEach((token, index) => {
    if (index === 0 || tokens[index - 1]!.group !== token.group) rows.push({ type: "header", group: token.group, count: counts.get(token.group) ?? 0 });
    rows.push({ type: "item", token, index });
  });
  return rows;
}

export function TokensScreen() {
  const state = useModelState();
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryModel} what="the tokens" />;
  return <TokenExplorer model={state.value} />;
}

function TokenExplorer({ model }: { model: Model }) {
  const params = useParams<{ "*"?: string }>();
  const [, navigate] = useLocation();
  const { scheme: hubScheme } = useTheme();
  const [scheme, setScheme] = useState<Scheme>(hubScheme);
  const [query, setQuery] = useState("");
  const selected = params["*"] ? (model.tokenByPath.get(params["*"]) ?? null) : null;
  const all = useMemo(() => [...model.tokens.values()], [model]);
  const tokens = useMemo(() => {
    const started = performance.now();
    const result = filterTokens(all, query);
    if (query.trim()) record("search", performance.now() - started);
    return result;
  }, [all, query]);
  const rows = useMemo(() => toRows(tokens), [tokens]);
  const getItemKey = useCallback((i: number) => { const row = rows[i]; return !row ? i : row.type === "header" ? `h:${row.group}` : row.token.id; }, [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (i) => (rows[i]?.type === "header" ? HEADER_HEIGHT : ROW_HEIGHT), getItemKey, overscan: 12 });
  const selectedIndex = selected ? tokens.findIndex((t) => t.id === selected.id) : -1;

  useListKeys({
    count: tokens.length,
    index: selectedIndex,
    onMove: (index) => {
      const token = tokens[index];
      if (!token) return;
      markNavigation(tokenHref(token.path));
      navigate(tokenHref(token.path), { replace: true });
    },
    onOpen: () => document.querySelector<HTMLElement>("[data-detail-heading]")?.focus(),
  });

  useEffect(() => {
    const rowIndex = rows.findIndex((row) => row.type === "item" && row.token.id === selected?.id);
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
  }, [rows, selected, virtualizer]);

  const list = (
    <>
      <PaneHeader title="Tokens" count={all.length}>
        <Segmented<Scheme> label="Show values for" value={scheme} onChange={setScheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </PaneHeader>
      <div className="border-b border-line p-3">
        <SearchField value={query} onChange={setQuery} label="Search tokens" placeholder="Search path, variable or value (#171717)…" />
      </div>
      {tokens.length === 0 ? (
        <EmptyState icon={SearchX} title="No tokens match">
          Nothing matches “{query.trim()}”.
        </EmptyState>
      ) : (
        <div ref={scrollRef} data-list-pane className="min-h-0 flex-1 overflow-y-auto py-1.5">
          <div role="list" aria-label="Tokens" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const style = { height: item.size, transform: `translateY(${item.start}px)` };
              if (row.type === "header") {
                return (
                  <div key={item.key} role="presentation" className="absolute inset-x-0 top-0 flex items-end gap-2 px-4.5 pb-1 text-caption text-muted capitalize" style={style}>
                    {row.group}
                    <span className="tabular text-faint">{row.count}</span>
                  </div>
                );
              }
              const { token } = row;
              const isSelected = token.id === selected?.id;
              const element = model.byId.get(token.id);
              return (
                <div key={item.key} role="listitem" className="absolute inset-x-0 top-0 px-1.5" style={style}>
                  <Link
                    href={tokenHref(token.path)}
                    aria-current={isSelected ? "true" : undefined}
                    className={clsx("flex h-full items-center gap-2.5 rounded-md px-3 transition-colors duration-75", isSelected ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-raised hover:text-ink")}
                  >
                    {token.type === "color" ? <Swatch color={token[scheme]} size="xs" className="m-0.5" /> : element && <KindIcon element={element} scheme={scheme} />}
                    <span className={clsx("shrink-0 font-mono text-mono", isSelected && "font-medium")}>{token.path.slice(token.group.length + 1)}</span>
                    <span className="min-w-0 flex-1 truncate text-right font-mono text-mono-sm text-faint">{token[scheme]}</span>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );

  return <SplitView listLabel="Tokens" backHref="/tokens" hasDetail={selected !== null} list={list} detail={selected ? <TokenDetail key={selected.id} model={model} token={selected} /> : <Palette model={model} />} />;
}

/** The overview: every colour of the system, light over dark, as one palette. */
function Palette({ model }: { model: Model }) {
  const colors = [...model.tokens.values()].filter((t) => t.type === "color");
  const { system } = model.catalog;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6 animate-enter">
      <header className="mb-5 space-y-1">
        <h2 className="text-title">{system.name} palette</h2>
        <p className="text-small text-muted">
          {colors.length} colours, each with a light and a dark value. Pick one for its alias chain, contrast and consumers.
        </p>
      </header>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
        {colors.map((token) => (
          <li key={token.id}>
            <Link href={tokenHref(token.path)} className="group block overflow-hidden rounded-lg border border-line transition-shadow duration-100 hover:shadow-popover">
              <div className="checker grid h-16 grid-cols-2">
                <span style={{ background: token.light }} />
                <span style={{ background: token.dark }} />
              </div>
              <div className="border-t border-line px-2.5 py-2">
                <div className="truncate font-mono text-mono-sm text-ink">{token.path.slice("color.".length)}</div>
                <div className="truncate font-mono text-caption text-faint">
                  {token.light} · {token.dark}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
