/**
 * Registries: every registry in shadcn's directory, for someone who does not know their names. Each
 * says what it is, in its own words, and how many items it has; the biggest come first (yours and
 * the official one before them), or by name, narrowed by words ("animated", "landing page").
 * Browse its items opens Discover on that registry; one that is not among your sources opens
 * Discover's Every registry, which fetches every registry's listings once when asked. Nothing is
 * fetched here: the list is the directory `youiyoux discover sync` keeps.
 */
import { ArrowLeft, ArrowUpRight, Library } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { compact, EMPTY_QUERY, queryToSearch } from "../../data/discover.ts";
import { fetchRegistries, type RegistryPage, type RegistryRow, type RegistrySort } from "../../data/registries.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Select } from "../../ui/Field.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";
import { SearchField } from "../../ui/SearchField.tsx";

const PAGE = 48;
const TYPING_MS = 250;
/** Words to start from, when the field is empty. */
const SUGGESTIONS = ["animated", "blocks", "landing page", "dashboard", "forms", "charts"];

type Loaded = { status: "loading" } | { status: "ready"; page: RegistryPage; rows: readonly RegistryRow[] } | { status: "error"; message: string };

/** Where Browse its items goes: Discover on that registry, among every registry's unless it is yours or the official one. */
export const browseHref = (row: Pick<RegistryRow, "name" | "state">): string => `/discover${queryToSearch({ ...EMPTY_QUERY, source: row.name, every: row.state !== "official" && row.state !== "source" })}`;

const STATE_LABEL: Readonly<Record<RegistryRow["state"], string | null>> = { official: "Official", source: "Your source", listed: null, available: null };

