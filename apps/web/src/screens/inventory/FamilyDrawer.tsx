/**
 * A family opened from the wall: a drawer on a desktop, a bottom sheet on a phone, headed by how
 * many uses it has across how many projects. Usage lists every look (project, repo-relative
 * file:line, routes); Variants draws each distinct specimen; Code shows their HTML. It loads
 * the family's chunk in each of its projects, so every use is listed even under a project filter.
 */
import { useMemo, useRef } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { useParts, type InventorySource } from "../../data/inventory-source.ts";
import { usageRows, type FamilyView } from "../../data/inventory-view.ts";
import type { InventoryChunk } from "../../data/types.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs.tsx";
import { familyTiles } from "./family-tiles.ts";
import { Sheet, useWide } from "./Sheet.tsx";
import { ScrollRoot, TileGrid } from "./Specimens.tsx";

/** Code shows this many specimens' HTML; the rest are counted. */
const CODE_LIMIT = 12;

export function FamilyDrawer({ view: open, source, scheme, onClose }: { view: FamilyView | null; source: InventorySource; scheme: Scheme; onClose: () => void }) {
  const wide = useWide();
  // The family it last showed stays while it closes.
  const last = useRef<FamilyView | null>(null);
  if (open) last.current = open;
  const view = open ?? last.current;
  return (
    <Sheet
      open={open !== null}
      onOpenChange={(open) => !open && onClose()}
      variant={wide ? "drawer" : "sheet"}
      testId="family-drawer"
      title={view ? `${view.uses} ${view.uses === 1 ? "use" : "uses"} across ${view.projects} ${view.projects === 1 ? "project" : "projects"}` : ""}
      description={view?.name}
    >
      {/* Its specimens mount as they near the screen, not the page's scroll area behind it. */}
      <ScrollRoot.Provider value={null}>{view && <FamilyDetail view={view} source={source} scheme={scheme} />}</ScrollRoot.Provider>
    </Sheet>
  );
}

function FamilyDetail({ view, source, scheme }: { view: FamilyView; source: InventorySource; scheme: Scheme }) {
  const role = source.index.roles.find((r) => r.role === view.family.role);
  const files = useMemo(() => view.family.projects.flatMap((p) => (role?.chunks[p] ? [role.chunks[p]] : [])), [view.family.projects, role]);
  const states = useParts<InventoryChunk>(source, files, true);
  const ready = states.every((s) => s.status === "ready");
  const failed = states.find((s) => s.status === "error");
  const chunks = ready ? states.map((s) => (s as { value: InventoryChunk }).value) : [];
  const looks = chunks.flatMap((c) => c.looks.filter((l) => l.family === view.family.id).map((l) => ({ ...l, project: c.project })));
  const rows = usageRows({ family: view.family, looks });
  const tiles = ready ? familyTiles(view.family, chunks, source, scheme) : [];
  const code = tiles.filter((t) => t.specimen !== null);
  if (failed?.status === "error") return <p className="px-5 py-4 text-small text-danger">{failed.message}</p>;
  return (
    <Tabs defaultValue="usage" className="flex min-h-0 flex-col">
      <TabsList className="px-5">
        <TabsTrigger value="usage" count={ready ? rows.length : undefined}>
          Usage
        </TabsTrigger>
        <TabsTrigger value="variants" count={ready ? tiles.length : undefined}>
          Variants
        </TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
      </TabsList>
      {!ready ? (
        <p aria-busy="true" className="px-5 py-4 text-small text-faint">
          Loading its uses…
        </p>
      ) : (
        <>
          <TabsContent value="usage" className="px-5 py-4 outline-none">
            <ul className="divide-y divide-line" aria-label="Every use">
              {rows.map((row) => (
                <li key={row.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-small" data-use>
                  <span className="font-medium text-ink">{row.project}</span>
                  <code className="font-mono text-mono-sm break-all text-ink-2">{row.place}</code>
                  <span className="text-caption text-muted">{row.routes.length > 0 ? row.routes.join(" ") : "no route found"}</span>
                </li>
              ))}
            </ul>
          </TabsContent>
          <TabsContent value="variants" className="px-5 py-4 outline-none">
            <p className="mb-3 text-small text-muted">Each distinct way it is drawn, per project; looks drawn the same share a tile.</p>
            <TileGrid tiles={tiles} scheme={scheme} />
          </TabsContent>
          <TabsContent value="code" className="space-y-3 px-5 py-4 outline-none">
            {code.length === 0 ? (
              <p className="text-small text-muted">No specimen was built for this family, so there is no HTML to show: its looks draw their measured shape.</p>
            ) : (
              <>
                {code.slice(0, CODE_LIMIT).map((tile) => (
                  <CodeBlock key={tile.key} title={`${tile.project} · ${tile.place}`} code={tile.specimen!.html} maxHeight="sm" />
                ))}
                {code.length > CODE_LIMIT && <p className="text-small text-muted">{code.length - CODE_LIMIT} more in Variants.</p>}
              </>
            )}
          </TabsContent>
        </>
      )}
    </Tabs>
  );
}
