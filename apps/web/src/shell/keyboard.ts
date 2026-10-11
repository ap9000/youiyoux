/**
 * The keyboard layer: ⌘K palette, `/` search, `?` shortcuts, `g`-chords between
 * screens, and list movement (j/k, arrows, enter) for whichever list is active.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { NAV } from "../app/routes.tsx";
import { markNavigation } from "../lib/perf.ts";

export type Overlay = "palette" | "help" | null;

let overlay: Overlay = null;
const listeners = new Set<() => void>();

export function setOverlay(next: Overlay): void {
  overlay = next;
  listeners.forEach((listener) => listener());
}

export function useOverlay(): Overlay {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => overlay,
  );
}

const CHORD_WINDOW_MS = 900;

export function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** The search field of the active pane, marked with data-pane-search. */
function paneSearch(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("[data-pane-search]");
}

export function useGlobalKeys(navigate: (to: string) => void): void {
  useEffect(() => {
    let chordAt = 0;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOverlay(overlay === "palette" ? null : "palette");
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || overlay || isTyping(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        const search = paneSearch();
        if (search) search.select();
        else setOverlay("palette");
        return;
      }
      if (event.key === "?") {
        setOverlay("help");
        return;
      }
      const target = NAV.find((item) => item.key === event.key);
      if (target && performance.now() - chordAt < CHORD_WINDOW_MS) {
        event.preventDefault();
        chordAt = 0;
        if (target.href !== location.pathname) markNavigation(target.href);
        navigate(target.href);
        return;
      }
      chordAt = event.key === "g" ? performance.now() : 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}

export interface ListKeys {
  readonly count: number;
  readonly index: number;
  onMove(index: number): void;
  onOpen?(): void;
}

/** Where list keys apply: nothing focused, the pane's search, or inside the list itself. */
function inListScope(target: EventTarget | null): boolean {
  if (target === document.body || target === null) return true;
  return target instanceof Element && (target.hasAttribute("data-pane-search") || target.closest("[data-list-pane]") !== null);
}

/**
 * j/k and arrows move the selection of the active list; enter opens it. They act only
 * when focus is in the list, its search field, or nowhere, so links, buttons and tabs
 * elsewhere keep their own keys (Enter activates, arrows scroll).
 */
export function useListKeys(keys: ListKeys): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || overlay) return;
      const fromSearch = event.target instanceof HTMLElement && event.target.hasAttribute("data-pane-search");
      if (!inListScope(event.target)) return;
      const { count, index, onMove, onOpen } = latest.current;
      if (count === 0) return;
      const down = event.key === "ArrowDown" || (!fromSearch && event.key === "j");
      const up = event.key === "ArrowUp" || (!fromSearch && event.key === "k");
      if (down || up) {
        event.preventDefault();
        const next = Math.min(count - 1, Math.max(0, index + (down ? 1 : -1)));
        if (next !== index) onMove(next);
      } else if (event.key === "Enter" && onOpen && (event.target === document.body || event.target === null)) {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export const SHORTCUTS: ReadonlyArray<{ readonly group: string; readonly items: ReadonlyArray<{ readonly keys: readonly string[]; readonly label: string }> }> = [
  {
    group: "Anywhere",
    items: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["/"], label: "Search the current list" },
      { keys: ["?"], label: "Keyboard shortcuts" },
    ],
  },
  { group: "Go to", items: NAV.map((item) => ({ keys: ["g", item.key], label: item.label })) },
  {
    group: "Lists",
    items: [
      { keys: ["j"], label: "Next item" },
      { keys: ["k"], label: "Previous item" },
      { keys: ["↑", "↓"], label: "Move, also while searching" },
      { keys: ["Esc"], label: "Clear search, then leave the field" },
    ],
  },
];
