/**
 * Discover: UI components from outside (shadcn registries and npm), found by need, previewed in
 * the user's own theme, compared with what the project already builds, and saved or put up for
 * adoption as drafts for a person to approve. Never downloaded wholesale, never installed:
 *
 *   1. Search reads listings only: /__youi/query on the hub's own server (the local index,
 *      paged and faceted), or on a static host the snapshot's listings, searched in memory.
 *   2. Opening a result is the one step that fetches anything: only that item's source, bundled
 *      by the hub's server and drawn in a sandboxed frame with the project's CSS (candidate.tsx).
 *   3. From an Inventory family (Find alternatives) the family is pinned, and every opened
 *      candidate gets a compare card beside it (PinnedCompare).
 *
 * With pictures from `youiyoux discover previews` (discover-thumbs.ts), results are a gallery:
 * each candidate as it draws in the project's theme, in the hub's scheme, with a type strip to
 * browse by when nothing is searched; `view=list` keeps the plain list.
 *
 * Everything matching can be paged through, in a chosen order (recommended, name, registry or most
 * downloaded) and 20, 50 or 100 to a page; numbered pages jump anywhere.
 *
 * The query, the facets, the order, the pinned family, the open candidate and the view live in the URL. The page
 * paints from nothing but its own shell (search, facets, result cards); listings arrive after.
 * What exists only once something is opened or pinned (the drawer, the specimen tiles, the
 * sandboxed frames, the compare cards) is its own chunk (Opened.tsx), and its frames mount only
 * near the screen.
 */
