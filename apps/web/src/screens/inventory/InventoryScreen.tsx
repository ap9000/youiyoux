/**
 * Inventory: every UI element across the inventoried projects, from `youi inventory`, laid out
 * around their specimens. Filters (type, library or kit, project, near-duplicates, search) sit
 * on top and live in the URL; then a headline: how many families there are and could be, and
 * the top three fixes; then the specimen wall, one row per role, each family a tile with its
 * look drawn for real (Specimens.tsx) in cells by library or kit; then each near-duplicate's
 * compare card and fix. Opening a tile lists every use in a drawer (a bottom sheet on a phone).
 *
 * The first paint needs only the index. Only the chunks of the roles and projects the filters
 * show are ever fetched: a role's as its row nears the screen, the others one at a time when
 * the browser is idle (the headline, compare cards and fix list need them all); the extras
 * (kits, primitives, flags) right after the first paint. Specimen frames mount only near the
 * screen, six load at once and at most 48 are mounted.
 */
import { clsx } from "clsx";
import { Copy, Layers, ScanSearch, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTheme, type Scheme } from "../../app/theme.tsx";
import { kitLabel, ROLE_LABEL, roleAnchor } from "../../data/inventory.ts";
import { useParts, type InventorySource } from "../../data/inventory-source.ts";
import { activeFilters, consolidation, familyViews, filterCounts, filterFamilies, filtersToSearch, kitCells, Libraries, neededChunks, topFixes, type FamilyView, type Filters } from "../../data/inventory-view.ts";
import { retryInventory, useDetectState, useInventoryState } from "../../data/store.ts";
import type { DetectReport, InventoryChunk, InventoryExtras, InventoryFlag, InventoryIndex, InventoryRoleIndex } from "../../data/types.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";
import { compareAnchor, CompareCard, fixAnchor, FixCard } from "./Compare.tsx";
import { FamilyDrawer } from "./FamilyDrawer.tsx";
import { familyTiles, leadTiles } from "./family-tiles.ts";
import { FilterBar, TOUCH, useFilters } from "./FilterBar.tsx";
import { LARGE_TILE_HEIGHT, LeadTile, ScrollRoot, useNearViewport } from "./Specimens.tsx";

const SHORT_SHA = 7;
/** Height a role row keeps per family before its chunks arrive, so the page does not jump. */
const TILE_PLACEHOLDER = LARGE_TILE_HEIGHT + 96;
/** Tiles per row a placeholder assumes. */
const PLACEHOLDER_COLUMNS = 4;

export function InventoryScreen() {
  const state = useInventoryState();
  const detect = useDetectState();
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryInventory} what="the inventory" />;
  return <InventoryView inventory={state.value} detect={detect.status === "ready" ? detect.value : null} />;
}

export function InventoryView({ inventory, detect = null }: { inventory: InventorySource | null; detect?: DetectReport | null }) {
  const index = inventory?.index;
  if (!inventory || !index || index.summary.looks === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneHeader title="Inventory" count={0} />
        <EmptyState icon={ScanSearch} title={index ? "No elements found" : "No inventory yet"}>
          {index ? "The inventoried projects render no buttons, inputs, cards, badges, dialogs or tabs this scanner recognises." : "Run youi inventory --project <dir> (once per project), then open the hub with youi ui --inventory .youi/inventory.json."}
        </EmptyState>
      </div>
    );
  }
  return <Inventory source={inventory} detect={detect} />;
}

