/** Route table: every screen is its own chunk, preloaded on hover/focus and on idle after first paint. */
import { Boxes, LayoutGrid, Library, type LucideIcon, Monitor, Palette, PlugZap, Scale, GitPullRequestArrow } from "lucide-react";
import { type ComponentType, createElement } from "react";

/**
 * A screen whose chunk can be preloaded. Unlike React.lazy, once the chunk has arrived it
 * renders synchronously, so a preloaded route never suspends (React holds a suspended
 * route's fallback for at least 300 ms, which would blow the navigation budget).
 */
export function preloadable<M, P extends object>(load: () => Promise<M>, pick: (module: M) => ComponentType<P>): { Component: ComponentType<P>; preload: () => Promise<void> } {
  let Loaded: ComponentType<P> | null = null;
  let failure: unknown = null;
  let pending: Promise<void> | null = null;
  const preload = (): Promise<void> =>
    (pending ??= load().then(
      (module) => {
        Loaded = pick(module);
        failure = null;
      },
      (error: unknown) => {
        // Forget the failed attempt so the next render or hover tries again.
        failure = error;
        pending = null;
      },
    ));
  function Component(props: P) {
    if (Loaded) return createElement(Loaded, props);
    if (failure) {
      const error = failure;
      failure = null;
      throw error;
    }
    throw preload();
  }
  return { Component, preload };
}

const home = preloadable(() => import("../screens/home/HomeScreen.tsx"), (m) => m.HomeScreen);
const catalog = preloadable(() => import("../screens/catalog/CatalogScreen.tsx"), (m) => m.CatalogScreen);
const tokens = preloadable(() => import("../screens/tokens/TokensScreen.tsx"), (m) => m.TokensScreen);
const rules = preloadable(() => import("../screens/rules/RulesScreen.tsx"), (m) => m.RulesScreen);
const screens = preloadable(() => import("../screens/screens/ScreensScreen.tsx"), (m) => m.ScreensScreen);
const library = preloadable(() => import("../screens/library/LibraryScreen.tsx"), (m) => m.LibraryScreen);
const changes = preloadable(() => import("../screens/changes/ChangesScreen.tsx"), (m) => m.ChangesScreen);
const loadStubs = () => import("../screens/stubs/StubScreens.tsx");
const sources = preloadable(loadStubs, (m) => m.SourcesScreen);
const access = preloadable(loadStubs, (m) => m.AccessScreen);
const notFound = preloadable(loadStubs, (m) => m.NotFoundScreen);

export const HomeScreen = home.Component;
export const CatalogScreen = catalog.Component;
export const TokensScreen = tokens.Component;
export const LibraryScreen = library.Component;
export const ScreensScreen = screens.Component;
export const RulesScreen = rules.Component;
export const SourcesScreen = sources.Component;
export const ChangesScreen = changes.Component;
export const AccessScreen = access.Component;
export const NotFoundScreen = notFound.Component;

const loaders = {
  home: home.preload,
  catalog: catalog.preload,
  tokens: tokens.preload,
  rules: rules.preload,
  screens: screens.preload,
  library: library.preload,
  changes: changes.preload,
  stubs: () => Promise.all([sources, access, notFound].map((s) => s.preload())).then(() => undefined),
} as const;

/**
 * The tool's top level. The System holds approved elements, their rules and live usage: what
 * products build with. The Library holds what is ingested from outside, to browse, categorize
 * and propose; nothing in it is built with. Work is changes moving through review.
 */
export type NavSection = "system" | "library" | "work";

export const NAV_SECTIONS: Readonly<Record<NavSection, { readonly label: string; readonly hint: string }>> = {
  system: { label: "System", hint: "Approved elements, rules and live usage: build with these" },
  library: { label: "Library", hint: "Ingested references: browse and propose, never build with" },
  work: { label: "Work", hint: "Changes in progress and their review" },
};

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The `g` chord key that jumps here. */
  readonly key: string;
  readonly loader: keyof typeof loaders;
  readonly section: NavSection;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutGrid, key: "o", loader: "home", section: "system" },
  { href: "/elements", label: "Components", icon: Boxes, key: "c", loader: "catalog", section: "system" },
  { href: "/tokens", label: "Tokens", icon: Palette, key: "t", loader: "tokens", section: "system" },
  { href: "/rules", label: "Rules", icon: Scale, key: "r", loader: "rules", section: "system" },
  { href: "/screens", label: "Screens", icon: Monitor, key: "s", loader: "screens", section: "system" },
  { href: "/library", label: "Browse", icon: Library, key: "l", loader: "library", section: "library" },
  { href: "/library/sources", label: "Sources", icon: PlugZap, key: "i", loader: "stubs", section: "library" },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow, key: "w", loader: "changes", section: "work" },
];

export interface NavGroup {
  readonly section: NavSection;
  readonly items: readonly NavItem[];
}

/** NAV split into runs of the same section, in order, for the rail to label and divide. */
export function navGroups(items: readonly NavItem[] = NAV): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of items) {
    const section = item.section;
    const last = groups.at(-1);
    if (last && last.section === section) groups[groups.length - 1] = { section, items: [...last.items, item] };
    else groups.push({ section, items: [item] });
  }
  return groups;
}

function matches(href: string, path: string): boolean {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

/** The most specific nav item for a path, so /library/sources lights Sources, not Browse. */
export function isActive(item: NavItem, path: string): boolean {
  const best = NAV.filter((n) => matches(n.href, path)).sort((a, b) => b.href.length - a.href.length)[0];
  return best?.href === item.href;
}

/** Start loading the chunk behind `href` (safe to call repeatedly; imports are cached). */
export function preload(href: string): void {
  const item = [...NAV].reverse().find((n) => isActive(n, href));
  if (item) void loaders[item.loader]();
}

export function preloadAll(): void {
  for (const load of Object.values(loaders)) void load();
}
