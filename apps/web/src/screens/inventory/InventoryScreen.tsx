/**
 * Inventory: every UI element across the inventoried projects, from `youi inventory`. A role ×
 * project grid on top; then, per role, each family of look-alikes as a row with its shape, kits,
 * count, file:line examples and, when it spans projects or kits, each side of the near-duplicate.
 * On a phone the grid becomes one section per role.
 */
import { clsx } from "clsx";
import { Copy, Layers, ScanSearch, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { familyName, kitLabel, ROLE_LABEL, roleAnchor, roleRows, shapeChips, uniqueExamples, type RoleRow } from "../../data/inventory.ts";
import { retryInventory, useInventoryState } from "../../data/store.ts";
import type { InventoryFamily, InventoryFlag, InventoryReport } from "../../data/types.ts";
import { Badge } from "../../ui/Badge.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";

const SHORT_SHA = 7;

export function InventoryScreen() {
  const state = useInventoryState();
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryInventory} what="the inventory" />;
  return <InventoryView inventory={state.value} />;
}

export function InventoryView({ inventory }: { inventory: InventoryReport | null }) {
  if (!inventory || inventory.looks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneHeader title="Inventory" count={0} />
        <EmptyState icon={ScanSearch} title={inventory ? "No elements found" : "No inventory yet"}>
          {inventory ? "The inventoried projects render no buttons, inputs, cards, badges, dialogs or tabs this scanner recognises." : "Run youi inventory --project <dir> (once per project), then open the hub with youi ui --inventory .youi/inventory.json."}
        </EmptyState>
      </div>
    );
  }
  const rows = roleRows(inventory);
  const near = inventory.families.filter((f) => f.nearDuplicate).length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader title="Inventory" count={inventory.families.length}>
        <Badge tone="outline">
          {inventory.projects.length} {inventory.projects.length === 1 ? "project" : "projects"}
        </Badge>
        {near > 0 && <Badge tone="warning">{near} {near === 1 ? "near-duplicate" : "near-duplicates"}</Badge>}
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-10 px-6 py-6 animate-enter max-sm:px-4">
          <Intro inventory={inventory} />
          <RoleGrid inventory={inventory} rows={rows} />
          {inventory.flags.length > 0 && <Flags flags={inventory.flags} />}
          {rows.map((row) => (
            <RoleSection key={row.role} row={row} />
          ))}
          <Kits inventory={inventory} />
          <p className="text-small text-muted">
            {inventory.summary.notClustered} breakpoint and state classes recorded, not clustered: a family is decided by the resting shape.
            {inventory.summary.unshaped > 0 && ` ${inventory.summary.unshaped} ${inventory.summary.unshaped === 1 ? "look has" : "looks have"} no resolved shape and ${inventory.summary.unshaped === 1 ? "is" : "are"} not grouped.`}
          </p>
        </div>
      </div>
    </div>
  );
}

function Intro({ inventory }: { inventory: InventoryReport }) {
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
            {p.status === "partial" && <span className="text-warning"> · partial ({p.failed.length} not fully read)</span>}
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

function RoleGrid({ inventory, rows }: { inventory: InventoryReport; rows: readonly RoleRow[] }) {
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
                    <CellText cell={row.cells.get(p.id)} />
                  </td>
                ))}
                <td>
                  <NearCount families={row.families} />
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
                <NearCount families={row.families} />
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small">
              {inventory.projects.map((p) => (
                <div key={p.id} className="contents">
                  <dt className="text-muted">{p.id}</dt>
                  <dd>
                    <CellText cell={row.cells.get(p.id)} />
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

function NearCount({ families }: { families: readonly InventoryFamily[] }) {
  const near = families.filter((f) => f.nearDuplicate && f.projects.length > 1).length;
  return near > 0 ? <Badge tone="warning">{near} shared across projects</Badge> : <span className="text-small text-faint">none shared</span>;
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

function FamilyRow({ family }: { family: InventoryFamily }) {
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

function RoleSection({ row }: { row: RoleRow }) {
  return (
    <section id={roleAnchor(row.role)} aria-labelledby={`${roleAnchor(row.role)}-title`} className="scroll-mt-4 space-y-1">
      <header className="flex flex-wrap items-baseline gap-x-3 border-b border-line pb-2">
        <h2 id={`${roleAnchor(row.role)}-title`} className="text-heading">
          {ROLE_LABEL[row.role]}
        </h2>
        <span className="tabular text-small text-muted">
          {row.families.length} {row.families.length === 1 ? "family" : "families"} · {row.looks} {row.looks === 1 ? "look" : "looks"}
          {row.unshaped > 0 && ` · ${row.unshaped} without a resolved shape`}
        </span>
      </header>
      {row.families.length > 0 ? (
        <ul>
          {row.families.map((family) => (
            <FamilyRow key={family.id} family={family} />
          ))}
        </ul>
      ) : (
        <p className="py-3 text-small text-muted">No look of this role has a resolved shape.</p>
      )}
    </section>
  );
}

function Kits({ inventory }: { inventory: InventoryReport }) {
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