function Inventory({ source, detect }: { source: InventorySource; detect: DetectReport | null }) {
  const index = source.index;
  const { scheme } = useTheme();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [filters, writeFilters] = useFilters(index);
  // Wall tiles come in one after another on first load only: any filter or role change ends it.
  const firstLoad = useRef(true);
  const initialSearch = useRef(filtersToSearch(filters));
  if (filtersToSearch(filters) !== initialSearch.current) firstLoad.current = false;
  const setFilters = useCallback(
    (next: Filters) => {
      firstLoad.current = false;
      writeFilters(next);
    },
    [writeFilters],
  );

  // The first paint is the index alone; the chunks in scope and the extras load right after it.
  const painted = useAfterFirstPaint();
  const scope = useMemo(() => neededChunks(index, filters), [index, filters]);
  // Read here; loaded by each row as it nears the screen, and the rest when the browser is idle.
  const states = useParts<InventoryChunk>(source, scope, false);
  useIdleLoad(source, scope, painted);
  const [extrasState] = useParts<InventoryExtras>(source, [index.extras], painted);
  const extras = extrasState?.status === "ready" ? extrasState.value : null;
  const libraries = useMemo(() => new Libraries(extras, detect), [extras, detect]);
  const statusKey = states.map((s) => s.status).join("|");
  // The states are new arrays each render; their statuses say when the chunks changed.
  const chunks = useMemo(() => states.flatMap((s) => (s.status === "ready" ? [s.value] : [])), [statusKey, scope]);
  const views = useMemo(() => (extras ? familyViews(chunks, libraries) : []), [chunks, libraries, extras]);
  const ready = extras !== null && states.every((s) => s.status === "ready");
  const loaded = (file: string): boolean => extras !== null && source.get(file).status === "ready";
  const counts = filterCounts(index, views, filters, loaded, libraries);
  const shown = useMemo(() => filterFamilies(views, filters), [views, filters]);
  const near = shown.filter((v) => v.family.nearDuplicate);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? (views.find((v) => v.family.id === openId) ?? null) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-screen="inventory">
      <PaneHeader title="Inventory" count={index.summary.families}>
        <Badge tone="outline">
          {index.projects.length} {index.projects.length === 1 ? "project" : "projects"}
        </Badge>
        {index.summary.nearDuplicates > 0 && (
          <Badge tone="warning">
            {index.summary.nearDuplicates} {index.summary.nearDuplicates === 1 ? "near-duplicate" : "near-duplicates"}
          </Badge>
        )}
      </PaneHeader>
      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
        <ScrollRoot.Provider value={scroller}>
          <div className="mx-auto max-w-6xl space-y-8 px-6 py-6 max-sm:space-y-6 max-sm:px-4">
            <FilterBar filters={filters} onChange={setFilters} counts={counts} shown={ready ? shown.length : null} total={index.summary.families} />
            <Headline index={index} views={shown} ready={ready} filtered={activeFilters(filters) > 0} />
            <section aria-labelledby="inventory-wall" className="space-y-6">
              <h2 id="inventory-wall" className="sr-only">
                Specimen wall
              </h2>
              <Wall index={index} filters={filters} scope={scope} views={shown} chunks={chunks} source={source} scheme={scheme} libraries={libraries} extras={extras !== null} ready={ready} stagger={firstLoad.current} onOpen={setOpenId} />
            </section>
            {ready && near.length > 0 && (
              <section aria-labelledby="inventory-compare" className="space-y-3">
                <SectionTitle id="inventory-compare" title="Near-duplicates, compared" count={near.length}>
                  The same look built more than once: drag across a pair to see where they part.
                </SectionTitle>
                <div className="grid gap-4 lg:grid-cols-2">
                  {near.map((view) => (
                    <CompareCard key={view.family.id} view={view} chunks={chunks} source={source} scheme={scheme} libraries={libraries} />
                  ))}
                </div>
              </section>
            )}
            {ready && near.length > 0 && (
              <section aria-labelledby="inventory-fixes" className="space-y-3">
                <SectionTitle id="inventory-fixes" title="Fix list" count={near.length}>
                  Each near-duplicate, every way it is built and the files that would change.
                </SectionTitle>
                <ul className="space-y-4">
                  {near.map((view) => (
                    <FixCard key={view.family.id} view={view} chunks={chunks} source={source} scheme={scheme} libraries={libraries} />
                  ))}
                </ul>
              </section>
            )}
            <Extras extras={extras}>{(value) => value.flags.length > 0 && <Flags flags={value.flags} />}</Extras>
            <Extras extras={extras}>{(value) => <Kits extras={value} />}</Extras>
            <p className="text-small text-muted">
              {index.summary.notClustered} breakpoint and state classes recorded, not clustered: a family is decided by the resting shape.
              {index.summary.unshaped > 0 && ` ${index.summary.unshaped} ${index.summary.unshaped === 1 ? "look has" : "looks have"} no resolved shape and ${index.summary.unshaped === 1 ? "is" : "are"} not grouped.`}
            </p>
          </div>
        </ScrollRoot.Provider>
      </div>
      <FamilyDrawer view={open} source={source} scheme={scheme} onClose={() => setOpenId(null)} />
    </div>
  );
}