export function RegistriesScreen() {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const q = (params.get("q") ?? "").slice(0, 200);
  const sort: RegistrySort = params.get("sort") === "name" ? "name" : "items";
  const go = (next: { q?: string; sort?: RegistrySort }): void => {
    const out = new URLSearchParams();
    const nq = next.q ?? q;
    const ns = next.sort ?? sort;
    if (nq.trim()) out.set("q", nq);
    if (ns !== "items") out.set("sort", ns);
    const text = out.toString();
    navigate(`${path}${text ? `?${text}` : ""}`, { replace: true });
  };

  // The field types freely; the address (and the list) follows once typing pauses.
  const [typed, setTyped] = useState(q);
  const latest = useRef({ q, sort });
  latest.current = { q, sort };
  useEffect(() => setTyped(q), [q]);
  useEffect(() => {
    if (typed === latest.current.q) return;
    const timer = setTimeout(() => go({ q: typed }), TYPING_MS);
    return () => clearTimeout(timer);
    // go reads the latest address itself.
  }, [typed]);

  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [more, setMore] = useState(0);
  useEffect(() => setMore(0), [q, sort]);
  useEffect(() => {
    const controller = new AbortController();
    if (more === 0) setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    fetchRegistries({ q, sort, offset: more, limit: PAGE }, { signal: controller.signal }).then(
      (page) => setState((s) => ({ status: "ready", page, rows: more > 0 && s.status === "ready" ? [...s.rows, ...page.rows] : page.rows })),
      (error: unknown) => !controller.signal.aborted && setState({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => controller.abort();
  }, [q, sort, more]);

  const page = state.status === "ready" ? state.page : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-screen="registries">
      <PaneHeader title="Registries" count={page?.total}>
        <Link href="/discover" className="inline-flex items-center gap-1 text-small text-muted hover:text-ink max-md:h-11">
          <ArrowLeft aria-hidden className="size-4" /> Discover
        </Link>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 px-6 py-6 max-sm:space-y-4 max-sm:px-4">
          <div className="space-y-2">
            <p className="max-w-2xl text-small text-muted">Every registry in shadcn's directory, in its own words. Browse one's items to see them running in your theme.</p>
            <SearchField value={typed} onChange={setTyped} placeholder="What are you after: animated, landing page, dashboard…" label="Search registries" touch className="max-w-2xl" />
            {!q && (
              <div className="flex flex-wrap items-center gap-1.5 text-small text-muted">
                <span>Try</span>
                {SUGGESTIONS.map((word) => (
                  <button key={word} type="button" onClick={() => setTyped(word)} className="rounded-sm border border-line px-2 py-0.5 text-ink-2 hover:bg-raised max-md:py-2.5">
                    {word}
                  </button>
                ))}
              </div>
            )}
          </div>
          {state.status === "loading" && (
            <p aria-busy="true" className="text-small text-faint">
              Reading the registry directory…
            </p>
          )}
          {state.status === "error" && (
            <EmptyState icon={Library} title="No registry list here">
              {state.message}
            </EmptyState>
          )}
          {state.status === "ready" && state.rows.length === 0 && (
            <EmptyState icon={Library} title={`No registry says “${q}”`}>
              Try fewer words, or another way of putting it.
            </EmptyState>
          )}
          {state.status === "ready" && state.rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="min-w-0 flex-1 text-small text-muted" data-registries-summary>
                  {q ? `For “${q}”: ` : ""}
                  {state.page.total} {state.page.total === 1 ? "registry" : "registries"}
                  {state.page.left + state.page.icons > 0 && <span className="text-faint max-sm:hidden"> · {[state.page.left ? `${state.page.left} hidden or unavailable` : "", state.page.icons ? `${state.page.icons} icon sets` : ""].filter(Boolean).join(" and ")} left out</span>}
                </p>
                <label className="flex items-center gap-1.5 text-small text-muted">
                  Sort
                  <Select value={sort} onChange={(event) => go({ sort: event.target.value === "name" ? "name" : "items" })} className="w-auto max-md:h-11" data-registry-sort>
                    <option value="items">Most items</option>
                    <option value="name">Name A–Z</option>
                  </Select>
                </label>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Registries">
                {state.rows.map((row) => (
                  <RegistryCard key={row.name} row={row} fetched={state.page.every !== null} />
                ))}
              </ul>
              {state.rows.length < state.page.total && (
                <Button onClick={() => setMore(state.rows.length)} className="max-md:h-11" data-more>
                  Show {Math.min(PAGE, state.page.total - state.rows.length)} more
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One registry. With every registry's listings fetched (`fetched`), one with none of them to show
 * (a mirror whose items are listed under their own registries, or none Discover can draw) says so
 * instead of offering an empty page.
 */
function RegistryCard({ row, fetched }: { row: RegistryRow; fetched: boolean }) {
  const label = STATE_LABEL[row.state];
  const empty = fetched && row.listed === null && row.state === "available";
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3" data-registry={row.name} data-state={row.state}>
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 truncate font-mono text-body font-medium text-ink">{row.name}</h3>
        {label && <Badge tone={row.state === "official" ? "accent" : "neutral"}>{label}</Badge>}
      </div>
      <p className="line-clamp-3 min-h-[3lh] text-small text-ink-2">{row.description ?? <span className="text-faint">It says nothing about itself.</span>}</p>
      <p className="tabular text-caption text-muted" data-count>
        {row.listed !== null ? `${compact(row.listed)} to browse` : empty ? "Nothing of its own to browse here" : row.itemCount !== null ? `${compact(row.itemCount)} ${row.itemCount === 1 ? "item" : "items"}` : "Items not counted"}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {!empty && (
          <Button asChild size="sm" className="max-md:h-11">
            <Link href={browseHref(row)} aria-label={`Browse ${row.name}'s items`} data-browse={row.name}>
              Browse its items
            </Link>
          </Button>
        )}
        {row.homepage && (
          <a href={row.homepage} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-small text-muted hover:text-ink max-md:h-11" aria-label={`${row.name}'s site (opens a new tab)`}>
            Its site <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}
