/** Theme: system, light or dark, pinned in localStorage and applied as html[data-theme]. */
import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

const STORAGE_KEY = "yx-theme";
const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = readChoice();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((listener) => listener());
darkQuery?.addEventListener("change", notify);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  const root = document.documentElement;
  if (next === "system") delete root.dataset.theme;
  else root.dataset.theme = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be blocked; the theme still applies for this session.
  }
  notify();
}

export function cycleTheme(): void {
  setTheme(CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length]!);
}

function resolvedScheme(): Scheme {
  if (choice !== "system") return choice;
  return darkQuery?.matches ? "dark" : "light";
}

export function useTheme(): { choice: ThemeChoice; scheme: Scheme } {
  const current = useSyncExternalStore(subscribe, () => choice);
  const scheme = useSyncExternalStore(subscribe, resolvedScheme);
  return { choice: current, scheme };
}
