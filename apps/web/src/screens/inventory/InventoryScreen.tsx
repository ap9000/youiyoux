/**
 * Inventory: every UI element across the inventoried projects, from `youi inventory`. A role ×
 * project grid on top; then, per role, each family of look-alikes as a row with its shape, kits,
 * count, file:line examples and, when it spans projects or kits, each side of the near-duplicate.
 * On a phone the grid becomes one section per role. Each family shows its looks drawn for real
 * (Specimens.tsx), in each project's own CSS and the hub's colour scheme.
 *
 * The first paint needs only the index (projects, roles by project, counts); a role's looks,
 * families and specimens are fetched per project when its section nears the screen, and kits,
 * primitives and flags right after the first paint, so it does not grow with the library.
 */
import { clsx } from "clsx";
import { Copy, Layers, ScanSearch, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme, type Scheme } from "../../app/theme.tsx";
import { familyName, kitLabel, ROLE_LABEL, roleAnchor, shapeChips, uniqueExamples } from "../../data/inventory.ts";
import { useParts, type InventorySource } from "../../data/inventory-source.ts";
import { retryInventory, useInventoryState } from "../../data/store.ts";
import type { InventoryChunk, InventoryExtras, InventoryFamily, InventoryFlag, InventoryIndex, InventoryRoleIndex } from "../../data/types.ts";
import { Badge } from "../../ui/Badge.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";
import { ScrollRoot, TileGrid, useNearViewport, type Tile } from "./Specimens.tsx";

const SHORT_SHA = 7;
/** Height a role section keeps before its chunks arrive, per family, so the page does not jump. */
const FAMILY_PLACEHOLDER = 136;

export function InventoryScreen() {
  const state = useInventoryState();
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryInventory} what="the inventory" />;
  return <InventoryView inventory={state.value} />;
}

export function InventoryView({ inventory }: { inventory: InventorySource | null }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
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
  const near = index.summary.nearDuplicates;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader title="Inventory" count={index.summary.families}>
        <Badge tone="outline">
          {index.projects.length} {index.projects.length === 1 ? "project" : "projects"}
        </Badge>
        {near > 0 && <Badge tone="warning">{near} {near === 1 ? "near-duplicate" : "near-duplicates"}</Badge>}
      </PaneHeader>
      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
        <ScrollRoot.Provider value={scroller}>
          <div className="mx-auto max-w-6xl space-y-10 px-6 py-6 animate-enter max-sm:px-4">
            <Intro inventory={index} />
            <RoleGrid inventory={index} />
            <Extras source={inventory}>{(extras) => extras.flags.length > 0 && <Flags flags={extras.flags} />}</Extras>
            {index.roles.map((row) => (
              <RoleSection key={row.role} row={row} source={inventory} />
            ))}
            <Extras source={inventory}>{(extras) => <Kits extras={extras} />}</Extras>
            <p className="text-small text-muted">
              {index.summary.notClustered} breakpoint and state classes recorded, not clustered: a family is decided by the resting shape.
              {index.summary.unshaped > 0 && ` ${index.summary.unshaped} ${index.summary.unshaped === 1 ? "look has" : "looks have"} no resolved shape and ${index.summary.unshaped === 1 ? "is" : "are"} not grouped.`}
            </p>
          </div>
        </ScrollRoot.Provider>
      </div>
    </div>
  );
}

/** Kits, primitives and flags: fetched right after the first paint, then shown. */
function Extras({ source, children }: { source: InventorySource; children: (extras: InventoryExtras) => ReactNode }) {
  const [state] = useParts<InventoryExtras>(source, [source.index.extras], true);
  return state?.status === "ready" ? children(state.value) : null;
}

