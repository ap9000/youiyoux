/**
 * Editing a component on a live screen, in the app's page (the live bridge runs this): a prop or
 * its text changed in place, as React DevTools changes it, so a person sees the real result before
 * any code is written.
 *
 * React's development build hands its renderer to `__REACT_DEVTOOLS_GLOBAL_HOOK__` as it loads, and
 * the renderer's `overrideProps` renders one component again with its props replaced. So the bridge,
 * loaded in the page's head before the app's scripts, leaves a minimal hook for React to find (or
 * uses the DevTools extension's, which is there first). An override lasts until the component's
 * parent renders it again, so after each commit what is still wanted is applied again. A component
 * is found again on the tree React committed by its name and where it was: its box's corner,
 * within a few pixels.
 *
 * Self-contained, as the bridge inlines it with `toString()`; it touches the page only when framed.
 */

/** A prop value the hub may set: what a contract's enum, string, boolean and number props take. */
export type LiveValue = string | number | boolean;
export interface LiveBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LiveEdits {
  /** Whether this page can be edited live, and why not. */
  ready(): { editable: boolean; why: string | null };
  /** The component's current values for `ask` (only plain values) and its text, when its children are text. */
  read(name: string, box: LiveBox, ask: readonly string[]): { found: boolean; props: Record<string, LiveValue | null>; text: string | null };
  /** Set props (and the text) on the component, and keep them set until reset. */
  edit(name: string, box: LiveBox, set: Readonly<Record<string, LiveValue>>, text: string | null): { ok: boolean; why: string | null };
  /** Every edit undone: each prop back to what the page had. */
  reset(): void;
  /** The edits let go without undoing them: the code now says the same, and the app reloads it. */
  forget(): void;
}

