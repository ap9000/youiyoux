/**
 * Style: author a system's tokens and component states with a live preview, light and dark.
 * Edits stay in this tab (kept across reloads) until Save draft puts them in the changes queue
 * as a style draft; from there the impact preview, approval and review branch follow the same
 * path as a rule change. Nothing here writes the design repository.
 *
 * `/style` starts a new set of edits; `/style/draft/<id>` continues a saved draft.
 */
import { clsx } from "clsx";
import { ArrowRight, Paintbrush, PlugZap, RotateCcw, SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useParams } from "wouter";
import type { Model } from "../../data/model.ts";
import { retryModel, useModelState } from "../../data/store.ts";
import { asRequestError, type StyleDraftContent, type StyleDraftView, workflowApi, type WorkflowRequestError } from "../../data/workflow.ts";
import type { PinnedState } from "../../preview/pin.ts";
import type { PreviewScreen, PreviewToken } from "../../preview/protocol.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { TextInput } from "../../ui/Field.tsx";
import { Keys } from "../../ui/Kbd.tsx";
import { PaneHeader, PaneSkeleton, ResourceState } from "../../ui/Pane.tsx";
import { SearchField } from "../../ui/SearchField.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { StartEditor } from "../changes/ServiceDown.tsx";
import { ContrastPanel } from "./ContrastPanel.tsx";
import { LivePreview, MiniPreview } from "./LivePreview.tsx";
import { applyEdit, contrastWarnings, editable, editCount, editorModel, EMPTY, GROUPS, groupOf, previewVars, type EditAction, type EditorModel, type Group } from "./model.ts";
import { StatesPanel } from "./StatesPanel.tsx";
import { TokenCard } from "./TokenControls.tsx";
import { SAMPLED_TYPES, tokenFocus } from "./uses.ts";

type Tab = Group | "states";

/** The preview screen that shows a token group best: picking a group turns the preview to it (an edit on a phone, to the token). */
const SCREEN_FOR: Record<Tab, Exclude<PreviewScreen, "token">> = { color: "components", type: "type", space: "scale", radius: "scale", border: "scale", shadow: "scale", motion: "motion", focus: "focus", other: "components", states: "components" };

/** The two-column editor starts at Tailwind's lg (64rem); below it the preview is a sticky strip. */
const WIDE = "(min-width: 64rem)";
function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = matchMedia(WIDE);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => matchMedia(WIDE).matches,
    () => true,
  );
}

/** The height of an element as it changes, for the scroll padding that keeps focused fields out from under it. */
function useHeight(): [(node: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    observer.current = new ResizeObserver(() => setHeight(node.getBoundingClientRect().height));
    observer.current.observe(node);
  }, []);
  return [ref, height];
}

const storageKey = (system: string, draft: string | null): string => `yx-style:${system}:${draft ?? "new"}`;

function readStored(key: string): StyleDraftContent | null {
  try {
    const text = sessionStorage.getItem(key);
    return text ? (JSON.parse(text) as StyleDraftContent) : null;
  } catch {
    return null;
  }
}

const same = (a: StyleDraftContent, b: StyleDraftContent): boolean => JSON.stringify(a) === JSON.stringify(b);

export function StyleScreen() {
  const state = useModelState();
  const params = useParams<{ "*"?: string }>();
  const draftId = /^draft\/(d-[0-9a-f]{10})$/.exec(params["*"] ?? "")?.[1] ?? null;
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryModel} what="the system's tokens" />;
  return <Loader key={draftId ?? "new"} model={state.value} draftId={draftId} />;
}

/** A saved draft loads before the editor opens on it; a new set of edits opens at once. */
function Loader({ model, draftId }: { model: Model; draftId: string | null }) {
  const [draft, setDraft] = useState<StyleDraftView | null>(null);
  const [failure, setFailure] = useState<WorkflowRequestError | null>(null);
  useEffect(() => {
    if (!draftId) return;
    workflowApi.draft(draftId).then(
      (view) => (view.kind === "style" ? setDraft(view) : setFailure(asRequestError(new Error(`${draftId} is a rule draft: open it from Rules.`)))),
      (error: unknown) => setFailure(asRequestError(error)),
    );
  }, [draftId]);
  if (draftId && failure) {
    return (
      <EmptyState icon={PlugZap} title="This draft could not be opened" actions={<Button asChild><Link href="/style">Start new edits</Link></Button>}>
        {failure.message}
      </EmptyState>
    );
  }
  if (draftId && !draft) return <PaneSkeleton />;
  return <Editor model={model} initialDraft={draft} />;
}