/**
 * True once the page has painted its first frame: a frame callback runs before a paint, so the
 * second one runs after it. Without frame callbacks (tests), after a task.
 */
function useAfterFirstPaint(): boolean {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") {
      const timer = setTimeout(() => setPainted(true), 0);
      return () => clearTimeout(timer);
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPainted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  return painted;
}

/** Requests per idle period: one chunk at a time, so what the screen shows goes first. */
const IDLE_TIMEOUT_MS = 2000;

/**
 * Loads `files` one after another, each when the browser is next idle, skipping any a row near
 * the screen has started; a file that failed is left for its row to show and retry.
 */
function useIdleLoad(source: InventorySource, files: readonly string[], enabled: boolean): void {
  const key = files.join("\0");
  useEffect(() => {
    if (!enabled) return;
    const queue = key.split("\0").filter(Boolean);
    let cancel = (): void => {};
    let stopped = false;
    const whenIdle = (run: () => void): void => {
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
        cancel = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(run, 0);
        cancel = () => clearTimeout(id);
      }
    };
    /** Runs `then` once nothing in the queue is loading. */
    const settled = (then: () => void): void => {
      if (!queue.some((f) => source.get(f).status === "loading")) return then();
      const unsubscribe = source.subscribe(() => {
        if (queue.some((f) => source.get(f).status === "loading")) return;
        unsubscribe();
        if (!stopped) then();
      });
      cancel = unsubscribe;
    };
    const next = (): void => {
      const file = queue.find((f) => source.get(f).status === "idle");
      if (!file || stopped) return;
      whenIdle(() => {
        if (stopped) return;
        source.load(file);
        settled(next);
      });
    };
    settled(next);
    return () => {
      stopped = true;
      cancel();
    };
  }, [source, key, enabled]);
}

function SectionTitle({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <header className="space-y-0.5">
      <h2 id={id} className="flex items-baseline gap-2 text-heading">
        {title} <span className="tabular text-small font-normal text-muted">{count}</span>
      </h2>
      <p className="text-small text-muted">{children}</p>
    </header>
  );
}

/** Kits, primitives and flags: fetched right after the first paint, then shown. */
function Extras({ extras, children }: { extras: InventoryExtras | null; children: (extras: InventoryExtras) => ReactNode }) {
  return extras ? children(extras) : null;
}

/* ------------------------------------------------------------------------ headline */

