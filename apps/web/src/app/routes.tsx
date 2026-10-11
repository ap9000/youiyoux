/** Route table: every screen is its own chunk, preloaded on hover/focus and on idle after first paint. */
import { Boxes, House, KeyRound, Library, type LucideIcon, Monitor, Palette, GitPullRequestArrow } from "lucide-react";
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
const library = preloadable(() => import("../screens/library/LibraryScreen.tsx"), (m) => m.LibraryScreen);
const loadStubs = () => import("../screens/stubs/StubScreens.tsx");
const screens = preloadable(loadStubs, (m) => m.ScreensScreen);
const changes = preloadable(loadStubs, (m) => m.ChangesScreen);
const access = preloadable(loadStubs, (m) => m.AccessScreen);
const notFound = preloadable(loadStubs, (m) => m.NotFoundScreen);

export const HomeScreen = home.Component;
export const CatalogScreen = catalog.Component;
export const TokensScreen = tokens.Component;
export const LibraryScreen = library.Component;
export const ScreensScreen = screens.Component;
export const ChangesScreen = changes.Component;
export const AccessScreen = access.Component;
export const NotFoundScreen = notFound.Component;

const loaders = {
  home: home.preload,
  catalog: catalog.preload,
  tokens: tokens.preload,
  library: library.preload,
  stubs: () => Promise.all([screens, changes, access, notFound].map((s) => s.preload())).then(() => undefined),
} as const;

/**
 * The two halves of the tool. The System holds approved elements, their live usage and
 * their rules: what products build with. The Library holds what is ingested from outside,
 * to browse, categorize and propose; nothing in it is built with.
 */
export type NavSection = "system" | "library";

export const NAV_SECTIONS: Readonly<Record<NavSection, { readonly label: string; readonly hint: string }>> = {
  system: { label: "System", hint: "Approved elements, live usage and rules: build with these" },
  library: { label: "Library", hint: "Ingested references: browse and propose, never build with" },
};

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The `g` chord key that jumps here. */
  readonly key: string;
  readonly loader: keyof typeof loaders;
  /** Which half of the tool this screen belongs to; Home and the admin screens belong to neither. */
  readonly section?: NavSection;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Home", icon: House, key: "h", loader: "home" },
  { href: "/elements", label: "Elements", icon: Boxes, key: "e", loader: "catalog", section: "system" },
  { href: "/tokens", label: "Tokens", icon: Palette, key: "t", loader: "tokens", section: "system" },
  { href: "/screens", label: "Screens", icon: Monitor, key: "s", loader: "stubs", section: "system" },
  { href: "/library", label: "Library", icon: Library, key: "l", loader: "library", section: "library" },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow, key: "c", loader: "stubs" },
  { href: "/access", label: "Access", icon: KeyRound, key: "a", loader: "stubs" },
];

export interface NavGroup {
  readonly section: NavSection | null;
  readonly items: readonly NavItem[];
}

/** NAV split into runs of the same section, in order, for the rail to label and divide. */
export function navGroups(items: readonly NavItem[] = NAV): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of items) {
    const section = item.section ?? null;
    const last = groups.at(-1);
    if (last && last.section === section) groups[groups.length - 1] = { section, items: [...last.items, item] };
    else groups.push({ section, items: [item] });
  }
  return groups;
}

export function isActive(item: NavItem, path: string): boolean {
  return item.href === "/" ? path === "/" : path === item.href || path.startsWith(`${item.href}/`);
}

/** Start loading the chunk behind `href` (safe to call repeatedly; imports are cached). */
export function preload(href: string): void {
  const item = [...NAV].reverse().find((n) => isActive(n, href));
  if (item) void loaders[item.loader]();
}

export function preloadAll(): void {
  for (const load of Object.values(loaders)) void load();
}