export function liveEdits(): LiveEdits {
  type Fiber = { tag: number; type: unknown; child: Fiber | null; sibling: Fiber | null; stateNode: unknown; memoizedProps: Record<string, unknown> | null };
  type Renderer = { overrideProps?: (fiber: Fiber, path: Array<string | number>, value: unknown) => void; bundleType?: number };
  type Hook = { renderers: Map<number, Renderer>; onCommitFiberRoot?: (...args: unknown[]) => void; __youiyoux?: boolean };
  type Edit = { name: string; box: LiveBox; set: Record<string, unknown>; was: Record<string, unknown> };
  const page = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  // Where a component may have moved to since it was picked, in page pixels.
  const NEAR = 24;
  const edits: Edit[] = [];

  // Before React loads, a hook for it to hand its renderer to; the DevTools extension's, when it is there first.
  if (!page.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    const renderers = new Map<number, Renderer>();
    page.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      __youiyoux: true,
      renderers,
      supportsFiber: true,
      isDisabled: false,
      inject: (renderer: Renderer) => {
        renderers.set(renderers.size + 1, renderer);
        return renderers.size;
      },
      onCommitFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onScheduleFiberRoot: () => undefined,
      checkDCE: () => undefined,
    } as Hook;
  }
  const hook = page.__REACT_DEVTOOLS_GLOBAL_HOOK__;

  const renderer = (): Renderer | null => [...(hook.renderers?.values() ?? [])].find((r) => typeof r.overrideProps === "function") ?? null;
  const roots = (): Fiber[] => {
    const found: Fiber[] = [];
    for (const element of document.querySelectorAll("*")) {
      const key = Object.keys(element).find((k) => k.startsWith("__reactContainer$"));
      if (!key) continue;
      const container = (element as unknown as Record<string, Fiber & { stateNode?: { current?: Fiber } }>)[key]!;
      found.push(container.stateNode?.current ?? container);
    }
    return found;
  };
  const nameOf = (type: unknown): string | null => {
    const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | null;
    return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || t?.type?.displayName || t?.type?.name || null;
  };
  const boxOf = (fiber: Fiber): LiveBox | null => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const walk = (first: Fiber | null): void => {
      for (let node = first; node; node = node.sibling) {
        if (node.tag === 5) {
          const rect = (node.stateNode as Element | null)?.getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            left = Math.min(left, rect.left);
            top = Math.min(top, rect.top);
            right = Math.max(right, rect.right);
            bottom = Math.max(bottom, rect.bottom);
          }
        } else if (node.tag !== 6) walk(node.child);
      }
    };
    walk(fiber.child);
    return Number.isFinite(left) ? { x: Math.round(left + scrollX), y: Math.round(top + scrollY), width: Math.round(right - left), height: Math.round(bottom - top) } : null;
  };
  /** The committed component called `name` whose box starts nearest `box`'s corner, within NEAR. */
  const find = (name: string, box: LiveBox): { fiber: Fiber; box: LiveBox } | null => {
    let best: { fiber: Fiber; box: LiveBox; off: number } | null = null;
    const walk = (first: Fiber | null): void => {
      for (let node = first; node; node = node.sibling) {
        if (COMPONENT.has(node.tag) && nameOf(node.type) === name) {
          const at = boxOf(node);
          const off = at ? Math.abs(at.x - box.x) + Math.abs(at.y - box.y) + Math.abs(at.width - box.width) / 4 : Infinity;
          if (at && off <= NEAR * 2 && (!best || off < best.off)) best = { fiber: node, box: at, off };
        }
        walk(node.child);
      }
    };
    for (const root of roots()) walk(root);
    return best;
  };
  /**
   * The props set at once: each `overrideProps` call copies the props last rendered, so two calls
   * before a render would keep only the second. An empty path replaces the whole props object.
   */
  const put = (r: Renderer, fiber: Fiber, changes: Record<string, unknown>): void => r.overrideProps!(fiber, [], { ...fiber.memoizedProps, ...changes });
  const plain = (value: unknown): LiveValue | null => (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : null);

  /** Each edit still wanted, applied again where a commit put the old value back. */
  const again = (): void => {
    const r = renderer();
    if (!r) return;
    for (const edit of edits) {
      const now = find(edit.name, edit.box);
      if (!now) continue;
      edit.box = now.box;
      if (Object.entries(edit.set).some(([key, value]) => !Object.is(now.fiber.memoizedProps?.[key], value))) put(r, now.fiber, edit.set);
    }
  };
  let queued = false;
  const commit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = (...args: unknown[]) => {
    commit?.apply(hook, args);
    if (edits.length === 0 || queued) return;
    queued = true;
    // After React has finished this commit, never inside it.
    setTimeout(() => {
      queued = false;
      again();
    }, 0);
  };

  return {
    ready() {
      const r = [...(hook.renderers?.values() ?? [])];
      if (r.some((one) => typeof one.overrideProps === "function")) return { editable: true, why: null };
      if (r.length > 0) return { editable: false, why: "this is a production build of React, which can't change props in place: run the app in development" };
      return { editable: false, why: roots().length > 0 ? "the bridge loaded after React: load it in the page's head, before the app's scripts" : "React isn't on this page" };
    },
    read(name, box, ask) {
      const at = find(name, box);
      if (!at) return { found: false, props: {}, text: null };
      const props: Record<string, LiveValue | null> = {};
      for (const key of ask) props[key] = plain(at.fiber.memoizedProps?.[key]);
      const children = at.fiber.memoizedProps?.["children"];
      return { found: true, props, text: typeof children === "string" ? children : null };
    },
    edit(name, box, set, text) {
      const r = renderer();
      if (!r) return { ok: false, why: this.ready().why };
      const at = find(name, box);
      if (!at) return { ok: false, why: "the component is no longer where it was on the page" };
      const wanted: Record<string, unknown> = { ...set, ...(text === null ? {} : { children: text }) };
      let edit = edits.find((e) => e.name === name && find(e.name, e.box)?.fiber === at.fiber);
      if (!edit) edits.push((edit = { name, box: at.box, set: {}, was: {} }));
      for (const [key, value] of Object.entries(wanted)) {
        if (!(key in edit.was)) edit.was[key] = at.fiber.memoizedProps?.[key];
        edit.set[key] = value;
      }
      put(r, at.fiber, edit.set);
      return { ok: true, why: null };
    },
    forget() {
      edits.splice(0);
    },
    reset() {
      const r = renderer();
      const undo = edits.splice(0);
      if (!r) return;
      for (const edit of undo) {
        const at = find(edit.name, edit.box);
        if (at) put(r, at.fiber, edit.was);
      }
    },
  };
}