function Headline({ index, views, ready, filtered }: { index: InventoryIndex; views: readonly FamilyView[]; ready: boolean; filtered: boolean }) {
  const t = index.tolerance;
  const families = ready ? views.length : filtered ? null : index.summary.families;
  const estimate = ready ? consolidation(views, t) : null;
  const fixes = ready ? topFixes(views) : [];
  const folded = estimate ? estimate.families - estimate.estimate : 0;
  return (
    <section aria-labelledby="inventory-headline" className="space-y-4" data-testid="inventory-headline">
      <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
        <h2 id="inventory-headline" className="text-display tabular text-ink" data-testid="consolidation">
          {families === null ? "Counting families…" : `${families} ${families === 1 ? "family" : "families"}`}
          <span aria-hidden className="text-muted">
            {" → "}
          </span>
          <span className="text-muted">could be ~{estimate ? estimate.estimate : "…"}</span>
        </h2>
        <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-raised">
          {estimate && estimate.families > 0 && <div className="h-full rounded-full bg-accent" style={{ width: `${(estimate.estimate / estimate.families) * 100}%` }} />}
        </div>
        <p className="text-small text-muted">
          {estimate
            ? folded > 0
              ? `${folded} ${folded === 1 ? "family sits" : "families sit"} within one tolerance step of another of the same element, and ${builtTwice(views)}.`
              : `No two families of the same element sit within one tolerance step; ${builtTwice(views)}.`
            : "Looking at every family in view…"}
          {index.projects.length > 0 && ` Across ${listed(index.projects.map((p) => p.id))}.`}
        </p>
      </div>
      {fixes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-heading">Top {fixes.length === 1 ? "fix" : `${fixes.length} fixes`}</h3>
          <ol className="grid gap-3 md:grid-cols-3" data-testid="top-fixes">
            {fixes.map((view, i) => (
              <li key={view.family.id} className="space-y-1.5 rounded-lg border border-line bg-surface p-3">
                <p className="flex items-baseline gap-2">
                  <span className="tabular text-caption text-faint">{i + 1}</span>
                  <span className="font-medium text-ink">{view.name}</span>
                </p>
                <p className="tabular text-small text-muted">
                  Built {view.family.sides.length} ways · {view.uses} {view.uses === 1 ? "use" : "uses"} · {view.projects} {view.projects === 1 ? "project" : "projects"}
                </p>
                <p className="flex gap-3 text-small">
                  <a href={`#${compareAnchor(view.family.id)}`} className="inv-link text-accent max-md:inline-flex max-md:min-h-11 max-md:items-center">
                    Compare
                  </a>
                  <a href={`#${fixAnchor(view.family.id)}`} className="inv-link text-accent max-md:inline-flex max-md:min-h-11 max-md:items-center">
                    Fix
                  </a>
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
      <details className="group rounded-lg border border-line bg-surface px-4 py-3 text-small max-md:py-0">
        <summary className="cursor-pointer font-medium text-ink max-md:min-h-11 max-md:py-3">How grouping works</summary>
        <div className="mt-2 space-y-2 text-ink-2 max-md:mt-0 max-md:pb-3">
          <p>
            Every button, input, card, badge, dialog, tab and link-as-button is grouped into families by its resolved shape: height, padding, radius, font size and weight, from Tailwind classes and CSS rules with each project&rsquo;s own theme. Colour is ignored.
          </p>
          <p>
            A family&rsquo;s looks are all within height ±{t.height}px, padding ±{t.padding}px, radius ±{t.radius}px, font size ±{t.fontSize}px and weight ±{t.fontWeight} of each other, so look-alikes never chain into one family.
          </p>
          <p>
            &ldquo;Could be ~N&rdquo; is an estimate, not a regrouping: a near-duplicate (one look built in more than one project or kit) counts once, and families of the same element whose usual shapes are within one tolerance step of each other on every dimension count as one.
          </p>
          <ul className="space-y-0.5 text-muted">
            {index.projects.map((p) => (
              <li key={p.id}>
                <span className="font-medium text-ink">{p.id}</span> · {p.files} files{p.commit ? ` @${p.commit.slice(0, SHORT_SHA)}` : ""} · routes: {p.routes}
                {p.status === "partial" && <span className="text-warning"> · partial ({p.failed} not fully read)</span>}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function builtTwice(views: readonly FamilyView[]): string {
  const n = views.filter((v) => v.family.nearDuplicate).length;
  return n === 0 ? "none is built more than once" : `${n} ${n === 1 ? "is" : "are"} built more than once`;
}

/* --------------------------------------------------------------------------- wall */

interface WallProps {
  index: InventoryIndex;
  filters: Filters;
  /** The chunk files the filters need. */
  scope: readonly string[];
  /** The extras (kits) are loaded, so looks can be sorted into libraries. */
  extras: boolean;
  views: readonly FamilyView[];
  chunks: readonly InventoryChunk[];
  source: InventorySource;
  scheme: Scheme;
  libraries: Libraries;
  ready: boolean;
  stagger: boolean;
  onOpen: (family: string) => void;
}

function Wall(props: WallProps) {
  const { index, filters, views, ready } = props;
  const rows = index.roles.filter((r) => (!filters.type || r.role === filters.type) && (!filters.project || (r.cells[filters.project]?.looks ?? 0) > 0));
  const filtered = activeFilters(filters) > 0;
  let order = 0;
  const shownRows = rows.flatMap((row) => {
    const mine = views.filter((v) => v.family.role === row.role);
    const loaded = props.extras && Object.values(row.chunks).every((file) => !props.scope.includes(file) || props.source.get(file).status === "ready");
    if (loaded && mine.length === 0 && filtered) return [];
    const start = order;
    order += mine.length;
    return [{ row, mine, start }];
  });
  if (ready && shownRows.length === 0) {
    return <EmptyState icon={ScanSearch} title="No families match">Try fewer filters, or clear them.</EmptyState>;
  }
  return (
    <>
      {shownRows.map(({ row, mine, start }) => (
        <RoleRow key={row.role} {...props} row={row} views={mine} start={start} />
      ))}
    </>
  );
}

function RoleRow({ row, views, start, filters, scope, extras, chunks, source, scheme, libraries, stagger, onOpen }: WallProps & { row: InventoryRoleIndex; start: number }) {
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref, "800px", "100000px");
  const files = useMemo(() => Object.values(row.chunks).filter((file) => scope.includes(file)), [row.chunks, scope]);
  const states = useParts<InventoryChunk>(source, files, near);
  const failed = states.find((s) => s.status === "error");
  const ready = extras && states.every((s) => s.status === "ready");
  const cells = kitCells(views);
  const families = filters.project ? (row.cells[filters.project]?.families ?? 0) : row.families;
  let i = start;
  return (
    <section ref={ref} id={roleAnchor(row.role)} aria-labelledby={`${roleAnchor(row.role)}-title`} className="scroll-mt-4 space-y-3" data-role={row.role}>
      <header className="flex flex-wrap items-baseline gap-x-3 border-b border-line pb-2">
        <h2 id={`${roleAnchor(row.role)}-title`} className="text-heading">
          {ROLE_LABEL[row.role]}
        </h2>
        <span className="tabular text-small text-muted">
          {ready ? `${views.length} ${views.length === 1 ? "family" : "families"}` : `${families} ${families === 1 ? "family" : "families"}`} · {row.looks} {row.looks === 1 ? "look" : "looks"}
          {row.unshaped > 0 && ` · ${row.unshaped} without a resolved shape`}
        </span>
      </header>
      {failed?.status === "error" ? (
        <p className="text-small text-danger">{failed.message}</p>
      ) : !ready ? (
        families > 0 && (
          <div aria-busy="true" className="text-small text-faint" style={{ minHeight: Math.ceil(families / PLACEHOLDER_COLUMNS) * TILE_PLACEHOLDER }}>
            Loading {families} {families === 1 ? "family" : "families"}…
          </div>
        )
      ) : views.length === 0 ? (
        <p className="text-small text-muted">No look of this role has a resolved shape.</p>
      ) : (
        <div className="flex flex-wrap gap-4 max-md:flex-col">
          {cells.map((cell) => (
            // Side by side, each as wide as its families need, on a desktop; stacked on a phone.
            <div key={cell.group.id} className="min-w-0 space-y-2 md:flex-(--cell-flex)" style={{ "--cell-flex": `${cell.families.length} 1 ${Math.min(cell.families.length, 3) * 200}px` } as CSSProperties} data-kit-cell={cell.group.id}>
              <p className="flex items-baseline gap-1.5 text-small">
                <span className="font-medium text-ink-2">{cell.group.label}</span>
                <span className="tabular text-caption text-faint">{cell.families.length}</span>
              </p>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 max-md:grid-cols-2 max-md:gap-2">
                {cell.families.map((view) => (
                  <WallTile key={view.family.id} view={view} chunks={chunks} source={source} scheme={scheme} libraries={libraries} stagger={stagger ? i++ : null} onOpen={onOpen} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WallTile({ view, chunks, source, scheme, libraries, stagger, onOpen }: { view: FamilyView; chunks: readonly InventoryChunk[]; source: InventorySource; scheme: Scheme; libraries: Libraries; stagger: number | null; onOpen: (family: string) => void }) {
  // The specimen most of its main library's looks share, unless it draws nothing at the desk width.
  const tiles = leadTiles(
    familyTiles(view.family, chunks, source, scheme, (_, kit) => libraries.primary(kit).id === view.primary.id),
    view.family,
    `wall:${view.family.id}`,
  );
  const open = (): void => onOpen(view.family.id);
  return (
    <li
      className={clsx("inv-tile inv-press flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-line bg-surface p-2", stagger !== null && "inv-enter")}
      style={stagger !== null ? ({ "--inv-i": stagger } as CSSProperties) : undefined}
      data-family={view.family.id}
      data-stagger={stagger ?? undefined}
      onClick={(event) => !(event.target as Element).closest("button") && open()}
    >
      <LeadTile tiles={tiles} scheme={scheme} size="large" as="div" caption={false} />
      <div className="min-w-0 space-y-0.5 px-1">
        <h3 className="inv-tile-name text-small font-medium break-words text-ink">{view.name}</h3>
        <p className="tabular text-caption text-muted">
          {view.uses} {view.uses === 1 ? "use" : "uses"} · {view.projects} {view.projects === 1 ? "project" : "projects"}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 px-1 pb-1">
        {view.family.nearDuplicate && <Badge tone="warning">Near-duplicate</Badge>}
        <Button size="sm" className={clsx("inv-press ml-auto max-md:px-3", TOUCH)} onClick={open} aria-label={`Open ${view.name}`}>
          Open
        </Button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ flags and kits */

function Flags({ flags }: { flags: readonly InventoryFlag[] }) {
  return (
    <section aria-labelledby="inventory-flags" className="space-y-3">
      <h2 id="inventory-flags" className="flex items-center gap-2 text-heading">
        <TriangleAlert aria-hidden className="size-4 text-warning" /> Flags <span className="tabular text-small font-normal text-muted">{flags.length}</span>
      </h2>
      <ul className="space-y-2">
        {flags.map((flag) => (
          <li key={flag.kind === "duplicate-definition" ? `d:${flag.name}` : `m:${flag.project}:${flag.file}:${flag.role}`} className="rounded-md border border-line p-3 text-small">
            {flag.kind === "duplicate-definition" ? (
              <>
                <p className="text-ink">
                  <Copy aria-hidden className="mr-1.5 inline size-3.5 text-muted" />
                  <code className="font-mono text-mono-sm">{flag.name}</code> is defined {flag.locations.length} times
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {flag.locations.map((l) => (
                    <li key={`${l.project}:${l.file}`} className="text-muted">
                      <Place project={l.project} file={l.file} line={l.line} /> · {kitLabel(l.kit)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p className="text-ink">
                  <Layers aria-hidden className="mr-1.5 inline size-3.5 text-muted" />
                  <Place project={flag.project} file={flag.file} /> imports {new Set(flag.imports.map((i) => i.kit)).size} kits&rsquo; {flag.role} in {flag.imports.length} {flag.imports.length === 1 ? "import" : "imports"}
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {flag.imports.map((i) => (
                    <li key={`${i.specifier}:${i.line}:${i.kit}`} className="text-muted">
                      <code className="font-mono text-mono-sm text-ink-2">{i.name}</code> from {kitLabel(i.kit)} · line {i.line}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Place({ project, file, line }: { project: string; file: string; line?: number }) {
  return (
    <code className="font-mono text-mono-sm break-all text-ink-2">
      <span className="text-muted">{project}:</span>
      {file}
      {line !== undefined && `:${line}`}
    </code>
  );
}

function Kits({ extras: inventory }: { extras: InventoryExtras }) {
  if (inventory.kits.length === 0 && inventory.primitives.length === 0) return null;
  return (
    <section aria-labelledby="inventory-kits" className="space-y-3">
      <h2 id="inventory-kits" className="text-heading">
        Kits and primitives
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        {inventory.kits.map((kit) => (
          <Card key={kit.id} title={kitLabel(kit.id)} aside={`${kit.project} · ${kit.kind === "cva-folder" ? "CVA folder" : `class kit ${kit.prefix ?? ""}`}`}>
            {kit.members.map((m) => (
              <span key={m.name} className="inline-flex items-center gap-1">
                <code className="font-mono text-mono-sm text-ink-2">{m.name}</code>
                {Object.keys(m.variants).length > 0 && <span className="text-caption text-muted">{Object.entries(m.variants).map(([k, v]) => `${k}: ${v.length}`).join(", ")}</span>}
              </span>
            ))}
          </Card>
        ))}
        {inventory.primitives.map((p) => (
          <Card key={`${p.project}:${p.package}`} title={p.package} aside={`${p.project} · ${p.count} ${p.count === 1 ? "site" : "sites"}`}>
            {p.exports.map((e) => (
              <code key={e} className="font-mono text-mono-sm text-ink-2">
                {e}
              </code>
            ))}
          </Card>
        ))}
      </div>
    </section>
  );
}

function Card({ title, aside, children }: { title: string; aside: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-mono-sm text-ink">{title}</span>
        <span className="text-caption text-muted">{aside}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">{children}</div>
    </div>
  );
}
