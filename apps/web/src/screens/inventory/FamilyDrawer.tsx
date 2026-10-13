/**
 * A family opened from the wall: a drawer on a desktop, a bottom sheet on a phone, headed by how
 * many uses it has across how many projects. Usage lists every look (project, repo-relative
 * file:line, routes), and beneath them its Storybook stories, which are not uses; Variants draws
 * each distinct specimen and each story, or (States) each one default, hover,
 * focus, pressed and disabled side by side; Code shows their HTML. It loads
 * the family's chunk in each of its projects, so every use is listed even under a project filter.
 * Find alternatives opens Discover with this family pinned, to compare outside candidates beside it.
 */
import { Compass } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import type { Scheme } from "../../app/theme.tsx";
import { useParts, type InventorySource } from "../../data/inventory-source.ts";
import { discoverRole, queryToSearch, EMPTY_QUERY } from "../../data/discover.ts";
import { storyRows, usageRows, type FamilyView } from "../../data/inventory-view.ts";
import type { InventoryChunk } from "../../data/types.ts";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs.tsx";
import { familyTiles } from "./family-tiles.ts";
import { Sheet, useWide } from "./Sheet.tsx";
import { ScrollRoot, StateStrip, StoryCaption, storyLabel, TileGrid, type Tile } from "./Specimens.tsx";

/** Discover with this family pinned and its role chosen: outside candidates to compare beside it. */
export const alternativesHref = (family: { id: string; role: string }): string => `/discover${queryToSearch({ ...EMPTY_QUERY, family: family.id, role: discoverRole(family.role) })}`;

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
      title={view ? drawerTitle(view) : ""}
      description={view?.name}
    >
      {/* Its specimens mount as they near the screen, not the page's scroll area behind it. */}
      <ScrollRoot.Provider value={null}>{view && <FamilyDetail view={view} source={source} scheme={scheme} />}</ScrollRoot.Provider>
    </Sheet>
  );
}

/** `13 uses across 4 projects · 3 stories`, or `Only in Storybook: 2 stories`. */
function drawerTitle(view: FamilyView): string {
  const stories = `${view.stories} ${view.stories === 1 ? "story" : "stories"}`;
  if (view.authored) return `Only in Storybook: ${stories}`;
  return `${view.uses} ${view.uses === 1 ? "use" : "uses"} across ${view.projects} ${view.projects === 1 ? "project" : "projects"}${view.stories > 0 ? ` · ${stories}` : ""}`;
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
  const stories = storyRows({ looks });
  const tiles = ready ? familyTiles(view.family, chunks, source, scheme) : [];
  const code = tiles.filter((t) => t.specimen !== null);
  if (failed?.status === "error") return <p className="px-5 py-4 text-small text-danger">{failed.message}</p>;
  return (
    <Tabs defaultValue="usage" className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-5 pb-2">
        <Button size="sm" asChild className="max-md:h-11">
          <Link href={alternativesHref(view.family)} data-find-alternatives={view.family.id}>
            <Compass /> Find alternatives
          </Link>
        </Button>
        <span className="text-caption text-muted">Outside candidates, compared beside this one.</span>
      </div>
      <TabsList className="px-5 max-md:h-12">
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
          <TabsContent value="usage" className="space-y-4 px-5 py-4 outline-none">
            {rows.length === 0 && <p className="text-small text-muted">No project renders this shape: only its Storybook stories do. Its stories are below, and drawn in Variants.</p>}
            <ul className="divide-y divide-line" aria-label="Every use">
              {rows.map((row) => (
                <li key={row.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-small" data-use>
                  <span className="font-medium text-ink">{row.project}</span>
                  <code className="font-mono text-mono-sm break-all text-ink-2">{row.place}</code>
                  <span className="text-caption text-muted">{row.routes.length > 0 ? row.routes.join(" ") : "no route found"}</span>
                </li>
              ))}
            </ul>
            {stories.length > 0 && (
              <section aria-labelledby="family-stories" className="space-y-1">
                <h3 id="family-stories" className="text-small font-medium text-ink">
                  Stories <span className="tabular font-normal text-muted">{stories.length}</span>
                </h3>
                <p className="text-caption text-muted">Authored states from Storybook, drawn with this project's code and CSS. They are not uses, so the counts above leave them out.</p>
                <ul className="divide-y divide-line" aria-label="Storybook stories">
                  {stories.map((row) => (
                    <li key={row.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-small" data-story-row>
                      <span className="font-medium text-ink">{row.story}</span>
                      <code className="font-mono text-mono-sm break-all text-ink-2">{row.place}</code>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </TabsContent>
          <TabsContent value="variants" className="px-5 py-4 outline-none">
            <Variants tiles={tiles} scheme={scheme} />
          </TabsContent>
          <TabsContent value="code" className="space-y-3 px-5 py-4 outline-none">
            {code.length === 0 ? (
              <p className="text-small text-muted">No specimen was built for this family, so there is no HTML to show: its looks draw their measured shape.</p>
            ) : (
              <>
                {code.slice(0, CODE_LIMIT).map((tile) => (
                  <CodeBlock key={tile.key} title={tile.story ? `${storyLabel(tile.story)} · ${tile.place}` : `${tile.project} · ${tile.place}`} code={tile.specimen!.html} maxHeight="sm" touch />
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

/** Variants: every distinct specimen as a tile, or each drawn one in its five states, so near-duplicates compare state by state. */
function Variants({ tiles, scheme }: { tiles: readonly Tile[]; scheme: Scheme }) {
  const [show, setShow] = useState<"looks" | "states">("looks");
  const drawn = tiles.filter((t) => t.specimen !== null && t.css !== null);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-small text-muted">{show === "looks" ? "Each distinct way it is drawn, per project; looks drawn the same share a tile. Storybook stories follow, each labeled." : "Each drawn look default, hover, focus, pressed and disabled, from its project's own CSS."}</p>
        <Segmented
          label="Show"
          touch
          value={show}
          onChange={setShow}
          options={[
            { value: "looks", label: "Looks" },
            { value: "states", label: "States", count: drawn.length },
          ]}
        />
      </div>
      {show === "looks" ? (
        <TileGrid tiles={tiles} scheme={scheme} tryIt />
      ) : drawn.length === 0 ? (
        <p className="text-small text-muted">No look of this family was drawn from its project's code and CSS, so there are no states to show.</p>
      ) : (
        <ul className="space-y-4" aria-label="States of each look">
          {drawn.map((tile) => (
            <li key={tile.key} className="min-w-0 space-y-1">
              {tile.story ? (
                <StoryCaption story={tile.story} place={tile.place} />
              ) : (
                <p className="flex min-w-0 items-baseline gap-1.5 text-caption text-muted">
                  <span className="shrink-0 font-medium text-ink-2">{tile.project}</span>
                  {tile.count > 1 && <span className="shrink-0 tabular">×{tile.count}</span>}
                  <span className="truncate font-mono" title={tile.place}>
                    {tile.place}
                  </span>
                </p>
              )}
              <StateStrip tile={tile} scheme={scheme} label={tile.story ? `${tile.project} ${storyLabel(tile.story)}` : `${tile.project} ${tile.place}`} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