function Intro({ inventory }: { inventory: InventoryIndex }) {
  const t = inventory.tolerance;
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-reading text-ink-2">
        Every button, input, card, badge, dialog, tab and link-as-button in {inventory.projects.map((p) => p.id).join(" and ")}, grouped into families by resolved shape: height, padding, radius, font size and weight, from Tailwind classes and CSS rules with each project&rsquo;s own theme. Colour is ignored.
      </p>
      <p className="text-small text-muted">
        A family&rsquo;s looks are all within height ±{t.height}px, padding ±{t.padding}px, radius ±{t.radius}px, font size ±{t.fontSize}px and weight ±{t.fontWeight} of each other, so look-alikes never chain into one family.
      </p>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-small text-muted">
        {inventory.projects.map((p) => (
          <li key={p.id}>
            <span className="font-medium text-ink">{p.id}</span> · {p.files} files{p.commit ? ` @${p.commit.slice(0, SHORT_SHA)}` : ""} · routes: {p.routes}
            {p.status === "partial" && <span className="text-warning"> · partial ({p.failed} not fully read)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CellText({ cell }: { cell: { families: number; looks: number } | undefined }) {
  if (!cell || cell.looks === 0) return <span className="text-faint">—</span>;
  return (
    <span className="tabular">
      <span className="text-ink">{cell.families}</span> <span className="text-muted">{cell.families === 1 ? "family" : "families"} ·</span> <span className="text-ink">{cell.looks}</span> <span className="text-muted">{cell.looks === 1 ? "look" : "looks"}</span>
    </span>
  );
}

function RoleGrid({ inventory }: { inventory: InventoryIndex }) {
  const rows = inventory.roles;
  return (
    <section aria-labelledby="inventory-grid" className="space-y-3">
      <h2 id="inventory-grid" className="text-heading">
        Roles by project
      </h2>
      <div className="overflow-x-auto rounded-md border border-line max-md:hidden" data-testid="role-grid">
        <table className="w-full border-collapse text-left text-small">
          <thead>
            <tr className="border-b border-line bg-sunken">
              <th scope="col" className="h-8 px-3 font-medium text-muted">
                Role
              </th>
              {inventory.projects.map((p) => (
                <th key={p.id} scope="col" className="h-8 px-3 font-medium text-muted">
                  {p.id}
                </th>
              ))}
              <th scope="col" className="h-8 px-3 font-medium text-muted">
                Across projects
              </th>
            </tr>
          </thead>
          <tbody className="[&>tr]:border-b [&>tr]:border-line [&>tr:last-child]:border-0 [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
            {rows.map((row) => (
              <tr key={row.role}>
                <th scope="row" className="font-medium">
                  <a href={`#${roleAnchor(row.role)}`} className="text-ink hover:text-accent">
                    {ROLE_LABEL[row.role]}
                  </a>
                </th>
                {inventory.projects.map((p) => (
                  <td key={p.id}>
                    <CellText cell={row.cells[p.id]} />
                  </td>
                ))}
                <td>
                  <NearCount shared={row.shared} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden" data-testid="role-stack">
        {rows.map((row) => (
          <li key={row.role} className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <a href={`#${roleAnchor(row.role)}`} className="text-heading text-ink">
                {ROLE_LABEL[row.role]}
              </a>
              <span className="ml-auto">
                <NearCount shared={row.shared} />
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small">
              {inventory.projects.map((p) => (
                <div key={p.id} className="contents">
                  <dt className="text-muted">{p.id}</dt>
                  <dd>
                    <CellText cell={row.cells[p.id]} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NearCount({ shared }: { shared: number }) {
  return shared > 0 ? <Badge tone="warning">{shared} shared across projects</Badge> : <span className="text-small text-faint">none shared</span>;
}

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

function ShapeChips({ family }: { family: InventoryFamily }) {
  return (
    <span className="flex flex-wrap gap-1" aria-label="Shape">
      {shapeChips(family.shape).map((chip) => (
        <span key={chip.label} className={clsx("inline-flex h-5 items-center gap-1 rounded-xs border border-line px-1.5 font-mono text-mono-sm", chip.known ? "text-ink" : "text-faint")}>
          <span className="text-muted">{chip.label}</span> {chip.value}
        </span>
      ))}
    </span>
  );
}

function Examples({ examples }: { examples: InventoryFamily["examples"] }) {
  return (
    <ul className="space-y-0.5">
      {uniqueExamples(examples).map((e) => (
        <li key={`${e.project}:${e.file}:${e.line}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Place project={e.project} file={e.file} line={e.line} />
          <span className="text-caption text-muted">
            &lt;{e.tag}&gt; {e.routes.length > 0 ? e.routes.join(" ") : "unrouted"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A family's looks as tiles: one per distinct specimen in each project (looks drawn the same
 * share one, with their count), and one per shape for looks nothing draws.
 */
export function familyTiles(family: InventoryFamily, chunks: readonly InventoryChunk[], source: InventorySource, scheme: Scheme): Tile[] {
  const tiles: Tile[] = [];
  for (const chunk of chunks) {
    const file = source.index.projects.find((p) => p.id === chunk.project)?.specimenCss?.[scheme];
    const css = file ? source.cssUrl(file) : null;
    const groups = new Map<string, Tile & { count: number }>();
    for (const look of chunk.looks) {
      if (look.family !== family.id) continue;
      const specimen = look.specimen ? (chunk.specimens[look.specimen] ?? null) : null;
      const key = `${chunk.project}:${specimen && css ? `s:${look.specimen}` : `shape:${Object.values(look.shape).join("/")}`}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { key, project: chunk.project, specimen, css: specimen ? css : null, shape: look.shape, count: 1, place: `${look.file}:${look.line}` });
    }
    tiles.push(...groups.values());
  }
  return tiles;
}

function FamilyRow({ family, tiles, scheme }: { family: InventoryFamily; tiles: readonly Tile[] | null; scheme: Scheme }) {
  return (
    <li className="space-y-3 border-b border-line py-4 last:border-0" data-family={family.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-medium text-ink">{familyName(family)}</h3>
        <span className="font-mono text-mono-sm text-faint">{family.id}</span>
        <ShapeChips family={family} />
        <span className="tabular text-small text-ink">
          {family.looks} {family.looks === 1 ? "look" : "looks"}
          {family.shapes > 1 && <span className="text-muted"> · {family.shapes} shapes</span>}
        </span>
        {family.nearDuplicate && <Badge tone="warning">{family.projects.length > 1 ? "Near-duplicate across projects" : "Near-duplicate across kits"}</Badge>}
      </div>
      {tiles && tiles.length > 0 && <TileGrid tiles={tiles} scheme={scheme} />}
      {family.nearDuplicate ? (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Near-duplicates">
          {family.sides.map((side) => (
            <li key={`${side.project}:${side.kit ?? ""}`} className="space-y-1.5 rounded-md border border-line bg-raised p-3">
              <div className="flex flex-wrap items-center gap-x-2 text-small">
                <span className="font-medium text-ink">{side.project}</span>
                <Kit kit={side.kit} />
                <span className="ml-auto tabular text-muted">
                  {side.looks} {side.looks === 1 ? "look" : "looks"}
                </span>
              </div>
              <Examples examples={side.examples} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-x-6 gap-y-1.5 text-small md:grid-cols-[minmax(160px,max-content)_1fr]">
          <div className="flex flex-wrap items-center gap-1.5">
            {family.kits.length > 0 ? family.kits.map((k) => <Kit key={k} kit={k} />) : <Kit kit={null} />}
            <span className="text-muted">· {family.projects.join(", ")}</span>
          </div>
          <Examples examples={family.examples} />
        </div>
      )}
    </li>
  );
}

function Kit({ kit }: { kit: string | null }) {
  return (
    <Badge tone={kit ? "neutral" : "outline"} title={kit ?? "Not from a kit: styled in place"}>
      {kitLabel(kit)}
    </Badge>
  );
}

function RoleSection({ row, source }: { row: InventoryRoleIndex; source: InventorySource }) {
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref, "800px", "100000px");
  const { scheme } = useTheme();
  const files = useMemo(() => Object.values(row.chunks), [row.chunks]);
  const states = useParts<InventoryChunk>(source, files, near);
  const ready = states.every((s) => s.status === "ready");
  const chunks = ready ? states.map((s) => (s as { value: InventoryChunk }).value) : [];
  const byId = new Map<string, InventoryFamily>();
  for (const chunk of chunks) for (const family of chunk.families) byId.set(family.id, family);
  // The report's order, which its ids number (button-1, button-2, …).
  const families = [...byId.values()].sort((a, b) => Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1)));
  const failed = states.find((s) => s.status === "error");
  return (
    <section ref={ref} id={roleAnchor(row.role)} aria-labelledby={`${roleAnchor(row.role)}-title`} className="scroll-mt-4 space-y-1">
      <header className="flex flex-wrap items-baseline gap-x-3 border-b border-line pb-2">
        <h2 id={`${roleAnchor(row.role)}-title`} className="text-heading">
          {ROLE_LABEL[row.role]}
        </h2>
        <span className="tabular text-small text-muted">
          {row.families} {row.families === 1 ? "family" : "families"} · {row.looks} {row.looks === 1 ? "look" : "looks"}
          {row.unshaped > 0 && ` · ${row.unshaped} without a resolved shape`}
        </span>
      </header>
      {row.families === 0 ? null : failed?.status === "error" ? (
        <p className="py-3 text-small text-danger">{failed.message}</p>
      ) : !ready ? (
        <div aria-busy="true" className="py-3 text-small text-faint" style={{ minHeight: row.families * FAMILY_PLACEHOLDER }}>
          Loading {row.families} {row.families === 1 ? "family" : "families"}…
        </div>
      ) : (
        <ul>
          {families.map((family) => (
            <FamilyRow key={family.id} family={family} tiles={familyTiles(family, chunks, source, scheme)} scheme={scheme} />
          ))}
        </ul>
      )}
      {row.families === 0 && (
        <p className="py-3 text-small text-muted">No look of this role has a resolved shape.</p>
      )}
    </section>
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