import { clsx } from "clsx";
import { ArrowLeft, ArrowRight, ChevronDown, Compass, LayoutGrid, Library, List, SlidersHorizontal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { descriptionOf, findDiscoverHit, parseQuery, PER_PAGE, queryToSearch, searchDiscover, signalLines, SORT_LABELS, SORT_SUMMARIES, SORTS, sourceOf, type DiscoverHit, type DiscoverPage, type DiscoverQuery, type DiscoverSort } from "../../data/discover.ts";
import { hasPictures, shortReason, useThumbs, type Thumbs } from "../../data/discover-thumbs.ts";
import type { InventorySource } from "../../data/inventory-source.ts";
import { everyStatus, NO_SERVER, startEvery, type EveryStatus } from "../../data/registries.ts";
import type { Resource } from "../../data/store.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Select } from "../../ui/Field.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";
import { SearchField } from "../../ui/SearchField.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { LicenceBadge } from "./LicenceBadge.tsx";

/** The parts that exist once something is opened or pinned: one chunk, fetched then and not before. */
const loadOpened = () => import("./Opened.tsx");
const PinnedSection = lazy(() => loadOpened().then((m) => ({ default: m.PinnedSection })));
const CandidateLayer = lazy(() => loadOpened().then((m) => ({ default: m.CandidateLayer })));

/** Needs to start from, when the field is empty. */
const SUGGESTIONS = ["command menu", "date picker", "toast", "dialog", "tabs"];
const TYPING_MS = 250;
const ROLE_FACETS = 12;
/** Every registry lists hundreds of sources: the biggest few, and the one chosen. */
const SOURCE_FACETS = 12;
/** How often a fetch of every registry's listings is asked how far it has got. */
const EVERY_POLL_MS = 1_000;
/** Browsing the gallery with nothing searched: a shelf for each of the commonest types. */
const SHELVES = 8;
const SHELF_SIZE = 4;

type Loaded = { status: "loading" } | { status: "ready"; page: DiscoverPage } | { status: "error"; message: string };

/** One page of listings for the query (its search part only; the open candidate and the pin do not search again). */
function useListings(query: DiscoverQuery, generation = 0): Loaded {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const key = `${queryToSearch({ ...query, open: null, family: null })}#${generation}`;
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    searchDiscover(query, { signal: controller.signal }).then(
      (page) => setState({ status: "ready", page }),
      (error: unknown) => !controller.signal.aborted && setState({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => controller.abort();
    // The key is the query's search part.
  }, [key]);
  return state;
}

export function DiscoverScreen() {
  return <DiscoverView />;
}

/** The page; a pinned family is read from `inventory` (a test's), else from the snapshot's, loaded only when a family is pinned. */
export function DiscoverView({ inventory }: { inventory?: Resource<InventorySource | null> }) {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const query = useMemo(() => parseQuery(search), [search]);
  const setQuery = useCallback((next: DiscoverQuery) => navigate(`${path}${queryToSearch(next)}`, { replace: true }), [path, navigate]);
  const { scheme } = useTheme();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  // The field types freely; the URL (and the search) follows once typing pauses.
  const [typed, setTyped] = useState(query.q);
  const latest = useRef(query);
  latest.current = query;
  useEffect(() => setTyped(query.q), [query.q]);
  useEffect(() => {
    if (typed === latest.current.q) return;
    const timer = setTimeout(() => setQuery({ ...latest.current, q: typed, offset: 0 }), TYPING_MS);
    return () => clearTimeout(timer);
  }, [typed, setQuery]);

  // Every registry's listings arriving: the same search, asked again.
  const [generation, setGeneration] = useState(0);
  const listings = useListings(query, generation);
  const page = listings.status === "ready" ? listings.page : null;
  const thumbs = useThumbs();
  const gallery = query.view ? query.view === "gallery" : hasPictures(thumbs);

  // Every listing seen this visit, so an open candidate stays open across pages and searches.
  const seen = useRef(new Map<string, DiscoverHit>());
  for (const hit of page?.hits ?? []) seen.current.set(hit.id, hit);
  const [opened, setOpened] = useState<string[]>(() => (query.open ? [query.open] : []));
  // The project candidates are drawn in: the pinned family's, else the hub's first (the server's choice).
  const [project, setProject] = useState<string | null>(null);
  const open = (hit: DiscoverHit): void => {
    seen.current.set(hit.id, hit);
    setOpened((list) => (list.includes(hit.id) ? list : [...list, hit.id]));
    setQuery({ ...query, open: hit.id });
  };
  // A link that opens a candidate on no page shown (shared, or bookmarked): that one listing, asked for once the page has loaded.
  const [, setLinked] = useState<string | null>(null);
  useEffect(() => {
    const id = query.open;
    if (!id || listings.status === "loading" || seen.current.has(id)) return;
    const controller = new AbortController();
    findDiscoverHit(id, { signal: controller.signal }).then(
      (hit) => {
        if (!hit) return;
        seen.current.set(hit.id, hit);
        setLinked(hit.id);
        // A link by ref (@initium/hero-section-1): the address takes the listing's own id.
        if (hit.id !== id) {
          setOpened((list) => [...new Set(list.map((open) => (open === id ? hit.id : open)))]);
          setQuery({ ...latest.current, open: hit.id });
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [query.open, listings.status]);
  const openHit = query.open ? (seen.current.get(query.open) ?? null) : null;
  // On a phone the facets fold away behind one button, so the results are on the first screen.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const closeHit = useCallback(() => setQuery({ ...latest.current, open: null }), [setQuery]);

  const set = (patch: Partial<DiscoverQuery>): void => setQuery({ ...query, ...patch, offset: 0, open: null });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-screen="discover">
      <PaneHeader title="Discover" count={page?.matched}>
        <Badge tone="outline" className="max-sm:hidden">Outside references · not built with</Badge>
        <Button asChild variant="ghost" size="sm" className="max-md:h-11">
          <Link href="/discover/registries" data-registries-link>
            <Library aria-hidden /> Registries
          </Link>
        </Button>
      </PaneHeader>
      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl space-y-6 px-6 py-6 max-sm:space-y-4 max-sm:px-4">
            <div className="space-y-2">
              <SearchField value={typed} onChange={setTyped} placeholder="Search by need: command menu, date picker, toast…" label="Search by need" touch className="max-w-2xl" />
              <Segmented
                label="Search in"
                value={query.every ? "every" : "yours"}
                onChange={(next) => set({ every: next === "every", source: null })}
                touch
                options={[
                  { value: "yours" as const, label: "Your sources" },
                  { value: "every" as const, label: "Every registry" },
                ]}
              />
              {!query.q && (
                <div className="flex flex-wrap items-center gap-1.5 text-small text-muted">
                  <span>Try</span>
                  {SUGGESTIONS.map((need) => (
                    <button key={need} type="button" onClick={() => setTyped(need)} className="rounded-sm border border-line px-2 py-0.5 text-ink-2 hover:bg-raised max-md:py-2.5">
                      {need}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {query.every && <EveryRegistry onReady={() => setGeneration((n) => n + 1)} />}

            {query.family && (
              <Suspense fallback={<p className="text-small text-faint">Loading the pinned family…</p>}>
                <PinnedSection id={query.family} opened={opened} scheme={scheme} role={query.role} inventory={inventory} scroller={scroller} onClear={() => set({ family: null })} onProject={setProject} />
              </Suspense>
            )}

            <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
              <div className="min-w-0 space-y-3">
                <FilterToggle query={query} open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} onChange={set} />
                <Facets query={query} page={page} onChange={set} folded={!filtersOpen} />
              </div>
              <section aria-labelledby="discover-results" className="min-w-0 space-y-3">
                <h2 id="discover-results" className="sr-only">
                  Results
                </h2>
                <Results listings={listings} query={query} onOpen={open} onPage={(offset) => setQuery({ ...query, offset, open: null })} gallery={gallery} thumbs={thumbs ?? null} scheme={scheme} onView={(view) => setQuery({ ...query, view, open: null })} onRole={(role) => set({ role })} onSort={(sort) => setQuery({ ...query, sort, offset: 0, open: null })} onPer={(per) => setQuery({ ...query, per, offset: 0, open: null })} />
              </section>
            </div>

          </div>
      </div>
      {(opened.length > 0 || openHit) && (
        <Suspense fallback={null}>
          <CandidateLayer openHit={openHit} opened={opened} project={query.family ? project : null} scheme={scheme} family={query.family} onClose={closeHit} />
        </Suspense>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- every registry */

/**
 * Every registry: whether their listings are on this machine, and if not, the one button that
 * fetches them (each registry's list once: names and descriptions, never an item's code), with how
 * far it has got. `onReady` runs when a fetch finishes, so the search is asked again.
 */
function EveryRegistry({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState<EveryStatus | null | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const running = status !== "loading" && status?.state === "running";
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let was: EveryStatus["state"] | null = null;
    const ask = (): void => {
      everyStatus({ signal: controller.signal }).then(
        (next) => {
          setStatus(next);
          if (was === "running" && next?.state !== "running") ready.current();
          was = next?.state ?? null;
          if (next?.state === "running") timer = setTimeout(ask, EVERY_POLL_MS);
        },
        () => undefined,
      );
    };
    ask();
    return () => (controller.abort(), clearTimeout(timer));
    // Asked again each time a fetch starts here.
  }, [running]);
  const start = (): void => {
    setError(null);
    startEvery().then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  if (status === "loading") return null;
  if (status === null)
    return (
      <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-small text-muted" data-every="none">
        {NO_SERVER}
      </p>
    );
  if (status.state === "ready")
    return (
      <p className="text-small text-muted" data-every="ready">
        Searching every registry in shadcn's directory{status.fetchedAt ? `, as listed on ${new Date(status.fetchedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""}.{" "}
        <span className="text-faint">Unknown code from strangers: it only ever runs in the sandboxed preview, and packages are fetched only for the official registry and your own sources.</span>
      </p>
    );
  return (
    <section aria-label="Every registry" className="space-y-2 rounded-lg border border-line bg-surface p-4" data-every={status.state}>
      {status.state === "running" ? (
        <>
          <p className="text-body text-ink" role="status">
            Asking each registry for its list: {status.done} of {status.total || "…"}
          </p>
          <div className="h-1 overflow-hidden rounded-full bg-raised" aria-hidden>
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${status.total ? Math.round((status.done / status.total) * 100) : 0}%` }} />
          </div>
          <p className="text-small text-muted">Your sources stay searchable meanwhile. It takes a minute or two.</p>
        </>
      ) : (
        <>
          <h2 className="text-body font-medium text-ink">Every registry's items are not on this machine yet</h2>
          <p className="max-w-2xl text-small text-muted">
            Fetching asks each of the few hundred registries in shadcn's directory for its list once: names, descriptions and file lists, never an item's code. After that, a search covers all of them, and an item is fetched only when you open it.
          </p>
          {status.state === "failed" && (
            <p className="text-small text-warning" role="status">
              The last fetch stopped: {status.error}
            </p>
          )}
          {error && (
            <p className="text-small text-warning" role="status">
              {error}
            </p>
          )}
          <Button variant="primary" onClick={start} className="max-md:h-11" data-every-start>
            {status.state === "failed" ? "Try again" : "Fetch every registry's list"}
          </Button>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ facets */

function FacetGroup({ label, value, options, onChange, disabled }: { label: string; value: string | null; options: ReadonlyArray<{ value: string; label: string; count: number | null }>; onChange: (value: string | null) => void; disabled?: string }) {
  return (
    <fieldset className="min-w-0 space-y-1" disabled={disabled !== undefined}>
      <legend className="mb-1 text-caption font-medium tracking-wide text-muted uppercase">{label}</legend>
      {disabled !== undefined ? (
        <p className="text-small text-faint">{disabled}</p>
      ) : (
        <ul className="flex flex-col gap-0.5 max-md:flex-row max-md:flex-wrap">
          {[{ value: "", label: "Any", count: null }, ...options].map((option) => {
            const active = (value ?? "") === option.value;
            return (
              <li key={option.value || "any"}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange(option.value || null)}
                  className={clsx("flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-small max-md:h-11 max-md:w-auto max-md:border max-md:border-line", active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-raised")}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.count !== null && <span className="tabular text-caption text-faint">{option.count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

type Filter = "role" | "source" | "licence" | "style";

/** A filter that is on, in words: `button`, `@coss`, `Known licence`, `Headless`. */
function filterLabel(key: Filter, value: string): string {
  if (key === "licence") return value === "known" ? "Known licence" : "Unknown licence";
  if (key === "style") return value === "headless" ? "Headless" : "Styled";
  return key === "role" ? value.replace(/-/g, " ") : value;
}

/** On a phone: the one button the facets fold behind, with how many are on, and each one that is on, to take off without unfolding. */
function FilterToggle({ query, open, onToggle, onChange }: { query: DiscoverQuery; open: boolean; onToggle: () => void; onChange: (patch: Partial<DiscoverQuery>) => void }) {
  const on = (["role", "source", "licence", "style"] as const).flatMap((key) => (query[key] ? [{ key, value: query[key] }] : []));
  return (
    <div className="space-y-2 md:hidden" data-filter-toggle>
      <Button variant="outline" size="sm" aria-expanded={open} aria-controls="discover-facets" onClick={onToggle} className="h-11 w-full justify-between">
        <span className="flex items-center gap-2">
          <SlidersHorizontal aria-hidden />
          Filters
          {on.length > 0 && (
            <>
              {" "}
              <span className="tabular text-muted">· {on.length} on</span>
            </>
          )}
        </span>
        <ChevronDown aria-hidden className={clsx("transition-transform", open && "rotate-180")} />
      </Button>
      {!open && on.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Filters on">
          {on.map(({ key, value }) => (
            <li key={key}>
              <button type="button" onClick={() => onChange({ [key]: null })} aria-label={`Take off ${filterLabel(key, value)}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-sm border border-line px-2.5 text-small text-ink-2 hover:bg-raised">
                {filterLabel(key, value)}
                <X aria-hidden className="size-3.5 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Facets({ query, page, onChange, folded }: { query: DiscoverQuery; page: DiscoverPage | null; onChange: (patch: Partial<DiscoverQuery>) => void; folded: boolean }) {
  const facets = page?.facets ?? { role: {}, source: {}, licence: {}, style: {} };
  const entries = (record: Readonly<Record<string, number>>) => Object.entries(record);
  const keep = (list: Array<{ value: string; label: string; count: number | null }>, selected: string | null) => (selected && !list.some((o) => o.value === selected) ? [...list, { value: selected, label: selected.replace(/-/g, " "), count: null }] : list);
  const unknown = facets.licence.unknown ?? 0;
  const known = entries(facets.licence).reduce((n, [k, c]) => n + (k === "unknown" ? 0 : c), 0);
  return (
    <aside id="discover-facets" aria-label="Facets" className={clsx("space-y-4 max-md:space-y-3", folded && "max-md:hidden")} data-facets data-folded={folded || undefined}>
      <FacetGroup label="Role" value={query.role} onChange={(role) => onChange({ role })} options={keep(entries(facets.role).slice(0, ROLE_FACETS).map(([value, count]) => ({ value, label: value.replace(/-/g, " "), count })), query.role)} />
      <FacetGroup label="Source" value={query.source} onChange={(source) => onChange({ source })} options={keep(entries(facets.source).slice(0, SOURCE_FACETS).map(([value, count]) => ({ value, label: value, count })), query.source)} />
      <FacetGroup
        label="Licence"
        value={query.licence}
        onChange={(licence) => onChange({ licence: licence as DiscoverQuery["licence"] })}
        options={[
          { value: "known", label: "Known", count: page ? known : null },
          { value: "unknown", label: "Unknown", count: page ? unknown : null },
        ]}
      />
      <FacetGroup
        label="Style"
        value={query.style}
        onChange={(style) => onChange({ style: style as DiscoverQuery["style"] })}
        options={[
          { value: "headless", label: "Headless", count: page ? (facets.style.headless ?? 0) : null },
          { value: "styled", label: "Styled", count: page ? (facets.style.styled ?? 0) : null },
        ]}
      />
      <FacetGroup label="Seen on" value={null} onChange={() => undefined} options={[]} disabled="Later: which sites you know use it." />
    </aside>
  );
}

/* ----------------------------------------------------------------------- results */

interface ResultsProps {
  listings: ReturnType<typeof useListings>;
  query: DiscoverQuery;
  onOpen: (hit: DiscoverHit) => void;
  onPage: (offset: number) => void;
  gallery: boolean;
  thumbs: Thumbs | null;
  scheme: Scheme;
  onView: (view: "gallery" | "list") => void;
  onRole: (role: string) => void;
  onSort: (sort: DiscoverSort | null) => void;
  onPer: (per: number) => void;
}

function Results({ listings, query, onOpen, onPage, gallery, thumbs, scheme, onView, onRole, onSort, onPer }: ResultsProps) {
  if (listings.status === "loading")
    return (
      <p aria-busy="true" className="text-small text-faint">
        Searching the listings…
      </p>
    );
  if (listings.status === "error")
    return (
      <EmptyState icon={Compass} title="No listings to search">
        {listings.message}
      </EmptyState>
    );
  const { page } = listings;
  if (page.hits.length === 0)
    return (
      <EmptyState icon={Compass} title={query.q ? `Nothing for “${query.q}”` : "No listings match"}>
        Try another need, or loosen a facet.
      </EmptyState>
    );
  const last = Math.min(page.offset + page.hits.length, page.matched);
  const types = Object.entries(page.facets.role).slice(0, ROLE_FACETS);
  // Nothing searched, filtered or ordered, on the gallery's first page: browse it by type instead.
  const browsing = !query.q && !query.role && !query.source && !query.licence && !query.style && !query.sort;
  const shelves = gallery && hasPictures(thumbs) && browsing && page.offset === 0 && types.length > 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-small text-muted" data-results-summary>
          {shelves ? `Browsing by type: the ${Math.min(SHELVES, types.length)} commonest of ${page.matched}` : (
            <>
              {query.q ? `For “${query.q}”: ` : query.role ? `${query.role.replace(/-/g, " ")}: ` : query.sort ? `${SORT_SUMMARIES[query.sort]}: ` : "Browsing, official first: "}
              {page.offset + 1}–{last} of {page.matched}
            </>
          )}
          {page.from === "snapshot" ? ` · from this snapshot's listings${page.capped ? " (the first of more)" : ""}` : ""}
        </p>
        <Order query={query} onSort={onSort} onPer={onPer} />
        {hasPictures(thumbs) && <ViewSwitch gallery={gallery} onView={onView} />}
      </div>
      {shelves ? (
        <div className="space-y-8" data-shelves>
          {types.slice(0, SHELVES).map(([role, count]) => (
            <Shelf key={role} query={query} role={role} count={count} thumbs={thumbs} scheme={scheme} onOpen={onOpen} onRole={onRole} />
          ))}
        </div>
      ) : gallery ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Candidates" data-gallery>
          {page.hits.map((hit) => (
            <GalleryCard key={hit.id} hit={hit} thumbs={thumbs} scheme={scheme} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Candidates">
          {page.hits.map((hit) => (
            <ResultCard key={hit.id} hit={hit} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {!shelves && (page.offset > 0 || last < page.matched) && <Pages offset={page.offset} per={query.per} matched={page.matched} onPage={onPage} />}
    </>
  );
}

/** The order and the page size, as two small selects. */
function Order({ query, onSort, onPer }: { query: DiscoverQuery; onSort: (sort: DiscoverSort | null) => void; onPer: (per: number) => void }) {
  return (
    <div className="flex items-center gap-2" data-order>
      <label className="flex items-center gap-1.5 text-small text-muted">
        Sort
        <Select value={query.sort ?? "recommended"} onChange={(event) => onSort(event.target.value === "recommended" ? null : (event.target.value as DiscoverSort))} className="w-auto max-md:h-11" data-sort>
          {(["recommended", ...SORTS] as const).map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-center gap-1.5 text-small text-muted">
        <span className="sr-only">Per page</span>
        <Select value={query.per} onChange={(event) => onPer(Number(event.target.value))} className="w-auto max-md:h-11" aria-label="Per page" data-per>
          {PER_PAGE.map((per) => (
            <option key={per} value={per}>
              {per} a page
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

/** The page numbers around the current one, the first and the last, with gaps between: `1 … 4 5 6 … 65`. */
export function pageNumbers(current: number, count: number): Array<number | "gap"> {
  const shown = [...new Set([1, current - 1, current, current + 1, count])].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  shown.forEach((n, i) => {
    if (i > 0 && n - shown[i - 1]! > 1) out.push(n - shown[i - 1]! === 2 ? n - 1 : "gap");
    out.push(n);
  });
  return out;
}

function Pages({ offset, per, matched, onPage }: { offset: number; per: number; matched: number; onPage: (offset: number) => void }) {
  const count = Math.max(1, Math.ceil(matched / per));
  const current = Math.min(count, Math.floor(offset / per) + 1);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-1.5" data-pages>
      <Button disabled={current === 1} onClick={() => onPage((current - 2) * per)} className="max-md:h-11">
        <ArrowLeft /> Previous
      </Button>
      {pageNumbers(current, count).map((n, i) =>
        n === "gap" ? (
          <span key={`gap-${i}`} aria-hidden className="px-1 text-faint">
            …
          </span>
        ) : (
          <Button key={n} variant={n === current ? "primary" : "ghost"} aria-current={n === current ? "page" : undefined} aria-label={`Page ${n} of ${count}`} onClick={() => onPage((n - 1) * per)} className="min-w-8 tabular-nums max-md:h-11 max-md:min-w-11">
            {n}
          </Button>
        ),
      )}
      <Button disabled={current === count} onClick={() => onPage(current * per)} className="max-md:h-11">
        Next <ArrowRight />
      </Button>
    </nav>
  );
}

function ResultCard({ hit, onOpen }: { hit: DiscoverHit; onOpen: (hit: DiscoverHit) => void }) {
  const signals = signalLines(hit);
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3" data-hit={hit.id}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body font-medium text-ink">{hit.title ?? hit.name}</h3>
          <p className="truncate font-mono text-mono-sm text-muted">{hit.source.ref ?? hit.name}</p>
        </div>
        <LicenceBadge licence={hit.license} />
      </div>
      {descriptionOf(hit) && <p className="line-clamp-2 text-small text-ink-2">{descriptionOf(hit)}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
        <span>{sourceOf(hit)}</span>
        {signals.map((s) => (
          <span key={s} className="tabular" data-signal>
            {s}
          </span>
        ))}
      </div>
      {hit.install && (
        <div className="flex min-w-0 items-center gap-1 rounded-md bg-sunken px-2 py-0.5">
          <code className="min-w-0 flex-1 truncate font-mono text-mono-sm text-ink-2" data-install>
            {hit.install.command}
          </code>
          <CopyButton value={hit.install.command} label={`Copy install command for ${hit.name}`} className="max-md:size-11" />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onOpen(hit)} className="max-md:h-11" aria-label={`Preview ${hit.title ?? hit.name} in your theme`} data-open={hit.id}>
          Preview in your theme
        </Button>
      </div>
    </li>
  );
}

function ViewSwitch({ gallery, onView }: { gallery: boolean; onView: (view: "gallery" | "list") => void }) {
  return (
    <div role="group" aria-label="Layout" className="inline-flex rounded-md border border-line p-0.5" data-view-switch>
      {(["gallery", "list"] as const).map((view) => {
        const active = (view === "gallery") === gallery;
        const Icon = view === "gallery" ? LayoutGrid : List;
        return (
          <button key={view} type="button" aria-pressed={active} onClick={() => onView(view)} className={clsx("inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-small transition-colors duration-100 max-md:h-11 max-md:px-3", active ? "bg-raised text-ink" : "text-muted hover:text-ink")}>
            <Icon aria-hidden className="size-3.5" />
            {view === "gallery" ? "Gallery" : "List"}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A candidate as a picture: how it draws in the project's theme, in the hub's scheme, then what it
 * is. Without a picture it says why (it could not be drawn on its own) or that none was taken.
 * The picture opens it, as Preview in your theme does.
 */
function GalleryCard({ hit, thumbs, scheme, onOpen }: { hit: DiscoverHit; thumbs: Thumbs | null; scheme: Scheme; onOpen: (hit: DiscoverHit) => void }) {
  const thumb = thumbs?.items[hit.id];
  const failed = thumbs?.failed[hit.id];
  const name = hit.title ?? hit.name;
  const signals = signalLines(hit);
  return (
    <li className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-100 hover:border-line-strong" data-hit={hit.id} data-picture={thumb ? "yes" : failed ? "failed" : "none"}>
      <button type="button" onClick={() => onOpen(hit)} aria-label={`Preview ${name} in your theme`} data-open={hit.id} className="block border-b border-line bg-sunken outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        <span className="relative block aspect-[5/3] overflow-hidden">
          {thumb ? (
            <img src={thumb[scheme]} width={thumb.width} height={thumb.height} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
          ) : (
            <span className="absolute inset-0 grid place-items-center p-4 text-center text-small text-faint" title={failed}>
              {failed ? shortReason(failed) : "No picture yet"}
            </span>
          )}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <div className="flex min-w-0 items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate text-body font-medium text-ink">{name}</h3>
          <LicenceBadge licence={hit.license} />
        </div>
        <p className="truncate font-mono text-mono-sm text-muted">{hit.source.ref ?? hit.name}</p>
        {signals.length > 0 && (
          <p className="flex flex-wrap gap-x-3 text-caption text-muted">
            {signals.map((s) => (
              <span key={s} className="tabular" data-signal>
                {s}
              </span>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

/** One type's shelf: its first candidates with a picture (any, when none has one), and the way to all of them. */
function Shelf({ query, role, count, thumbs, scheme, onOpen, onRole }: { query: DiscoverQuery; role: string; count: number; thumbs: Thumbs | null; scheme: Scheme; onOpen: (hit: DiscoverHit) => void; onRole: (role: string) => void }) {
  const listings = useListings({ ...query, role, offset: 0 });
  const label = role.replace(/-/g, " ");
  const found = listings.status === "ready" ? listings.page.hits : [];
  const pictured = found.filter((hit) => thumbs?.items[hit.id]);
  const hits = (pictured.length > 0 ? pictured : found).slice(0, SHELF_SIZE);
  return (
    <section aria-labelledby={`shelf-${role}`} className="space-y-3" data-shelf={role}>
      <header className="flex items-baseline gap-3">
        <h3 id={`shelf-${role}`} className="text-heading first-letter:uppercase">
          {label}
        </h3>
        <span className="tabular text-small text-faint">{count}</span>
        <button type="button" onClick={() => onRole(role)} className="ml-auto inline-flex items-center gap-1 text-small text-accent hover:underline max-md:h-11">
          All {count} <ArrowRight aria-hidden className="size-3.5" />
        </button>
      </header>
      {listings.status === "error" ? (
        <p className="text-small text-muted">{listings.message}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${label} candidates`} aria-busy={listings.status === "loading" || undefined}>
          {hits.map((hit) => (
            <GalleryCard key={hit.id} hit={hit} thumbs={thumbs} scheme={scheme} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}