function Editor({ model: hub, initialDraft }: { model: Model; initialDraft: StyleDraftView | null }) {
  const [, navigate] = useLocation();
  const { system } = hub.catalog;
  const model: EditorModel = useMemo(() => editorModel(system.id, system.cssPrefix, [...hub.tokens.values()], hub.catalog.components.map((c) => c.contract)), [hub, system]);
  const [draft, setDraft] = useState<StyleDraftView | null>(initialDraft);
  const key = storageKey(system.id, draft?.id ?? null);
  const [content, dispatchRaw] = useReducer((current: StyleDraftContent, action: EditAction) => applyEdit(model, current, action), undefined, () => readStored(key) ?? initialDraft?.content ?? EMPTY);
  const [tab, setTab] = useState<Tab>("color");
  const [screen, setScreen] = useState<PreviewScreen>("components");
  const wide = useWide();
  // The token last edited: on a phone the preview turns to what it touches.
  const [edited, setEdited] = useState<string | null>(null);
  const dispatch = useCallback(
    (action: EditAction) => {
      dispatchRaw(action);
      if (!("path" in action)) return;
      setEdited(action.path);
      if (!wide && SAMPLED_TYPES.has(model.byPath.get(action.path)?.type ?? "")) setScreen("token");
    },
    [wide, model],
  );
  const [stickyRef, stickyHeight] = useHeight();
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<PinnedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WorkflowRequestError | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    workflowApi.info().then(
      () => setOffline(false),
      (error: unknown) => setOffline(asRequestError(error).offline),
    );
  }, []);

  useEffect(() => {
    try {
      if (draft && same(content, draft.content)) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(content));
    } catch {
      // Private browsing may refuse storage: edits still live in this tab.
    }
  }, [content, draft, key]);

  const open = !draft || draft.status === "draft" || draft.status === "previewed" || draft.status === "approved";
  const dirty = draft ? !same(content, draft.content) : editCount(content) > 0;
  const vars = useMemo(() => previewVars(model, content), [model, content]);
  const warnings = useMemo(() => contrastWarnings(model, content), [model, content]);
  const focus = useMemo(() => (edited ? tokenFocus(model, content, edited) : null), [model, content, edited]);
  const tokens: PreviewToken[] = useMemo(() => model.tokens.map((t) => ({ path: t.path, type: t.type, cssVar: t.cssVar })), [model]);
  const usable = model.tokens.filter(editable);

  const save = useCallback(async (): Promise<void> => {
    if (!open || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const saved = draft ? await workflowApi.save(draft.id, draft.revision, content) : await workflowApi.createStyle(content);
      if (saved.kind !== "style") throw new Error("the service returned a rule draft");
      try {
        sessionStorage.removeItem(storageKey(system.id, null));
      } catch {
        // Nothing stored.
      }
      setDraft(saved);
      if (!draft) navigate(`/style/draft/${saved.id}`, { replace: true });
    } catch (error: unknown) {
      setFailure(asRequestError(error));
    } finally {
      setBusy(false);
    }
  }, [open, busy, draft, content, system.id, navigate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  const counts = useMemo(() => {
    const byGroup = new Map<Group, number>();
    for (const token of usable) byGroup.set(groupOf(token), (byGroup.get(groupOf(token)) ?? 0) + 1);
    return byGroup;
  }, [usable]);
  const stateful = model.contracts.filter((c) => c.states && Object.keys(c.states).length > 0).length;
  const tabs = [...GROUPS.filter((g) => (counts.get(g.value) ?? 0) > 0).map((g) => ({ value: g.value as Tab, label: g.label, count: counts.get(g.value) ?? 0 })), { value: "states" as Tab, label: "States", count: stateful }];
  const q = query.trim().toLowerCase();
  const shown = usable.filter((t) => groupOf(t) === tab && (!q || t.path.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)));
  const warningsFor = (path: string) => warnings.filter((w) => w.pair.foreground === path || w.pair.background === path || w.pair.foreground === `${path}.color`);

  if (usable.length === 0) {
    return (
      <EmptyState icon={Paintbrush} title="This snapshot cannot be edited yet">
        It was built before the style editor. Run <code className="font-mono text-mono-sm">pnpm data</code> (or <code className="font-mono text-mono-sm">youi ui</code>) again.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader title="Style" count={editCount(content)}>
        {draft && (
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/changes/${draft.id}`}>
              Review <ArrowRight />
            </Link>
          </Button>
        )}
        {editCount(content) > 0 && open && (
          <Button size="icon-sm" variant="ghost" aria-label="Undo every unsaved edit" title="Undo every unsaved edit" disabled={!dirty} onClick={() => dispatch({ type: "replace", content: draft?.content ?? EMPTY })}>
            <RotateCcw />
          </Button>
        )}
        {open && (
          <Button size="sm" variant={dirty ? "primary" : "outline"} disabled={!dirty || busy || offline} onClick={() => void save()}>
            {busy ? "Saving…" : draft ? "Save draft" : "Save as draft"}
          </Button>
        )}
      </PaneHeader>

      {offline && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-warning-soft px-4 py-2 text-small text-ink-2">
          <PlugZap aria-hidden className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">Editing and the live preview work here; saving a draft needs the local workflow service.</span>
          <StartEditor />
        </div>
      )}
      {failure && (
        <div role="alert" className="border-b border-line bg-danger-soft px-4 py-2 text-small text-ink-2">
          <p className="font-medium">{failure.message}</p>
          {failure.problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      {draft && !open && (
        <div role="status" className="border-b border-line bg-raised px-4 py-2 text-small text-ink-2">
          This draft is {draft.status.replace("-", " ")}: it can no longer change. <Link href="/style" className="font-medium text-accent hover:underline">Start new edits</Link>
        </div>
      )}

      {/* Below lg one column scrolls, with the preview stuck to its top; scroll padding keeps a focused field from sliding under it. */}
      <div className="min-h-0 flex-1 max-lg:flex max-lg:flex-col max-lg:overflow-y-auto lg:grid lg:grid-cols-[minmax(22rem,30rem)_minmax(0,1fr)]" style={wide ? undefined : { scrollPaddingTop: stickyHeight + 8 }}>
        {!wide && (
          <section ref={stickyRef} aria-label="Live preview" className="sticky top-0 z-10 shrink-0 border-b border-line bg-canvas px-4 py-2 shadow-raise">
            <MiniPreview vars={vars} tokens={tokens} pinned={pinned} onPinned={setPinned} screen={screen} onScreen={setScreen} focus={focus} />
          </section>
        )}
        <section aria-label="Edit tokens and states" className="min-w-0 space-y-4 p-4 lg:overflow-y-auto lg:border-r lg:border-line">
          <div className="space-y-1.5">
            <label htmlFor="style-title" className="block text-small font-medium text-ink-2">
              Change
            </label>
            <TextInput id="style-title" value={content.title} placeholder="Name this change (Warmer brand, Rounder controls…)" disabled={!open} onChange={(event) => dispatch({ type: "title", title: event.target.value })} />
            <p className="flex flex-wrap items-center gap-1.5 text-small text-muted">
              {draft ? (
                <>
                  <Badge tone="outline">{draft.id}</Badge> revision {draft.revision}
                  {dirty ? " · unsaved edits" : " · saved"}
                </>
              ) : (
                `${editCount(content)} unsaved edit(s), kept in this tab`
              )}
              {dirty && open && (
                <span className="inline-flex items-center gap-1">
                  · save <Keys keys={["⌘", "S"]} />
                </span>
              )}
            </p>
          </div>
          <ContrastPanel warnings={warnings} />
          <Segmented<Tab>
            label="Token group"
            value={tab}
            onChange={(next) => {
              setTab(next);
              setQuery("");
              setScreen(SCREEN_FOR[next]);
            }}
            options={tabs}
            wrap
          />
          {tab === "states" ? (
            <StatesPanel model={model} content={content} dispatch={open ? dispatch : () => undefined} onPin={setPinned} pinned={pinned} />
          ) : (
            <>
              <SearchField value={query} onChange={setQuery} label="Filter tokens" placeholder="Filter by path or description…" />
              {shown.length === 0 ? (
                <EmptyState icon={SearchX} title="No tokens match">
                  Nothing in {GROUPS.find((g) => g.value === tab)?.label.toLowerCase()} matches “{query.trim()}”.
                </EmptyState>
              ) : (
                <fieldset disabled={!open} className={clsx("space-y-3", !open && "opacity-70")}>
                  <legend className="sr-only">{GROUPS.find((g) => g.value === tab)?.label} tokens</legend>
                  {shown.map((token) => (
                    <TokenCard key={token.path} model={model} token={token} content={content} dispatch={dispatch} warnings={warningsFor(token.path)} />
                  ))}
                </fieldset>
              )}
            </>
          )}
        </section>
        {wide && (
          <section aria-label="Live preview" className="min-w-0 p-4 lg:overflow-y-auto">
            <LivePreview vars={vars} tokens={tokens} pinned={pinned} onPinned={setPinned} screen={screen === "token" ? SCREEN_FOR[tab] : screen} onScreen={setScreen} />
          </section>
        )}
      </div>
    </div>
  );
}
