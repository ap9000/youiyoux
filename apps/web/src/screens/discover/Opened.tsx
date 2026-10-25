/**
 * Discover's parts that exist only once something is opened or pinned, in a chunk of their own so
 * the page's first paint never carries them: the pinned Inventory family and a compare card per
 * opened candidate beside it (PinnedSection); and the candidate's drawer with the hidden frame
 * that learns what each opened candidate draws (CandidateLayer). Specimen tiles, the sandboxed
 * frames and the drawer's dialog all come with this chunk.
 */
import { Pin, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { sourceOf, type DiscoverHit } from "../../data/discover.ts";
import { ROLE_LABEL } from "../../data/inventory.ts";
import { useParts, type InventorySource } from "../../data/inventory-source.ts";
import { familyViews, Libraries } from "../../data/inventory-view.ts";
import { useInventoryState, type Resource } from "../../data/store.ts";
import type { InventoryChunk, InventoryExtras, InventoryFamily } from "../../data/types.ts";
import { Button } from "../../ui/Button.tsx";
import { familyTiles, leadTiles } from "../inventory/family-tiles.ts";
import { Sheet, useWide } from "../inventory/Sheet.tsx";
import { LeadTile, ScrollRoot, type Tile } from "../inventory/Specimens.tsx";
import { DrawProbe, usePreview } from "./candidate.tsx";
import { CandidatePanel } from "./CandidatePanel.tsx";
import { PinnedCompare } from "./PinnedCompare.tsx";

export interface Pinned {
  readonly family: InventoryFamily;
  readonly name: string;
  readonly tiles: readonly Tile[];
}

/** What usePinned reads before the inventory has loaded, or when the snapshot has none. */
const NO_SOURCE: InventorySource = { index: { roles: [], projects: [], extras: "" } as unknown as InventorySource["index"], get: () => ({ status: "idle" }), load: () => undefined, subscribe: () => () => undefined, cssUrl: (file) => file };

/** The pinned inventory family, from the snapshot's inventory: its role's chunks in each of its projects (`button-1` is a button). */
function usePinned(id: string, scheme: Scheme, inventory: Resource<InventorySource | null>): { pinned: Pinned | null; missing: boolean } {
  const source = (inventory.status === "ready" ? inventory.value : null) ?? NO_SOURCE;
  const role = source.index.roles.find((r) => r.role === id.replace(/-\d+$/, ""));
  const files = useMemo(() => (role ? Object.values(role.chunks) : []), [role]);
  const states = useParts<InventoryChunk>(source, files, files.length > 0);
  const extrasFiles = useMemo(() => (role ? [source.index.extras] : []), [role, source]);
  const [extrasState] = useParts<InventoryExtras>(source, extrasFiles, extrasFiles.length > 0);
  const ready = states.length > 0 && states.every((s) => s.status === "ready");
  // The states are new arrays each render; their statuses say when the chunks changed.
  const statusKey = states.map((s) => s.status).join("|");
  const chunks = useMemo(() => (ready ? states.map((s) => (s as { value: InventoryChunk }).value) : []), [statusKey, files]);
  const extras = extrasState?.status === "ready" ? extrasState.value : null;
  return useMemo(() => {
    const family = chunks.flatMap((c) => c.families).find((f) => f.id === id) ?? null;
    const settled = inventory.status === "ready" || inventory.status === "error";
    if (settled && (source === NO_SOURCE || !role || (ready && !family))) return { pinned: null, missing: true };
    if (!family) return { pinned: null, missing: false };
    const name = extras ? (familyViews(chunks, new Libraries(extras, null)).find((v) => v.family.id === id)?.name ?? family.id) : family.id;
    return { pinned: { family, name, tiles: leadTiles(familyTiles(family, chunks, source, scheme), family, `pinned:${family.id}`) }, missing: false };
  }, [chunks, extras, id, inventory.status, ready, role, scheme, source]);
}

/** The pinned family, and each opened candidate's compare card beside it. Tells the page which project to draw candidates in. */
export function PinnedSection({ id, opened, scheme, role, inventory, scroller, onClear, onProject }: { id: string; opened: readonly string[]; scheme: Scheme; role: string | null; inventory?: Resource<InventorySource | null> | undefined; scroller: Element | null; onClear: () => void; onProject: (project: string | null) => void }) {
  const snapshot = useInventoryState();
  const { pinned, missing } = usePinned(id, scheme, inventory ?? snapshot);
  const project = pinned?.family.projects[0] ?? null;
  useEffect(() => onProject(project), [project, onProject]);
  return (
    <ScrollRoot.Provider value={scroller}>
      <section aria-label="Pinned family" className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-raised p-3" data-pinned={id}>
        <div className="w-44 shrink-0 max-sm:w-full">{pinned ? <LeadTile tiles={pinned.tiles} scheme={scheme} as="div" caption={false} /> : null}</div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-1.5 text-small font-medium text-ink">
            <Pin aria-hidden className="size-3.5 text-muted" /> Finding alternatives for {pinned ? pinned.name : id}
          </p>
          <p className="text-small text-muted">{missing ? `The inventory has no family ${id}.` : pinned ? `${pinned.family.looks} ${pinned.family.looks === 1 ? "use" : "uses"} in ${pinned.family.projects.join(", ")}. Open a candidate to compare it beside this one, with the slider.` : "Loading the family…"}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="max-md:h-11">
          <X /> Unpin
        </Button>
      </section>
      {pinned && opened.length > 0 && (
        <section aria-labelledby="discover-compare" className="mt-6 space-y-3">
          <h2 id="discover-compare" className="text-heading">
            Beside your {pinned.name}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {opened.map((candidate) => (
              <ComparedCandidate key={candidate} id={candidate} project={project} pinned={pinned} scheme={scheme} role={role} />
            ))}
          </div>
        </section>
      )}
    </ScrollRoot.Provider>
  );
}

function ComparedCandidate({ id, project, pinned, scheme, role }: { id: string; project: string | null; pinned: Pinned; scheme: Scheme; role: string | null }) {
  const state = usePreview(id, project);
  if (state === null) return <p className="rounded-lg border border-line p-4 text-small text-faint">Fetching {id}…</p>;
  if (state.status === "error" || state.answer.error) return <p className="rounded-lg border border-dashed border-line-strong p-4 text-small text-muted">{state.status === "error" ? state.message : state.answer.error}</p>;
  return <PinnedCompare family={pinned.family} familyName={pinned.name} familyTiles={pinned.tiles} answer={state.answer} scheme={scheme} role={role ? (ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role) : null} />;
}

/** The hidden frame that learns what an opened candidate draws (one per candidate, once its preview is ready). */
function Probe({ id, project, onFail }: { id: string; project: string | null; onFail: (id: string, sentence: string) => void }) {
  const state = usePreview(id, project);
  if (state?.status !== "ready" || state.answer.error) return null;
  return <DrawProbe answer={state.answer} onFail={(sentence) => onFail(id, sentence)} />;
}

/** Every opened candidate's hidden frame, and the open one's drawer (a tall bottom sheet on a phone); closing it gives focus back to the result that opened it. */
export function CandidateLayer({ openHit, opened, project, scheme, family, onClose }: { openHit: DiscoverHit | null; opened: readonly string[]; project: string | null; scheme: Scheme; family: string | null; onClose: () => void }) {
  const wide = useWide();
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const fail = useCallback((id: string, sentence: string) => setFailures((f) => (f[id] ? f : { ...f, [id]: sentence })), []);
  const preview = usePreview(openHit ? openHit.id : null, project);
  return (
    <>
      {opened.map((id) => (
        <Probe key={id} id={id} project={project} onFail={fail} />
      ))}
      <Sheet open={openHit !== null} onOpenChange={(next) => !next && onClose()} variant={wide ? "drawer" : "sheet"} size="large" testId="candidate-drawer" title={openHit ? (openHit.title ?? openHit.name) : ""} description={openHit ? `${sourceOf(openHit)} · ${openHit.kind}` : undefined}>
        <ScrollRoot.Provider value={null}>{openHit && <CandidatePanel hit={openHit} state={preview} scheme={scheme} family={family} failure={failures[openHit.id] ?? null} onClose={onClose} />}</ScrollRoot.Provider>
      </Sheet>
    </>
  );
}
